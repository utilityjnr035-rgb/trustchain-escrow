/**
 * chatRoomResync.test.js — Issue #194
 *
 * Unit tests for chatRoomResyncService.
 *
 * Coverage:
 *  1. Adds missing participants (client, freelancer, arbiter)
 *  2. Does not re-add existing participants
 *  3. Removes unauthorized participants when removeUnauthorized = true
 *  4. Does not remove unauthorized participants when removeUnauthorized = false
 *  5. Role change triggers an update
 *  6. Handles escrow-not-found gracefully
 *  7. handleEscrowParticipantChange triggers resync with correct options
 *  8. ARBITER_REMOVED event sets removeUnauthorized = true
 *  9. DISPUTE_RAISED event syncs arbiter access
 * 10. Participants absent from DB are added idempotently on repeated calls
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const logMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../config/logger.js', () => ({
  createModuleLogger: () => logMock,
}));

const prismaMock = {
  escrow: {
    findUnique: jest.fn(),
  },
  chatRoomParticipant: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};
jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));

// ── Import SUT after mocks ────────────────────────────────────────────────────

const {
  syncChatRoomParticipants,
  handleEscrowParticipantChange,
  ROLE_CLIENT,
  ROLE_FREELANCER,
  ROLE_ARBITER,
} = await import('../services/chatRoomResyncService.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT = 'GCLIENT000000000000000000000000000000000000000000000000';
const FREELANCER = 'GFREELANCER0000000000000000000000000000000000000000000';
const ARBITER = 'GARBITER000000000000000000000000000000000000000000000000';
const STRANGER = 'GSTRANGER00000000000000000000000000000000000000000000000';

const ESCROW_ID = 42n;

function makeEscrow(overrides = {}) {
  return {
    clientAddress: CLIENT,
    freelancerAddress: FREELANCER,
    arbiterAddress: ARBITER,
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.chatRoomParticipant.upsert.mockResolvedValue({});
  prismaMock.chatRoomParticipant.update.mockResolvedValue({});
  prismaMock.chatRoomParticipant.delete.mockResolvedValue({});
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('syncChatRoomParticipants', () => {
  // ── 1. Adds missing participants ──────────────────────────────────────────

  it('adds client, freelancer, and arbiter when room is empty', async () => {
    prismaMock.escrow.findUnique.mockResolvedValue(makeEscrow());
    prismaMock.chatRoomParticipant.findMany.mockResolvedValue([]);

    const result = await syncChatRoomParticipants(ESCROW_ID);

    expect(prismaMock.chatRoomParticipant.upsert).toHaveBeenCalledTimes(3);
    expect(result.added).toBe(3);
    expect(result.removed).toBe(0);
    expect(result.unchanged).toBe(0);
  });

  // ── 2. Does not re-add existing participants ──────────────────────────────

  it('does not upsert participants already present with the correct role', async () => {
    prismaMock.escrow.findUnique.mockResolvedValue(makeEscrow());
    prismaMock.chatRoomParticipant.findMany.mockResolvedValue([
      { address: CLIENT, role: ROLE_CLIENT },
      { address: FREELANCER, role: ROLE_FREELANCER },
      { address: ARBITER, role: ROLE_ARBITER },
    ]);

    const result = await syncChatRoomParticipants(ESCROW_ID);

    expect(prismaMock.chatRoomParticipant.upsert).not.toHaveBeenCalled();
    expect(result.unchanged).toBe(3);
    expect(result.added).toBe(0);
  });

  // ── 3. Removes unauthorized participants when policy allows ───────────────

  it('removes stranger when removeUnauthorized = true', async () => {
    prismaMock.escrow.findUnique.mockResolvedValue(makeEscrow());
    prismaMock.chatRoomParticipant.findMany.mockResolvedValue([
      { address: CLIENT, role: ROLE_CLIENT },
      { address: FREELANCER, role: ROLE_FREELANCER },
      { address: ARBITER, role: ROLE_ARBITER },
      { address: STRANGER, role: 'unknown' }, // unauthorized interloper
    ]);

    const result = await syncChatRoomParticipants(ESCROW_ID, { removeUnauthorized: true });

    expect(prismaMock.chatRoomParticipant.delete).toHaveBeenCalledWith({
      where: { escrowId_address: { escrowId: ESCROW_ID, address: STRANGER } },
    });
    expect(result.removed).toBe(1);
  });

  // ── 4. Does NOT remove unauthorized participants by default ───────────────

  it('leaves stranger untouched when removeUnauthorized = false (default)', async () => {
    prismaMock.escrow.findUnique.mockResolvedValue(makeEscrow());
    prismaMock.chatRoomParticipant.findMany.mockResolvedValue([
      { address: CLIENT, role: ROLE_CLIENT },
      { address: STRANGER, role: 'unknown' },
    ]);

    const result = await syncChatRoomParticipants(ESCROW_ID);

    expect(prismaMock.chatRoomParticipant.delete).not.toHaveBeenCalled();
    expect(result.removed).toBe(0);
  });

  // ── 5. Role change triggers an update ────────────────────────────────────

  it('updates role when participant exists with a stale role', async () => {
    prismaMock.escrow.findUnique.mockResolvedValue(makeEscrow());
    // Arbiter exists but with wrong role
    prismaMock.chatRoomParticipant.findMany.mockResolvedValue([
      { address: CLIENT, role: ROLE_CLIENT },
      { address: FREELANCER, role: ROLE_FREELANCER },
      { address: ARBITER, role: 'stale_role' }, // role mismatch
    ]);

    const result = await syncChatRoomParticipants(ESCROW_ID);

    expect(prismaMock.chatRoomParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { role: ROLE_ARBITER },
      }),
    );
    // Role update counted as a meaningful change
    expect(result.added).toBeGreaterThan(0);
  });

  // ── 6. Escrow not found — returns zeros and logs warning ─────────────────

  it('returns { added:0, removed:0, unchanged:0 } when escrow does not exist', async () => {
    prismaMock.escrow.findUnique.mockResolvedValue(null);

    const result = await syncChatRoomParticipants(999n);

    expect(result).toEqual({ added: 0, removed: 0, unchanged: 0 });
    expect(prismaMock.chatRoomParticipant.upsert).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'chat_resync_escrow_not_found' }),
    );
  });

  // ── 7. No arbiter on escrow — only client and freelancer added ────────────

  it('only adds client and freelancer when escrow has no arbiter', async () => {
    prismaMock.escrow.findUnique.mockResolvedValue(
      makeEscrow({ arbiterAddress: null }),
    );
    prismaMock.chatRoomParticipant.findMany.mockResolvedValue([]);

    const result = await syncChatRoomParticipants(ESCROW_ID);

    expect(prismaMock.chatRoomParticipant.upsert).toHaveBeenCalledTimes(2);
    expect(result.added).toBe(2);
  });

  // ── 8. Idempotent on repeated calls ──────────────────────────────────────

  it('is idempotent — second call does nothing when participants are already synced', async () => {
    prismaMock.escrow.findUnique.mockResolvedValue(makeEscrow());
    prismaMock.chatRoomParticipant.findMany
      .mockResolvedValueOnce([]) // first call: empty room
      .mockResolvedValueOnce([   // second call: fully synced room
        { address: CLIENT, role: ROLE_CLIENT },
        { address: FREELANCER, role: ROLE_FREELANCER },
        { address: ARBITER, role: ROLE_ARBITER },
      ]);
    prismaMock.chatRoomParticipant.upsert.mockResolvedValue({});

    // First sync populates participants
    await syncChatRoomParticipants(ESCROW_ID);

    // Second sync should find everything already up-to-date
    const secondResult = await syncChatRoomParticipants(ESCROW_ID);
    expect(secondResult.added).toBe(0);
    expect(secondResult.unchanged).toBe(3);
  });
});

// ── handleEscrowParticipantChange ─────────────────────────────────────────────

describe('handleEscrowParticipantChange', () => {
  // ── 9. ESCROW_FUNDED triggers resync without removal ─────────────────────

  it('ESCROW_FUNDED triggers syncChatRoomParticipants with removeUnauthorized=false', async () => {
    prismaMock.escrow.findUnique.mockResolvedValue(makeEscrow());
    prismaMock.chatRoomParticipant.findMany.mockResolvedValue([]);

    await handleEscrowParticipantChange({ type: 'ESCROW_FUNDED', escrowId: ESCROW_ID });

    // Upsert called for each participant (no delete)
    expect(prismaMock.chatRoomParticipant.upsert).toHaveBeenCalled();
    expect(prismaMock.chatRoomParticipant.delete).not.toHaveBeenCalled();
  });

  // ── 10. ARBITER_REMOVED sets removeUnauthorized = true ───────────────────

  it('ARBITER_REMOVED triggers resync with removeUnauthorized=true', async () => {
    // After removal, arbiter is no longer on the escrow
    prismaMock.escrow.findUnique.mockResolvedValue(
      makeEscrow({ arbiterAddress: null }),
    );
    prismaMock.chatRoomParticipant.findMany.mockResolvedValue([
      { address: CLIENT, role: ROLE_CLIENT },
      { address: FREELANCER, role: ROLE_FREELANCER },
      { address: ARBITER, role: ROLE_ARBITER }, // stale — should be removed
    ]);

    await handleEscrowParticipantChange({ type: 'ARBITER_REMOVED', escrowId: ESCROW_ID });

    expect(prismaMock.chatRoomParticipant.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { escrowId_address: { escrowId: ESCROW_ID, address: ARBITER } },
      }),
    );
  });

  // ── 11. DISPUTE_RAISED event adds arbiter access ─────────────────────────

  it('DISPUTE_RAISED syncs arbiter into the room', async () => {
    prismaMock.escrow.findUnique.mockResolvedValue(makeEscrow());
    // Room initially has only client and freelancer (arbiter not yet added)
    prismaMock.chatRoomParticipant.findMany.mockResolvedValue([
      { address: CLIENT, role: ROLE_CLIENT },
      { address: FREELANCER, role: ROLE_FREELANCER },
    ]);

    await handleEscrowParticipantChange({ type: 'DISPUTE_RAISED', escrowId: ESCROW_ID });

    // Arbiter must have been upserted
    const upsertCalls = prismaMock.chatRoomParticipant.upsert.mock.calls;
    const arbiterUpsert = upsertCalls.find((call) => call[0]?.create?.address === ARBITER);
    expect(arbiterUpsert).toBeDefined();
  });

  // ── 12. Missing escrowId logs a warning and does not crash ────────────────

  it('handles missing escrowId gracefully without throwing', async () => {
    await expect(handleEscrowParticipantChange({ type: 'ESCROW_FUNDED' })).resolves.not.toThrow();
    expect(logMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'chat_resync_missing_escrow_id' }),
    );
  });

  // ── 13. OWNERSHIP_TRANSFER sets removeUnauthorized = true ────────────────

  it('OWNERSHIP_TRANSFER triggers removal of stale participants', async () => {
    const NEW_CLIENT = 'GNEWCLIENT000000000000000000000000000000000000000000';
    prismaMock.escrow.findUnique.mockResolvedValue(
      makeEscrow({ clientAddress: NEW_CLIENT }),
    );
    prismaMock.chatRoomParticipant.findMany.mockResolvedValue([
      { address: CLIENT, role: ROLE_CLIENT }, // old client — should be removed
      { address: FREELANCER, role: ROLE_FREELANCER },
    ]);

    await handleEscrowParticipantChange({ type: 'OWNERSHIP_TRANSFER', escrowId: ESCROW_ID });

    expect(prismaMock.chatRoomParticipant.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { escrowId_address: { escrowId: ESCROW_ID, address: CLIENT } },
      }),
    );
  });
});
