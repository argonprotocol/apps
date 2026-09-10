import { numericToAlpha, type IMiningSlot } from '@argonprotocol/apps-core';
import type { IMiningCohortFinancialRecord } from '../../src-vue/interfaces/db/ICohortFrameRecord.ts';

export const activeMiningSlots: IMiningSlot[] = Array.from({ length: 10 }, (_, slotId) => ({
  slotId,
  seats: Array.from({ length: 10 }, (_, seatIndex) => {
    const index = slotId * 10 + seatIndex;
    const startingFrameId = slotId === 0 ? 120 : 110 + slotId;

    return {
      id: `${numericToAlpha(slotId)}${seatIndex + 1}`,
      index: seatIndex,
      slotId,
      miner: {
        startingFrameId,
        address: `5SyntheticActiveMiner${index.toString().padStart(3, '0')}`,
        isOurs: true,
        bidAmount: 573_000_000n + BigInt(index % 8) * 1_000_000n,
        micronotsStaked: 390_740_000n,
      },
      bid: null,
    };
  }),
}));

export const activeMiningCohorts: IMiningCohortFinancialRecord[] = Array.from({ length: 10 }, (_, slotId) => {
  const id = slotId === 0 ? 120 : 110 + slotId;
  const timestamp = new Date(Date.UTC(2026, 7, id - 100)).toISOString();

  return {
    id,
    progress: id === 120 ? 6.2 : Math.min((120 - id) * 10 + 6.2, 100),
    transactionFeesTotal: 2_500_000n,
    micronotsStakedPerSeat: 390_740_000n,
    microgonsBidPerSeat: 573_000_000n + BigInt(slotId) * 1_000_000n,
    seatCountWon: 10,
    microgonsToBeMinedPerSeat: 420_000_000n,
    micronotsToBeMinedPerSeat: 80_000_000n,
    argonotPriceAtBid: 14_000_000n,
    micronotsMinedTotal: 265_000_000n + BigInt(slotId) * 18_000_000n,
    microgonsMinedTotal: 1_400_000_000n + BigInt(slotId) * 100_000_000n,
    microgonsMintedTotal: 400_000_000n + BigInt(slotId) * 20_000_000n,
    microgonFeesCollectedTotal: 40_000_000n + BigInt(slotId) * 5_000_000n,
    closingArgonotPrice: 0n,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
});
