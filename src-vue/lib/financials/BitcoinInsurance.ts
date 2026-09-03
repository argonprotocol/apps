import type { IBitcoinFission } from '@argonprotocol/apps-core';
import type { IBitcoinSecuritizationTerm } from '../../interfaces/IBitcoinSecuritizationTerm.ts';

export type IBitcoinInsuranceAllocation = {
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

export function allocateBitcoinInsuranceCosts(args: {
  terms: readonly IBitcoinSecuritizationTerm[];
  fissions: readonly IBitcoinFission[];
}): IBitcoinInsuranceAllocation {
  const costByLiquidId = new Map<number, bigint>();
  const incompleteLiquidIds = new Set<number>();
  let unallocatedCost = 0n;
  const fissionsByUtxoId = new Map<number, IBitcoinFission[]>();
  for (const fission of args.fissions) {
    const fissions = fissionsByUtxoId.get(fission.utxoId) ?? [];
    fissions.push(fission);
    fissionsByUtxoId.set(fission.utxoId, fissions);
  }
  const termsByUtxoId = new Map<number, IBitcoinSecuritizationTerm[]>();
  for (const term of args.terms) {
    const terms = termsByUtxoId.get(term.utxoId) ?? [];
    terms.push(term);
    termsByUtxoId.set(term.utxoId, terms);
  }

  for (const [utxoId, fissions] of fissionsByUtxoId) {
    const terms = termsByUtxoId.get(utxoId);
    if (!terms?.length) {
      for (const fission of fissions) incompleteLiquidIds.add(fission.liquidId);
      continue;
    }

    for (const fission of fissions) {
      if (fission.createdAtTick == null) continue;
      const hasOpeningTerm = terms.some(term => {
        return (
          term.startTick <= fission.createdAtTick! && (term.endTick == null || fission.createdAtTick! < term.endTick)
        );
      });
      if (!hasOpeningTerm) incompleteLiquidIds.add(fission.liquidId);
    }
  }

  for (const [utxoId, terms] of termsByUtxoId) {
    const fissions = fissionsByUtxoId.get(utxoId) ?? [];
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
      if (!result) {
        for (const fission of fissions) incompleteLiquidIds.add(fission.liquidId);
        unallocatedCost += term.addedNetSecurityFee;
        continue;
      }

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
  fissions: readonly IBitcoinFission[],
): Pick<IBitcoinInsuranceAllocation, 'costByLiquidId' | 'unallocatedCost'> | undefined {
  const eventTicks = fissions.flatMap(fission => [
    fission.createdAtTick,
    fission.closedAtTick,
    fission.lastRatchetTick,
    ...(fission.ratchets ?? []).map(ratchet => ratchet.tick),
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
  const open = (fission: IBitcoinFission, tick: number): boolean => {
    let remaining = fission.satoshis;
    const lots: AvailableSatoshis[] = [];
    while (remaining > 0n) {
      const source = available[0];
      if (!source) return false;

      const amount = source.amount < remaining ? source.amount : remaining;
      addWeight(fission.liquidId, amount, tick - source.idleSince);
      lots.push({ amount, idleSince: tick });
      source.amount -= amount;
      remaining -= amount;
      if (source.amount === 0n) available.shift();
    }
    active.set(fission.fissionId, { liquidId: fission.liquidId, startedAt: tick, lots });
    return true;
  };
  const close = (fission: IBitcoinFission, tick: number) => {
    const allocation = active.get(fission.fissionId);
    if (!allocation) return;
    for (const lot of allocation.lots) {
      addWeight(allocation.liquidId, lot.amount, tick - allocation.startedAt);
      available.push({ amount: lot.amount, idleSince: tick });
    }
    active.delete(fission.fissionId);
  };

  const activeAtStart = overlapping
    .filter(
      fission =>
        fission.createdAtTick! <= term.startTick &&
        (fission.closedAtTick == null || fission.closedAtTick > term.startTick),
    )
    .sort((left, right) => left.fissionId - right.fissionId);
  for (const fission of activeAtStart) if (!open(fission, term.startTick)) return;

  const ticks = new Set<number>();
  for (const fission of overlapping) {
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
    for (const fission of overlapping
      .filter(candidate => candidate.closedAtTick === tick)
      .sort((left, right) => left.fissionId - right.fissionId)) {
      close(fission, tick);
    }
    for (const fission of overlapping
      .filter(candidate => candidate.createdAtTick === tick)
      .sort((left, right) => left.fissionId - right.fissionId)) {
      if (!open(fission, tick)) return;
    }
  }
  for (const fission of overlapping) close(fission, endTick);

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
