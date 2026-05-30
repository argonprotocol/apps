import { NetworkConfig } from '@argonprotocol/apps-core';
import { BITCOIN_BLOCK_MILLIS, TICK_MILLIS } from '../lib/Env.ts';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import type { IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import type { IVaultCollectNotice } from './VaultCollectBuilder.ts';

type IBitcoinMismatchView = {
  phase:
    | 'none'
    | 'review'
    | 'accepting'
    | 'returningOnArgon'
    | 'returningOnBitcoin'
    | 'returned'
    | 'readyToResume'
    | 'error';
  error?: string;
  candidateCount: number;
  isFundingExpired: boolean;
  nextCandidate?: {
    canAccept: boolean;
    canReturn: boolean;
    record: IBitcoinUtxoRecord;
  };
};

type IBitcoinUnlockReleaseState = {
  isReleaseStatus: boolean;
};

type IBitcoinAlertSource = {
  config: {
    pendingConfirmationExpirationBlocks: number;
  };
  getLockByUtxoId(utxoId: number): IBitcoinLockRecord | undefined;
  getActiveLocks(): IBitcoinLockRecord[];
  getMismatchViewState(lock: IBitcoinLockRecord): IBitcoinMismatchView;
  getAcceptedFundingRecord(lock: IBitcoinLockRecord): IBitcoinUtxoRecord | undefined;
  getLockUnlockReleaseState(lock: IBitcoinLockRecord): IBitcoinUnlockReleaseState;
  isLockedStatus(lock: IBitcoinLockRecord): boolean;
  unlockDeadlineTime(lock: IBitcoinLockRecord): number;
  verifyExpirationTime(lock: IBitcoinLockRecord): number;
};

export type IBitcoinAlert =
  | {
      kind: 'mismatch';
      lock: IBitcoinLockRecord;
      amountMicrogons: bigint;
    }
  | {
      kind: 'resumeFunding';
      lock: IBitcoinLockRecord;
      amountMicrogons: bigint;
    }
  | {
      kind: 'unlockNeedsAttention';
      lock: IBitcoinLockRecord;
      amountMicrogons: bigint;
      error: string;
    }
  | {
      kind: 'unlockExpiring';
      lock: IBitcoinLockRecord;
      amountMicrogons: bigint;
      expiresAt: number;
    }
  | {
      kind: 'fundingExpiring';
      lock: IBitcoinLockRecord;
      amountMicrogons: bigint;
      expiresAt: number;
    };

export function buildAlertSummary(args: {
  count: number;
  formattedAmount?: string;
  formattedEarnings?: string;
  formattedAtRisk?: string;
}): string {
  const { count, formattedAmount, formattedEarnings, formattedAtRisk } = args;
  const actionLabel = `${count} action${count === 1 ? '' : 's'}`;

  if (formattedEarnings && formattedAtRisk) {
    return `You have ${actionLabel} needing your attention, with ${formattedEarnings} in earnings and ${formattedAtRisk} at risk.`;
  }
  if (formattedEarnings) {
    return `You have ${actionLabel} needing your attention, with ${formattedEarnings} in earnings.`;
  }
  if (formattedAtRisk) {
    return `You have ${actionLabel} needing your attention, with ${formattedAtRisk} at risk.`;
  }
  if (!formattedAmount) {
    return `You have ${actionLabel} needing your attention.`;
  }
  return `You have ${actionLabel} needing your attention worth ${formattedAmount}.`;
}

export function getBitcoinAlertNotices(bitcoinLocks: IBitcoinAlertSource, now: number = Date.now()): IBitcoinAlert[] {
  const alerts: IBitcoinAlert[] = [];

  for (const lock of bitcoinLocks.getActiveLocks()) {
    const mismatchView = bitcoinLocks.getMismatchViewState(lock);
    if (mismatchView.phase === 'readyToResume') {
      alerts.push({
        kind: 'resumeFunding',
        lock,
        amountMicrogons: lock.liquidityPromised,
      });
      continue;
    }

    if (
      mismatchView.phase === 'error' ||
      mismatchView.phase === 'review' ||
      mismatchView.phase === 'returningOnArgon' ||
      mismatchView.phase === 'returningOnBitcoin'
    ) {
      alerts.push({
        kind: 'mismatch',
        lock,
        amountMicrogons: lock.liquidityPromised,
      });
      continue;
    }

    const fundingRecord = bitcoinLocks.getAcceptedFundingRecord(lock) ?? lock.fundingUtxoRecord;
    if (bitcoinLocks.getLockUnlockReleaseState(lock).isReleaseStatus && fundingRecord?.statusError) {
      alerts.push({
        kind: 'unlockNeedsAttention',
        lock,
        amountMicrogons: lock.liquidityPromised,
        error: fundingRecord.statusError,
      });
      continue;
    }

    const expiresAt = bitcoinLocks.unlockDeadlineTime(lock);
    if (bitcoinLocks.isLockedStatus(lock) && isAlertLockNearExpiration(expiresAt, now)) {
      alerts.push({
        kind: 'unlockExpiring',
        lock,
        amountMicrogons: lock.liquidityPromised,
        expiresAt,
      });

      continue;
    }

    if (lock.status === BitcoinLockStatus.LockPendingFunding) {
      const fundingExpiresAt = bitcoinLocks.verifyExpirationTime(lock);
      if (
        isFundingWindowNearExpiration(fundingExpiresAt, bitcoinLocks.config.pendingConfirmationExpirationBlocks, now)
      ) {
        alerts.push({
          kind: 'fundingExpiring',
          lock,
          amountMicrogons: lock.liquidityPromised,
          expiresAt: fundingExpiresAt,
        });
      }
    }
  }

  return alerts.sort(compareBitcoinAlerts);
}

export function sumBitcoinAlertAmount(bitcoinAlerts: IBitcoinAlert[]): bigint {
  let total = 0n;
  for (const alert of bitcoinAlerts) {
    total += alert.amountMicrogons;
  }
  return total;
}

function compareBitcoinAlerts(a: IBitcoinAlert, b: IBitcoinAlert): number {
  const priorityA = getBitcoinAlertPriority(a);
  const priorityB = getBitcoinAlertPriority(b);
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }

  if (a.kind === 'unlockExpiring' && b.kind === 'unlockExpiring' && a.expiresAt !== b.expiresAt) {
    return a.expiresAt - b.expiresAt;
  }

  return b.lock.createdAt.getTime() - a.lock.createdAt.getTime();
}

function getBitcoinAlertPriority(alert: IBitcoinAlert): number {
  if (alert.kind === 'unlockNeedsAttention') return 0;
  if (alert.kind === 'mismatch') return 1;
  if (alert.kind === 'unlockExpiring') return 2;
  if (alert.kind === 'fundingExpiring') return 3;
  return 4;
}

function isAlertLockNearExpiration(
  expiresAt: number,
  now: number,
  warningWindowMillis: number = 10 * NetworkConfig.rewardTicksPerFrame * TICK_MILLIS,
): boolean {
  return expiresAt > now && expiresAt < now + warningWindowMillis;
}

function isFundingWindowNearExpiration(
  expiresAt: number,
  pendingConfirmationExpirationBlocks: number,
  now: number,
  remainingThresholdRatio: number = 0.25,
): boolean {
  if (expiresAt <= now || pendingConfirmationExpirationBlocks <= 0) {
    return false;
  }

  const totalFundingWindowMillis = pendingConfirmationExpirationBlocks * BITCOIN_BLOCK_MILLIS;
  return expiresAt - now <= totalFundingWindowMillis * remainingThresholdRatio;
}
