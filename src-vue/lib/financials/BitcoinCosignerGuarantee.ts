import type { BitcoinFission } from '@argonprotocol/apps-core';
import type { IBitcoinSecuritizationTerm } from '../../interfaces/IBitcoinSecuritizationTerm.ts';

export type IBitcoinCosignerGuaranteeAllocation = {
  costByLiquidId: Map<number, bigint>;
  incompleteLiquidIds: Set<number>;
  unallocatedCost: bigint;
};

type AvailableSatoshis = {
  amount: bigint;
  idleSince: number;
};

type ActiveSatoshis = {
  liquidId: number;
  startedAt: number;
  lots: AvailableSatoshis[];
};

export function allocateBitcoinCosignerGuaranteeCosts(args: {
  terms: readonly IBitcoinSecuritizationTerm[];
  fissions: readonly BitcoinFission[];
}): IBitcoinCosignerGuaranteeAllocation {
  const costByLiquidId = new Map<number, bigint>();
  const incompleteLiquidIds = new Set<number>();
  const incompleteLockIds = new Set<number>();
  let unallocatedCost = 0n;
  const fissionsByLockId = new Map<number, BitcoinFission[]>();
  for (const fission of args.fissions) {
    if (
      (fission.ratchetNumber ?? 0) > 0 &&
      !fission.ratchets?.some(
        ratchet => ratchet.source === 'fission' && ratchet.ratchetNumber === fission.ratchetNumber,
      )
    ) {
      incompleteLiquidIds.add(fission.liquidId);
    }
    const directFee = fission.ratchets?.reduce((total, ratchet) => total + (ratchet.netSecurityFee ?? 0n), 0n) ?? 0n;
    if (directFee > 0n) costByLiquidId.set(fission.liquidId, (costByLiquidId.get(fission.liquidId) ?? 0n) + directFee);
    const fissions = fissionsByLockId.get(fission.lockId) ?? [];
    fissions.push(fission);
    fissionsByLockId.set(fission.lockId, fissions);
  }
  const termsByLockId = new Map<number, IBitcoinSecuritizationTerm[]>();
  for (const term of args.terms) {
    const terms = termsByLockId.get(term.lockId) ?? [];
    terms.push(term);
    termsByLockId.set(term.lockId, terms);
  }

  for (const [lockId, fissions] of fissionsByLockId) {
    const terms = termsByLockId.get(lockId);
    if (!terms?.length) {
      for (const fission of fissions) incompleteLiquidIds.add(fission.liquidId);
      incompleteLockIds.add(lockId);
      continue;
    }

    if (fissions.some(fission => !fission.hasCompleteRepaymentHistory)) {
      incompleteLockIds.add(lockId);
      for (const fission of fissions) incompleteLiquidIds.add(fission.liquidId);
      continue;
    }

    const orderedTerms = [...terms].sort((left, right) => left.termIndex - right.termIndex);
    const hasCompleteTermSequence = orderedTerms.every((term, index) => term.termIndex === index);
    let hasMissingOpeningTerm = !hasCompleteTermSequence;
    for (const fission of fissions) {
      if (fission.createdAtTick == null) {
        hasMissingOpeningTerm = true;
        continue;
      }
      const hasOpeningTerm = terms.some(term => {
        return (
          term.startTick <= fission.createdAtTick! && (term.endTick == null || fission.createdAtTick! < term.endTick)
        );
      });
      if (!hasOpeningTerm) hasMissingOpeningTerm = true;
    }
    if (hasMissingOpeningTerm) {
      incompleteLockIds.add(lockId);
      for (const fission of fissions) incompleteLiquidIds.add(fission.liquidId);
    }
  }

  for (const [lockId, terms] of termsByLockId) {
    const fissions = fissionsByLockId.get(lockId) ?? [];
    if (incompleteLockIds.has(lockId)) {
      unallocatedCost += terms.reduce((total, term) => total + term.addedNetSecurityFee, 0n);
      continue;
    }
    const hasMissingTicks = fissions.some(
      fission => fission.createdAtTick == null || (fission.closedAtArgonBlock != null && fission.closedAtTick == null),
    );
    if (hasMissingTicks) {
      for (const fission of fissions) incompleteLiquidIds.add(fission.liquidId);
      unallocatedCost += terms.reduce((total, term) => total + term.addedNetSecurityFee, 0n);
      continue;
    }

    for (const term of [...terms].sort((left, right) => left.termIndex - right.termIndex)) {
      const result = allocateTerm(term, fissions);

      for (const [liquidId, cost] of result.costByLiquidId) {
        costByLiquidId.set(liquidId, (costByLiquidId.get(liquidId) ?? 0n) + cost);
      }
      unallocatedCost += result.unallocatedCost;
    }
  }

  return { costByLiquidId, incompleteLiquidIds, unallocatedCost };
}

