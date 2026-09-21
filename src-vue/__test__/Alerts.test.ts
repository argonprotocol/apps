import { describe, expect, it, vi } from 'vitest';
import { MoveTo, MoveToken, NetworkConfig } from '@argonprotocol/apps-core';
import { getBitcoinAlertNotices } from '../lib/Alerts.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { BITCOIN_BLOCK_MILLIS, TICK_MILLIS } from '../lib/Env.ts';
import type { IMintingAuthorityAuthorization, IMintingAuthorityAuthorizeMetadata } from '../lib/MintingAuthorities.ts';
import { type IVaultCollectMetadata, VaultCollectBuilder } from '../lib/VaultCollectBuilder.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { AppVaultOperator } from '../../e2e/actors/AppVaultOperator.ts';

describe('VaultCollectBuilder.getNotice', () => {
  it('keeps the collect plan visible while a collect step is in flight', () => {
    const notice = createCollectBuilder(
      vaultSource({
        pendingCollectRevenue: 42n,
        expiringCollectAmount: 7n,
        pendingCollectTxInfo: {
          tx: {
            metadataJson: {
              vaultId: 1,
              actionType: 'approveCouncil',
              expectedCollectRevenue: 0n,
              cosignedReleases: [],
              moveTo: MoveTo.VaultingSecurity,
            },
          },
        },
        pendingCosignLocksById: new Map([[11, { targetValue: 50n }]]),
        globalCouncilPendingApprovals: 1,
        pendingMintingAuthorizations: [
          {
            moveToken: MoveToken.ARGNOT,
            mintingAuthorityTip: 1_000n,
            mintingAuthorityTipShare: 100n,
            mintingAuthorityTipValueMicrogons: 25n,
          },
          {
            moveToken: MoveToken.ARGN,
            mintingAuthorityTip: 15n,
            mintingAuthorityTipShare: 15n,
            mintingAuthorityTipValueMicrogons: 15n,
          },
          {
            moveToken: MoveToken.ARGN,
            mintingAuthorityTip: 10n,
            mintingAuthorityTipShare: 10n,
            mintingAuthorityTipValueMicrogons: 10n,
          },
        ],
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
      orphanSignatureCount: 0,
      nextCosignDueDate: 5678,
      councilApprovalCount: 1,
      authorizedTransferCount: 3,
      authorizedTransferRewardAmount: 50n,
      pendingAuthorizedTransferCount: 0,
      pendingAuthorizedTransferRewardAmount: 0n,
      signaturePenalty: 50n,
      earningsAmountMicrogons: 42n,
      amountAtRiskMicrogons: 57n,
      transactionCount: 4,
      processing: {
        actionType: 'approveCouncil',
        collectRevenue: 0n,
        signatureCount: 0,
        councilApprovalCount: 0,
      },
    });
  });

  it('surfaces council approvals and minting authorizations without bitcoin or revenue work', () => {
    const notice = createCollectBuilder(
      vaultSource({
        globalCouncilPendingApprovals: 2,
        pendingMintingAuthorizations: [
          {
            moveToken: MoveToken.ARGNOT,
            mintingAuthorityTip: 1_000n,
            mintingAuthorityTipShare: 100n,
            mintingAuthorityTipValueMicrogons: 25n,
          },
        ],
      }),
    ).getNotice();

    expect(notice).toEqual({
      isProcessing: false,
      collectRevenue: 0n,
      expiringCollectAmount: 0n,
      nextCollectDueDate: 0,
      signatureCount: 0,
      orphanSignatureCount: 0,
      nextCosignDueDate: 0,
      councilApprovalCount: 2,
      authorizedTransferCount: 1,
      authorizedTransferRewardAmount: 25n,
      pendingAuthorizedTransferCount: 0,
      pendingAuthorizedTransferRewardAmount: 0n,
      signaturePenalty: 0n,
      earningsAmountMicrogons: 0n,
      amountAtRiskMicrogons: 0n,
      transactionCount: 2,
      processing: undefined,
    });
  });

  it('returns null when there is nothing to collect or sign', () => {
    expect(createCollectBuilder(vaultSource()).getNotice()).toBeNull();
  });

  it('keeps the snapshot-valued tip share while an ARGNOT authorization is processing', () => {
    const metadataJson: IMintingAuthorityAuthorizeMetadata = {
      actionType: 'authorizeTransfer',
      authorizations: [
        {
          authorityIndex: 0,
          transferId: '0xtransfer',
          mintingAuthorityTip: 1_250_000n,
          mintingAuthorityTipShare: 500_000n,
          mintingAuthorityTipValueMicrogons: 2_000_000n,
          microgonCollateral: 0n,
          micronotCollateral: 2_000_000n,
        },
      ],
    };
    const notice = createCollectBuilder(
      vaultSource({
        pendingMintingAuthorizeTxInfosByTransferId: new Map([
          [
            '0xtransfer',
            {
              isPostProcessed: false,
              tx: { id: 1, metadataJson },
            },
          ],
        ]),
      }),
    ).getNotice();

    expect(notice?.pendingAuthorizedTransferCount).toBe(1);
    expect(notice?.pendingAuthorizedTransferRewardAmount).toBe(2_000_000n);
  });

  it('surfaces orphan release signatures without other vault work', () => {
    const notice = createCollectBuilder(
      vaultSource({
        pendingOrphanCosignCount: 2,
      }),
    ).getNotice();

    expect(notice?.signatureCount).toBe(2);
    expect(notice?.orphanSignatureCount).toBe(2);
    expect(notice?.transactionCount).toBe(1);
  });

  it('keeps a release from the Vault owner available for explicit collect approval', () => {
    const source = vaultSource({ pendingCosignLocksById: new Map([[11, { targetValue: 50n }]]) });
    const notice = createCollectBuilder(source, new Set([11])).getNotice();

    expect(notice?.signatureCount).toBe(1);
    expect(notice?.transactionCount).toBe(1);
  });

  it('marks revenue collection as processing only when the active submission is collecting revenue', () => {
    const notice = createCollectBuilder(
      vaultSource({
        pendingCollectRevenue: 42n,
        pendingCollectTxInfo: {
          tx: {
            metadataJson: {
              vaultId: 1,
              actionType: 'collectRevenue',
              expectedCollectRevenue: 42n,
              cosignedReleases: [],
              cosignedOrphanUtxos: [],
              moveTo: MoveTo.VaultingSecurity,
            },
          },
        },
      }),
    ).getNotice();

    expect(notice?.isProcessing).toBe(true);
    expect(notice?.processing).toEqual({
      actionType: 'collectRevenue',
      collectRevenue: 42n,
      signatureCount: 0,
      councilApprovalCount: 0,
    });
  });
});

describe('AppVaultOperator vault alert poller', () => {
  it('submits orphan signatures through the vault alert collect path', async () => {
    const subscribe = vi.fn().mockResolvedValue(undefined);
    const source = vaultSource({ pendingOrphanCosignCount: 1 });
    const collectBuilder = createCollectBuilder(source);
    const getNotice = vi.spyOn(collectBuilder, 'getNotice');
    const collect = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        source.data.pendingOrphanCosignCount = 0;
        return { waitForPostProcessing: Promise.resolve() };
      });
    const actor = Object.assign(Object.create(AppVaultOperator.prototype), {
      myVault: { subscribe, collectBuilder, collect },
    }) as AppVaultOperator;

    const abortController = new AbortController();
    const poller = actor.pollVaultAlerts({ signal: abortController.signal, pollMs: 1 });
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
    abortController.abort();
    await poller;

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(getNotice).toHaveBeenCalled();
    expect(collect).toHaveBeenCalledWith({ moveTo: MoveTo.DefaultArgon });
  });
});

