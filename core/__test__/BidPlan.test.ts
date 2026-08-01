import { describe, expect, it, vi } from 'vitest';
import { planBid, planBidWithFeeEstimate, type IBidPlanSubaccount } from '../src/BidPlan.ts';

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

    expect(result.replacedBids.map(x => x.address)).toEqual(['B']);
    expect(result.accountsToBidWith.map(x => x.address)).toEqual(['B', 'C']);
    expect(result.seatsAfterBid).toBe(3);
  });

  it('returns the affordable partial plan with its argonot shortfall', () => {
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

    expect(result.reason).toBe('insufficient-argonot-balance');
    expect(result.accountsToBidWith.map(x => x.address)).toEqual(['B']);
    expect(result.seatsAfterBid).toBe(2);
  });

  it('rejects a plan that would reduce current winning seats', () => {
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

    expect(result.reason).toBe('seat-reduction');
  });

  it('rejects a plan that would not change any active bids', () => {
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

    expect(result.reason).toBe('no-op');
  });

  it('uses one conservative fee estimate when the fee reduces the plan', async () => {
    const estimateFee = vi.fn().mockResolvedValue(100n);
    const result = await planBidWithFeeEstimate({
      microgonsPerSeat: 95n,
      seats: 4,
      nextCohortSize: 5,
      micronotsPerSeat: 10n,
      accountBalance: 200n,
      accountMicronots: 100n,
      tip: 0n,
      allWinningBids,
      myWinningBids,
      subaccounts,
      estimateFee,
    });

    expect(estimateFee).toHaveBeenCalledOnce();
    expect(estimateFee.mock.calls[0][0]).toHaveLength(3);
    expect(result.feeEstimate).toBe(100n);
    expect(result.plan.accountsToBidWith).toHaveLength(2);
  });

  it('only reuses the balance from lower bids that remain in the affordable plan', () => {
    const lowerOwnBids = [
      { address: 'A', bidMicrogons: 90n, micronotsStaked: 10n },
      { address: 'B', bidMicrogons: 90n, micronotsStaked: 10n },
    ];
    const result = planBid({
      microgonsPerSeat: 100n,
      seats: 2,
      nextCohortSize: 2,
      micronotsPerSeat: 10n,
      accountBalance: 0n,
      accountMicronots: 0n,
      feeEstimate: 0n,
      tip: 0n,
      allWinningBids: lowerOwnBids,
      myWinningBids: lowerOwnBids,
      subaccounts,
    });

    expect(result.reason).toBe('insufficient-argon-balance');
    expect(result.accountsToBidWith).toHaveLength(0);
    expect(result.seatsAfterBid).toBe(0);
  });
});
