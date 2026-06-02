import { describe, expect, it } from 'vitest';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { getBitcoinAlertNotices } from '../lib/Alerts.ts';
import { BITCOIN_BLOCK_MILLIS, TICK_MILLIS } from '../lib/Env.ts';
import { VaultCollectBuilder } from '../lib/VaultCollectBuilder.ts';
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

describe('VaultCollectBuilder.getNotice', () => {
  it('keeps the collect plan visible while a collect step is in flight', () => {
    const notice = createCollectBuilder(
      vaultSource({
        pendingCollectRevenue: 42n,
        expiringCollectAmount: 7n,
        pendingCollectTxInfo: {
          tx: { metadataJson: { actionType: 'approveCouncil', expectedCollectRevenue: 0n, cosignedUtxoIds: [] } },
        },
        pendingCosignUtxosById: new Map([[11, { targetValue: 50n }]]),
        globalCouncilPendingApprovals: 1,
        pendingMintingAuthorizationTips: [25n, 15n, 10n],
        nextCollectDueDate: 1234,
        nextCosignDueDate: 5678,
      }),
    ).getNotice();

    expect(notice).toEqual({
      isProcessing: true,
      collectRevenue: 42n,
      expiringCollectAmount: 7n,
      nextCollectDueDate: 1234,
      signatureCount: 1,
      nextCosignDueDate: 5678,
      councilApprovalCount: 1,
      authorizedTransferCount: 3,
      authorizedTransferRewardAmount: 50n,
      signaturePenalty: 50n,
      earningsAmountMicrogons: 92n,
      amountAtRiskMicrogons: 57n,
      transactionCount: 4,
    });
  });

  it('surfaces council approvals and minting authorizations without bitcoin or revenue work', () => {
    const notice = createCollectBuilder(
      vaultSource({
        globalCouncilPendingApprovals: 2,
        pendingMintingAuthorizationTips: [25n],
      }),
    ).getNotice();

    expect(notice).toEqual({
      isProcessing: false,
      collectRevenue: 0n,
      expiringCollectAmount: 0n,
      nextCollectDueDate: 0,
      signatureCount: 0,
      nextCosignDueDate: 0,
      councilApprovalCount: 2,
      authorizedTransferCount: 1,
      authorizedTransferRewardAmount: 25n,
      signaturePenalty: 0n,
      earningsAmountMicrogons: 25n,
      amountAtRiskMicrogons: 0n,
      transactionCount: 2,
    });
  });

  it('returns null when there is nothing to collect or sign', () => {
    expect(createCollectBuilder(vaultSource()).getNotice()).toBeNull();
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
          actionType: 'approveCouncil' | 'collectRevenue' | 'cosignBitcoin';
          expectedCollectRevenue: bigint;
          cosignedUtxoIds: number[];
        };
      };
    } | null;
    pendingMintingAuthorizeTxInfosByTransferId: Map<
      string,
      {
        tx: {
          metadataJson: {
            actionType: 'authorizeTransfer';
          };
        };
      }
    >;
    globalCouncilPendingApprovals: number;
    pendingMintingAuthorizationTips: bigint[];
    pendingCosignUtxosById: Map<number, { targetValue: bigint }>;
    myPendingBitcoinCosignTxInfosByUtxoId: Map<number, unknown>;
    nextCollectDueDate: number;
    nextCosignDueDate: number;
  }> = {},
) {
  return {
    createdVault: { securitization: 10_000n },
    globalCouncil: {
      data: {
        pendingApprovals: Array.from({ length: data.globalCouncilPendingApprovals ?? 0 }, () => ({})),
      },
    },
    mintingAuthorities: {
      data: {
        authorities: [],
        pendingMintingAuthorizations: Array.from(data.pendingMintingAuthorizationTips ?? [], mintingAuthorityTip => ({
          mintingAuthorityTip,
        })),
        pendingMintingAuthorizeTxInfosByTransferId: data.pendingMintingAuthorizeTxInfosByTransferId ?? new Map(),
      },
    },
    data: {
      pendingCollectRevenue: 0n,
      expiringCollectAmount: 0n,
      pendingCollectTxInfo: null,
      pendingCosignUtxosById: new Map(),
      myPendingBitcoinCosignTxInfosByUtxoId: new Map(),
      nextCollectDueDate: 0,
      nextCosignDueDate: 0,
      ...data,
    },
  };
}

function createCollectBuilder(source: ReturnType<typeof vaultSource>) {
  return new VaultCollectBuilder({
    createdVault: source.createdVault,
    bitcoinLocks: { getLockByUtxoId: () => undefined },
    globalCouncil: source.globalCouncil,
    mintingAuthorities: source.mintingAuthorities,
    data: source.data,
  } as any);
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
