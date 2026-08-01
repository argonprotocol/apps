import type { Accountset } from './Accountset.js';
import { bigIntMax } from './utils.js';

export type IBidPlanReason =
  | 'invalid-bid-amount'
  | 'invalid-seat-count'
  | 'seat-reduction'
  | 'no-op'
  | 'max-bid-too-low'
  | 'insufficient-bidding-accounts'
  | 'insufficient-argon-balance'
  | 'insufficient-argonot-balance';

export interface IBidPlanBid {
  address: string;
  bidMicrogons: bigint;
  micronotsStaked: bigint;
}

export type IBidPlanSubaccount = Awaited<ReturnType<Accountset['getAvailableMinerAccounts']>>[number];

export interface IBidPlanInput {
  microgonsPerSeat: bigint;
  seats: number;
  nextCohortSize: number;
  micronotsPerSeat: bigint;
  accountBalance: bigint;
  accountMicronots: bigint;
  feeEstimate: bigint;
  tip: bigint;
  allWinningBids: IBidPlanBid[];
  myWinningBids: IBidPlanBid[];
  subaccounts: IBidPlanSubaccount[];
}

export interface IBidPlan {
  reason?: IBidPlanReason;
  seatsAfterBid: number;
  replacedBids: IBidPlanBid[];
  accountsToBidWith: IBidPlanSubaccount[];
}

export interface IBidPlanWithFeeEstimateInput extends Omit<IBidPlanInput, 'feeEstimate'> {
  estimateFee(subaccounts: IBidPlanSubaccount[], bidAmount: bigint, tip: bigint): Promise<bigint>;
}

export interface IBidPlanWithFeeEstimateResult {
  plan: IBidPlan;
  feeEstimate: bigint;
  availableBalanceForBids: bigint;
  availableMicronots: bigint;
}

export async function planBidWithFeeEstimate(
  input: IBidPlanWithFeeEstimateInput,
): Promise<IBidPlanWithFeeEstimateResult> {
  const myWinningAddresses = new Set(input.myWinningBids.map(x => x.address));
  const sortedSubaccounts = sortBidderSubaccounts(input.subaccounts, myWinningAddresses);
  const initialPlan = planBidWithSortedSubaccounts(
    {
      ...input,
      feeEstimate: 0n,
    },
    sortedSubaccounts,
  );
  const feeEstimate = await input.estimateFee(initialPlan.accountsToBidWith, input.microgonsPerSeat, input.tip);
  const plan = planBidWithSortedSubaccounts(
    {
      ...input,
      feeEstimate,
    },
    sortedSubaccounts,
  );

  const reusableMicrogons = plan.replacedBids.reduce((sum, bid) => sum + bid.bidMicrogons, 0n);
  const reusableMicronots = plan.replacedBids.reduce((sum, bid) => sum + bid.micronotsStaked, 0n);

  return {
    plan,
    feeEstimate,
    availableBalanceForBids: bigIntMax(input.accountBalance + reusableMicrogons - feeEstimate - input.tip, 0n),
    availableMicronots: bigIntMax(input.accountMicronots + reusableMicronots, 0n),
  };
}

export function planBid(input: IBidPlanInput): IBidPlan {
  const myWinningAddresses = new Set(input.myWinningBids.map(x => x.address));
  const sortedSubaccounts = sortBidderSubaccounts(input.subaccounts, myWinningAddresses);
  return planBidWithSortedSubaccounts(input, sortedSubaccounts);
}

