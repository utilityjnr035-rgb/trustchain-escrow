/**
 * cacheStampede.test.js — Issue #195
 *
 * Tests for single-flight / cache-stampede protection in cacheService.getOrLoad().
 *
 * Coverage:
 *  1. Concurrent miss invokes loader exactly once (singleflight coalescing)
 *  2. Cache hit is returned immediately without calling the loader
 *  3. Loader failure does NOT poison the cache (next caller retries)
 *  4. Tags are stored when tags array is provided
 *  5. Parallel requests all receive the same resolved value
 *  6. Sequential requests after cache is warm hit the cache, not the loader
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Tenant context mock ───────────────────────────────────────────────────────
// scopeCacheKey / scopeCacheTag must be mockable before the SUT is imported.

jest.unstable_mockModule('../lib/tenantContext.js', () => ({
  scopeCacheKey: (key) => key,
  scopeCacheTag: (tag) => tag,
}));

// ── Logger mock ───────────────────────────────────────────────────────────────

const logMock = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../config/logger.js', () => ({
  createModuleLogger: () => logMock,
}));

// ── Redis mock (no REDIS_URL so the in-memory backend is used) ────────────────
// We don't need to mock redis — just ensure REDIS_URL is unset.

delete process.env.REDIS_URL;

// ── Import SUT AFTER mocks ────────────────────────────────────────────────────

const cacheService = (await import('../services/cacheService.js')).default;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create N concurrent getOrLoad() calls for the same key.
 * Returns an array of Promises that can be settled with Promise.allSettled().
 */
function concurrentGetOrLoad(n, key, loader, ttl = 60, tags = []) {
  return Array.from({ length: n }, () => cacheService.getOrLoad(key, loader, ttl, tags));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Bust the in-memory cache between tests by invalidating known keys.
  // We generate unique keys per test so there is no cross-test bleed.
  jest.clearAllMocks();
});

describe('cacheService.getOrLoad — single-flight stampede protection', () => {
  // ── 1. Concurrent miss calls loader exactly once ──────────────────────────

  it('calls loader exactly once when N concurrent misses arrive simultaneously', async () => {
    const key = `test:stampede:${Date.now()}`;
    const loader = jest.fn(async () => ({ data: 'result' }));

    const promises = concurrentGetOrLoad(8, key, loader);
    const results = await Promise.all(promises);

    // Loader must have been invoked exactly once despite 8 concurrent callers
    expect(loader).toHaveBeenCalledTimes(1);

    // All callers receive the same resolved value
    for (const result of results) {
      expect(result).toEqual({ data: 'result' });
    }
  });

  // ── 2. Cache hit bypasses loader ─────────────────────────────────────────

  it('returns cached value without calling loader on a warm cache', async () => {
    const key = `test:hit:${Date.now()}`;
    const loader = jest.fn(async () => ({ warmed: true }));

    // Warm the cache
    await cacheService.set(key, { warmed: true }, 60);

    const result = await cacheService.getOrLoad(key, loader, 60);
    expect(result).toEqual({ warmed: true });
    expect(loader).not.toHaveBeenCalled();
  });

  // ── 3. Loader failure does not poison the cache ───────────────────────────

  it('does not cache errors; next caller retries the loader', async () => {
    const key = `test:failure:${Date.now()}`;
    let callCount = 0;
    const loader = jest.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('DB down');
      return { recovered: true };
    });

    // First call: loader throws
    await expect(cacheService.getOrLoad(key, loader, 60)).rejects.toThrow('DB down');

    // Nothing should have been cached
    const cached = await cacheService.get(key);
    expect(cached).toBeNull();

    // Second call: loader succeeds and result is cached
    const result = await cacheService.getOrLoad(key, loader, 60);
    expect(result).toEqual({ recovered: true });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  // ── 4. Tags are stored when provided ─────────────────────────────────────

  it('persists cache entry with supplied invalidation tags', async () => {
    const key = `test:tags:${Date.now()}`;
    const tag = `escrow:${Date.now()}`;
    const loader = jest.fn(async () => ({ id: 42 }));

    await cacheService.getOrLoad(key, loader, 60, [tag]);

    // Value must be retrievable via get()
    const cached = await cacheService.get(key);
    expect(cached).toEqual({ id: 42 });

    // Invalidating by tag must remove the entry
    await cacheService.invalidateTag(tag);
    const afterInvalidation = await cacheService.get(key);
    expect(afterInvalidation).toBeNull();
  });

  // ── 5. All parallel callers receive the same value ────────────────────────

  it('all concurrent callers receive the resolved value of the single in-flight load', async () => {
    const key = `test:parallel:${Date.now()}`;
    let resolveLoad;
    const deferred = new Promise((res) => {
      resolveLoad = res;
    });

    const loader = jest.fn(async () => {
      await deferred;
      return { concurrent: true };
    });

    // Kick off 5 parallel requests before resolving the loader
    const promises = concurrentGetOrLoad(5, key, loader);

    // Allow the event-loop to register all in-flight callers
    await Promise.resolve();

    // Release the loader
    resolveLoad();

    const results = await Promise.all(promises);
    expect(loader).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r).toEqual({ concurrent: true });
    }
  });

  // ── 6. Sequential warm-cache requests do not call loader again ────────────

  it('does not call loader on subsequent sequential requests once cache is warm', async () => {
    const key = `test:sequential:${Date.now()}`;
    const loader = jest.fn(async () => ({ seq: 1 }));

    // First call — populates cache
    const first = await cacheService.getOrLoad(key, loader, 60);
    expect(first).toEqual({ seq: 1 });
    expect(loader).toHaveBeenCalledTimes(1);

    // Subsequent calls — all served from cache
    for (let i = 0; i < 5; i++) {
      const result = await cacheService.getOrLoad(key, loader, 60);
      expect(result).toEqual({ seq: 1 });
    }

    // Loader still called only once
    expect(loader).toHaveBeenCalledTimes(1);
  });

  // ── 7. Analytics includes inFlightCount ──────────────────────────────────

  it('analytics() exposes inFlightCount field', () => {
    const stats = cacheService.analytics();
    expect(typeof stats.inFlightCount).toBe('number');
    expect(stats.inFlightCount).toBeGreaterThanOrEqual(0);
  });

  // ── 8. getOrLoad is exported from cacheService ────────────────────────────

  it('exports getOrLoad as a function', () => {
    expect(typeof cacheService.getOrLoad).toBe('function');
  });
});
