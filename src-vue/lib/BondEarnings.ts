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
  let backfilledEarnings = 0n;
  for (const backfill of history?.earningsBackfills ?? []) backfilledEarnings += backfill.addedEarnings;
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

  // Preserve the larger proven amount when daily recovery is incomplete. If the
  // two sources disagree, this is a lower bound, not a complete lifetime return.
  const vaultEarnings = bigIntMax(backfilledEarnings, observedVaultEarnings);
  let lifetimeEarnings = chainEarnings;
  if (chainEarnings !== undefined) lifetimeEarnings = chainEarnings + vaultEarnings - backfilledEarnings;
  const earningThroughFrame = history?.releaseFrame === undefined ? completedFrame : history.releaseFrame - 1;
  const hasDailyCoverage =
    earningThroughFrame !== undefined && (history?.earningsHistoryThroughFrame ?? -1) >= earningThroughFrame;
  let attributionIsComplete = !hasMissingPayout;
  if (!hasDailyCoverage) {
    if (lot?.isFlexible || history?.flexibilityHistory.some(transition => transition.isFlexible)) {
      attributionIsComplete = false;
    }
  }
  if (observedVaultEarnings !== vaultEarnings) attributionIsComplete = false;
  if (backfilledEarnings > 0n && observedVaultEarnings !== backfilledEarnings) attributionIsComplete = false;

  let isComplete = attributionIsComplete;
  if (lifetimeEarnings === undefined || observedEarnings !== lifetimeEarnings) isComplete = false;
  if (participatedFrames === undefined || records.length < participatedFrames) isComplete = false;
  if (history?.earningsComplete === false) isComplete = false;

  return {
    records,
    lifetimeEarnings,
    vaultEarnings,
    isComplete,
    attributionIsComplete,
    participationIsComplete: records.every(record => record.bonds != null && record.displacedMicrogons != null),
  };
}

/** Reconcile bond income against the vault's actual collection and expiry history. */
export function getVaultBondEarnings(
  {
    bondLots,
    bondHistory,
    dailyEarnings,
    isLoaded,
    currentFrameId,
  }: Pick<ArgonBonds['data'], 'bondLots' | 'bondHistory' | 'dailyEarnings' | 'isLoaded' | 'currentFrameId'>,
  vaultId: number,
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
    const earnings = getBondEarnings(lot, history, records, currentFrameId - 1);
    totalEarnings += earnings.vaultEarnings;
    if (!history?.flexibilityHistoryComplete) isComplete = false;
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