describe('getBitcoinAlertNotices', () => {
  it('ignores submitted locks until finalized script details exist', () => {
    const source = bitcoinSource({
      locks: [lock(2, { status: BitcoinLockStatus.LockIsProcessingOnArgon })],
    });
    source.unlockDeadlineTime = () => {
      throw new Error('Submitted locks do not have script details.');
    };

    expect(getBitcoinAlertNotices(source)).toEqual([]);
  });

  it('only shows securitizationHoldExpiring once less than 25% of the hold remains', () => {
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
    ).toEqual(['securitizationHoldExpiring']);

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

  it('keeps valid Bitcoin alerts when an old pending lock has no funding deadline', () => {
    const now = Date.now();
    const alerts = getBitcoinAlertNotices(
      bitcoinSource({
        locks: [lock(2, { securitizationHoldExpirationBitcoinHeight: undefined }), lock(3)],
        fundingDeadlines: { 3: now + BITCOIN_BLOCK_MILLIS },
      }),
      now,
    );

    expect(alerts.map(alert => [alert.kind, alert.lock.lockId])).toEqual([['securitizationHoldExpiring', 3]]);
  });

  it('sorts attention alerts by severity and urgency', () => {
    const now = Date.now();
    const nearUnlockDeadline = now + 10 * NetworkConfig.rewardTicksPerFrame * TICK_MILLIS - 1;

    const alerts = getBitcoinAlertNotices(
      bitcoinSource({
        locks: [
          lock(14),
          lock(13, { status: BitcoinLockStatus.LockFunded }),
          lock(12),
          lock(11, { status: BitcoinLockStatus.LockFunded }),
        ],
        releaseErrorsByLockId: { 11: 'vault cosign failed' },
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
      'unlockExpiring',
      'securitizationHoldExpiring',
    ]);
  });
});

function vaultSource(
  data: Partial<{
    pendingCollectRevenue: bigint;
    expiringCollectAmount: bigint;
    pendingCollectTxInfo: {
      tx: {
        metadataJson: IVaultCollectMetadata;
      };
    } | null;
    pendingMintingAuthorizeTxInfosByTransferId: Map<
      string,
      {
        isPostProcessed: boolean;
        tx: {
          id: number;
          metadataJson: IMintingAuthorityAuthorizeMetadata;
        };
      }
    >;
    globalCouncilPendingApprovals: number;
    pendingMintingAuthorizations: Array<
      Pick<
        IMintingAuthorityAuthorization,
        'moveToken' | 'mintingAuthorityTip' | 'mintingAuthorityTipShare' | 'mintingAuthorityTipValueMicrogons'
      >
    >;
    pendingCosignLocksById: Map<number, { targetValue: bigint }>;
    pendingOrphanCosignCount: number;
    myPendingBitcoinCosignTxInfosByLockId: Map<number, unknown>;
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
        pendingMintingAuthorizations: data.pendingMintingAuthorizations ?? [],
        pendingMintingAuthorizeTxInfosByTransferId: data.pendingMintingAuthorizeTxInfosByTransferId ?? new Map(),
      },
    },
    data: {
      pendingCollectRevenue: 0n,
      expiringCollectAmount: 0n,
      pendingCollectTxInfo: null,
      pendingCosignLocksById: new Map(),
      pendingOrphanCosignCount: 0,
      myPendingBitcoinCosignTxInfosByLockId: new Map(),
      nextCollectDueDate: 0,
      nextCosignDueDate: 0,
      ...data,
    },
  };
}

