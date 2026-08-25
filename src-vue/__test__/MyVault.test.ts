import { describe, expect, it, vi } from 'vitest';
import { targetVaultDelegateBalance, type MiningFrames, Vault } from '@argonprotocol/apps-core';
import { reactive } from 'vue';
import { MyVault, type IVaultIncreaseAllocationMetadata } from '../lib/MyVault.ts';
import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import { TransactionInfo } from '../lib/TransactionInfo.ts';
import { TxAttemptState, type TransactionTracker } from '../lib/TransactionTracker.ts';
import * as mainchainStore from '../stores/mainchain.ts';
import { ExtrinsicType, TransactionStatus, type ITransactionRecord } from '../lib/db/TransactionsTable.ts';
import {
  TransactionHistoryStatus,
  type ITransactionStatusHistoryRecord,
} from '../lib/db/TransactionStatusHistoryTable.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { bigintCodec, numberCodec, optionCodec } from '../../core/__test__/helpers/codecs.ts';
import { getOfflineRegistry, type ArgonPrimitivesVault } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { MyVaultRecovery } from '../lib/recovery/MyVaultRecovery.ts';

type IMyVaultTestTarget = {
  buildPendingOrphanCosignTxs(args: {
    finalizedClient: unknown;
    submitClient: unknown;
    vaultId: number;
  }): Promise<Array<{ tx: unknown; metadata: unknown }>>;
  buildCosignTx(args: {
    utxoId: number;
    releaseRequest: { toScriptPubkey: string; bitcoinNetworkFee: bigint };
  }): Promise<{ tx: unknown; vaultSignature: Uint8Array } | undefined>;
  cosignRelease(args: {
    utxoId: number;
    releaseRequest: { toScriptPubkey: string; bitcoinNetworkFee: bigint };
  }): Promise<{ txInfo: TransactionInfo; vaultSignature: Uint8Array } | undefined>;
  onCosignResult(txInfo: TransactionInfo<{ utxoId: number }>): Promise<void>;
  recordPendingCosignUtxos(rawUtxoIds: Iterable<unknown>, updateSeq: number): Promise<void>;
  updateCollectDeadlines(): void;
  trackTxResultFee(txResult: unknown): Promise<void>;
  recordFee(txResult: { finalFee?: bigint; finalFeeTip?: bigint }): void;
  onVaultCreated(txInfo: TransactionInfo<{ masterXpubPath: string }>): Promise<Vault>;
  onIncreaseVaultSecuritization(txInfo: TransactionInfo<IVaultIncreaseAllocationMetadata>): Promise<void>;
};

describe('MyVaultRecovery', () => {
  it('restores sensible percentages when the vault has no committed capital', () => {
    const rules = MyVaultRecovery.rebuildRules({
      feesInMicrogons: 0n,
      vault: {
        securitization: 0n,
        securitizationRatio: 1,
        terms: {
          treasuryProfitSharing: BigNumber(0.1),
          bitcoinBaseFee: 0n,
          bitcoinAnnualPercentRate: BigNumber(0.02),
        },
      },
    });

    expect(rules).toMatchObject({
      baseMicrogonCommitment: 0n,
      capitalForSecuritizationPct: 100,
      capitalForTreasuryPct: 0,
      personalBtcPct: 0,
    });
  });
});

describe('MyVault crosschain queue history', () => {
  it('returns approval work without mixing in registration or personal transfer transactions', () => {
    const authorize = createTxInfo({ extrinsicType: ExtrinsicType.CrosschainTransferAuthorize });
    const councilApproval = createTxInfo({ extrinsicType: ExtrinsicType.CrosschainTransferApproveCouncil });
    const collectedCouncilApproval = createTxInfo({
      extrinsicType: ExtrinsicType.VaultCollect,
      metadataJson: { actionType: 'approveCouncil', councilApprovalCount: 2 },
    });
    const registration = createTxInfo({ extrinsicType: ExtrinsicType.CrosschainTransferRegisterMintingAuthority });
    const personalTransfer = createTxInfo({ extrinsicType: ExtrinsicType.CrosschainTransferTransferOut });
    const { myVault } = createVault({
      txInfos: [authorize, councilApproval, collectedCouncilApproval, registration, personalTransfer],
    });

    expect(myVault.getCrosschainQueueTxInfos()).toEqual([authorize, councilApproval, collectedCouncilApproval]);
  });
});

