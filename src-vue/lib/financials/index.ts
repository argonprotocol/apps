import { calculatePerformanceReturn, type IPerformanceReturnInput } from '@argonprotocol/apps-core';
import {
  financialGroups,
  type FinancialGroup,
  type IFinancialAggregate,
  type IFinancialGroupSnapshot,
  type IFinancialGroupSummary,
  type IFinancialInvestmentPosition,
  type IFinancialObservation,
  type IFinancialPosition,
  type IFinancialRefreshToken,
  type IFinancialReturnSummary,
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
      nextSnapshots.set(refresh.group, {
        group: refresh.group,
        state: 'ready',
        positions: Object.freeze([...positions]),
        observation,
      });
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
        const excludeFromAccountAggregate = position.kind === 'bond' && position.excludeFromAccountAggregate === true;
        if (!excludeFromAccountAggregate) accountPositions.push(position);

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
          if (!excludeFromAccountAggregate) grossAssets += position.currentValue;
        } else {
          groupLiabilities -= position.currentValue;
          if (!excludeFromAccountAggregate) grossLiabilities -= position.currentValue;
        }
      }
    }

    // Mining RTD describes mining terms. Pending bids have not started, and
    // ARGNOT custody lots are tracked separately without repeatedly adding
    // internal collateral transitions to the term-return denominator.
    const returnPositions =
      group === 'mining' ? groupPositions.filter(position => position.kind === 'mining-cohort') : groupPositions;
    const returnSummary = calculatePositionReturn(returnPositions);
    groups.push({
      group,
      state: snapshot.state,
      isStale: snapshot.state === 'stale',
      positions: groupPositions,
      currentValue: groupAssets - groupLiabilities,
      grossAssets: groupAssets,
      grossLiabilities: groupLiabilities,
      observation: snapshot.observation,
      message: snapshot.message,
      returnSummary,
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
  const accountReturnAvailability =
    readiness === 'partial' && accountReturn.availability === 'available' ? 'partial' : accountReturn.availability;
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

export function calculatePositionReturn(positions: readonly IFinancialPosition[]): IFinancialReturnSummary {
  const investments = positions.filter((position): position is IFinancialInvestmentPosition => {
    return (
      position.kind === 'mining-cohort' ||
      position.kind === 'vault' ||
      position.kind === 'bond' ||
      position.kind === 'bitcoin-asset' ||
      position.kind === 'stable-swap'
    );
  });
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
  let settledPrincipalValue = 0n;

  for (const position of investments) {
    const positionIncome = position.paidIncome;
    paidIncome += positionIncome;
    settledPrincipalValue += position.settledPrincipalValue ?? 0n;

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
      });
      continue;
    }

    const { currentValue } = position;
    if (currentValue === undefined || position.settledPrincipalValue === undefined) continue;

    let endingCapital = currentValue + position.settledPrincipalValue + positionIncome;
    if (position.kind === 'mining-cohort') {
      if (position.performanceEndingCapital === undefined) continue;
      endingCapital = position.performanceEndingCapital;
    } else if (position.kind === 'bitcoin-asset' && position.performanceEndingCapital !== undefined) {
      endingCapital = position.performanceEndingCapital;
    }

    eligibleInvestments.push({
      startingDate: position.startedAt,
      startingCapital: investedCost,
      endingDate: position.endedAt,
      endingCapital,
      capitalFlows: position.capitalFlows,
    });
  }

  if (eligibleInvestments.length === 0) {
    return {
      availability: 'unavailable',
      investedCost: 0n,
      paidIncome,
      settledPrincipalValue,
      eligiblePositionCount: 0,
      investmentPositionCount: investments.length,
    };
  }

  const performance = calculatePerformanceReturn(eligibleInvestments);
  const availability = eligibleInvestments.length === investments.length ? 'available' : 'partial';

  return {
    availability,
    investedCost: performance.eligibleCapitalInvested,
    paidIncome,
    settledPrincipalValue,
    returnAmount: performance.totalProfits,
    basisPoints: performance.basisPoints,
    percent: performance.percent,
    eligiblePositionCount: eligibleInvestments.length,
    investmentPositionCount: investments.length,
  };
}
