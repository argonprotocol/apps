import { calculatePerformanceReturn, NetworkConfig, type IPerformanceReturnInput } from '@argonprotocol/apps-core';
import {
  financialGroups,
  type FinancialGroup,
  type IFinancialAggregate,
  type IFinancialGroupSnapshot,
  type IFinancialGroupSummary,
  type IFinancialInvestmentPosition,
  type IFinancialObservation,
  type IFinancialObservedGroupSnapshot,
  type IFinancialPosition,
  type IFinancialRefreshToken,
  type IFinancialReturnSummary,
  type IFinancialReturnSnapshot,
  type IFinancialScope,
} from '../../interfaces/IFinancialPosition.ts';

export class FinancialPositionBook {
  public revision = 0;

  private scopeKey = '';
  private readonly refreshGenerations = new Map<FinancialGroup, number>();
  private readonly groupSnapshots = new Map<FinancialGroup, IFinancialGroupSnapshot>();

  constructor() {
    this.resetSnapshots();
  }

  public get snapshots(): IFinancialGroupSnapshot[] {
    return [...this.groupSnapshots.values()];
  }

  public setScope(scope: IFinancialScope): void {
    const scopeKey = [...scope.ownedAccounts].sort().join(',');
    if (scopeKey === this.scopeKey) return;

    this.scopeKey = scopeKey;
    this.refreshGenerations.clear();
    this.resetSnapshots();
    this.revision += 1;
  }

  public beginRefresh(group: FinancialGroup): IFinancialRefreshToken {
    if (!this.scopeKey) {
      throw new Error('Financial position scope must be set before refreshing a group');
    }

    const generation = (this.refreshGenerations.get(group) ?? 0) + 1;
    this.refreshGenerations.set(group, generation);

    const snapshot = this.groupSnapshots.get(group);
    if (!snapshot || snapshot.state === 'error') {
      this.groupSnapshots.set(group, { group, state: 'loading', positions: [] });
      this.revision += 1;
    }

    return { group, generation, scopeKey: this.scopeKey };
  }

  public publish(
    refresh: IFinancialRefreshToken,
    positions: readonly IFinancialPosition[],
    observation: IFinancialObservation,
    requiredObservation?: IFinancialObservation,
  ): boolean {
    return this.commit([{ refresh, positions, observation, requiredObservation }]);
  }

  public commit(
    updates: readonly {
      refresh: IFinancialRefreshToken;
      positions: readonly IFinancialPosition[];
      observation: IFinancialObservation;
      requiredObservation?: IFinancialObservation;
    }[],
  ): boolean {
    if (updates.length === 0 || updates.some(({ refresh }) => !this.isCurrent(refresh))) return false;

    const incompleteUpdate = updates.find(
      ({ observation, requiredObservation }) =>
        requiredObservation && !doesObservationCover(observation, requiredObservation),
    );
    if (incompleteUpdate) {
      const blockNumber = incompleteUpdate.requiredObservation?.blockNumber ?? 'unknown';
      this.fail(
        updates.map(({ refresh }) => refresh),
        `Waiting for ${incompleteUpdate.refresh.group} state at block ${blockNumber}`,
      );
      return false;
    }

    const nextSnapshots = new Map(this.groupSnapshots);
    for (const { refresh, positions, observation } of updates) {
      const nextSnapshot: IFinancialObservedGroupSnapshot = {
        group: refresh.group,
        state: 'ready',
        positions: Object.freeze([...positions]),
        observation,
      };
      const previous = this.groupSnapshots.get(refresh.group);
      if (previous?.state === 'ready' || previous?.state === 'stale') {
        const previousReturns = new Map(
          previous.positions
            .filter(isReturnPosition)
            .map(position => [position.id, { position, observation: previous.observation }]),
        );
        for (const retained of previous.retainedReturns ?? []) previousReturns.set(retained.position.id, retained);

        const retainedReturns: IFinancialReturnSnapshot[] = [];
        for (const position of positions.filter(isReturnPosition)) {
          const previousReturn = previousReturns.get(position.id);
          if (previousReturn?.position.kind !== position.kind) continue;

          const current = calculatePositionReturn([position], nextSnapshot);
          const prior = calculatePositionReturn([previousReturn.position], previous);
          if (prior.availability !== 'available') continue;
          if (current.availability === 'available') {
            if (position.kind !== 'bond' || position.lifecycle === 'completed') continue;
            if (current.apy !== undefined || !previousReturn.position.dailyReturns) continue;

            retainedReturns.push({
              position: {
                ...position,
                dailyReturns: previousReturn.position.dailyReturns,
                dailyReturnPeriodDays: previousReturn.position.dailyReturnPeriodDays,
              },
              observation,
            });
            continue;
          }

          retainedReturns.push(previousReturn);
        }
        if (retainedReturns.length) nextSnapshot.retainedReturns = Object.freeze(retainedReturns);
      }
      nextSnapshots.set(refresh.group, nextSnapshot);
    }
    validatePositionOwnership(nextSnapshots.values());

    this.groupSnapshots.clear();
    for (const [group, snapshot] of nextSnapshots) this.groupSnapshots.set(group, snapshot);
    this.revision += 1;
    return true;
  }

