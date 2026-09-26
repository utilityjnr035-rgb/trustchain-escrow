/**
 * Cache Service — Redis with in-memory fallback
 *
 * Exposes the same interface as the original lib/cache.js so all existing
 * controllers work without modification. Adds:
 *
 * - Tag-based invalidation: tag a cached entry with one or more logical
 *   group names (e.g. "escrow:42", "escrows") so a single
 *   invalidateTag("escrow:42") call purges every related entry atomically.
 *
 * - setWithTags(key, value, ttl, tags[])
 * - invalidateTag(tag)
 * - invalidateTags(tags[])
 *
 * - Single-flight / cache stampede protection (Issue #195):
 *   getOrLoad(key, loader, ttl, tags?) coalesces concurrent misses so the
 *   loader function is invoked at most once per in-flight window.  Failed
 *   loads are never cached, and the in-flight entry is removed so the next
 *   caller retries cleanly.
 *
 * Redis is optional: if REDIS_URL is unset or the connection fails the
 * service transparently falls back to the in-memory store.
 */

import { createClient } from 'redis';
import { createModuleLogger } from '../config/logger.js';
import { scopeCacheKey, scopeCacheTag } from '../lib/tenantContext.js';

const log = createModuleLogger('cacheService');

// ── Analytics counters ────────────────────────────────────────────────────────

const stats = { hits: 0, misses: 0, sets: 0, invalidations: 0 };

// ── In-memory fallback ────────────────────────────────────────────────────────

const memStore = new Map();
/** tag → Set<key> */
const memTags = new Map();

const mem = {
  get(key) {
    const entry = memStore.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      memStore.delete(key);
      return null;
    }
    return entry.value;
  },
  set(key, value, ttlSeconds) {
    memStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
  del(key) {
    memStore.delete(key);
  },
  keys() {
    return [...memStore.keys()];
  },
  size() {
    return memStore.size;
  },
  tagAdd(tag, key) {
    if (!memTags.has(tag)) memTags.set(tag, new Set());
    memTags.get(tag).add(key);
  },
  tagKeys(tag) {
    return [...(memTags.get(tag) ?? [])];
  },
  tagDel(tag) {
    memTags.delete(tag);
  },
};

// ── Redis client ──────────────────────────────────────────────────────────────

let redis = null;
let redisReady = false;

if (process.env.REDIS_URL) {
  redis = createClient({ url: process.env.REDIS_URL });
  redis.on('ready', () => {
    redisReady = true;
    log.info({ message: 'redis_connected' });
  });
  redis.on('error', (err) => {
    redisReady = false;
    log.warn({ message: 'redis_error_fallback_memory', error: err.message });
  });
  redis.connect().catch((err) => log.warn({ message: 'redis_connect_failed', error: err.message }));
}

// ── Redis tag helpers ─────────────────────────────────────────────────────────
// Tags are stored as Redis Sets: tag:<name> → [key1, key2, ...]

const redisTagKey = (tag) => `tag:${tag}`;

async function redisTagAdd(tag, key, ttlSeconds) {
  const tKey = redisTagKey(tag);
  await redis.sAdd(tKey, key).catch(() => null);
  // Expire the tag set slightly after the longest possible entry TTL
  await redis.expire(tKey, ttlSeconds + 60).catch(() => null);
}

async function redisTagKeys(tag) {
  return redis.sMembers(redisTagKey(tag)).catch(() => []);
}

async function redisTagDel(tag) {
  return redis.del(redisTagKey(tag)).catch(() => null);
}

// ── Public API ────────────────────────────────────────────────────────────────

async function get(key) {
  const scopedKey = scopeCacheKey(key);

  if (redisReady) {
    const raw = await redis.get(scopedKey).catch(() => null);
    if (raw !== null) {
      stats.hits++;
      return JSON.parse(raw);
    }
  } else {
    const val = mem.get(scopedKey);
    if (val !== null) {
      stats.hits++;
      return val;
    }
  }
  stats.misses++;
  return null;
}

async function set(key, value, ttlSeconds = 60) {
  const scopedKey = scopeCacheKey(key);

  stats.sets++;
  if (redisReady) {
    await redis.set(scopedKey, JSON.stringify(value), { EX: ttlSeconds }).catch(() => {
      mem.set(scopedKey, value, ttlSeconds);
    });
  } else {
    mem.set(scopedKey, value, ttlSeconds);
  }
}

/**
 * Store a value and associate it with one or more invalidation tags.
 *
 * @param {string}   key
 * @param {*}        value
 * @param {number}   ttlSeconds
 * @param {string[]} tags  — logical group names, e.g. ['escrows', 'escrow:42']
 */
async function setWithTags(key, value, ttlSeconds = 60, tags = []) {
  const scopedKey = scopeCacheKey(key);
  const scopedTags = tags.map((tag) => scopeCacheTag(tag));

  await set(key, value, ttlSeconds);
  for (const tag of scopedTags) {
    if (redisReady) {
      await redisTagAdd(tag, scopedKey, ttlSeconds);
    } else {
      mem.tagAdd(tag, scopedKey);
    }
  }
}

async function invalidate(key) {
  const scopedKey = scopeCacheKey(key);

  stats.invalidations++;
  if (redisReady) await redis.del(scopedKey).catch(() => null);
  mem.del(scopedKey);
}