describe('MyVault cosign recovery', () => {
  it('updates collect alert state from finalized data', async () => {
    const unsubscribe = vi.fn();
    const subscribeStorage = vi.fn(async () => unsubscribe);
    const frameRevenues = vi
      .fn()
      .mockResolvedValueOnce([{ frameId: numberCodec(1), uncollectedRevenue: bigintCodec(42n) }])
      .mockResolvedValueOnce([{ frameId: numberCodec(1), uncollectedRevenue: bigintCodec(84n) }]);
    const orphanEntries = vi
      .fn()
      .mockResolvedValueOnce([[{}, numberCodec(2)]])
      .mockResolvedValueOnce([[{}, numberCodec(3)]]);
    const requestEvent = {
      section: 'bitcoinLocks',
      method: 'OrphanedUtxoReleaseRequested',
      data: { vaultId: numberCodec(7) },
    };
    const vaultEvent = { section: 'vaults', method: 'FundsLocked', data: { vaultId: numberCodec(7) } };
    const blockEvents: { event: unknown }[] = [{ event: requestEvent }];
    const eventMatcher = (method: string) => ({ is: (event: { method?: string }) => event.method === method });
    const unrelatedEvent = eventMatcher('Unrelated');
    const bitcoinEvents = {
      BitcoinLockCreated: eventMatcher('BitcoinLockCreated'),
      BitcoinLockFlexibleChanged: unrelatedEvent,
      BitcoinLockRatcheted: unrelatedEvent,
      BitcoinUtxoCosignRequested: unrelatedEvent,
      BitcoinUtxoCosigned: unrelatedEvent,
      BitcoinCosignPastDue: unrelatedEvent,
      BitcoinLockBurned: unrelatedEvent,
      OrphanedUtxoReleaseRequested: eventMatcher('OrphanedUtxoReleaseRequested'),
      OrphanedUtxoCosigned: unrelatedEvent,
    };
    const vaultEvents = {
      FundsLocked: eventMatcher('FundsLocked'),
      VaultCollected: unrelatedEvent,
      VaultRevenueUncollected: unrelatedEvent,
    };
    const client = {
      clientType: 'pruned',
      query: {
        vaults: {
          vaultsById: subscribeStorage,
          revenuePerFrameByVault: subscribeStorage,
          pendingCosignByVaultId: subscribeStorage,
          lastCollectFrameByVaultId: subscribeStorage,
          argonotCommitmentByVaultId: subscribeStorage,
        },
      },
      on: vi.fn(),
    };
    const eventClient = {
      events: { bitcoinLocks: bitcoinEvents },
    };
    const finalizedApi = {
      events: { bitcoinLocks: bitcoinEvents, vaults: vaultEvents },
      query: {
        vaults: {
          revenuePerFrameByVault: frameRevenues,
          pendingCosignByVaultId: vi.fn(async () => []),
          orphanedUtxoAccountsByVaultId: { entries: orphanEntries },
        },
      },
    };
    const clients = {
      get: vi.fn(async () => client),
      events: { on: vi.fn(() => unsubscribe) },
    };
    const getMainchainClients = vi.spyOn(mainchainStore, 'getMainchainClients').mockReturnValue(clients as any);
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(eventClient as any);
    const { myVault, blockWatchEventOn, getBlockEvents, getBlockEventsWithSpec } = createVault({
      blockEvents,
      finalizedApi,
    });
    myVault.data.createdVault = { vaultId: 7 } as Vault;
    myVault.data.metadata = { id: 7 } as any;
    vi.spyOn(myVault as unknown as IMyVaultTestTarget, 'updateCollectDeadlines').mockImplementation(() => undefined);

    await myVault.subscribe();

    expect(myVault.data.pendingOrphanCosignCount).toBe(2);
    expect(myVault.data.pendingCollectRevenue).toBe(42n);

    const onBestBlocks = blockWatchEventOn.mock.calls.find(([event]) => event === 'best-blocks')![1];
    onBestBlocks([{ blockNumber: 10, blockHash: '0x10' }]);
    await vi.waitFor(() => {
      expect(getBlockEvents).toHaveBeenCalledTimes(1);
    });
    expect(myVault.data.pendingOrphanCosignCount).toBe(2);
    expect(myVault.data.pendingCollectRevenue).toBe(42n);

    const onFinalized = blockWatchEventOn.mock.calls.find(([event]) => event === 'finalized')![1];
    blockEvents.splice(
      0,
      1,
      { event: { method: 'BitcoinLockCreated', data: { vaultId: numberCodec(7) } } },
      { event: { method: 'OrphanedUtxoReleaseRequested', data: { vaultId: numberCodec(8) } } },
      { event: { method: 'FundsLocked', data: { vaultId: numberCodec(8) } } },
    );
    await onFinalized([{ blockNumber: 9, blockHash: '0x09' }]);

    expect(orphanEntries).toHaveBeenCalledTimes(1);
    expect(frameRevenues).toHaveBeenCalledTimes(1);

    blockEvents.splice(0, blockEvents.length, { event: requestEvent });
    await onFinalized([{ blockNumber: 10, blockHash: '0x10' }]);

    expect(myVault.data.pendingOrphanCosignCount).toBe(3);
    expect(myVault.data.pendingCollectRevenue).toBe(42n);

    blockEvents.splice(0, 1, { event: vaultEvent });
    await onFinalized([{ blockNumber: 11, blockHash: '0x11' }]);

    expect(myVault.data.pendingCollectRevenue).toBe(84n);
    expect(getBlockEventsWithSpec).toHaveBeenCalledTimes(3);

    myVault.unsubscribe();
    getMainchainClient.mockRestore();
    getMainchainClients.mockRestore();
  });

  it('does not add the informational tip to the actual transaction fee twice', () => {
    const { myVault } = createVault();
    myVault.data.metadata = { operationalFeeMicrogons: 10n } as any;

    (myVault as unknown as IMyVaultTestTarget).recordFee({ finalFee: 5n, finalFeeTip: 2n });

    expect(myVault.data.metadata!.operationalFeeMicrogons).toBe(15n);
  });

  it('reuses a recent submitted cosign tx', async () => {
    const txInfo = createTxInfo({
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 11 },
    });
    const { myVault } = createVault({ txInfos: [txInfo], finalizedHeight: 101 });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(11);

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Pending });
  });

  it('ignores an old submitted cosign tx after the grace window', async () => {
    const txInfo = createTxInfo({
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 12 },
    });
    const { myVault } = createVault({ txInfos: [txInfo], finalizedHeight: 103 });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(12);

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('ignores a dropped cosign tx immediately so it can be retried', async () => {
    const txInfo = createTxInfo({
      id: 20,
      status: TransactionStatus.Submitted,
      txNonce: 7,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 20 },
    });
    const { myVault } = createVault({
      txInfos: [txInfo],
      finalizedHeight: 100,
      historyByTxId: {
        20: [{ id: 1, transactionId: 20, status: TransactionHistoryStatus.Dropped }],
      },
    });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(20);

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('ignores a reorged in-block cosign tx after the grace window', async () => {
    const txInfo = createTxInfo({
      status: TransactionStatus.InBlock,
      submittedAtBlockHeight: 100,
      blockHeight: 100,
      blockHash: '0xold',
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 13 },
    });
    const { myVault, blockWatch } = createVault({
      txInfos: [txInfo],
      finalizedHeight: 103,
      headerByHeight: { 100: '0xnew' },
    });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(13);

    expect(blockWatch.getHeader).toHaveBeenCalledWith(100);
    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('resubmits a cosign when the previous in-block attempt was reorged out', async () => {
    const staleTxInfo = createTxInfo({
      status: TransactionStatus.InBlock,
      submittedAtBlockHeight: 100,
      blockHeight: 100,
      blockHash: '0xold',
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 14 },
    });
    const freshTxInfo = createTxInfo({
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 103,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 14 },
    });
    const submitAndWatch = vi.fn().mockResolvedValue(freshTxInfo);
    const { myVault } = createVault({
      txInfos: [staleTxInfo],
      finalizedHeight: 103,
      headerByHeight: { 100: '0xnew' },
      submitAndWatch,
    });
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'buildCosignTx').mockResolvedValue({
      tx: { kind: 'cosign' },
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
    vi.spyOn(testVault, 'onCosignResult').mockResolvedValue(undefined);

    const result = await testVault.cosignRelease({
      utxoId: 14,
      releaseRequest: {
        toScriptPubkey: '0014abcd',
        bitcoinNetworkFee: 10n,
      },
    });

    expect(submitAndWatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      txInfo: freshTxInfo,
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
  });

  it('resubmits a dropped cosign and links it as a follow-on attempt', async () => {
    const staleTxInfo = createTxInfo({
      id: 21,
      status: TransactionStatus.Submitted,
      txNonce: 7,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 21 },
    });
    const freshTxInfo = createTxInfo({
      id: 22,
      status: TransactionStatus.Submitted,
      txNonce: 8,
      submittedAtBlockHeight: 101,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 21 },
    });
    const submitAndWatch = vi.fn().mockResolvedValue(freshTxInfo);
    const followOnTx = { resolve: vi.fn(), isSettled: false };
    const createIntentForFollowOnTx = vi.fn().mockReturnValue(followOnTx);
    const { myVault } = createVault({
      txInfos: [staleTxInfo],
      finalizedHeight: 100,
      historyByTxId: {
        21: [{ id: 1, transactionId: 21, status: TransactionHistoryStatus.Dropped }],
      },
      submitAndWatch,
      createIntentForFollowOnTx,
    });
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'buildCosignTx').mockResolvedValue({
      tx: { kind: 'cosign' },
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
    vi.spyOn(testVault, 'onCosignResult').mockResolvedValue(undefined);

    const result = await testVault.cosignRelease({
      utxoId: 21,
      releaseRequest: {
        toScriptPubkey: '0014abcd',
        bitcoinNetworkFee: 10n,
      },
    });

    expect(createIntentForFollowOnTx).toHaveBeenCalledWith(staleTxInfo);
    expect(followOnTx.resolve).toHaveBeenCalledWith(freshTxInfo);
    expect(submitAndWatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      txInfo: freshTxInfo,
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
  });

  it('resubmits from the latest dropped cosign attempt in a retry chain', async () => {
    const originalTxInfo = createTxInfo({
      id: 30,
      status: TransactionStatus.Submitted,
      txNonce: 7,
      followOnTxId: 31,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 30 },
    });
    const droppedRetryTxInfo = createTxInfo({
      id: 31,
      status: TransactionStatus.Submitted,
      txNonce: 8,
      submittedAtBlockHeight: 101,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 30 },
    });
    const freshTxInfo = createTxInfo({
      id: 32,
      status: TransactionStatus.Submitted,
      txNonce: 9,
      submittedAtBlockHeight: 102,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 30 },
    });
    const submitAndWatch = vi.fn().mockResolvedValue(freshTxInfo);
    const followOnTx = { resolve: vi.fn(), isSettled: false };
    const createIntentForFollowOnTx = vi.fn().mockReturnValue(followOnTx);
    const { myVault } = createVault({
      txInfos: [droppedRetryTxInfo, originalTxInfo],
      finalizedHeight: 101,
      historyByTxId: {
        31: [{ id: 1, transactionId: 31, status: TransactionHistoryStatus.Dropped }],
      },
      submitAndWatch,
      createIntentForFollowOnTx,
    });
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'buildCosignTx').mockResolvedValue({
      tx: { kind: 'cosign' },
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
    vi.spyOn(testVault, 'onCosignResult').mockResolvedValue(undefined);

    const result = await testVault.cosignRelease({
      utxoId: 30,
      releaseRequest: {
        toScriptPubkey: '0014abcd',
        bitcoinNetworkFee: 10n,
      },
    });

    expect(createIntentForFollowOnTx).toHaveBeenCalledTimes(1);
    expect(createIntentForFollowOnTx).toHaveBeenCalledWith(droppedRetryTxInfo);
    expect(followOnTx.resolve).toHaveBeenCalledWith(freshTxInfo);
    expect(submitAndWatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      txInfo: freshTxInfo,
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
  });

  it('rejects the follow-on intent if cosign resubmission fails', async () => {
    const staleTxInfo = createTxInfo({
      id: 25,
      status: TransactionStatus.Submitted,
      txNonce: 7,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 25 },
    });
    const submitError = new Error('submit failed');
    const submitAndWatch = vi.fn().mockRejectedValue(submitError);
    const followOnTx = { resolve: vi.fn(), reject: vi.fn(), isSettled: false };
    const createIntentForFollowOnTx = vi.fn().mockReturnValue(followOnTx);
    const { myVault } = createVault({
      txInfos: [staleTxInfo],
      finalizedHeight: 100,
      historyByTxId: {
        25: [{ id: 1, transactionId: 25, status: TransactionHistoryStatus.Dropped }],
      },
      submitAndWatch,
      createIntentForFollowOnTx,
    });
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'buildCosignTx').mockResolvedValue({
      tx: { kind: 'cosign' },
      vaultSignature: new Uint8Array([1, 2, 3]),
    });

    await expect(
      testVault.cosignRelease({
        utxoId: 25,
        releaseRequest: {
          toScriptPubkey: '0014abcd',
          bitcoinNetworkFee: 10n,
        },
      }),
    ).rejects.toThrow('submit failed');

    expect(createIntentForFollowOnTx).toHaveBeenCalledWith(staleTxInfo);
    expect(followOnTx.reject).toHaveBeenCalledWith(submitError);
    expect(followOnTx.resolve).not.toHaveBeenCalled();
  });

  it('ignores a retracted cosign once the nonce lane has moved on-chain', async () => {
    const txInfo = createTxInfo({
      id: 23,
      status: TransactionStatus.InBlock,
      txNonce: 7,
      submittedAtBlockHeight: 100,
      blockHeight: 100,
      blockHash: '0xold',
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 23 },
    });
    const newerTxInfo = createTxInfo({
      id: 24,
      status: TransactionStatus.Finalized,
      txNonce: 8,
      submittedAtBlockHeight: 101,
      accountAddress: txInfo.tx.accountAddress,
      extrinsicType: ExtrinsicType.VaultCollect,
      metadataJson: { cosignedUtxoIds: [] },
    });
    const { myVault } = createVault({
      txInfos: [txInfo, newerTxInfo],
      finalizedHeight: 101,
      headerByHeight: { 100: '0xold' },
      historyByTxId: {
        23: [{ id: 1, transactionId: 23, status: TransactionHistoryStatus.Retracted }],
      },
    });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(23);

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('ignores failed finalized collect attempts as cosign carriers', async () => {
    const txInfo = createTxInfo({
      id: 26,
      status: TransactionStatus.Finalized,
      extrinsicType: ExtrinsicType.VaultCollect,
      metadataJson: { cosignedUtxoIds: [26] },
      blockExtrinsicErrorJson: { message: 'PendingCosignsBeforeCollect' },
    });
    const { myVault } = createVault({
      txInfos: [txInfo],
      finalizedHeight: 101,
    });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(26);

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('tracks standalone cosign submissions while awaiting finalization', async () => {
    let resolveFinalized: (value: Uint8Array) => void;
    const waitForFinalizedBlock = new Promise<Uint8Array>(resolve => {
      resolveFinalized = resolve;
    });
    const postProcessor = { resolve: vi.fn() };
    const txInfo = {
      tx: {
        metadataJson: { utxoId: 15 },
      },
      txResult: {
        waitForFinalizedBlock,
      },
      createPostProcessor: vi.fn(() => postProcessor),
    } as unknown as TransactionInfo<{ utxoId: number }>;
    const { myVault } = createVault();
    const testVault = myVault as unknown as IMyVaultTestTarget;
    const trackTxResultFee = vi.spyOn(testVault, 'trackTxResultFee').mockResolvedValue(undefined);

    const pending = testVault.onCosignResult(txInfo);

    expect(myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.get(15)).toBe(txInfo);

    resolveFinalized!(new Uint8Array([1, 2, 3]));
    await pending;

    expect(trackTxResultFee).toHaveBeenCalledWith(txInfo.txResult);
    expect(postProcessor.resolve).toHaveBeenCalledTimes(1);
    expect(myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.size).toBe(0);
  });

  it('prunes stale standalone cosign progress when the utxo is no longer pending', async () => {
    const txInfo = createTxInfo({
      status: TransactionStatus.Submitted,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 16 },
    });
    const { myVault } = createVault();
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({} as any);
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'updateCollectDeadlines').mockImplementation(() => undefined);

    myVault.data.pendingCosignUtxosById.set(16, { targetValue: 1_000n });
    myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.set(16, txInfo as TransactionInfo<{ utxoId: number }>);

    await testVault.recordPendingCosignUtxos([], 0);

    expect(myVault.data.pendingCosignUtxosById.size).toBe(0);
    expect(myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.size).toBe(0);

    getMainchainClient.mockRestore();
  });

  it('submits combined vault securitization through TxSubmitter and tracks both amounts', async () => {
    const { myVault, trackTxResult } = createVault();
    const tx = createMockTxResultTx();
    const txResultInfo = createTxInfo({
      extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
      metadataJson: {
        securitizationMicrogons: 1_100n,
        vaultId: 7,
      },
    });
    myVault.data.createdVault = {
      vaultId: 7,
      securitization: 1_000n,
      securitizationRatio: 1,
    } as any;
    myVault.data.argonotCommitment.committedMicronots = 100n;
    const buildSecuritizationTx = vi
      .spyOn(myVault as unknown as { buildSecuritizationTx: MyVault['buildSecuritizationTx'] }, 'buildSecuritizationTx')
      .mockResolvedValue(tx as any);
    vi.spyOn(myVault as any, 'onIncreaseVaultSecuritization').mockResolvedValue(undefined);
    trackTxResult.mockResolvedValue(txResultInfo);
    const client = {
      genesisHash: { toHex: () => '0xgenesis' },
      runtimeVersion: {
        specVersion: { toNumber: () => 151 },
        transactionVersion: { toNumber: () => 5 },
      },
      registry: { signedExtensions: ['AuthorizeCall', 'CheckMetadataHash'] },
      rpc: {
        chain: {
          getHeader: vi.fn(async () => ({ number: { toNumber: () => 170 } })),
        },
        system: {
          accountNextIndex: vi.fn(async () => 9),
          dryRun: vi.fn(async () => ({ toHuman: () => ({ Ok: { Ok: [] } }) })),
        },
      },
    };
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(client as any);

    const result = await myVault.setVaultSecuritization({
      securitizationMicrogons: 1_100n,
      committedMicronots: 350n,
      metadata: { moveFrom: 'VaultingHold', moveTo: 'VaultingSecurity' },
    });

    expect(buildSecuritizationTx).toHaveBeenCalledWith(
      {
        securitizationMicrogons: 1_100n,
        committedMicronots: 350n,
      },
      client,
    );
    expect(tx.signAsync).toHaveBeenCalledWith(expect.objectContaining({ address: expect.any(String) }), {
      nonce: 9,
      tip: undefined,
    });
    expect(tx.signedTx.send).toHaveBeenCalledTimes(1);
    expect(trackTxResult).toHaveBeenCalledWith({
      txResult: expect.objectContaining({
        extrinsic: expect.objectContaining({
          nonce: 9,
          submittedAtBlockNumber: 170,
        }),
      }),
      extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
      metadata: {
        securitizationMicrogons: 1_100n,
        securitizationChangeMicrogons: 100n,
        committedMicronots: 350n,
        argonotChangeMicronots: 250n,
        vaultId: 7,
        moveFrom: 'VaultingHold',
        moveTo: 'VaultingSecurity',
      },
    });
    expect(result).toBe(txResultInfo);

    getMainchainClient.mockRestore();
  });

  it('publishes the current securitization transaction until its post-processing finishes', async () => {
    const finalizationResolvers: Array<() => void> = [];
    const createPendingTxInfo = (id: number) => {
      const waitForFinalizedBlock = new Promise<void>(resolve => finalizationResolvers.push(resolve));
      return {
        tx: { id },
        txResult: { waitForFinalizedBlock },
        createPostProcessor: vi.fn(() => ({ resolve: vi.fn(), reject: vi.fn() })),
      } as unknown as TransactionInfo<IVaultIncreaseAllocationMetadata>;
    };
    const firstTxInfo = createPendingTxInfo(41);
    const secondTxInfo = createPendingTxInfo(42);
    const { myVault } = createVault();
    myVault.data = reactive(myVault.data) as typeof myVault.data;
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'trackTxResultFee').mockResolvedValue(undefined);
    vi.spyOn(myVault, 'recordFinalizedVaultCapital').mockResolvedValue(undefined);

    const firstProcessing = testVault.onIncreaseVaultSecuritization(firstTxInfo);
    expect(myVault.data.pendingAllocateTxInfo?.tx.id).toBe(41);

    const secondProcessing = testVault.onIncreaseVaultSecuritization(secondTxInfo);
    expect(myVault.data.pendingAllocateTxInfo?.tx.id).toBe(42);

    finalizationResolvers[0]();
    await firstProcessing;
    expect(myVault.data.pendingAllocateTxInfo?.tx.id).toBe(42);

    finalizationResolvers[1]();
    await secondProcessing;
    expect(myVault.data.pendingAllocateTxInfo).toBeNull();
  });

  it('uses the selected final ARGN and ARGNOT securitization amounts', async () => {
    const { myVault } = createVault();
    const fundingTx = { id: 'funding' };
    const commitmentTx = { id: 'commitment' };
    const batchTx = { id: 'batch' };
    myVault.data.createdVault = {
      vaultId: 7,
      securitization: 1_000n,
      securitizationRatio: 1,
    } as any;
    myVault.data.argonotCommitment.committedMicronots = 100n;
    const client = {
      tx: {
        vaults: {
          modifyFunding: vi.fn(() => fundingTx),
          setCommittedArgonots: vi.fn(() => commitmentTx),
        },
        utility: {
          batchAll: vi.fn(() => batchTx),
        },
      },
    };

    const result = await myVault.buildSecuritizationTx(
      {
        securitizationMicrogons: 900n,
        committedMicronots: 80n,
      },
      client as any,
    );

    expect(client.tx.vaults.modifyFunding).toHaveBeenCalledWith(7, 900n, 1_000_000_000_000_000_000n);
    expect(client.tx.vaults.setCommittedArgonots).toHaveBeenCalledWith(80n);
    expect(client.tx.utility.batchAll).toHaveBeenCalledWith([fundingTx, commitmentTx]);
    expect(result).toBe(batchTx);
  });

  it('reuses the pending collect tx instead of resubmitting collect work', async () => {
    const txInfo = createTxInfo({
      extrinsicType: ExtrinsicType.VaultCollect,
      metadataJson: {
        vaultId: 7,
        actionType: 'collectRevenue',
        expectedCollectRevenue: 0n,
        cosignedUtxoIds: [],
        moveTo: 'VaultingHold',
      },
    }) as TransactionInfo<any>;
    const { myVault, submitAndWatch } = createVault({ submitAndWatch: vi.fn() });
    myVault.data.pendingCollectTxInfo = txInfo;
    const getFinalizedClient = vi.spyOn(mainchainStore, 'getFinalizedClient').mockResolvedValue({} as any);

    const result = await myVault.collect({ moveTo: 'VaultingHold' as any });

    expect(result).toBe(txInfo);
    expect(submitAndWatch).not.toHaveBeenCalled();

    getFinalizedClient.mockRestore();
  });

  it('returns the in-flight collect tx without starting collateralization work', async () => {
    const collectTxInfo = createTxInfo({
      extrinsicType: ExtrinsicType.VaultCollect,
      metadataJson: {
        vaultId: 7,
        actionType: 'collectRevenue',
        expectedCollectRevenue: 40n,
        cosignedUtxoIds: [],
        moveTo: 'VaultingHold',
      },
    }) as TransactionInfo<any>;
    const { myVault, mintingAuthorities, submitAndWatch } = createVault();
    myVault.data.pendingCollectTxInfo = collectTxInfo;

    const result = await myVault.collect({ moveTo: 'VaultingHold' as any });

    expect(result).toBe(collectTxInfo);
    expect(submitAndWatch).not.toHaveBeenCalled();
    expect(mintingAuthorities.refresh).not.toHaveBeenCalled();
    expect(mintingAuthorities.authorize).not.toHaveBeenCalled();
  });

  it('clears a reactive pending collect tx after post-processing finishes', async () => {
    const txInfo = {
      tx: {
        id: 91,
        metadataJson: {
          vaultId: 7,
          moveTo: 'VaultingHold',
        },
      },
      txResult: {
        waitForFinalizedBlock: Promise.resolve(new Uint8Array([1, 2, 3])),
        waitForInFirstBlock: Promise.resolve(new Uint8Array([1, 2, 3])),
        events: [],
      },
      createPostProcessor: vi.fn(() => ({
        resolve: vi.fn(),
        reject: vi.fn(),
        isSettled: false,
      })),
    } as unknown as TransactionInfo<any>;
    const { myVault, globalCouncil, mintingAuthorities } = createVault();
    myVault.data = reactive(myVault.data) as any;
    myVault.data.pendingCollectTxInfo = txInfo;

    vi.spyOn(myVault as any, 'updateRevenueStats').mockResolvedValue(undefined);
    vi.spyOn(myVault as unknown as IMyVaultTestTarget, 'trackTxResultFee').mockResolvedValue(undefined);
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({} as any);
    const getFinalizedClient = vi.spyOn(mainchainStore, 'getFinalizedClient').mockResolvedValue({
      query: {
        vaults: {
          revenuePerFrameByVault: vi.fn().mockResolvedValue([]),
        },
      },
    } as any);

    await myVault.onVaultCollect(txInfo);

    expect(globalCouncil.refresh).toHaveBeenCalledTimes(1);
    expect(mintingAuthorities.refresh).toHaveBeenCalledTimes(1);
    expect(myVault.data.pendingCollectTxInfo).toBeNull();

    getMainchainClient.mockRestore();
    getFinalizedClient.mockRestore();
  });

  it('submits collect work without starting collateralization work inline', async () => {
    const collectTxInfo = createTxInfo({
      extrinsicType: ExtrinsicType.VaultCollect,
      metadataJson: {
        vaultId: 7,
        actionType: 'collectRevenue',
        expectedCollectRevenue: 40n,
        cosignedUtxoIds: [],
        moveTo: 'VaultingHold',
      },
    }) as TransactionInfo<any>;
    const { myVault, mintingAuthorities, submitAndWatch } = createVault({
      submitAndWatch: vi.fn().mockResolvedValue(collectTxInfo),
    });
    myVault.data.createdVault = { vaultId: 7 } as any;
    myVault.data.metadata = { id: 7 } as any;
    mintingAuthorities.refresh.mockResolvedValue([{ transferId: '0xaaa' }, { transferId: '0xbbb' }]);
    const getFinalizedClient = vi.spyOn(mainchainStore, 'getFinalizedClient').mockResolvedValue({} as any);
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({} as any);
    vi.spyOn(myVault.collectBuilder, 'buildPendingSubmission').mockResolvedValue({
      tx: { kind: 'collect' } as any,
      metadata: {
        vaultId: 7,
        actionType: 'collectRevenue',
        councilApprovalCount: 0,
        expectedCollectRevenue: 40n,
        cosignedUtxoIds: [],
        cosignedOrphanUtxos: [],
        moveTo: 'VaultingHold' as any,
      },
      submittedCosignUtxoIds: [],
    });
    vi.spyOn(myVault as any, 'onVaultCollect').mockRejectedValue(new Error('post-processing failed'));

    const result = await myVault.collect({ moveTo: 'VaultingHold' as any });

    expect(result).toBe(collectTxInfo);
    expect(submitAndWatch).toHaveBeenCalledTimes(1);
    expect(mintingAuthorities.authorize).not.toHaveBeenCalled();

    getFinalizedClient.mockRestore();
    getMainchainClient.mockRestore();
  });

  it('refreshes finalized alert state when no collect batch is available', async () => {
    const { myVault, mintingAuthorities } = createVault();
    myVault.data.createdVault = { vaultId: 7 } as any;
    myVault.data.metadata = { id: 7 } as any;
    myVault.data.pendingCollectRevenue = 42n;
    myVault.data.pendingOrphanCosignCount = 1;
    vi.spyOn(myVault as unknown as IMyVaultTestTarget, 'updateCollectDeadlines').mockImplementation(() => undefined);
    const getFinalizedClient = vi.spyOn(mainchainStore, 'getFinalizedClient').mockResolvedValue({
      query: {
        vaults: {
          pendingCosignByVaultId: vi.fn(async () => []),
          orphanedUtxoAccountsByVaultId: { entries: vi.fn(async () => []) },
          revenuePerFrameByVault: vi.fn(async () => []),
        },
      },
    } as any);
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({} as any);
    vi.spyOn(myVault.collectBuilder, 'buildPendingSubmission').mockResolvedValue(undefined);

    await expect(myVault.collect({ moveTo: 'VaultingHold' as any })).resolves.toBeUndefined();
    expect(mintingAuthorities.authorize).not.toHaveBeenCalled();
    expect(myVault.data.pendingCollectRevenue).toBe(0n);
    expect(myVault.data.pendingOrphanCosignCount).toBe(0);

    getFinalizedClient.mockRestore();
    getMainchainClient.mockRestore();
  });

  it('submits all current orphan cosigns before collecting revenue', async () => {
    const firstOrphanTx = { kind: 'first-orphan-cosign' };
    const secondOrphanTx = { kind: 'second-orphan-cosign' };
    const collectTx = { kind: 'collect' };
    const batchAll = vi.fn(() => ({ kind: 'batch' }));
    const collect = vi.fn(() => collectTx);
    const client = {
      query: {
        vaults: {
          pendingCosignByVaultId: vi.fn().mockResolvedValue([]),
          revenuePerFrameByVault: vi.fn().mockResolvedValue([{ uncollectedRevenue: { toBigInt: () => 40n } }]),
          orphanedUtxoAccountsByVaultId: {
            entries: vi.fn().mockResolvedValue([[{}, numberCodec(2)]]),
          },
        },
      },
      tx: {
        utility: { batchAll },
        vaults: { collect },
      },
    };
    const finalizedClient = client;
    const { myVault } = createVault();
    myVault.data.createdVault = { vaultId: 7 } as any;
    myVault.data.pendingOrphanCosignCount = 2;
    const firstOrphanMetadata = {
      lockUtxoId: 8,
      ownerAccount: 'owner-1',
      txid: 'a'.repeat(64),
      vout: 2,
      vaultSignatureHex: '0x1234',
    };
    const secondOrphanMetadata = {
      ...firstOrphanMetadata,
      txid: 'b'.repeat(64),
    };
    const buildPendingOrphanCosignTxs = vi
      .spyOn(myVault as unknown as IMyVaultTestTarget, 'buildPendingOrphanCosignTxs')
      .mockResolvedValueOnce([{ tx: firstOrphanTx, metadata: firstOrphanMetadata }])
      .mockResolvedValueOnce([
        { tx: firstOrphanTx, metadata: firstOrphanMetadata },
        { tx: secondOrphanTx, metadata: secondOrphanMetadata },
      ]);

    const partialSubmission = await myVault.collectBuilder.buildPendingSubmission({
      client: client as any,
      finalizedClient: finalizedClient as any,
      moveTo: 'VaultingHold' as any,
    });

    expect(collect).not.toHaveBeenCalled();
    expect(partialSubmission?.tx).toBe(firstOrphanTx);
    expect(partialSubmission?.metadata.actionType).toBe('cosignBitcoin');

    const completeSubmission = await myVault.collectBuilder.buildPendingSubmission({
      client: client as any,
      finalizedClient: finalizedClient as any,
      moveTo: 'VaultingHold' as any,
    });

    expect(buildPendingOrphanCosignTxs).toHaveBeenCalledWith({
      finalizedClient,
      submitClient: client,
      vaultId: 7,
    });
    expect(batchAll).toHaveBeenCalledWith([firstOrphanTx, secondOrphanTx, collectTx]);
    expect(completeSubmission?.metadata).toMatchObject({
      actionType: 'collectRevenue',
      cosignedOrphanUtxos: [firstOrphanMetadata, secondOrphanMetadata],
    });
  });

  it('batches council approvals into collect work', async () => {
    const buildApprovePendingGatewayUpdateTxs = vi.fn(async () => [{ kind: 'queue-approval' }]);
    const batchAll = vi.fn(() => ({ kind: 'batch' }));
    const collect = vi.fn(() => ({ kind: 'collect' }));
    const client = {
      query: {
        vaults: {
          pendingCosignByVaultId: vi.fn().mockResolvedValue([]),
          revenuePerFrameByVault: vi.fn().mockResolvedValue([{ uncollectedRevenue: { toBigInt: () => 40n } }]),
          orphanedUtxoAccountsByVaultId: { entries: vi.fn().mockResolvedValue([]) },
        },
      },
      tx: {
        crosschainTransfer: {},
        utility: {
          batchAll,
        },
        vaults: {
          collect,
        },
      },
    };
    const { myVault, globalCouncil, mintingAuthorities } = createVault();
    myVault.data.createdVault = {
      vaultId: 7,
    } as any;
    globalCouncil.refresh.mockResolvedValue([
      { approvalHash: '0x' + '11'.repeat(32) },
      { approvalHash: '0x' + '22'.repeat(32) },
    ]);
    globalCouncil.buildApprovePendingGatewayUpdateTxs = buildApprovePendingGatewayUpdateTxs;
    mintingAuthorities.refresh.mockResolvedValue([
      {
        authorityIndex: 2,
        destinationSigningKey: '0x' + '33'.repeat(20),
        transferId: '0x' + '44'.repeat(32),
        authorizationHash: '0x' + '55'.repeat(32),
        microgonCollateral: 0n,
        micronotCollateral: 25n,
      },
    ]);
    vi.spyOn(myVault as unknown as IMyVaultTestTarget, 'buildPendingOrphanCosignTxs').mockResolvedValue([]);

    const submission = await myVault.collectBuilder.buildPendingSubmission({
      client: client as any,
      finalizedClient: client as any,
      moveTo: 'VaultingHold' as any,
    });

    expect(buildApprovePendingGatewayUpdateTxs).toHaveBeenCalledWith(client, [
      { approvalHash: '0x' + '11'.repeat(32) },
      { approvalHash: '0x' + '22'.repeat(32) },
    ]);
    expect(collect).toHaveBeenCalledWith(7);
    expect(batchAll).toHaveBeenCalledWith([{ kind: 'queue-approval' }, { kind: 'collect' }]);
    expect(submission).toEqual({
      tx: { kind: 'batch' },
      metadata: {
        vaultId: 7,
        actionType: 'collectRevenue',
        councilApprovalCount: 2,
        expectedCollectRevenue: 40n,
        cosignedUtxoIds: [],
        cosignedOrphanUtxos: [],
        moveTo: 'VaultingHold',
      },
      submittedCosignUtxoIds: [],
    });
  });

  it('does not let collateralization block collect work', async () => {
    const buildApprovePendingGatewayUpdateTxs = vi.fn(async () => []);
    const batchAll = vi.fn(() => ({ kind: 'batch' }));
    const collect = vi.fn(() => ({ kind: 'collect' }));
    const client = {
      query: {
        vaults: {
          pendingCosignByVaultId: vi.fn().mockResolvedValue([]),
          revenuePerFrameByVault: vi.fn().mockResolvedValue([{ uncollectedRevenue: { toBigInt: () => 40n } }]),
          orphanedUtxoAccountsByVaultId: { entries: vi.fn().mockResolvedValue([]) },
        },
      },
      tx: {
        crosschainTransfer: {},
        utility: {
          batchAll,
        },
        vaults: {
          collect,
        },
      },
    };
    const { myVault, globalCouncil, mintingAuthorities } = createVault();
    myVault.data.createdVault = {
      vaultId: 7,
    } as any;
    globalCouncil.refresh.mockResolvedValue([]);
    globalCouncil.buildApprovePendingGatewayUpdateTxs = buildApprovePendingGatewayUpdateTxs;
    mintingAuthorities.refresh.mockResolvedValue([
      {
        authorityIndex: 2,
        destinationSigningKey: '0x' + '33'.repeat(20),
        transferId: '0x' + '44'.repeat(32),
        authorizationHash: '0x' + '55'.repeat(32),
        microgonCollateral: 0n,
        micronotCollateral: 25n,
      },
      {
        authorityIndex: 3,
        destinationSigningKey: '0x' + '44'.repeat(20),
        transferId: '0x' + '66'.repeat(32),
        authorizationHash: '0x' + '77'.repeat(32),
        microgonCollateral: 0n,
        micronotCollateral: 15n,
      },
    ]);
    vi.spyOn(myVault as unknown as IMyVaultTestTarget, 'buildPendingOrphanCosignTxs').mockResolvedValue([]);

    const submission = await myVault.collectBuilder.buildPendingSubmission({
      client: client as any,
      finalizedClient: client as any,
      moveTo: 'VaultingHold' as any,
    });

    expect(buildApprovePendingGatewayUpdateTxs).toHaveBeenCalledWith(client, []);
    expect(batchAll).not.toHaveBeenCalled();
    expect(collect).toHaveBeenCalledWith(7);
    expect(submission).toEqual({
      tx: { kind: 'collect' },
      metadata: {
        vaultId: 7,
        actionType: 'collectRevenue',
        councilApprovalCount: 0,
        expectedCollectRevenue: 40n,
        cosignedUtxoIds: [],
        cosignedOrphanUtxos: [],
        moveTo: 'VaultingHold',
      },
      submittedCosignUtxoIds: [],
    });
  });

  it('ignores failed orphan cosign txs', async () => {
    const txInfo = createTxInfo({
      status: TransactionStatus.TimedOutWaitingForBlock,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignOrphanedUtxoRelease,
      metadataJson: {
        ownerAccount: 'owner-1',
        txid: 'a'.repeat(64),
        vout: 2,
      },
    });
    const { myVault } = createVault({ txInfos: [txInfo], finalizedHeight: 103 });

    const latestTxAttempt = await myVault.findLatestOrphanCosignTxAttempt({
      ownerAccount: 'owner-1',
      txid: 'a'.repeat(64),
      vout: 2,
    });

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('retries completed delegate setup after reload when the vault still needs a delegate', async () => {
    const completedTxInfo = createTxInfo({
      status: TransactionStatus.Finalized,
      extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
    });
    const submittedTxInfo = createTxInfo({
      id: 2,
      extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
    });
    const submitAndWatch = vi.fn().mockResolvedValueOnce(completedTxInfo).mockResolvedValueOnce(submittedTxInfo);
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({
      consts: {
        vaults: {
          revenueCollectionExpirationFrames: {
            toNumber: () => 10,
          },
        },
      },
      query: {
        vaults: {
          argonotCommitmentByVaultId: vi.fn(async () => optionCodec()),
        },
      },
      tx: {
        operationalAccounts: {
          setName: vi.fn(() => ({ kind: 'set-name' })),
        },
        utility: {
          batchAll: vi.fn(() => ({ kind: 'delegate-setup' })),
        },
      },
    } as any);
    const myVault = new MyVault(
      Promise.resolve({
        vaultsTable: {
          get: vi.fn(async () => ({ id: 7, createdAtBlockHeight: 10 })),
        },
        transactionsTable: {
          fetchStatusHistory: vi.fn(async () => []),
        },
      } as any),
      {
        load: vi.fn(async () => undefined),
        updateRevenue: vi.fn(async () => undefined),
        vaultsById: { 7: { vaultId: 7, delegateAccountId: null } },
        operatorNamesByVaultId: {},
        stats: {
          synchedToFrame: 1,
          vaultsById: { 7: { vaultId: 7 } },
        },
      } as any,
      createMockWalletKeys(),
      {
        load: vi.fn(async () => undefined),
        pendingBlockTxInfosAtLoad: [],
        data: {
          txInfosByType: {
            [ExtrinsicType.VaultSetBitcoinLockDelegate]: completedTxInfo,
          },
        },
        findLatestTxAttempt: vi.fn().mockResolvedValue(undefined),
        submitAndWatch,
      } as any,
      {
        load: vi.fn(async () => undefined),
      } as any,
      {
        load: vi.fn(async () => undefined),
        currentFrameId: 2,
      } as any,
      {
        load: vi.fn(async () => undefined),
        data: { pendingApprovals: [] },
      } as any,
      {
        load: vi.fn(async () => undefined),
        data: {
          authorities: [],
          pendingMintingAuthorizations: [],
          pendingMintingAuthorizeTxInfosByTransferId: new Map(),
        },
      } as any,
    );
    vi.spyOn(myVault as any, 'refreshExternalLocks').mockResolvedValue(undefined);
    vi.spyOn(myVault as any, 'buildVaultDelegateSetupTxs').mockResolvedValue({
      needsSetup: true,
      txs: [{ kind: 'setup' }],
    });

    myVault.data.createdVault = myVault.vaults.vaultsById[7];
    await myVault.setupVaultInviteProfile({ operatorName: 'OperatorOne', currentOperatorName: '' });
    await myVault.load(true);
    const result = await myVault.setupVaultInviteProfile({ operatorName: 'OperatorOne', currentOperatorName: '' });

    expect(result).toBe(submittedTxInfo);
    expect(submitAndWatch).toHaveBeenCalledTimes(2);

    getMainchainClient.mockRestore();
  });

  it('resumes pending operator profile setup after restart without submitting it again', async () => {
    const pending = createTxInfo({
      extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 100,
    });
    const { myVault, submitAndWatch } = createVault({ txInfos: [pending] });
    const delegateAddress = await myVault.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    pending.tx.metadataJson = {
      vaultId: 7,
      delegateAddress,
      vaultName: 'OperatorOne',
    };
    myVault.data.createdVault = createTestVault({
      vaultId: 7,
      operatorAccountId: myVault.walletKeys.vaultingAddress,
      delegateAccountId: null,
    });

    const result = await myVault.setupVaultInviteProfile({ operatorName: 'OperatorOne', currentOperatorName: '' });

    expect(result).toBe(pending);
    expect(submitAndWatch).not.toHaveBeenCalled();
  });

  it('does not resubmit a finalized operator profile already reflected in profile state', async () => {
    const finalized = createTxInfo({
      extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
      status: TransactionStatus.Finalized,
    });
    const { myVault, submitAndWatch } = createVault({ txInfos: [finalized] });
    const delegateAddress = await myVault.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    finalized.tx.metadataJson = {
      vaultId: 7,
      delegateAddress,
      vaultName: 'OperatorOne',
    };
    const createdVault = createTestVault({
      vaultId: 7,
      operatorAccountId: myVault.walletKeys.vaultingAddress,
      delegateAccountId: delegateAddress,
    });
    myVault.data.createdVault = createdVault;
    vi.spyOn(myVault as any, 'buildVaultDelegateSetupTxs').mockResolvedValue({
      needsSetup: false,
      txs: [],
    });
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({} as any);

    const result = await myVault.setupVaultInviteProfile({
      operatorName: 'OperatorOne',
      currentOperatorName: 'OperatorOne',
    });

    expect(result).toBeUndefined();
    expect(submitAndWatch).not.toHaveBeenCalled();

    getMainchainClient.mockRestore();
  });

  it('batches an operational profile name with vault delegate setup', async () => {
    const submittedTxInfo = createTxInfo({
      extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
    });
    const setName = vi.fn(name => ({ kind: 'set-operational-name', name }));
    const batchAll = vi.fn(txs => ({ kind: 'batch', txs }));
    const client = {
      tx: {
        operationalAccounts: { setName },
        utility: { batchAll },
      },
    };
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(client as any);
    const { myVault, submitAndWatch } = createVault({
      submitAndWatch: vi.fn().mockResolvedValue(submittedTxInfo),
    });
    const signer = await myVault.walletKeys.getVaultingKeypair();
    const delegateAddress = await myVault.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    myVault.data.createdVault = createTestVault({
      vaultId: 7,
      operatorAccountId: signer.address,
      delegateAccountId: null,
    });
    vi.spyOn(myVault as any, 'buildVaultDelegateSetupTxs').mockResolvedValue({
      needsSetup: true,
      txs: [{ kind: 'delegate' }],
    });

    const result = await myVault.setupVaultInviteProfile({
      operatorName: 'OperatorOne',
      currentOperatorName: '',
    });

    expect(setName).toHaveBeenCalledWith('OperatorOne');
    expect(batchAll).toHaveBeenCalledWith([
      { kind: 'delegate' },
      { kind: 'set-operational-name', name: 'OperatorOne' },
    ]);
    expect(submitAndWatch).toHaveBeenCalledWith({
      tx: { kind: 'batch', txs: expect.any(Array) },
      txSigner: signer,
      useLatestNonce: true,
      extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
      metadata: {
        vaultId: 7,
        delegateAddress,
        operatorName: 'OperatorOne',
      },
    });
    expect(result).toBe(submittedTxInfo);

    getMainchainClient.mockRestore();
  });

  it('repairs a mismatched and underfunded vault delegate', async () => {
    const submittedTxInfo = createTxInfo({
      extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
    });
    const transferKeepAlive = vi.fn((address, amount) => ({ kind: 'fund-delegate', address, amount }));
    const setDelegateAccount = vi.fn(address => ({ kind: 'set-delegate', address }));
    const batchAll = vi.fn(txs => ({ kind: 'batch', txs }));
    const { myVault, submitAndWatch } = createVault({
      submitAndWatch: vi.fn().mockResolvedValue(submittedTxInfo),
    });
    const delegateAddress = await myVault.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    const client = {
      query: {
        system: {
          account: vi.fn(async address => ({
            data: {
              free: bigintCodec(address === delegateAddress ? 0n : 100_000_000n),
            },
          })),
        },
      },
      tx: {
        balances: { transferKeepAlive },
        utility: { batchAll },
        vaults: { setDelegateAccount },
      },
    };
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(client as any);
    Object.assign(myVault.globalCouncil, {
      buildRegisterCouncilSignerTx: vi.fn().mockResolvedValue(undefined),
    });
    myVault.data.createdVault = {
      vaultId: 7,
      operatorAccountId: myVault.walletKeys.vaultingAddress,
      delegateAccountId: 'wrong-delegate',
    } as Vault;

    const result = await myVault.ensureVaultDelegateReady();

    expect(transferKeepAlive).toHaveBeenCalledWith(delegateAddress, targetVaultDelegateBalance);
    expect(setDelegateAccount).toHaveBeenCalledWith(delegateAddress);
    expect(batchAll).toHaveBeenCalledWith([
      { kind: 'fund-delegate', address: delegateAddress, amount: targetVaultDelegateBalance },
      { kind: 'set-delegate', address: delegateAddress },
    ]);
    expect(submitAndWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        txSigner: expect.objectContaining({ address: myVault.walletKeys.vaultingAddress }),
        extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
        metadata: { vaultId: 7, delegateAddress },
      }),
    );
    expect(result).toBe(submittedTxInfo);

    getMainchainClient.mockRestore();
  });

  it('tops up a matching underfunded vault delegate without registering it again', async () => {
    const submittedTxInfo = createTxInfo({
      extrinsicType: ExtrinsicType.VaultTopUpBitcoinLockDelegate,
    });
    const transferKeepAlive = vi.fn((address, amount) => ({ kind: 'fund-delegate', address, amount }));
    const setDelegateAccount = vi.fn();
    const { myVault, submitAndWatch } = createVault({
      submitAndWatch: vi.fn().mockResolvedValue(submittedTxInfo),
    });
    const delegateAddress = await myVault.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    const client = {
      query: {
        system: {
          account: vi.fn(async () => ({ data: { free: bigintCodec(0n) } })),
        },
      },
      tx: {
        balances: { transferKeepAlive },
        vaults: { setDelegateAccount },
      },
    };
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(client as any);
    Object.assign(myVault.globalCouncil, {
      buildRegisterCouncilSignerTx: vi.fn().mockResolvedValue(undefined),
    });
    myVault.data.createdVault = {
      vaultId: 7,
      operatorAccountId: myVault.walletKeys.vaultingAddress,
      delegateAccountId: delegateAddress,
    } as Vault;

    const result = await myVault.ensureVaultDelegateReady();

    expect(transferKeepAlive).toHaveBeenCalledWith(delegateAddress, targetVaultDelegateBalance);
    expect(setDelegateAccount).not.toHaveBeenCalled();
    expect(submitAndWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: { kind: 'fund-delegate', address: delegateAddress, amount: targetVaultDelegateBalance },
        txSigner: expect.objectContaining({ address: myVault.walletKeys.vaultingAddress }),
        extrinsicType: ExtrinsicType.VaultTopUpBitcoinLockDelegate,
        metadata: { vaultId: 7, delegateAddress },
      }),
    );
    expect(result).toBe(submittedTxInfo);

    getMainchainClient.mockRestore();
  });

  it('resumes a pending delegate top-up instead of transferring twice', async () => {
    const pendingTopUp = createTxInfo({
      id: 44,
      extrinsicType: ExtrinsicType.VaultTopUpBitcoinLockDelegate,
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 100,
    });
    const transferKeepAlive = vi.fn((address, amount) => ({ kind: 'fund-delegate', address, amount }));
    const { myVault, submitAndWatch } = createVault({ txInfos: [pendingTopUp] });
    const delegateAddress = await myVault.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    pendingTopUp.tx.metadataJson = { vaultId: 7, delegateAddress };
    const client = {
      query: {
        system: {
          account: vi.fn(async () => ({ data: { free: bigintCodec(0n) } })),
        },
      },
      tx: {
        balances: { transferKeepAlive },
      },
    };
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(client as any);
    Object.assign(myVault.globalCouncil, {
      buildRegisterCouncilSignerTx: vi.fn().mockResolvedValue(undefined),
    });
    myVault.data.createdVault = {
      vaultId: 7,
      operatorAccountId: myVault.walletKeys.vaultingAddress,
      delegateAccountId: delegateAddress,
    } as Vault;

    const result = await myVault.ensureVaultDelegateReady();

    expect(transferKeepAlive).toHaveBeenCalledWith(delegateAddress, targetVaultDelegateBalance);
    expect(submitAndWatch).not.toHaveBeenCalled();
    expect(result).toBe(pendingTopUp);

    getMainchainClient.mockRestore();
  });

  it('prepares a member invite while using prior flexible-asset calls', async () => {
    const submittedTxInfo = createTxInfo({ extrinsicType: ExtrinsicType.VaultSetFlexibleAssets });
    const batchAll = vi.fn(txs => ({ kind: 'batch', txs }));
    const setAsBackfill = vi.fn((utxoId, isFlexible) => ({ kind: 'bitcoin', utxoId, isFlexible }));
    const setBondLotAsBackfill = vi.fn((bondLotId, isFlexible) => ({ kind: 'bond', bondLotId, isFlexible }));
    const client = {
      tx: {
        utility: { batchAll },
        bitcoinLocks: { setAsBackfill },
        treasury: { setBondLotAsBackfill },
      },
    };
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(client as any);
    const { myVault, submitAndWatch } = createVault({
      submitAndWatch: vi.fn().mockResolvedValue(submittedTxInfo),
    });
    const signer = await myVault.walletKeys.getVaultingKeypair();
    myVault.data.createdVault = createTestVault({
      vaultId: 7,
      operatorAccountId: signer.address,
      delegateAccountId: null,
    });
    vi.spyOn(myVault as any, 'buildVaultDelegateSetupTxs').mockResolvedValue({
      needsSetup: true,
      txs: [{ kind: 'delegate' }],
    });

    const result = await myVault.prepareMemberInvite({
      operatorName: 'OperatorOne',
      bitcoinChanges: [
        {
          lock: {
            utxoId: 11,
            vaultId: 7,
            isFunded: true,
            liquidityPromised: 1_000n,
            ownerAccount: signer.address,
            getReleaseRequest: vi.fn(async () => undefined),
          },
          isFlexible: true,
        },
      ],
      bondChanges: [
        {
          lot: {
            id: 22,
            vaultId: 7,
            accountId: signer.address,
            isOwn: true,
            programType: 'Vault',
            isReleasing: false,
          },
          isFlexible: true,
        },
      ],
    });

    expect(result).toBe(submittedTxInfo);
    expect(batchAll).toHaveBeenCalledWith([
      { kind: 'delegate' },
      { kind: 'bitcoin', utxoId: 11, isFlexible: true },
      { kind: 'bond', bondLotId: 22, isFlexible: true },
    ]);
    expect(submitAndWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        extrinsicType: ExtrinsicType.VaultSetFlexibleAssets,
        metadata: {
          bitcoinChanges: [{ utxoId: 11, isBackfill: true }],
          bondChanges: [{ bondLotId: 22, isBackfill: true }],
        },
      }),
    );

    getMainchainClient.mockRestore();
  });

  it('prepares flexible assets with the current runtime calls', async () => {
    const submittedTxInfo = createTxInfo({ extrinsicType: ExtrinsicType.VaultSetFlexibleAssets });
    const batchAll = vi.fn(txs => ({ kind: 'batch', txs }));
    const setFlexible = vi.fn((utxoId, isFlexible) => ({ kind: 'bitcoin', utxoId, isFlexible }));
    const setBondLotFlexible = vi.fn((bondLotId, isFlexible) => ({ kind: 'bond', bondLotId, isFlexible }));
    const client = {
      tx: {
        utility: { batchAll },
        bitcoinLocks: { setFlexible },
        treasury: { setBondLotFlexible },
      },
    };
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(client as any);
    const { myVault, submitAndWatch } = createVault({
      submitAndWatch: vi.fn().mockResolvedValue(submittedTxInfo),
    });
    const signer = await myVault.walletKeys.getVaultingKeypair();
    myVault.data.createdVault = createTestVault({
      vaultId: 7,
      operatorAccountId: signer.address,
      delegateAccountId: null,
    });

    const result = await myVault.setFlexibleAssets({
      bitcoinChanges: [
        {
          lock: {
            utxoId: 11,
            vaultId: 7,
            isFunded: true,
            liquidityPromised: 1_000n,
            ownerAccount: signer.address,
            getReleaseRequest: vi.fn(async () => undefined),
          },
          isFlexible: true,
        },
      ],
      bondChanges: [
        {
          lot: {
            id: 22,
            vaultId: 7,
            accountId: signer.address,
            isOwn: true,
            programType: 'Vault',
            isReleasing: false,
          },
          isFlexible: true,
        },
      ],
    });

    expect(result).toBe(submittedTxInfo);
    expect(batchAll).toHaveBeenCalledWith([
      { kind: 'bitcoin', utxoId: 11, isFlexible: true },
      { kind: 'bond', bondLotId: 22, isFlexible: true },
    ]);
    expect(submitAndWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        extrinsicType: ExtrinsicType.VaultSetFlexibleAssets,
      }),
    );

    getMainchainClient.mockRestore();
  });

  it('does not submit an empty member invite setup batch', async () => {
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({} as any);
    const { myVault, submitAndWatch } = createVault();
    myVault.data.createdVault = { vaultId: 7 } as Vault;
    vi.spyOn(myVault as any, 'buildVaultDelegateSetupTxs').mockResolvedValue({
      needsSetup: false,
      txs: [],
    });

    const result = await myVault.prepareMemberInvite({
      operatorName: 'OperatorOne',
      bitcoinChanges: [],
      bondChanges: [],
    });

    expect(result).toBeUndefined();
    expect(submitAndWatch).not.toHaveBeenCalled();

    getMainchainClient.mockRestore();
  });

  it('renders ready before load resolves, but still waits for council and authority state', async () => {
    let resolveBitcoinLocksLoad!: () => void;
    let resolveGlobalCouncilLoad!: () => void;
    let resolveMintingAuthoritiesLoad!: () => void;

    const bitcoinLocksLoad = new Promise<void>(resolve => {
      resolveBitcoinLocksLoad = resolve;
    });
    const globalCouncilLoad = new Promise<void>(resolve => {
      resolveGlobalCouncilLoad = resolve;
    });
    const mintingAuthoritiesLoad = new Promise<void>(resolve => {
      resolveMintingAuthoritiesLoad = resolve;
    });
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({
      consts: {
        vaults: {
          revenueCollectionExpirationFrames: {
            toNumber: () => 10,
          },
        },
      },
      query: {
        vaults: {
          argonotCommitmentByVaultId: vi.fn(async () =>
            optionCodec({
              committedMicronots: bigintCodec(25n),
              encumberedMicronots: bigintCodec(10n),
            }),
          ),
        },
      },
    } as any);
    const myVault = new MyVault(
      Promise.resolve({
        vaultsTable: {
          get: vi.fn(async () => ({ id: 7, createdAtBlockHeight: 10 })),
        },
        transactionsTable: {
          fetchStatusHistory: vi.fn(async () => []),
        },
      } as any),
      {
        load: vi.fn(async () => undefined),
        updateRevenue: vi.fn(async () => undefined),
        vaultsById: { 7: { vaultId: 7 } },
        operatorNamesByVaultId: {},
        stats: {
          synchedToFrame: 1,
          vaultsById: { 7: { vaultId: 7 } },
        },
      } as any,
      createMockWalletKeys(),
      {
        load: vi.fn(async () => undefined),
        pendingBlockTxInfosAtLoad: [],
        data: { txInfosByType: {} },
      } as any,
      {
        load: vi.fn(() => bitcoinLocksLoad),
      } as any,
      {
        load: vi.fn(async () => undefined),
        currentFrameId: 2,
      } as any,
      {
        load: vi.fn(() => globalCouncilLoad),
        data: { pendingApprovals: [] },
      } as any,
      {
        load: vi.fn(() => mintingAuthoritiesLoad),
        data: {
          authorities: [],
          pendingMintingAuthorizations: [],
          pendingMintingAuthorizeTxInfosByTransferId: new Map(),
        },
      } as any,
    );

    vi.spyOn(myVault as any, 'refreshExternalLocks').mockResolvedValue(undefined);

    const loadPromise = myVault.load();
    let isResolved = false;
    void loadPromise.then(() => {
      isResolved = true;
    });

    await vi.waitFor(() => {
      expect(myVault.data.isReady).toBe(true);
    });
    expect(myVault.data.argonotCommitment).toEqual({
      committedMicronots: 25n,
      encumberedMicronots: 10n,
    });
    expect(isResolved).toBe(false);

    resolveBitcoinLocksLoad();
    await Promise.resolve();
    expect(isResolved).toBe(false);

    resolveGlobalCouncilLoad();
    resolveMintingAuthoritiesLoad();
    await loadPromise;

    expect(isResolved).toBe(true);

    getMainchainClient.mockRestore();
  });

  it('records finalized vault capital from the resulting vault state after re-inclusion', async () => {
    const capitalInsert = vi.fn(async () => undefined);
    const walletKeys = createMockWalletKeys();
    const api = {
      query: {
        system: { number: vi.fn(async () => numberCodec(55)) },
        vaults: {
          argonotCommitmentByVaultId: vi.fn(async () =>
            optionCodec({
              committedMicronots: bigintCodec(25n),
              encumberedMicronots: bigintCodec(10n),
            }),
          ),
        },
      },
    };
    const client = { at: vi.fn(async () => api) };
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(client as any);
    const liveVault = {
      vaultId: 7,
      securitization: 900n,
      getRelockCapacity: () => 200n,
    } as Vault;
    const getVault = vi.spyOn(Vault, 'get').mockResolvedValue(liveVault);
    const { myVault } = createVault({
      db: {
        vaultCapitalHistoryTable: { insert: capitalInsert },
      },
      walletKeys,
    });
    myVault.data.metadata = { id: 7 } as any;
    myVault.vaults.vaultsById[7] = { securitization: 1_000n } as Vault;

    await myVault.recordFinalizedVaultCapital({
      tx: { blockHeight: 55, blockHash: '0x55', blockExtrinsicIndex: 2 },
      txResult: { waitForFinalizedBlock: Promise.resolve(new Uint8Array([0xfa])) },
    } as any);

    expect(myVault.data.createdVault).toBe(liveVault);
    expect(myVault.vaults.vaultsById[7]).toBe(liveVault);
    expect(myVault.data.argonotCommitment).toEqual({
      committedMicronots: 25n,
      encumberedMicronots: 10n,
    });
    expect(capitalInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'modified',
        securitization: 900n,
        securitizationTarget: 700n,
        blockHash: '0xfa',
        extrinsicIndex: 2,
      }),
    );
    getVault.mockRestore();
    getMainchainClient.mockRestore();
  });

  it('records a created vault against the finalized block after re-inclusion', async () => {
    const capitalInsert = vi.fn(async () => undefined);
    const metadataInsert = vi.fn(async () => ({ id: 7 }));
    const finalizedBlockHash = new Uint8Array([0xfa]);
    const vault = {
      vaultId: 7,
      securitization: 4_000n,
    } as Vault;
    const postProcessor = { resolve: vi.fn(), reject: vi.fn() };
    const txInfo = {
      tx: {
        blockHash: '0xstale',
        blockExtrinsicIndex: 5,
        metadataJson: { masterXpubPath: '//vault' },
      },
      txResult: {
        waitForFinalizedBlock: Promise.resolve(finalizedBlockHash),
        events: [{ data: { vaultId: numberCodec(7) } }],
        finalFee: 10n,
      },
      createPostProcessor: vi.fn(() => postProcessor),
    } as unknown as TransactionInfo<{ masterXpubPath: string }>;
    const api = {
      query: {
        system: { number: vi.fn(async () => numberCodec(55)) },
      },
    };
    const client = {
      at: vi.fn(async () => api),
      events: {
        vaults: {
          VaultCreated: { is: vi.fn(() => true) },
        },
      },
    };
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(client as any);
    const getVault = vi.spyOn(Vault, 'get').mockResolvedValue(vault);
    const { myVault } = createVault({
      db: {
        vaultsTable: { insert: metadataInsert },
        vaultCapitalHistoryTable: { insert: capitalInsert },
      },
    });

    await (myVault as unknown as IMyVaultTestTarget).onVaultCreated(txInfo);

    expect(capitalInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'created',
        blockHash: '0xfa',
      }),
    );
    getVault.mockRestore();
    getMainchainClient.mockRestore();
  });

  it('does not fail a finalized vault transaction when financial history cannot be recorded', async () => {
    const getMainchainClient = vi
      .spyOn(mainchainStore, 'getMainchainClient')
      .mockRejectedValue(new Error('archive unavailable'));
    const { myVault } = createVault();
    myVault.data.metadata = { id: 7 } as any;

    await expect(
      myVault.recordFinalizedVaultCapital({
        tx: {},
        txResult: { waitForFinalizedBlock: Promise.resolve(new Uint8Array()) },
      } as any),
    ).resolves.toBeUndefined();

    getMainchainClient.mockRestore();
  });
});

