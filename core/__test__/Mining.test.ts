import { describe, expect, it, vi } from 'vitest';
import { Mining, normalizeMiningSeatSlots } from '../src/Mining.ts';

describe('Mining seat slot construction', () => {
  it('uses the next cohort size only for the upcoming auction slot', async () => {
    const api = {
      query: {
        miningSlot: {
          minersByCohort: {
            entries: vi.fn().mockResolvedValue([
              [createCohortKey(1), [createMember('miner-1'), createMember('miner-2')]],
              [createCohortKey(13), [createMember('miner-3')]],
            ]),
          },
          bidsForNextSlotCohort: vi.fn().mockResolvedValue([createBid(13, 'bidder-1')]),
          nextCohortSize: vi.fn().mockResolvedValue(createNumberLike(17)),
          nextFrameId: vi.fn().mockResolvedValue(createNumberLike(13)),
        },
      },
    };

    const slots = await Mining.fetchMiningSeats('managed-account', api as any);
    const slotsById = new Map(slots.map(slot => [slot.slotId, slot]));

    expect(slotsById.get(1)?.seats).toHaveLength(10);
    expect(slotsById.get(3)?.seats).toHaveLength(17);
    expect(slotsById.get(7)?.seats).toHaveLength(10);
  });

  it('trims legacy empty seats to the ten-seat minimum outside the auction slot', () => {
    const occupiedSeat = { miner: { address: 'miner-1' }, bid: null };
    const emptySeat = { miner: null, bid: null };
    const legacySeats = [occupiedSeat, ...Array.from({ length: 16 }, () => emptySeat)];
    const slots = [
      { slotId: 0, seats: [...legacySeats] },
      { slotId: 1, seats: [...legacySeats] },
    ] as any;

    const normalized = normalizeMiningSeatSlots(slots, 0);

    expect(normalized.map(slot => slot.seats.length)).toEqual([17, 10]);
  });
});

function createNumberLike(value: number) {
  return { toNumber: () => value };
}

function createCohortKey(startingFrameId: number) {
  return { args: [createNumberLike(startingFrameId)] };
}

function createMember(address: string) {
  return {
    accountId: { toHuman: () => address },
    externalFundingAccount: { value: { toHuman: () => 'managed-account' } },
    bid: { toBigInt: () => 100n },
  };
}

function createBid(startingFrameId: number, address: string) {
  return {
    startingFrameId: createNumberLike(startingFrameId),
    accountId: { toHuman: () => address },
    bid: { toBigInt: () => 200n },
  };
}