function planBidWithSortedSubaccounts(input: IBidPlanInput, sortedSubaccounts: IBidPlanSubaccount[]): IBidPlan {
  const {
    accountBalance,
    accountMicronots,
    allWinningBids,
    feeEstimate,
    microgonsPerSeat,
    micronotsPerSeat,
    myWinningBids,
    nextCohortSize,
    seats,
    tip,
  } = input;
  const keptBids = myWinningBids.filter(x => x.bidMicrogons >= microgonsPerSeat);
  const currentWinningSeats = myWinningBids.length;
  const alreadyWinningSeats = keptBids.length;
  const requestedAdditionalSeats = Math.max(0, seats - alreadyWinningSeats);

  if (microgonsPerSeat <= 0n) {
    return createRejectedPlan('invalid-bid-amount', alreadyWinningSeats);
  }
  if (seats <= 0) {
    return createRejectedPlan('invalid-seat-count', alreadyWinningSeats);
  }
  if (seats < currentWinningSeats) {
    return createRejectedPlan('seat-reduction', alreadyWinningSeats);
  }

  const keptAddresses = new Set(keptBids.map(x => x.address));
  const lowerWinningBidsByAddress = new Map(
    myWinningBids.filter(x => x.bidMicrogons < microgonsPerSeat).map(x => [x.address, x]),
  );
  const accountsEligibleForBid = sortedSubaccounts.filter(x => !keptAddresses.has(x.address));
  const emptyBids = Math.max(0, nextCohortSize - allWinningBids.length);
  const bidsToReplace = allWinningBids.filter(x => x.bidMicrogons < microgonsPerSeat).length;
  const availableBidSlots = bidsToReplace + emptyBids;
  const targetAdditionalSeats = Math.min(requestedAdditionalSeats, availableBidSlots, accountsEligibleForBid.length);
  let targetSeatReason: IBidPlanReason | undefined;
  if (targetAdditionalSeats < requestedAdditionalSeats) {
    targetSeatReason =
      availableBidSlots < requestedAdditionalSeats ? 'max-bid-too-low' : 'insufficient-bidding-accounts';
  }
  const targetAccounts = accountsEligibleForBid.slice(0, targetAdditionalSeats);
  if (requestedAdditionalSeats === 0) {
    return createRejectedPlan('no-op', alreadyWinningSeats);
  }

  let remainingBalance = accountBalance - feeEstimate - tip;
  let remainingMicronots = accountMicronots;
  let hasArgonShortfall = remainingBalance < 0n;
  let hasArgonotShortfall = false;
  const accountsToBidWith: IBidPlanSubaccount[] = [];

  for (const account of targetAccounts) {
    const replacedBid = lowerWinningBidsByAddress.get(account.address);
    const requiredMicrogons = microgonsPerSeat - (replacedBid?.bidMicrogons ?? 0n);
    const requiredMicronots = bigIntMax(micronotsPerSeat - (replacedBid?.micronotsStaked ?? 0n), 0n);

    if (remainingBalance < requiredMicrogons) {
      hasArgonShortfall = true;
      continue;
    }
    if (remainingMicronots < requiredMicronots) {
      hasArgonotShortfall = true;
      continue;
    }

    accountsToBidWith.push(account);
    remainingBalance -= requiredMicrogons;
    remainingMicronots -= requiredMicronots;
  }
  const replacedBids = accountsToBidWith
    .map(x => lowerWinningBidsByAddress.get(x.address))
    .filter((x): x is IBidPlanBid => !!x);

  if (accountsToBidWith.length < requestedAdditionalSeats) {
    let reason = targetSeatReason;
    if (hasArgonotShortfall) {
      reason = 'insufficient-argonot-balance';
    }
    if (hasArgonShortfall) {
      reason = 'insufficient-argon-balance';
    }

    return {
      reason,
      seatsAfterBid: alreadyWinningSeats + accountsToBidWith.length,
      replacedBids,
      accountsToBidWith,
    };
  }

  return {
    seatsAfterBid: alreadyWinningSeats + accountsToBidWith.length,
    replacedBids,
    accountsToBidWith,
  };
}

function createRejectedPlan(reason: IBidPlanReason, seatsAfterBid: number): IBidPlan {
  return {
    reason,
    seatsAfterBid,
    replacedBids: [],
    accountsToBidWith: [],
  };
}

function sortBidderSubaccounts(
  subaccounts: IBidPlanSubaccount[],
  myWinningAddresses: Set<string>,
): IBidPlanSubaccount[] {
  return [...subaccounts].sort((a, b) => {
    const isWinningA = myWinningAddresses.has(a.address);
    const isWinningB = myWinningAddresses.has(b.address);
    if (isWinningA && !isWinningB) return -1;
    if (!isWinningA && isWinningB) return 1;
    if (a.isRebid && !b.isRebid) return -1;
    if (!a.isRebid && b.isRebid) return 1;
    return a.index - b.index;
  });
}