function createCollectBuilder(source: ReturnType<typeof vaultSource>, ownLockIds = new Set<number>()) {
  return new VaultCollectBuilder({
    createdVault: source.createdVault,
    bitcoinLocks: { getLockById: (lockId: number) => (ownLockIds.has(lockId) ? { lockId } : undefined) },
    globalCouncil: source.globalCouncil,
    mintingAuthorities: source.mintingAuthorities,
    data: source.data,
  } as any);
}

function bitcoinSource(args: {
  locks: IBitcoinLockRecord[];
  releaseErrorsByLockId?: Record<number, string>;
  releaseStates?: Record<number, { isReleaseStatus: boolean }>;
  unlockDeadlines?: Record<number, number>;
  fundingDeadlines?: Record<number, number>;
}) {
  const source = Object.create(BitcoinLocks.prototype) as BitcoinLocks;
  Object.defineProperties(
    source,
    Object.getOwnPropertyDescriptors({
      config: { securitizationHoldBlocks: 12 },
      getLockById: (lockId: number) => args.locks.find(lock => lock.lockId === lockId),
      getActiveLocks: () => args.locks,
      releases: {
        getActiveForLock: (lock: IBitcoinLockRecord) => {
          const statusError = args.releaseErrorsByLockId?.[lock.lockId ?? 0];
          return statusError ? { statusError } : undefined;
        },
        getLatestForLock: () => undefined,
      },
      getLockUnlockReleaseState: (lock: IBitcoinLockRecord) =>
        args.releaseStates?.[lock.lockId ?? 0] ?? { isReleaseStatus: false },
      isLockFunded: (lock: IBitcoinLockRecord) => lock.status === BitcoinLockStatus.LockFunded,
      unlockDeadlineTime: (lock: IBitcoinLockRecord) => args.unlockDeadlines?.[lock.lockId ?? 0] ?? 0,
      getSecuritizationHoldExpirationTime: (lock: IBitcoinLockRecord) => {
        if (
          lock.scriptDetails?.createdAtHeight === undefined ||
          lock.securitizationHoldExpirationBitcoinHeight === undefined
        ) {
          throw new Error('Bitcoin lock funding terms are unavailable.');
        }
        return args.fundingDeadlines?.[lock.lockId ?? 0] ?? 0;
      },
    }),
  );
  return source;
}

function lock(lockId: number, overrides: Partial<IBitcoinLockRecord> = {}): IBitcoinLockRecord {
  return {
    lockId,
    status: BitcoinLockStatus.LockPendingFunding,
    scriptDetails: { createdAtHeight: 1 } as IBitcoinLockRecord['scriptDetails'],
    securitizationHoldExpirationBitcoinHeight: 13,
    createdAt: new Date(`2026-01-${String(lockId).padStart(2, '0')}T00:00:00Z`),
    ...overrides,
  } as IBitcoinLockRecord;
}
