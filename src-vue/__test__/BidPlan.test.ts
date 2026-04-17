import { describe, expect, it } from 'vitest';
import { planBid, type IBidPlanSubaccount } from '@argonprotocol/apps-core';

const subaccounts: IBidPlanSubaccount[] = [
  { address: 'A', index: 0, isRebid: true },
  { address: 'B', index: 1, isRebid: true },
  { address: 'C', index: 2, isRebid: false },
  { address: 'D', index: 3, isRebid: false },
];

const myWinningBids = [
  { address: 'A', bidMicrogons: 100n, micronotsStaked: 10n },
  { address: 'B', bidMicrogons: 90n, micronotsStaked: 10n },
];

const allWinningBids = [
  ...myWinningBids,
  { address: 'X', bidMicrogons: 80n, micronotsStaked: 10n },
  { address: 'Y', bidMicrogons: 70n, micronotsStaked: 10n },
];

describe('planBid', () => {
  it('keeps higher bids and replaces lower bids before adding new accounts', () => {
    const result = planBid({
      microgonsPerSeat: 95n,
      seats: 3,
      nextCohortSize: 4,
      micronotsPerSeat: 10n,
      accountBalance: 100n,
      accountMicronots: 10n,
      feeEstimate: 0n,
      tip: 0n,
      allWinningBids,
      myWinningBids,
      subaccounts,
    });

    expect(result.canSubmit).toBe(true);
    expect(result.alreadyWinningSeats).toBe(1);
    expect(result.replacedBids.map(x => x.address)).toEqual(['B']);
    expect(result.newAccounts.map(x => x.address)).toEqual(['C']);
    expect(result.accountsToBidWith.map(x => x.address)).toEqual(['B', 'C']);
    expect(result.seatsAfterBid).toBe(3);
  });

  it('computes argonot shortfalls for new seats', () => {
    const result = planBid({
      microgonsPerSeat: 95n,
      seats: 3,
      nextCohortSize: 4,
      micronotsPerSeat: 10n,
      accountBalance: 100n,
      accountMicronots: 5n,
      feeEstimate: 0n,
      tip: 0n,
      allWinningBids,
      myWinningBids,
      subaccounts,
    });

    expect(result.canSubmit).toBe(false);
    expect(result.reason).toBe('insufficient-argonot-balance');
    expect(result.additionalMicronotsNeeded).toBe(5n);
    expect(result.seatsAfterBid).toBe(2);
  });

  it('rejects requests that would reduce current winning seats', () => {
    const result = planBid({
      microgonsPerSeat: 95n,
      seats: 1,
      nextCohortSize: 4,
      micronotsPerSeat: 10n,
      accountBalance: 100n,
      accountMicronots: 100n,
      feeEstimate: 0n,
      tip: 0n,
      allWinningBids,
      myWinningBids,
      subaccounts,
    });

    expect(result.canSubmit).toBe(false);
    expect(result.reason).toBe('seat-reduction');
    expect(result.currentWinningSeats).toBe(2);
  });

  it('rejects requests that would not change any active bids', () => {
    const result = planBid({
      microgonsPerSeat: 90n,
      seats: 2,
      nextCohortSize: 4,
      micronotsPerSeat: 10n,
      accountBalance: 100n,
      accountMicronots: 100n,
      feeEstimate: 0n,
      tip: 0n,
      allWinningBids,
      myWinningBids,
      subaccounts,
    });

    expect(result.canSubmit).toBe(false);
    expect(result.reason).toBe('no-op');
  });
});
