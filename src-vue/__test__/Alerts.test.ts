import { describe, expect, it } from 'vitest';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { getBitcoinAlertNotices, getVaultAlertNotice } from '../lib/Alerts.ts';
import { BITCOIN_BLOCK_MILLIS, TICK_MILLIS } from '../lib/Env.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';

type TestMismatchPhase =
  | 'none'
  | 'review'
  | 'accepting'
  | 'returningOnArgon'
  | 'returningOnBitcoin'
  | 'returned'
  | 'readyToResume'
  | 'error';

describe('getVaultAlertNotice', () => {
  it('uses processing collect metadata while collection is in flight', () => {
    const notice = getVaultAlertNotice(
      vaultSource({
        pendingCollectRevenue: 42n,
        expiringCollectAmount: 7n,
        pendingCollectTxInfo: {
          tx: { metadataJson: { expectedCollectRevenue: 64n, cosignedUtxoIds: [11, 12] } },
        },
        pendingCosignUtxosById: new Map([[11, { marketValue: 50n }]]),
        nextCollectDueDate: 1234,
      }),
      { getLockByUtxoId: () => undefined },
    );

    expect(notice).toEqual({
      isProcessing: true,
      collectRevenue: 64n,
      expiringCollectAmount: 7n,
      signatureCount: 2,
      signaturePenalty: 50n,
      amountMicrogons: 64n,
      nextDueDate: 1234,
    });
  });

  it('returns null when there is nothing to collect or sign', () => {
    expect(getVaultAlertNotice(vaultSource(), { getLockByUtxoId: () => undefined })).toBeNull();
  });
});

describe('getBitcoinAlertNotices', () => {
  it('surfaces review mismatches even before an action is available', () => {
    const alerts = getBitcoinAlertNotices(
      bitcoinSource({
        locks: [lock(1)],
        mismatches: {
          1: { phase: 'review', candidateCount: 1 },
        },
      }),
    );

    expect(alerts.map(({ kind }) => kind)).toEqual(['mismatch']);
  });

  it('only shows fundingExpiring once less than 25% of the funding window remains', () => {
    const now = Date.now();
    const totalFundingWindow = 12 * BITCOIN_BLOCK_MILLIS;

    expect(
      getBitcoinAlertNotices(
        bitcoinSource({
          locks: [lock(2)],
          fundingDeadlines: { 2: now + totalFundingWindow / 5 },
        }),
        now,
      ).map(({ kind }) => kind),
    ).toEqual(['fundingExpiring']);

    expect(
      getBitcoinAlertNotices(
        bitcoinSource({
          locks: [lock(2)],
          fundingDeadlines: { 2: now + totalFundingWindow / 3 },
        }),
        now,
      ),
    ).toEqual([]);
  });

  it('sorts attention alerts by severity and urgency', () => {
    const now = Date.now();
    const nearUnlockDeadline = now + 10 * NetworkConfig.rewardTicksPerFrame * TICK_MILLIS - 1;

    const alerts = getBitcoinAlertNotices(
      bitcoinSource({
        locks: [
          lock(14),
          lock(13, { status: BitcoinLockStatus.LockedAndMinted }),
          lock(12),
          lock(11, { status: BitcoinLockStatus.LockedAndMinted }),
        ],
        mismatches: {
          12: { phase: 'review', candidateCount: 1 },
        },
        acceptedFundingRecords: {
          11: fundingRecord('vault cosign failed'),
        },
        releaseStates: {
          11: { isReleaseStatus: true },
        },
        unlockDeadlines: {
          13: nearUnlockDeadline,
        },
        fundingDeadlines: {
          14: now + BITCOIN_BLOCK_MILLIS,
        },
      }),
      now,
    );

    expect(alerts.map(({ kind }) => kind)).toEqual([
      'unlockNeedsAttention',
      'mismatch',
      'unlockExpiring',
      'fundingExpiring',
    ]);
  });
});

function vaultSource(
  data: Partial<{
    pendingCollectRevenue: bigint;
    expiringCollectAmount: bigint;
    pendingCollectTxInfo: {
      tx: {
        metadataJson: {
          expectedCollectRevenue: bigint;
          cosignedUtxoIds: number[];
        };
      };
    } | null;
    pendingCosignUtxosById: Map<number, { marketValue: bigint }>;
    myPendingBitcoinCosignTxInfosByUtxoId: Map<number, unknown>;
    nextCollectDueDate: number;
  }> = {},
) {
  return {
    createdVault: { securitization: 10_000n },
    data: {
      pendingCollectRevenue: 0n,
      expiringCollectAmount: 0n,
      pendingCollectTxInfo: null,
      pendingCosignUtxosById: new Map(),
      myPendingBitcoinCosignTxInfosByUtxoId: new Map(),
      nextCollectDueDate: 0,
      ...data,
    },
  };
}

function bitcoinSource(args: {
  locks: IBitcoinLockRecord[];
  mismatches?: Record<number, Partial<{ phase: TestMismatchPhase; candidateCount: number; isFundingExpired: boolean }>>;
  acceptedFundingRecords?: Record<number, IBitcoinUtxoRecord | undefined>;
  releaseStates?: Record<number, { isReleaseStatus: boolean }>;
  unlockDeadlines?: Record<number, number>;
  fundingDeadlines?: Record<number, number>;
}) {
  return {
    config: { pendingConfirmationExpirationBlocks: 12 },
    getLockByUtxoId: (utxoId: number) => args.locks.find(lock => lock.utxoId === utxoId),
    getActiveLocks: () => args.locks,
    getMismatchViewState(lock: IBitcoinLockRecord): {
      phase: TestMismatchPhase;
      candidateCount: number;
      isFundingExpired: boolean;
      error?: string;
      nextCandidate?: {
        canAccept: boolean;
        canReturn: boolean;
        record: IBitcoinUtxoRecord;
      };
    } {
      return {
        phase: 'none',
        candidateCount: 0,
        isFundingExpired: false,
        error: undefined,
        nextCandidate: undefined,
        ...args.mismatches?.[lock.utxoId ?? 0],
      };
    },
    getAcceptedFundingRecord: (lock: IBitcoinLockRecord) => args.acceptedFundingRecords?.[lock.utxoId ?? 0],
    getLockUnlockReleaseState: (lock: IBitcoinLockRecord) =>
      args.releaseStates?.[lock.utxoId ?? 0] ?? { isReleaseStatus: false },
    isLockedStatus: (lock: IBitcoinLockRecord) =>
      [BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(lock.status),
    unlockDeadlineTime: (lock: IBitcoinLockRecord) => args.unlockDeadlines?.[lock.utxoId ?? 0] ?? 0,
    verifyExpirationTime: (lock: IBitcoinLockRecord) => args.fundingDeadlines?.[lock.utxoId ?? 0] ?? 0,
  };
}

function lock(utxoId: number, overrides: Partial<IBitcoinLockRecord> = {}): IBitcoinLockRecord {
  return {
    utxoId,
    status: BitcoinLockStatus.LockPendingFunding,
    liquidityPromised: 1_250_000_000n,
    createdAt: new Date(`2026-01-${String(utxoId).padStart(2, '0')}T00:00:00Z`),
    ...overrides,
  } as IBitcoinLockRecord;
}

function fundingRecord(statusError: string): IBitcoinUtxoRecord {
  return {
    status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
    statusError,
  } as IBitcoinUtxoRecord;
}
