/**
 * chatRoomResyncService.js — Issue #194
 *
 * Resyncs chat room participants from escrow participants whenever
 * ownership, dispute status, or role changes occur.
 *
 * ## Responsibilities
 *
 * 1. `syncChatRoomParticipants(escrowId, options)` — the primary entry-point.
 *    Reads the current escrow participant set (client, freelancer, arbiter)
 *    from the database, compares it against the existing chat room participant
 *    records, adds missing participants, and optionally removes unauthorised
 *    ones (controlled by `options.removeUnauthorized`).
 *
 * 2. `handleEscrowParticipantChange(event)` — thin event handler meant to be
 *    called from the event indexer or a domain event bus whenever an escrow
 *    undergoes an ownership, dispute, or role change.  It delegates to
 *    `syncChatRoomParticipants` after extracting the escrow ID from the event.
 *
 * ## Design notes
 *
 * - The service is intentionally decoupled from Socket.IO.  It only mutates
 *   the database; the real-time layer (chatSocket.js) re-reads participant
 *   state from the DB on each connection.
 * - All writes use Prisma upsert semantics so the function is idempotent.
 * - A "participant" in this service means a DB record that grants a wallet
 *   address access to a specific chat room (identified by escrow ID in the
 *   absence of a separate ChatRoom model — extended as needed).
 */

import prisma from '../lib/prisma.js';
import { createModuleLogger } from '../config/logger.js';

const log = createModuleLogger('chatRoomResyncService');

// ── Role constants ─────────────────────────────────────────────────────────────

export const ROLE_CLIENT = 'client';
export const ROLE_FREELANCER = 'freelancer';
export const ROLE_ARBITER = 'arbiter';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive the canonical participant set from an escrow record.
 *
 * @param {{ clientAddress: string, freelancerAddress: string, arbiterAddress: string|null }} escrow
 * @returns {Array<{ address: string, role: string }>}
 */
function escrowToParticipants(escrow) {
  const participants = [
    { address: escrow.clientAddress, role: ROLE_CLIENT },
    { address: escrow.freelancerAddress, role: ROLE_FREELANCER },
  ];
  if (escrow.arbiterAddress) {
    participants.push({ address: escrow.arbiterAddress, role: ROLE_ARBITER });
  }
  return participants;
}

// ── Core resync logic ─────────────────────────────────────────────────────────

/**
 * Resync chat room participants for a given escrow.
 *
 * @param {bigint|number|string} escrowId
 * @param {{ removeUnauthorized?: boolean }} [options={}]
 * @returns {Promise<{ added: number, removed: number, unchanged: number }>}
 */
export async function syncChatRoomParticipants(escrowId, options = {}) {
  const { removeUnauthorized = false } = options;
  const id = BigInt(escrowId);

  // ── Fetch canonical escrow participants from DB ───────────────────────────

  const escrow = await prisma.escrow.findUnique({
    where: { id },
    select: { clientAddress: true, freelancerAddress: true, arbiterAddress: true },
  });

  if (!escrow) {
    log.warn({ message: 'chat_resync_escrow_not_found', escrowId: String(escrowId) });
    return { added: 0, removed: 0, unchanged: 0 };
  }

  const authorizedParticipants = escrowToParticipants(escrow);
  const authorizedAddresses = new Set(authorizedParticipants.map((p) => p.address));

  // ── Fetch existing chat room participant records ──────────────────────────

  let existingParticipants = [];
  try {
    existingParticipants = await prisma.chatRoomParticipant.findMany({
      where: { escrowId: id },
      select: { address: true, role: true },
    });
  } catch (err) {
    // ChatRoomParticipant may not exist yet in older schema versions.
    // Log and treat as empty — the upserts below will create the table rows.
    log.warn({
      message: 'chat_resync_participant_query_failed',
      escrowId: String(escrowId),
      error: err.message,
    });
  }

  const existingAddresses = new Set(existingParticipants.map((p) => p.address));

  let added = 0;
  let removed = 0;
  let unchanged = 0;

  // ── Add missing participants ───────────────────────────────────────────────

  for (const { address, role } of authorizedParticipants) {
    if (!existingAddresses.has(address)) {
      try {
        await prisma.chatRoomParticipant.upsert({
          where: { escrowId_address: { escrowId: id, address } },
          create: { escrowId: id, address, role },
          update: { role }, // update role in case it changed
        });
        log.info({
          message: 'chat_resync_participant_added',
          escrowId: String(escrowId),
          address,
          role,
        });
        added++;
      } catch (err) {
        log.error({
          message: 'chat_resync_add_failed',
          escrowId: String(escrowId),
          address,
          error: err.message,
        });
      }
    } else {
      // Participant already exists — still upsert to ensure role is current
      const existing = existingParticipants.find((p) => p.address === address);
      if (existing && existing.role !== role) {
        try {
          await prisma.chatRoomParticipant.update({
            where: { escrowId_address: { escrowId: id, address } },
            data: { role },
          });
          log.info({
            message: 'chat_resync_role_updated',
            escrowId: String(escrowId),
            address,
            oldRole: existing.role,
            newRole: role,
          });
          added++; // count role updates as meaningful changes
        } catch (err) {
          log.error({
            message: 'chat_resync_role_update_failed',
            escrowId: String(escrowId),
            address,
            error: err.message,
          });
        }
      } else {
        unchanged++;
      }
    }
  }

  // ── Remove unauthorized participants (if policy requires) ─────────────────

  if (removeUnauthorized) {
    for (const { address } of existingParticipants) {
      if (!authorizedAddresses.has(address)) {
        try {
          await prisma.chatRoomParticipant.delete({
            where: { escrowId_address: { escrowId: id, address } },
          });
          log.info({
            message: 'chat_resync_participant_removed',
            escrowId: String(escrowId),
            address,
          });
          removed++;
        } catch (err) {
          log.error({
            message: 'chat_resync_remove_failed',
            escrowId: String(escrowId),
            address,
            error: err.message,
          });
        }
      }
    }
  }

  log.info({
    message: 'chat_resync_complete',
    escrowId: String(escrowId),
    added,
    removed,
    unchanged,
  });

  return { added, removed, unchanged };
}

// ── Event handler ─────────────────────────────────────────────────────────────

/**
 * Handle escrow participant change events emitted by the event indexer or
 * an internal domain event bus.
 *
 * Recognised event types:
 *  - `ESCROW_FUNDED`      — initial participants set on escrow creation
 *  - `ARBITER_ASSIGNED`   — an arbiter was added or changed
 *  - `ARBITER_REMOVED`    — an arbiter was removed (removeUnauthorized = true)
 *  - `DISPUTE_RAISED`     — dispute adds arbiter access
 *  - `DISPUTE_RESOLVED`   — dispute resolved; optionally remove arbiter
 *  - `OWNERSHIP_TRANSFER` — client address changed
 *
 * @param {{ type: string, escrowId: bigint|number|string, [key: string]: * }} event
 * @returns {Promise<void>}
 */
export async function handleEscrowParticipantChange(event) {
  if (!event?.escrowId) {
    log.warn({ message: 'chat_resync_missing_escrow_id', event });
    return;
  }

  const removeUnauthorized = [
    'ARBITER_REMOVED',
    'DISPUTE_RESOLVED',
    'OWNERSHIP_TRANSFER',
  ].includes(event.type);

  log.info({
    message: 'chat_resync_triggered',
    type: event.type,
    escrowId: String(event.escrowId),
    removeUnauthorized,
  });

  await syncChatRoomParticipants(event.escrowId, { removeUnauthorized });
}

export default { syncChatRoomParticipants, handleEscrowParticipantChange };