function createVault(args?: {
  txInfos?: TransactionInfo[];
  finalizedHeight?: number;
  headerByHeight?: Record<number, string>;
  submitAndWatch?: ReturnType<typeof vi.fn>;
  trackTxResult?: ReturnType<typeof vi.fn>;
  createIntentForFollowOnTx?: ReturnType<typeof vi.fn>;
  historyByTxId?: Record<number, Partial<ITransactionStatusHistoryRecord>[]>;
  db?: Record<string, unknown>;
  walletKeys?: ReturnType<typeof createMockWalletKeys>;
  ensureStoredEvents?: ReturnType<typeof vi.fn>;
  blockEvents?: unknown[];
  finalizedApi?: object;
}) {
  const blockWatchEventOn = vi.fn(
    (_event: string, _callback: (headers: { blockNumber: number; blockHash: string }[]) => void | Promise<void>) =>
      vi.fn(),
  );
  const getBlockEvents = vi.fn(async () => args?.blockEvents ?? []);
  const getBlockEventsWithSpec = vi.fn(async () => ({
    api: args?.finalizedApi ?? {},
    events: args?.blockEvents ?? [],
  }));
  const blockWatch = {
    finalizedBlockHeader: { blockNumber: args?.finalizedHeight ?? 100 },
    events: { on: blockWatchEventOn },
    getEvents: getBlockEvents,
    getEventsWithSpec: getBlockEventsWithSpec,
    getFinalizedApi: vi.fn(async () => args?.finalizedApi ?? {}),
    getApi: vi.fn(async () => args?.finalizedApi ?? {}),
    getHeader: vi.fn(async (blockHeight: number) => {
      return {
        blockNumber: blockHeight,
        blockHash: args?.headerByHeight?.[blockHeight] ?? `0x${blockHeight.toString(16)}`,
      };
    }),
  };
  const historyByTxId = args?.historyByTxId ?? {};
  const txInfos = args?.txInfos ?? [];
  const submitAndWatch = args?.submitAndWatch ?? vi.fn();
  const trackTxResult = args?.trackTxResult ?? vi.fn();
  const getTxAttemptState = vi.fn(async (txInfo: TransactionInfo, waitForConfirmations: number) => {
    const latestHistoryStatus = historyByTxId[txInfo.tx.id]?.at(-1)?.status;
    if (
      txInfo.tx.submissionErrorJson ||
      txInfo.tx.blockExtrinsicErrorJson ||
      txInfo.tx.status === TransactionStatus.Error ||
      txInfo.tx.status === TransactionStatus.TimedOutWaitingForBlock
    ) {
      return TxAttemptState.Replace;
    }

    if (
      latestHistoryStatus === TransactionHistoryStatus.Dropped ||
      latestHistoryStatus === TransactionHistoryStatus.Usurped ||
      latestHistoryStatus === TransactionHistoryStatus.Invalid
    ) {
      return TxAttemptState.Replace;
    }

    if (latestHistoryStatus === TransactionHistoryStatus.Retracted && txInfo.tx.txNonce != null) {
      for (const otherTxInfo of txInfos) {
        if (otherTxInfo.tx.id === txInfo.tx.id) continue;
        if (otherTxInfo.tx.accountAddress !== txInfo.tx.accountAddress) continue;
        if (otherTxInfo.tx.txNonce == null || otherTxInfo.tx.txNonce < txInfo.tx.txNonce) continue;

        if (otherTxInfo.tx.status === TransactionStatus.Finalized) {
          return TxAttemptState.Replace;
        }

        if (otherTxInfo.tx.status !== TransactionStatus.InBlock) {
          continue;
        }

        const { blockHeight, blockHash } = otherTxInfo.tx;
        if (blockHeight == null || !blockHash) {
          continue;
        }

        const header = await blockWatch.getHeader(blockHeight).catch(() => undefined);
        if (header?.blockHash === blockHash) {
          return TxAttemptState.Replace;
        }
      }
    }

    const finalizedHeight = blockWatch.finalizedBlockHeader.blockNumber;
    if (txInfo.tx.status === TransactionStatus.Submitted) {
      return finalizedHeight - txInfo.tx.submittedAtBlockHeight <= waitForConfirmations
        ? TxAttemptState.Pending
        : TxAttemptState.Replace;
    }

    if (txInfo.tx.status === TransactionStatus.InBlock) {
      const { blockHeight, blockHash } = txInfo.tx;
      if (blockHeight == null || !blockHash) {
        return TxAttemptState.Replace;
      }

      const header = await blockWatch.getHeader(blockHeight).catch(() => undefined);
      if (!header || header.blockHash === blockHash) {
        return TxAttemptState.Pending;
      }

      return finalizedHeight - blockHeight <= waitForConfirmations ? TxAttemptState.Pending : TxAttemptState.Replace;
    }

    if (txInfo.tx.status === TransactionStatus.Finalized) {
      return TxAttemptState.Finalized;
    }

    return TxAttemptState.Replace;
  });
  const transactionTracker = {
    data: {
      txInfos,
      txInfosByType: {},
    },
    submitAndWatch,
    trackTxResult,
    ensureStoredEvents: args?.ensureStoredEvents ?? vi.fn(async () => undefined),
    createIntentForFollowOnTx: args?.createIntentForFollowOnTx ?? vi.fn(),
    findLatestTxInfo: vi.fn((matcher: (txInfo: TransactionInfo) => boolean) => {
      return txInfos.find(matcher);
    }),
    findLatestTxAttempt: vi.fn(async (params: Parameters<TransactionTracker['findLatestTxAttempt']>[0]) => {
      const extrinsicTypes = Array.isArray(params.extrinsicType) ? params.extrinsicType : [params.extrinsicType];
      const txInfo = txInfos.find(candidate => {
        return extrinsicTypes.includes(candidate.tx.extrinsicType) && (params.matches?.(candidate) ?? true);
      });
      if (!txInfo) return;

      return {
        txInfo,
        txAttemptState: await getTxAttemptState(txInfo, params.waitForConfirmations),
      };
    }),
    getTxAttemptState,
  } as unknown as TransactionTracker;
  const onFrameId = vi.fn((_callback: (frameId: number) => void) => ({ unsubscribe: vi.fn() }));
  const miningFrames = {
    blockWatch,
    onFrameId,
    getFrameDate: vi.fn(() => new Date('2026-01-01T00:00:00Z')),
  } as unknown as MiningFrames;
  const bitcoinLocks = {} as BitcoinLocks;
  const globalCouncil = {
    data: {
      isReady: true,
      councilSigner: undefined,
      pendingApprovals: [],
    },
    load: vi.fn(async () => undefined),
    refresh: vi.fn(async () => []),
    relayApprovedGatewayUpdates: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(),
    buildApprovePendingGatewayUpdateTxs: vi.fn(async () => []),
  } as {
    data: {
      isReady: boolean;
      councilSigner?: string;
      pendingApprovals: { approvalHash: string }[];
    };
    load: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    relayApprovedGatewayUpdates: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    buildApprovePendingGatewayUpdateTxs: ReturnType<typeof vi.fn>;
  };
  const mintingAuthorities = {
    data: {
      isReady: true,
      authorities: [],
      pendingMintingAuthorizations: [],
      pendingMintingAuthorizeTxInfosByTransferId: new Map(),
    },
    load: vi.fn(async () => undefined),
    refresh: vi.fn(async () => []),
    authorize: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(),
  } as {
    data: {
      isReady: boolean;
      authorities: unknown[];
      pendingMintingAuthorizeTxInfosByTransferId: Map<string, unknown>;
      pendingMintingAuthorizations: Array<{
        authorityIndex: number;
        destinationSigningKey: string;
        transferId: string;
        authorizationHash: string;
        mintingAuthorityTip?: bigint;
        microgonCollateral: bigint;
        micronotCollateral: bigint;
      }>;
    };
    load: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    authorize: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  };

  const myVault = new MyVault(
    Promise.resolve({
      transactionsTable: {
        fetchStatusHistory: vi.fn(async () => []),
      },
      ...args?.db,
    } as any),
    {
      vaultsById: {},
      operatorNamesByVaultId: {},
      subscribeToVault: vi.fn(async () => vi.fn()),
      subscribeToOperatorName: vi.fn(async () => vi.fn()),
      updateVaultRevenue: vi.fn(async () => undefined),
    } as any,
    args?.walletKeys ?? createMockWalletKeys(),
    transactionTracker,
    bitcoinLocks,
    miningFrames,
    globalCouncil as any,
    mintingAuthorities as any,
  );

  return {
    myVault,
    blockWatch,
    blockWatchEventOn,
    getBlockEvents,
    getBlockEventsWithSpec,
    onFrameId,
    globalCouncil,
    mintingAuthorities,
    submitAndWatch,
    trackTxResult,
  };
}