  public fail(refreshes: IFinancialRefreshToken | readonly IFinancialRefreshToken[], message: string): boolean {
    const refreshList = Array.isArray(refreshes) ? refreshes : [refreshes];
    const currentRefreshes = refreshList.filter(refresh => this.isCurrent(refresh));
    if (currentRefreshes.length !== refreshList.length) return false;

    let didChange = false;
    for (const refresh of currentRefreshes) {
      const snapshot = this.groupSnapshots.get(refresh.group);
      if ((snapshot?.state === 'error' || snapshot?.state === 'stale') && snapshot.message === message) continue;

      if (snapshot && (snapshot.state === 'ready' || snapshot.state === 'stale')) {
        this.groupSnapshots.set(refresh.group, { ...snapshot, state: 'stale', message });
      } else {
        this.groupSnapshots.set(refresh.group, { group: refresh.group, state: 'error', positions: [], message });
      }
      didChange = true;
    }
    if (didChange) this.revision += 1;
    return didChange;
  }

  private isCurrent(refresh: IFinancialRefreshToken): boolean {
    return refresh.scopeKey === this.scopeKey && refresh.generation === this.refreshGenerations.get(refresh.group);
  }

  private resetSnapshots(): void {
    this.groupSnapshots.clear();
    for (const group of financialGroups) {
      this.groupSnapshots.set(group, { group, state: 'loading', positions: [] });
    }
  }
}

function validatePositionOwnership(snapshots: Iterable<IFinancialGroupSnapshot>): void {
  const positionIds = new Map<string, FinancialGroup>();
  for (const snapshot of snapshots) {
    for (const position of snapshot.positions) {
      if (position.group !== snapshot.group) {
        throw new Error(`Cannot publish ${position.group} position ${position.id} into ${snapshot.group}`);
      }
      const conflictingGroup = positionIds.get(position.id);
      if (conflictingGroup) {
        throw new Error(`Financial position id ${position.id} is already used by ${conflictingGroup}`);
      }
      positionIds.set(position.id, snapshot.group);
    }
  }
}