function allocateTerm(
  term: IBitcoinSecuritizationTerm,
  fissions: readonly BitcoinFission[],
): Pick<IBitcoinCosignerGuaranteeAllocation, 'costByLiquidId' | 'unallocatedCost'> {
  const eventTicks = fissions.flatMap(fission => [
    fission.createdAtTick,
    fission.closedAtTick,
    fission.lastRatchetTick,
    ...(fission.ratchets ?? []).map(ratchet => ratchet.tick),
    ...(fission.repayments ?? []).map(repayment => repayment.tick),
  ]);
  const latestEventTick = Math.max(
    term.startTick,
    ...eventTicks.filter((tick): tick is number => {
      return tick != null && tick >= term.startTick && (term.endTick == null || tick <= term.endTick);
    }),
  );
  const observationTick = term.endTick ?? latestEventTick;
  const endTick = observationTick === term.startTick ? term.startTick + 1 : observationTick;
  const duration = endTick - term.startTick;
  if (term.securitizedSatoshis <= 0n) {
    return { costByLiquidId: new Map(), unallocatedCost: term.addedNetSecurityFee };
  }

  const overlapping = fissions.filter(fission => {
    const opensBeforeTermEnds = term.endTick == null || fission.createdAtTick! < term.endTick;
    return (
      opensBeforeTermEnds &&
      fission.createdAtTick! <= observationTick &&
      (fission.closedAtTick == null || fission.closedAtTick > term.startTick)
    );
  });
  const available: AvailableSatoshis[] = [{ amount: term.securitizedSatoshis, idleSince: term.startTick }];
  const active = new Map<number, ActiveSatoshis>();
  const weightByLiquidId = new Map<number, bigint>();
  const addWeight = (liquidId: number, amount: bigint, ticks: number) => {
    if (ticks <= 0 || amount <= 0n) return;
    weightByLiquidId.set(liquidId, (weightByLiquidId.get(liquidId) ?? 0n) + amount * BigInt(ticks));
  };
  const open = (fission: BitcoinFission, tick: number) => {
    const repayments = fission.repayments ?? [];
    const repaid = repayments.reduce((sum, repayment) => sum + repayment.satoshis, 0n);
    let remaining = fission.initialSatoshis ?? fission.satoshis + repaid;
    for (const repayment of repayments) {
      if (repayment.tick <= tick) remaining -= repayment.satoshis;
    }
    const lots: AvailableSatoshis[] = [];
    // A Fission's Bitcoin can exceed the slice paid for by this Lock purchase.
    while (remaining > 0n && available.length > 0) {
      const source = available[0];
      const amount = source.amount < remaining ? source.amount : remaining;
      addWeight(fission.liquidId, amount, tick - source.idleSince);
      lots.push({ amount, idleSince: tick });
      source.amount -= amount;
      remaining -= amount;
      if (source.amount === 0n) available.shift();
    }
    active.set(fission.fissionId, { liquidId: fission.liquidId, startedAt: tick, lots });
  };
  const release = (fission: BitcoinFission, tick: number, amount?: bigint) => {
    const allocation = active.get(fission.fissionId);
    if (!allocation) return;
    let remaining = amount ?? allocation.lots.reduce((sum, lot) => sum + lot.amount, 0n);
    for (const lot of allocation.lots) {
      if (remaining === 0n) break;
      const returned = lot.amount < remaining ? lot.amount : remaining;
      addWeight(allocation.liquidId, returned, tick - allocation.startedAt);
      available.push({ amount: returned, idleSince: tick });
      lot.amount -= returned;
      remaining -= returned;
    }
    allocation.lots = allocation.lots.filter(lot => lot.amount > 0n);
    if (!allocation.lots.length) active.delete(fission.fissionId);
  };

  const activeAtStart = overlapping
    .filter(
      fission =>
        fission.createdAtTick! <= term.startTick &&
        (fission.closedAtTick == null || fission.closedAtTick > term.startTick),
    )
    .sort((left, right) => left.fissionId - right.fissionId);
  for (const fission of activeAtStart) open(fission, term.startTick);

  const repaymentSteps = overlapping.flatMap(fission => {
    const repayments = fission.repayments ?? [];
    const repaid = repayments.reduce((sum, repayment) => sum + repayment.satoshis, 0n);
    let satoshisBefore = fission.initialSatoshis ?? fission.satoshis + repaid;

    return repayments.map(repayment => {
      const step = { fission, repayment, satoshisBefore };
      satoshisBefore -= repayment.satoshis;
      return step;
    });
  });

  const ticks = new Set<number>();
  for (const fission of overlapping) {
    for (const repayment of fission.repayments ?? []) {
      if (repayment.tick > term.startTick && repayment.tick <= observationTick) ticks.add(repayment.tick);
    }
    if (fission.createdAtTick! > term.startTick && fission.createdAtTick! <= observationTick) {
      ticks.add(fission.createdAtTick!);
    }
    if (
      fission.closedAtTick != null &&
      fission.closedAtTick > term.startTick &&
      fission.closedAtTick <= observationTick
    ) {
      ticks.add(fission.closedAtTick);
    }
  }
  for (const tick of [...ticks].sort((left, right) => left - right)) {
    for (const { fission, repayment, satoshisBefore } of repaymentSteps) {
      if (repayment.tick !== tick) continue;
      const allocation = active.get(fission.fissionId);
      if (!allocation) continue;

      const allocated = allocation.lots.reduce((sum, lot) => sum + lot.amount, 0n);
      const returned = (allocated * repayment.satoshis) / satoshisBefore;
      release(fission, tick, returned);
    }
    for (const fission of overlapping
      .filter(candidate => candidate.closedAtTick === tick)
      .sort((left, right) => left.fissionId - right.fissionId)) {
      release(fission, tick);
    }
    for (const fission of overlapping
      .filter(candidate => candidate.createdAtTick === tick)
      .sort((left, right) => left.fissionId - right.fissionId)) {
      open(fission, tick);
    }
  }
  for (const fission of overlapping) release(fission, endTick);

  const denominator = term.securitizedSatoshis * BigInt(duration);
  const assignedWeight = [...weightByLiquidId.values()].reduce((total, weight) => total + weight, 0n);
  const allocatedCost = (term.addedNetSecurityFee * assignedWeight) / denominator;
  const shares = [...weightByLiquidId].map(([liquidId, weight]) => ({
    liquidId,
    cost: (term.addedNetSecurityFee * weight) / denominator,
    remainder: (term.addedNetSecurityFee * weight) % denominator,
  }));
  let remainder = allocatedCost - shares.reduce((total, share) => total + share.cost, 0n);
  shares.sort((left, right) => {
    if (left.remainder === right.remainder) return left.liquidId - right.liquidId;
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (const share of shares) {
    if (remainder === 0n) break;
    share.cost += 1n;
    remainder -= 1n;
  }

  return {
    costByLiquidId: new Map(shares.map(share => [share.liquidId, share.cost])),
    unallocatedCost: term.addedNetSecurityFee - allocatedCost,
  };
}