function createTestVault(args: {
  vaultId: number;
  operatorAccountId: string;
  delegateAccountId: string | null;
}): Vault {
  const rawVault = getOfflineRegistry().createType<ArgonPrimitivesVault>('ArgonPrimitivesVault', {
    operatorAccountId: args.operatorAccountId,
    delegateAccountId: args.delegateAccountId,
    securitization: 0n,
    securitizationTarget: 0n,
    securitizationLocked: 0n,
    flexibleSecuritizationLocked: 0n,
    reservedSecuritizationSpace: 0n,
    securitizationPendingActivation: 0n,
    lockedSatoshis: 0n,
    securitizedSatoshis: 0n,
    flexibleSecuritizedSatoshis: 0,
    securitizationReleaseSchedule: {},
    securitizationRatio: 1_000_000_000_000_000_000n,
    isClosed: false,
    terms: {
      bitcoinAnnualPercentRate: 0n,
      bitcoinBaseFee: 0n,
      treasuryProfitSharing: 0,
      treasuryBonusProfitSharing: 0,
    },
    pendingTerms: null,
    openedTick: 0n,
    operationalMinimumReleaseTick: null,
  });

  return new Vault(args.vaultId, rawVault, 1_000);
}

function createMockTxResultTx() {
  const signedTx = {
    hash: { toHex: () => '0xsigned' },
    method: { toHuman: () => ({ section: 'vaults', method: 'modifyFunding' }) },
    nonce: { toNumber: () => 9 },
    toHex: () => '0xsignedtx',
    send: vi.fn(async () => undefined),
  };
  return {
    signedTx,
    signAsync: vi.fn(async () => signedTx),
  };
}