export function reduceFinancialPositions(snapshots: readonly IFinancialGroupSnapshot[]): IFinancialAggregate {
  const snapshotsByGroup = new Map(snapshots.map(snapshot => [snapshot.group, snapshot]));
  const groups: IFinancialGroupSummary[] = [];
  const accountPositions: IFinancialPosition[] = [];

  let grossAssets = 0n;
  let grossLiabilities = 0n;
  let usableGroupCount = 0;
  let hasUnavailableValue = false;

  for (const group of financialGroups) {
    const snapshot = snapshotsByGroup.get(group) ?? { group, state: 'loading', positions: [] };
    const isUsable = snapshot.state === 'ready' || (snapshot.state === 'stale' && snapshot.positions.length > 0);
    const groupPositions = isUsable ? snapshot.positions : [];

    let groupAssets = 0n;
    let groupLiabilities = 0n;

    if (isUsable) {
      usableGroupCount += 1;
      for (const position of groupPositions) {
        if (position.currentValue === undefined) {
          hasUnavailableValue = true;
          continue;
        }
        // Unknown wallet basis is a return-only marker; its value is already in
        // the residual wallet-balance position.
        if (position.lifecycle === 'unavailable' && position.kind !== 'wallet-holding') {
          hasUnavailableValue = true;
          continue;
        }

        if (position.currentValue >= 0n) {
          groupAssets += position.currentValue;
          grossAssets += position.currentValue;
        } else {
          groupLiabilities -= position.currentValue;
          grossLiabilities -= position.currentValue;
        }
      }
    }

    // Mining RTD describes mining terms. Pending bids have not started, and
    // ARGNOT custody lots are tracked separately without repeatedly adding
    // internal collateral transitions to the term-return denominator.
    const retainedReturns = snapshot.retainedReturns ?? [];
    let returnPositions = groupPositions;
    if (group === 'mining') returnPositions = returnPositions.filter(position => position.kind === 'mining-cohort');
    accountPositions.push(...selectReturnPositions(returnPositions, snapshot));
    const returnSummary = calculatePositionReturn(returnPositions, snapshot);
    groups.push({
      group,
      state: snapshot.state,
      isStale: snapshot.state === 'stale',
      positions: groupPositions,
      currentValue: groupAssets - groupLiabilities,
      grossAssets: groupAssets,
      grossLiabilities: groupLiabilities,
      observation: snapshot.observation,
      message:
        snapshot.message ??
        (returnSummary.isStale
          ? 'Updating returns; showing the last complete calculation for affected positions.'
          : undefined),
      returnSummary,
      retainedReturns,
    });
  }

  const isStale = groups.some(group => group.isStale);
  let readiness: IFinancialAggregate['readiness'];
  if (usableGroupCount === 0) {
    if (isStale) {
      readiness = 'partial';
    } else {
      readiness = groups.some(group => group.state === 'loading') ? 'loading' : 'error';
    }
  } else {
    const hasUnavailableGroup = groups.some(group => group.state !== 'ready');
    readiness = hasUnavailableGroup || hasUnavailableValue ? 'partial' : 'ready';
  }

  const accountReturn = calculatePositionReturn(accountPositions);
  const hasStaleReturn = groups.some(group => group.returnSummary.isStale);
  const accountReturnAvailability =
    (readiness === 'partial' || hasStaleReturn) && accountReturn.availability === 'available'
      ? 'partial'
      : accountReturn.availability;
  const groupSummaries = Object.fromEntries(groups.map(summary => [summary.group, summary])) as Record<
    FinancialGroup,
    IFinancialGroupSummary
  >;
  const liquidSnapshot = snapshotsByGroup.get('liquid');
  const hasLiquidSnapshot =
    liquidSnapshot?.state === 'ready' || (liquidSnapshot?.state === 'stale' && liquidSnapshot.positions.length > 0);

  return {
    groups,
    groupSummaries,
    accountReturn: {
      availability: accountReturnAvailability,
      basisPoints: accountReturn.basisPoints,
      percent: accountReturn.percent,
      apr: accountReturn.apr,
      apy: accountReturn.apy,
      eligiblePositionCount: accountReturn.eligiblePositionCount,
      investmentPositionCount: accountReturn.investmentPositionCount,
    },
    grossAssets,
    grossLiabilities,
    netWorth: hasLiquidSnapshot ? grossAssets - grossLiabilities : undefined,
    readiness,
    isStale,
  };
}

function doesObservationCover(observation: IFinancialObservation, required: IFinancialObservation): boolean {
  if (observation.blockNumber === undefined || required.blockNumber === undefined) return false;
  if (observation.blockNumber !== required.blockNumber) return observation.blockNumber > required.blockNumber;

  if (observation.blockHash && required.blockHash) {
    return observation.blockHash.toLowerCase() === required.blockHash.toLowerCase();
  }
  return true;
}

