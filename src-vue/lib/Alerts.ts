import { NetworkConfig, StabilizerBuy } from '@argonprotocol/apps-core';
import { BITCOIN_BLOCK_MILLIS, TICK_MILLIS } from '../lib/Env.ts';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import type BitcoinLocks from './BitcoinLocks.ts';
import type { IVaultCollectNotice } from './VaultCollectBuilder.ts';
import type { StabilizerBuys } from './StabilizerBuys.ts';
import type { IStabilizerBuyOpportunity } from '../interfaces/IStabilizerBuyPurchase.ts';

export function getStabilizerBuyBidNotice(
  buys: StabilizerBuys,
): Extract<IStabilizerBuyOpportunity, { type: 'bid' }> | undefined {
  for (const position of buys.data.positions) {
    if (!position.isBiddingOpen(buys.data.currentFrameId)) continue;

    if (position.purchase.bidRate.isZero()) {
      const bidEvent = buys.data.frameRewards.find(
        rewards => rewards.admissionFrame === position.admissionFrame,
      )?.bidEvent;
      if (position.purchase.positiveBidCount === 0 && !bidEvent)
        return { type: 'bid', key: `bid:${buys.accountAddress}:${position.admissionFrame}:first`, position };
      continue;
    }

    const snapshot = buys.data.auctionsByFrame[position.admissionFrame];
    const inclusionPercent = buys.data.market?.auctionInclusionPercent;
    if (!snapshot || !inclusionPercent) continue;

    const ranked = StabilizerBuy.allocateBids(snapshot.bids, snapshot.auction, inclusionPercent);
    const own = ranked.find(bid => bid.ownerAccount === buys.accountAddress);
    if (own && own.fundingEstimate < own.requestedReward)
      return { type: 'bid', key: `bid:${buys.accountAddress}:${position.admissionFrame}:at-risk`, position, bid: own };
  }
}

export type IBitcoinAlert =
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
      kind: 'securitizationHoldExpiring';
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

export function getBitcoinAlertNotices(bitcoinLocks: BitcoinLocks, now: number = Date.now()): IBitcoinAlert[] {
  const alerts: IBitcoinAlert[] = [];

  for (const lock of bitcoinLocks.getActiveLocks()) {
    const release = bitcoinLocks.releases.getActiveForLock(lock);
    const releaseError = release?.statusError;
    if (bitcoinLocks.getLockUnlockReleaseState(lock).isReleaseStatus && releaseError) {
      alerts.push({
        kind: 'unlockNeedsAttention',
        lock,
        amountMicrogons: lock.securitizationCoverageMicrogons ?? 0n,
        error: releaseError,
      });
      continue;
    }

    if (bitcoinLocks.isLockFunded(lock)) {
      const expiresAt = bitcoinLocks.unlockDeadlineTime(lock);
      if (isAlertLockNearExpiration(expiresAt, now)) {
        alerts.push({
          kind: 'unlockExpiring',
          lock,
          amountMicrogons: lock.securitizationCoverageMicrogons ?? 0n,
          expiresAt,
        });

        continue;
      }
    }

    if (lock.status === BitcoinLockStatus.LockPendingFunding) {
      if (
        lock.scriptDetails?.createdAtHeight === undefined ||
        lock.securitizationHoldExpirationBitcoinHeight === undefined
      ) {
        continue;
      }
      const holdExpiresAt = bitcoinLocks.getSecuritizationHoldExpirationTime(lock);
      if (isSecuritizationHoldNearExpiration(holdExpiresAt, bitcoinLocks.config.securitizationHoldBlocks, now)) {
        alerts.push({
          kind: 'securitizationHoldExpiring',
          lock,
          amountMicrogons: lock.securitizationCoverageMicrogons ?? 0n,
          expiresAt: holdExpiresAt,
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
  if (alert.kind === 'unlockExpiring') return 1;
  return 2;
}

function isAlertLockNearExpiration(
  expiresAt: number,
  now: number,
  warningWindowMillis: number = 10 * NetworkConfig.rewardTicksPerFrame * TICK_MILLIS,
): boolean {
  return expiresAt > now && expiresAt < now + warningWindowMillis;
}

function isSecuritizationHoldNearExpiration(
  expiresAt: number,
  securitizationHoldBlocks: number,
  now: number,
  remainingThresholdRatio: number = 0.25,
): boolean {
  if (expiresAt <= now || securitizationHoldBlocks <= 0) {
    return false;
  }

  const totalFundingWindowMillis = securitizationHoldBlocks * BITCOIN_BLOCK_MILLIS;
  return expiresAt - now <= totalFundingWindowMillis * remainingThresholdRatio;
}
