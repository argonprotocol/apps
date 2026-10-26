import { bigIntMax, type BondLot } from '@argonprotocol/apps-core';
import type { ArgonBonds } from './ArgonBonds.ts';
import type { MyVault } from './MyVault.ts';
import type { IBondEarningsRecord } from './db/BondEarningsTable.ts';
import type { IBondLotHistoryRecord } from './db/BondLotHistoryTable.ts';
import type { IVaultRevenueEventsRecord } from './db/VaultRevenueEventsTable.ts';

/** Daily allocations and metric backfills describe overlapping income, not new payments. */
export function getBondEarnings(
  lot: BondLot | undefined,
  history: IBondLotHistoryRecord | undefined,
  records: readonly IBondEarningsRecord[],
  completedFrame?: number,
) {
  const chainEarnings = lot?.cumulativeEarnings ?? history?.cumulativeEarningsMicrogons;
  const participatedFrames = lot?.participatedFrames ?? history?.participatedFrames;
  let observedEarnings = 0n;
  let observedVaultEarnings = 0n;
  let hasMissingPayout = false;
  for (const record of records) {
    if (record.earningsMicrogons == null) {
      hasMissingPayout = true;
      continue;
    }
    observedEarnings += record.earningsMicrogons;
    if (record.earningsDestination === 'Vault') observedVaultEarnings += record.earningsMicrogons;
  }

  // Older counters omit vault-paid income; updated counters include it.
  // Both totals describe the same earnings, even before the backfill event is finalized locally.
  let lifetimeEarnings = chainEarnings;
  if (chainEarnings !== undefined) lifetimeEarnings = bigIntMax(chainEarnings, observedEarnings);
  const earningThroughFrame = history?.releaseFrame === undefined ? completedFrame : history.releaseFrame - 1;
  const createdFrame = lot?.createdFrameId ?? history?.createdFrame;
  const historyThroughFrame = history?.earningsHistoryThroughFrame ?? (createdFrame ?? 0) - 1;
  const hasDailyCoverage = earningThroughFrame !== undefined && historyThroughFrame >= earningThroughFrame;
  const isNewUnparticipated = isNewUnparticipatedBond(lot, history, records, completedFrame);

  let attributionIsComplete = !hasMissingPayout;
  if (!hasDailyCoverage && !isNewUnparticipated) {
    if (
      lot?.isFlexible ||
      history?.earningsBackfills.length ||
      history?.flexibilityHistory.some(transition => transition.isFlexible)
    ) {
      attributionIsComplete = false;
    }
  }

  let isComplete = attributionIsComplete;
  if (lifetimeEarnings === undefined || observedEarnings !== lifetimeEarnings) isComplete = false;
  if (participatedFrames === undefined || records.length < participatedFrames) isComplete = false;
  if (history?.earningsComplete === false) isComplete = false;

  return {
    records,
    lifetimeEarnings,
    vaultEarnings: observedVaultEarnings,
    isComplete,
    attributionIsComplete,
    isNewUnparticipatedBond: isNewUnparticipated,
  };
}

export function isNewUnparticipatedBond(
  lot: BondLot | undefined,
  history: IBondLotHistoryRecord | undefined,
  records: readonly IBondEarningsRecord[],
  completedFrame?: number,
): boolean {
  if (!lot || completedFrame === undefined) return false;
  if (lot.createdFrameId < completedFrame) return false;
  if (lot.participatedFrames !== 0 || lot.cumulativeEarnings !== 0n) return false;
  if ((history?.participatedFrames ?? 0) !== 0) return false;
  if ((history?.cumulativeEarningsMicrogons ?? 0n) !== 0n) return false;

  return records.length === 0;
}

/** Reconcile bond income against the vault's actual collection and expiry history. */
export function getVaultBondEarnings(
  {
    bondLots,
    bondHistory,
    dailyEarnings,
    isLoaded,
  }: Pick<ArgonBonds['data'], 'bondLots' | 'bondHistory' | 'dailyEarnings' | 'isLoaded'>,
  vaultId: number,
  completedFrame: number,
  revenueHistory: readonly IVaultRevenueEventsRecord[],
  revenueCoverage?: { fromBlock: number; throughBlock: number },
  pendingRevenueFrames: MyVault['pendingRevenueFrames'] = [],
) {
  const lotsById = new Map(bondLots.filter(lot => lot.vaultId === vaultId).map(lot => [lot.id, lot]));
  const historyById = new Map(
    bondHistory.filter(record => record.vaultId === vaultId).map(record => [record.bondLotId, record]),
  );
  const ids = new Set([...lotsById.keys(), ...historyById.keys()]);
  const revenueEvents = [...revenueHistory].sort(
    (a, b) => a.blockNumber - b.blockNumber || (a.extrinsicIndex ?? -1) - (b.extrinsicIndex ?? -1),
  );
  const collectedByEvent = new Map<number, bigint>();
  let totalEarnings = 0n;
  const pendingByFrame = new Map<number, bigint>();
  let isComplete = isLoaded;
  let hasCompleteAllocation = isLoaded;
  for (const id of ids) {
    const lot = lotsById.get(id);
    const history = historyById.get(id);
    const records = dailyEarnings.filter(record => record.bondLotId === id);
    const earnings = getBondEarnings(lot, history, records, completedFrame);
    totalEarnings += earnings.vaultEarnings;

    if (!history?.flexibilityHistoryComplete && !earnings.isNewUnparticipatedBond) isComplete = false;
    if (!earnings.attributionIsComplete) hasCompleteAllocation = false;
    for (const record of records) {
      if (record.earningsDestination !== 'Vault' || record.earningsMicrogons == null) continue;
      const settlement = revenueEvents.find(event => {
        if (event.blockNumber < record.payoutBlockNumber) return false;
        return event.source === 'vaultCollect' || event.frameId === record.frameId;
      });
      if (!settlement) {
        pendingByFrame.set(record.frameId, (pendingByFrame.get(record.frameId) ?? 0n) + record.earningsMicrogons);
        continue;
      }
      if (!revenueCoverage) hasCompleteAllocation = false;
      else if (revenueCoverage.fromBlock > record.payoutBlockNumber) hasCompleteAllocation = false;
      else if (revenueCoverage.throughBlock < settlement.blockNumber) hasCompleteAllocation = false;
      if (settlement.source === 'vaultCollect') {
        collectedByEvent.set(settlement.id, (collectedByEvent.get(settlement.id) ?? 0n) + record.earningsMicrogons);
      }
    }
  }
  let pendingEarnings = 0n;
  for (const [frameId, earnings] of pendingByFrame) {
    const pendingFrame = pendingRevenueFrames.find(frame => frame.frameId === frameId);
    if (!pendingFrame || pendingFrame.uncollectedEarnings < earnings) hasCompleteAllocation = false;
    pendingEarnings += earnings;
  }
  let collectedEarnings = 0n;
  for (const event of revenueEvents) {
    const collected = collectedByEvent.get(event.id) ?? 0n;
    if (collected > event.amount) hasCompleteAllocation = false;
    collectedEarnings += collected;
  }
  return {
    totalEarnings,
    collectedEarnings: hasCompleteAllocation ? collectedEarnings : undefined,
    pendingEarnings: hasCompleteAllocation ? pendingEarnings : undefined,
    isComplete: isComplete && hasCompleteAllocation,
  };
}