export function calculatePositionReturn(
  positions: readonly IFinancialPosition[],
  group?: IFinancialGroupSnapshot | IFinancialGroupSummary,
): IFinancialReturnSummary {
  const investments = selectReturnPositions(positions, group);
  if (investments.length === 0) {
    return {
      availability: 'not-applicable',
      investedCost: 0n,
      paidIncome: 0n,
      settledPrincipalValue: 0n,
      eligiblePositionCount: 0,
      investmentPositionCount: 0,
    };
  }

  const eligibleInvestments: IPerformanceReturnInput[] = [];
  let paidIncome = 0n;
  let hasUnknownIncome = false;
  let settledPrincipalValue = 0n;
  const retainedIds = new Set(group?.retainedReturns?.map(retained => retained.position.id));
  const isStale = investments.some(position => retainedIds.has(position.id));

  for (const position of investments) {
    const positionIncome = position.paidIncome;
    if (positionIncome === undefined) hasUnknownIncome = true;
    else paidIncome += positionIncome;
    settledPrincipalValue += position.settledPrincipalValue ?? 0n;
    if (positionIncome === undefined) continue;
    if ((position.kind === 'bond' || position.kind === 'vault') && position.returnIsComplete === false) continue;

    const { investedCost } = position;
    if (position.lifecycle === 'unavailable') continue;
    if (position.startedAt === undefined) continue;
    if (investedCost === undefined || investedCost <= 0n) continue;

    if (position.kind === 'bond') {
      eligibleInvestments.push({
        startingDate: position.startedAt,
        startingCapital: investedCost,
        endingDate: position.endedAt,
        endingCapital: investedCost + positionIncome,
        capitalFlows: position.capitalFlows,
        dailyReturns: position.dailyReturns,
        dailyReturnPeriodDays: position.dailyReturnPeriodDays,
      });
      continue;
    }

    const { currentValue } = position;
    if (currentValue === undefined || position.settledPrincipalValue === undefined) continue;

    let endingCapital = currentValue + position.settledPrincipalValue + positionIncome;
    if (position.kind === 'mining-cohort') {
      if (position.performanceEndingCapital === undefined) continue;
      endingCapital = position.performanceEndingCapital;
    } else if (
      (position.kind === 'bitcoin-liquid' || position.kind === 'vault') &&
      position.performanceEndingCapital !== undefined
    ) {
      endingCapital = position.performanceEndingCapital;
    }

    eligibleInvestments.push({
      startingDate: position.startedAt,
      startingCapital: investedCost,
      endingDate: position.endedAt,
      endingCapital,
      capitalFlows: position.capitalFlows,
      dailyReturns: position.dailyReturns,
      dailyReturnPeriodDays: position.dailyReturnPeriodDays,
    });
  }

  if (eligibleInvestments.length === 0) {
    return {
      availability: 'unavailable',
      investedCost: 0n,
      paidIncome: hasUnknownIncome ? undefined : paidIncome,
      settledPrincipalValue,
      eligiblePositionCount: 0,
      investmentPositionCount: investments.length,
    };
  }

  const performance = calculatePerformanceReturn(eligibleInvestments, {
    dayMillis: NetworkConfig.rewardTicksPerFrame * NetworkConfig.tickMillis,
  });
  const availability = eligibleInvestments.length === investments.length ? 'available' : 'partial';

  return {
    availability,
    ...(isStale ? { isStale: true } : {}),
    investedCost: performance.eligibleCapitalInvested,
    paidIncome: hasUnknownIncome ? undefined : paidIncome,
    settledPrincipalValue,
    returnAmount: performance.totalProfits,
    basisPoints: performance.basisPoints,
    percent: performance.percent,
    apr: performance.apr,
    apy: performance.apy,
    eligiblePositionCount: eligibleInvestments.length,
    investmentPositionCount: investments.length,
  };
}

/** Select coherent return facts and freeze each active calculation at its own observation. */
function selectReturnPositions(
  positions: readonly IFinancialPosition[],
  group?: IFinancialGroupSnapshot | IFinancialGroupSummary,
): IFinancialInvestmentPosition[] {
  const retainedById = new Map(group?.retainedReturns?.map(retained => [retained.position.id, retained]));
  return positions.filter(isReturnPosition).map(position => {
    const retained = retainedById.get(position.id);
    const returnPosition = retained?.position ?? position;
    const observedAt = retained?.observation.observedAt ?? group?.observation?.observedAt;
    if (returnPosition.endedAt !== undefined || observedAt === undefined) return returnPosition;

    return { ...returnPosition, endedAt: observedAt };
  });
}

function isReturnPosition(position: IFinancialPosition): position is IFinancialInvestmentPosition {
  return (
    position.kind === 'mining-cohort' ||
    position.kind === 'vault' ||
    position.kind === 'bond' ||
    position.kind === 'bitcoin-liquid' ||
    position.kind === 'stable-swap'
  );
}