async function invalidatePrefix(prefix) {
  const scopedPrefix = scopeCacheKey(prefix);

  stats.invalidations++;
  if (redisReady) {
    // Use SCAN (cursor-based) instead of KEYS to avoid blocking Redis
    let cursor = 0;
    do {
      const result = await redis
        .scan(cursor, { MATCH: `${scopedPrefix}*`, COUNT: 100 })
        .catch(() => ({ cursor: 0, keys: [] }));
      cursor = result.cursor;
      if (result.keys.length) await redis.del(result.keys).catch(() => null);
    } while (cursor !== 0);
  }
  for (const key of mem.keys()) {
    if (key.startsWith(scopedPrefix)) mem.del(key);
  }
}

/**
 * Delete every cached entry belonging to a tenant without blocking Redis.
 * Scans for `tenant:<slug>:*` keys using cursor-based SCAN iteration.
 * Safe to call on tenant deletion or suspension.
 *
 * @param {string} slug  — tenant slug (e.g. "acme")
 */
async function flushTenant(slug) {
  const prefix = `tenant:${slug}:`;
  if (redisReady) {
    let cursor = 0;
    do {
      const result = await redis
        .scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 })
        .catch(() => ({ cursor: 0, keys: [] }));
      cursor = result.cursor;
      if (result.keys.length) await redis.del(result.keys).catch(() => null);
    } while (cursor !== 0);
  }
  for (const key of mem.keys()) {
    if (key.startsWith(prefix)) mem.del(key);
  }
}

/**
 * Invalidate all cache entries associated with a tag.
 *
 * @param {string} tag
 */
async function invalidateTag(tag) {
  const scopedTag = scopeCacheTag(tag);

  stats.invalidations++;
  if (redisReady) {
    const keys = await redisTagKeys(scopedTag);
    if (keys.length) await redis.del(keys).catch(() => null);
    await redisTagDel(scopedTag);
  } else {
    for (const key of mem.tagKeys(scopedTag)) mem.del(key);
    mem.tagDel(scopedTag);
  }
}

/**
 * Invalidate all cache entries for multiple tags at once.
 *
 * @param {string[]} tags
 */
async function invalidateTags(tags) {
  await Promise.all(tags.map(invalidateTag));
}

// ── Single-flight / cache stampede protection (Issue #195) ───────────────────
//
// `_inFlight` maps a *scoped* cache key to the Promise that is currently
// loading it.  When `getOrLoad` detects a miss it checks this map first:
//
//  - If a Promise is already in-flight for this key, the caller awaits it
//    directly — no second DB/loader invocation is made.
//  - If no Promise is in-flight a new one is created, stored, and awaited.
//
// On success the result is written to cache and the in-flight entry removed.
// On failure the in-flight entry is removed without caching, so the next
// caller transparently retries.

/** @type {Map<string, Promise<*>>} */
const _inFlight = new Map();

/**
 * Read-through cache with single-flight coalescing.
 *
 * Concurrent cache misses for the same `key` call `loader` only once.
 * Errors thrown by `loader` propagate to all waiting callers and do NOT
 * poison the cache — the next call will attempt the loader again.
 *
 * @param {string}      key        — logical cache key (will be scoped)
 * @param {() => Promise<*>} loader — async function that fetches fresh data
 * @param {number}      [ttlSeconds=60] — TTL passed to set/setWithTags
 * @param {string[]}    [tags=[]]  — optional invalidation tags
 * @returns {Promise<*>}
 */
async function getOrLoad(key, loader, ttlSeconds = 60, tags = []) {
  // Fast path: cache hit
  const cached = await get(key);
  if (cached !== null) return cached;

  const scopedKey = scopeCacheKey(key);

  // Single-flight: if there is already an in-flight load for this key,
  // wait for it instead of firing a second loader.
  if (_inFlight.has(scopedKey)) {
    log.debug({ message: 'cache_stampede_coalesced', key: scopedKey });
    return _inFlight.get(scopedKey);
  }

  // No hit, no in-flight — start a new load.
  const loadPromise = (async () => {
    try {
      const value = await loader();
      // Persist to cache (with optional tags) before removing in-flight entry
      if (tags.length > 0) {
        await setWithTags(key, value, ttlSeconds, tags);
      } else {
        await set(key, value, ttlSeconds);
      }
      log.debug({ message: 'cache_loaded_and_stored', key: scopedKey });
      return value;
    } catch (err) {
      // Loader failed — do NOT cache the error so the next caller retries.
      log.warn({ message: 'cache_loader_failed', key: scopedKey, error: err.message });
      throw err;
    } finally {
      // Always clean up the in-flight entry, success or failure.
      _inFlight.delete(scopedKey);
    }
  })();

  _inFlight.set(scopedKey, loadPromise);
  return loadPromise;
}

/** Warm the cache by calling a loader function if the key is cold. */
async function warm(key, loader, ttlSeconds = 60) {
  const existing = await get(key);
  if (existing !== null) return existing;
  const value = await loader();
  await set(key, value, ttlSeconds);
  return value;
}

/** Returns hit rate and counters for the /health endpoint. */
function analytics() {
  const total = stats.hits + stats.misses;
  return {
    ...stats,
    hitRate: total > 0 ? (stats.hits / total).toFixed(4) : '0',
    backend: redisReady ? 'redis' : 'memory',
    memSize: mem.size(),
    inFlightCount: _inFlight.size,
  };
}

function size() {
  return redisReady ? null : mem.size();
}

export default {
  get,
  set,
  setWithTags,
  invalidate,
  invalidatePrefix,
  flushTenant,
  invalidateTag,
  invalidateTags,
  warm,
  getOrLoad,
  analytics,
  size,
};