function createTxInfo(overrides: Partial<ITransactionRecord>): TransactionInfo {
  const submittedAtTime = new Date('2026-01-01T00:00:00Z');
  const tx = {
    id: overrides.id ?? 1,
    status: overrides.status ?? TransactionStatus.Submitted,
    followOnTxId: overrides.followOnTxId,
    extrinsicHash: overrides.extrinsicHash ?? '0x1234',
    extrinsicMethodJson: overrides.extrinsicMethodJson ?? {},
    extrinsicType: overrides.extrinsicType ?? ExtrinsicType.VaultCosignBitcoinRelease,
    metadataJson: overrides.metadataJson ?? {},
    accountAddress: overrides.accountAddress ?? '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    submittedAtTime: overrides.submittedAtTime ?? submittedAtTime,
    submittedAtBlockHeight: overrides.submittedAtBlockHeight ?? 100,
    submissionErrorJson: overrides.submissionErrorJson,
    txNonce: overrides.txNonce,
    txTip: overrides.txTip,
    txFeePlusTip: overrides.txFeePlusTip,
    blockHeight: overrides.blockHeight,
    blockHash: overrides.blockHash,
    blockTime: overrides.blockTime,
    blockExtrinsicIndex: overrides.blockExtrinsicIndex,
    blockExtrinsicEventsJson: overrides.blockExtrinsicEventsJson ?? [],
    blockExtrinsicErrorJson: overrides.blockExtrinsicErrorJson,
    finalizedHeadHeight: overrides.finalizedHeadHeight,
    finalizedHeadTime: overrides.finalizedHeadTime,
    isFinalized: overrides.isFinalized ?? overrides.status === TransactionStatus.Finalized,
    createdAt: overrides.createdAt ?? submittedAtTime,
    updatedAt: overrides.updatedAt ?? submittedAtTime,
  } satisfies ITransactionRecord;

  return {
    tx,
  } as TransactionInfo;
}
