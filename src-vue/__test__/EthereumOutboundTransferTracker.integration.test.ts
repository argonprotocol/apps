import { EventEmitter } from 'node:events';
import { computed, reactive } from 'vue';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { JsonExt, MoveToken, NetworkConfig, TransactionEvents, TxSubmitter } from '@argonprotocol/apps-core';
import { EvmContracts } from '@argonprotocol/mainchain';
import { getBundledMetadata, type HistoricalEvent } from '@argonprotocol/runtime-client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseTransaction,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
} from 'viem';
import {
  EthereumOutboundTransferTracker,
  type ICrosschainTransferOutMetadata,
} from '../lib/EthereumOutboundTransferTracker.ts';
import {
  isCrosschainTransferVisible,
  isCrosschainTransferActive,
} from '../wallets/components/crosschainTransferView.ts';

import { EthereumClient } from '../lib/EthereumClient.ts';
import { createCrosschainTransferProgress, OUTBOUND_TRANSFER_STEP_TITLES } from '../lib/CrosschainTransferProgress.ts';
import { CrosschainOutboundTransferStatus } from '../lib/db/CrosschainOutboundTransfersTable.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { WalletType } from '../lib/Wallet.ts';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';

import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { createTestDb, createTestDbAtMigration } from './helpers/db.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

const { getEthereumGatewayPauseReasonMock, getMainchainClientMock } = vi.hoisted(() => ({
  getEthereumGatewayPauseReasonMock: vi.fn(),
  getMainchainClientMock: vi.fn(),
}));

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: getMainchainClientMock,
  getEthereumGatewayPauseReason: getEthereumGatewayPauseReasonMock,
}));

describe('EthereumOutboundTransferTracker integration', { tags: ['no-argon-network'] }, () => {
  let loadSpy: MockInstance<EthereumOutboundTransferTracker['load']>;
  beforeEach(() => {
    vi.clearAllMocks();
    loadSpy = vi.spyOn(EthereumOutboundTransferTracker.prototype, 'load');
    getEthereumGatewayPauseReasonMock.mockResolvedValue(undefined);
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: { executionRpcUrls: ['https://ethereum.test'] },
    });
  });

  afterEach(() => {
    for (const tracker of loadSpy.mock.contexts as EthereumOutboundTransferTracker[]) tracker.shutdown();
    loadSpy.mockRestore();
    vi.useRealTimers();
    NetworkConfig.clearRuntimeOverride('dev-docker');
  });

  it('writes intent before signing, then preserves the current nonce attempt through replacement', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys(TEST_MNEMONIC);
    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 1, blockHash: `0x${'fa'.repeat(32)}` },
      getApi: async () => ({
        query: {
          system: { account: async () => ({ nonce: 0 }) },
          crosschainTransfer: {
            transferOutById: async () => ({ state: { type: 'Started' }, amount: 100n, totalAttachedCollateral: 0n }),
          },
        },
      }),
    });
    let broadcasts = 0;
    let signingAttempts = 0;
    let chainNonce = 0;
    let localId: string;
    let resumeSigning!: () => void;
    const signingGate = new Promise<void>(resolve => (resumeSigning = resolve));
    const nativeTx = {
      paymentInfo: async () => ({ partialFee: { toBigInt: () => 1n } }),
      signAsync: async (_signer: unknown, options: { nonce: number }) => {
        signingAttempts += 1;
        await signingGate;
        return {
          hash: { toHex: () => `0x${(options.nonce === 0 ? 'fb' : 'fc').repeat(32)}` },
          method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'transferOut' }) },
          nonce: { toNumber: () => options.nonce },
          era: new TypeRegistry().createType('ExtrinsicEra', 0),
          send: async () => {
            const intent = await db.crosschainOutboundTransfersTable.get(localId);
            const journal = (await db.transactionsTable.fetchAll())[0];
            expect(intent?.amount).toBe(100n);
            expect(journal.metadataJson.localTransferId).toBe(localId);
            broadcasts += 1;
            if (options.nonce === 0) {
              chainNonce = 1;
              throw new Error('1010: Invalid Transaction: Transaction is outdated');
            }
            await db.execute(`CREATE TRIGGER RejectRequestLink BEFORE UPDATE OF argonRequestTransactionId ON CrosschainOutboundTransfers
              BEGIN SELECT RAISE(ABORT, 'temporary request link publication failure'); END`);
            return () => {};
          },
        };
      },
    };
    const mainchainClient = createMainchainClient();
    const client = {
      ...mainchainClient,
      tx: Object.assign((submitted: typeof nativeTx) => submitted, {
        crosschainTransfer: { transferOut: () => nativeTx },
      }),
      query: {
        ...mainchainClient.query,
        system: { account: async () => ({ nonce: 0, data: { free: 1_000_000n } }) },
      },
      consts: { ...mainchainClient.consts, balances: { existentialDeposit: 1n } },
      rpc: {
        system: { accountNextIndex: async () => ({ toNumber: () => chainNonce }) },
        chain: { getHeader: async () => ({ number: { toNumber: () => 1 } }) },
        author: { pendingExtrinsics: async () => [] },
      },
    };
    getMainchainClientMock.mockResolvedValue(client);
    const sign = vi.spyOn(TxSubmitter.prototype, 'sign').mockImplementation(async function (
      this: TxSubmitter,
      options = {},
    ) {
      return await this.tx.signAsync(this.account.address, options);
    });
    const findTransaction = vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(undefined);
    const transactions = new TransactionTracker(Promise.resolve(db), blockWatch.instance as any);
    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactions,
      blockWatch.instance as any,
      walletKeys,
      new EthereumClient(walletKeys, 'https://ethereum.test'),
    );
    tracker.data = reactive(tracker.data);
    const visible = computed(() => tracker.getTransferStateForToken(MoveToken.ARGN));
    const pending = computed(() =>
      tracker.getPendingAmount(walletKeys.defaultArgonAddress, walletKeys.coreEthereumAddress, MoveToken.ARGN),
    );
    const request = {
      moveToken: MoveToken.ARGN,
      amount: 100n,
      sourceWalletType: WalletType.argon,
      ethereumWallet: new WalletForEthereum(walletKeys.coreEthereumAddress, undefined, undefined, true),
    } as const;
    await db.execute(`CREATE TRIGGER RejectOutboundInsert BEFORE INSERT ON CrosschainOutboundTransfers
      BEGIN SELECT RAISE(ABORT, 'temporary outbound insert failure'); END`);

    try {
      await tracker.startMove(request);
      await vi.waitFor(() => expect(Boolean(visible.value.error) || signingAttempts > 0).toBe(true));
      expect(signingAttempts).toBe(0);
      expect(visible.value.error).toContain('temporary outbound insert failure');
      expect(broadcasts).toBe(0);
      expect(await db.transactionsTable.fetchAll()).toEqual([]);
      expect(await db.crosschainOutboundTransfersTable.fetchAll()).toEqual([]);
      expect(pending.value).toBe(0n);
      expect(tracker.hasSignerDependentTransfer(walletKeys.coreEthereumAddress)).toBe(false);

      await db.execute('DROP TRIGGER RejectOutboundInsert');
      const transfer = (await tracker.startMove(request))!;
      localId = transfer.id;
      await vi.waitFor(() => expect(signingAttempts).toBe(1));
      expect(await db.crosschainOutboundTransfersTable.get(localId)).toMatchObject({
        status: CrosschainOutboundTransferStatus.RequestPendingSubmission,
        amount: 100n,
      });
      expect(pending.value).toBe(100n);
      expect(await db.transactionsTable.fetchAll()).toEqual([]);
      blockWatch.emitFinalized({ blockNumber: 2, blockHash: `0x${'fd'.repeat(32)}` });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((await db.crosschainOutboundTransfersTable.get(localId))?.failureReason).toBeUndefined();
      expect(isCrosschainTransferActive(visible.value)).toBe(true);
      expect(visible.value.needsAttention).toBe(false);
      resumeSigning();

      await vi.waitFor(async () => {
        const journals = await db.transactionsTable.fetchAll();
        expect(journals).toHaveLength(2);
        expect(journals[0].txNonce).toBe(1);
        expect(journals[1].submissionErrorJson?.message).toContain('Transaction is outdated');
        expect(visible.value.error).toContain('temporary request link publication failure');
      });
      expect(await db.crosschainOutboundTransfersTable.get(localId)).toMatchObject({
        status: CrosschainOutboundTransferStatus.RequestPendingSubmission,
      });
      expect((await db.crosschainOutboundTransfersTable.get(localId))?.argonRequestTransactionId).toBeUndefined();
      expect(pending.value).toBe(100n);
      expect(tracker.hasSignerDependentTransfer(walletKeys.coreEthereumAddress)).toBe(true);
      expect(visible.value.needsAttention).toBe(false);
      await db.execute('DROP TRIGGER RejectRequestLink');
      blockWatch.emitFinalized({ blockNumber: 3, blockHash: `0x${'fe'.repeat(32)}` });
      blockWatch.emitBest();
      await vi.waitFor(async () => {
        const currentRequest = (await db.transactionsTable.fetchAll())[0];
        expect(await db.crosschainOutboundTransfersTable.get(localId)).toMatchObject({
          argonRequestTransactionId: currentRequest.id,
          status: CrosschainOutboundTransferStatus.RequestSubmittedToArgon,
        });
        expect(visible.value.error).toBe('');
      });
      expect((await db.crosschainOutboundTransfersTable.get(localId))?.failureReason).toBeUndefined();
      expect(visible.value.needsAttention).toBe(false);
      expect(isCrosschainTransferActive(visible.value)).toBe(true);
      expect(pending.value).toBe(100n);
      expect(broadcasts).toBe(2);
    } finally {
      resumeSigning();
      tracker.shutdown();
      await transactions.shutdown();
      sign.mockRestore();
      findTransaction.mockRestore();
      await db.close();
    }
  });

  it('releases a durable intent that was never sent after restart', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys(TEST_MNEMONIC);
    const id = 'interrupted-before-signing';
    // This is the durable boundary after beforeSubmit and before the native journal is saved.
    await db.crosschainOutboundTransfersTable.upsert({
      id,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 100n,
      argonSourceAddress: walletKeys.defaultArgonAddress,
      destinationAddress: walletKeys.coreEthereumAddress,
      status: CrosschainOutboundTransferStatus.RequestPendingSubmission,
      progressJson: createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
    });
    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 10, blockHash: `0x${'ac'.repeat(32)}` },
      getApi: async () => ({}),
    });
    getMainchainClientMock.mockResolvedValue({});
    const transactions = new TransactionTracker(Promise.resolve(db), blockWatch.instance as any);
    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactions,
      blockWatch.instance as any,
      walletKeys,
      undefined,
    );
    tracker.data = reactive(tracker.data);
    const visible = computed(() => tracker.getTransferStateForToken(MoveToken.ARGN));
    try {
      await tracker.load();
      await vi.waitFor(() => {
        expect(visible.value.needsAttention).toBe(true);
        expect(visible.value.error).toContain('not sent');
      });
      expect((await db.crosschainOutboundTransfersTable.get(id))?.failureReason).toContain('not sent');
      expect(await db.transactionsTable.fetchAll()).toEqual([]);
      expect(
        tracker.getPendingAmount(walletKeys.defaultArgonAddress, walletKeys.coreEthereumAddress, MoveToken.ARGN),
      ).toBe(0n);
      expect(tracker.hasSignerDependentTransfer(walletKeys.coreEthereumAddress)).toBe(false);
      expect(isCrosschainTransferActive(visible.value)).toBe(false);
      await tracker.dismissFailedTransfer(id);
      expect((await db.crosschainOutboundTransfersTable.get(id))?.isFailureAcknowledged).toBe(true);
      expect(isCrosschainTransferVisible(visible.value)).toBe(false);
    } finally {
      tracker.shutdown();
      await transactions.shutdown();
      await db.close();
    }
  });

  it('retries legacy rowless timeout restoration and publishes its later canonical inclusion', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys(TEST_MNEMONIC);
    const id = 'restored-timed-out-request';
    const transferId = `0x${'92'.repeat(32)}`;
    const tx = await db.transactionsTable.insert({
      extrinsicHash: `0x${'91'.repeat(32)}`,
      extrinsicMethodJson: {},
      extrinsicType: ExtrinsicType.CrosschainTransferTransferOut,
      metadataJson: {
        actionType: 'transferOutToEthereum',
        localTransferId: id,
        moveToken: MoveToken.ARGN,
        amount: 100n,
        sourceWalletType: WalletType.argon,
        destinationAddress: walletKeys.coreEthereumAddress,
        mortalityBlocks: 64,
      },
      accountAddress: walletKeys.defaultArgonAddress,
      submittedAtBlockHeight: 1,
      submittedAtTime: new Date('2026-01-01T00:00:00Z'),
      txNonce: 0,
    });
    await db.transactionsTable.markExpiredWaitingForBlock(tx);
    const header = {
      blockNumber: 62,
      blockHash: `0x${'93'.repeat(32)}`,
    };
    const blockWatch = createBlockWatch({
      initialHeader: header,
      getApi: async () => ({ query: { system: { account: async () => ({ nonce: 0 }) } } }),
    });
    getMainchainClientMock.mockResolvedValue({ rpc: { author: { pendingExtrinsics: async () => [] } } });
    const findTransaction = vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(undefined);
    const transactions = new TransactionTracker(Promise.resolve(db), blockWatch.instance as any);
    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactions,
      blockWatch.instance as any,
      walletKeys,
      undefined,
    );
    tracker.data = reactive(tracker.data);
    const visible = computed(() => tracker.getTransferStateForToken(MoveToken.ARGN));
    await db.execute(`CREATE TRIGGER RejectTimeoutRestore BEFORE INSERT ON CrosschainOutboundTransfers
      BEGIN SELECT RAISE(ABORT, 'temporary outbound insert failure'); END`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await tracker.load();
      expect(await db.crosschainOutboundTransfersTable.fetchAll()).toEqual([]);
      await db.execute('DROP TRIGGER RejectTimeoutRestore');
      expect(isCrosschainTransferActive(visible.value)).toBe(true);
      expect(visible.value.error).toBe('');
      expect(
        tracker.getPendingAmount(walletKeys.defaultArgonAddress, walletKeys.coreEthereumAddress, MoveToken.ARGN),
      ).toBe(100n);
      findTransaction.mockResolvedValue({
        blockNumber: 63,
        blockHash: `0x${'95'.repeat(32)}`,
        blockTime: Date.now(),
        tip: 0n,
        fee: 1n,
        extrinsicIndex: 0,
        extrinsicEvents: [
          {
            section: 'crosschainTransfer',
            method: 'TransferOutStarted',
            data: {
              destinationChain: { type: 'Ethereum' },
              transferId,
              accountId: walletKeys.defaultArgonAddress,
              asset: { type: 'Argon' },
              amount: 100n,
              mintingAuthorityTip: 0n,
            },
          },
        ],
      });
      blockWatch.emitFinalized({ blockNumber: 63, blockHash: `0x${'95'.repeat(32)}` });
      blockWatch.emitBest();
      await vi.waitFor(async () => {
        const record = await db.crosschainOutboundTransfersTable.get(id);
        expect(record?.status).toBe(CrosschainOutboundTransferStatus.RequestFinalizedOnArgon);
        expect(record?.transferId).toBe(transferId);
        expect(record?.argonRequestTransactionId).toBe(tx.id);
        expect(record?.failureReason).toBeUndefined();
        expect(visible.value.progress.currentStepLabel).toBe('Step 2 of 3: Waiting for Minting Authorization');
        expect(visible.value.error).toBe('');
        expect(
          tracker.getPendingAmount(walletKeys.defaultArgonAddress, walletKeys.coreEthereumAddress, MoveToken.ARGN),
        ).toBe(0n);
      });
    } finally {
      warn.mockRestore();
      findTransaction.mockRestore();
      tracker.shutdown();
      await transactions.shutdown();
      await db.close();
    }
  });

  it.each(['active', 'completed', 'dismissed failure'])(
    'preserves migrated $0 state through a historical metadata outage and canonical join',
    async history => {
      const { db, migrateToLatest } = await createTestDbAtMigration(21);
      const walletKeys = createMockWalletKeys(TEST_MNEMONIC);
      const transferId = `0x${'31'.repeat(32)}`;
      await db.execute(
        `INSERT INTO CrosschainOutboundTransfers
      (transferId, destinationChain, token, amount, argonSourceAddress, destinationAddress, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          transferId,
          'Ethereum',
          'ARGN',
          '100',
          walletKeys.defaultArgonAddress,
          walletKeys.coreEthereumAddress,
          history === 'completed' ? 'TargetFinalized' : 'RequestFinalizedOnArgon',
        ],
      );
      await migrateToLatest();
      if (history === 'dismissed failure') {
        const canonical = (await db.crosschainOutboundTransfersTable.fetchAll())[0];
        await db.crosschainOutboundTransfersTable.recordFailed({
          id: canonical.id,
          failureReason: 'Synthetic Ethereum failure',
        });
        await db.crosschainOutboundTransfersTable.acknowledgeFailed(canonical.id);
      }
      const migrated = (await db.crosschainOutboundTransfersTable.fetchAll())[0];
      expect(migrated.argonRequestTransactionId).toBeUndefined();
      const historicalRequest = await db.transactionsTable.insert({
        extrinsicHash: `0x${'3a'.repeat(32)}`,
        extrinsicMethodJson: {},
        extrinsicType: ExtrinsicType.CrosschainTransferTransferOut,
        metadataJson: {
          actionType: 'transferOutToEthereum',
          moveToken: MoveToken.ARGN,
          amount: 100n,
          sourceWalletType: WalletType.argon,
          destinationAddress: walletKeys.coreEthereumAddress,
        },
        accountAddress: walletKeys.defaultArgonAddress,
        submittedAtBlockHeight: 10,
        submittedAtTime: new Date('2026-01-01T00:00:00Z'),
        txNonce: 0,
      });
      await db.transactionsTable.recordInBlock(historicalRequest, {
        blockNumber: 10,
        blockHash: `0x${'3b'.repeat(32)}`,
        blockTime: new Date(),
        feePlusTip: 1n,
        tip: 0n,
        extrinsicIndex: 0,
        transactionEvents: [],
      });
      await db.transactionsTable.markFinalized(historicalRequest, { blockNumber: 10, blockTime: new Date() });

      const registry = new TypeRegistry();
      const metadataBytes = Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-159'))![1];
      const metadata = new Metadata(registry, metadataBytes);
      registry.setMetadata(metadata);
      const pallet = metadata.asLatest.pallets.find(pallet => pallet.name.toString() === 'CrosschainTransfer')!;
      const event = registry.createType(registry.createLookupType(pallet.events.unwrap().type), {
        TransferOutStarted: {
          destinationChain: 'Ethereum',
          transferId,
          accountId: walletKeys.defaultArgonAddress,
          asset: 'Argon',
          amount: 100n,
          mintingAuthorityTip: 1n,
        },
      });
      const raw = u8aToHex(u8aConcat(new Uint8Array([pallet.index.toNumber()]), event.toU8a()));
      const decoded = registry.createType('GenericEvent', hexToU8a(raw));
      // Older producers persisted codec bytes. Canonical identity is unavailable until metadata is hydrated.
      await db.execute('UPDATE Transactions SET blockExtrinsicEventsJson = ? WHERE id = ?', [
        JsonExt.stringify([{ raw, human: decoded.toHuman() }]),
        historicalRequest.id,
      ]);
      let metadataAvailable = false;
      const blockWatch = createBlockWatch({
        initialHeader: { blockNumber: 20, blockHash: `0x${'34'.repeat(32)}` },
        getApi: async () => {
          if (!metadataAvailable) throw new Error('temporary historical metadata RPC outage');
          return { registry };
        },
      });
      getMainchainClientMock.mockResolvedValue({});
      const transactions = new TransactionTracker(Promise.resolve(db), blockWatch.instance as any);
      const tracker = new EthereumOutboundTransferTracker(
        Promise.resolve(db),
        transactions,
        blockWatch.instance as any,
        walletKeys,
        undefined,
      );
      tracker.data = reactive(tracker.data);
      const visible = computed(() => tracker.getTransferStateForToken(MoveToken.ARGN));
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await tracker.load();
        expect(await db.crosschainOutboundTransfersTable.fetchAll()).toHaveLength(1);
        expect(await db.crosschainOutboundTransfersTable.get(migrated.id)).toEqual(migrated);
        expect(
          tracker.getPendingAmount(walletKeys.defaultArgonAddress, walletKeys.coreEthereumAddress, MoveToken.ARGN),
        ).toBe(0n);
        expect(isCrosschainTransferVisible(visible.value)).toBe(history === 'active');
        if (history === 'active') {
          expect(visible.value.amount).toBe(100n);
          expect(visible.value.error).toBe('');
          expect(visible.value.progress.currentStepLabel).toBe('Step 2 of 3: Waiting for Minting Authorization');
        }
        // Let the failed historical publication settle before the RPC boundary becomes available.
        await new Promise<void>(resolve => setImmediate(resolve));
        metadataAvailable = true;
        blockWatch.emitFinalized({ blockNumber: 21, blockHash: `0x${'35'.repeat(32)}` });
        await vi.waitFor(async () => {
          expect(await db.crosschainOutboundTransfersTable.fetchAll()).toHaveLength(1);
          expect(await db.crosschainOutboundTransfersTable.get(historicalRequest.extrinsicHash)).toBeUndefined();
          expect(await db.crosschainOutboundTransfersTable.get(migrated.id)).toMatchObject({
            ...migrated,
            argonRequestTransactionId: historicalRequest.id,
            updatedAt: expect.any(Date),
          });
          expect(
            tracker.getPendingAmount(walletKeys.defaultArgonAddress, walletKeys.coreEthereumAddress, MoveToken.ARGN),
          ).toBe(0n);
          expect(isCrosschainTransferVisible(visible.value)).toBe(history === 'active');
          if (history === 'active') {
            expect(tracker.getTransfer(migrated.id)?.persistedRecord?.argonRequestTransactionId).toBe(
              historicalRequest.id,
            );
            expect(visible.value.progress.currentStepLabel).toBe('Step 2 of 3: Waiting for Minting Authorization');
          }
        });
      } finally {
        errorLog.mockRestore();
        tracker.shutdown();
        await transactions.shutdown();
        await db.close();
      }
    },
  );

  it('keeps newer work selected after replaying a settled native failure and restarting', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys(TEST_MNEMONIC);
    const oldId = 'settled-native-failure';
    const currentId = 'newer-active-transfer';
    const failedRequest = await db.transactionsTable.insert({
      extrinsicHash: `0x${'61'.repeat(32)}`,
      extrinsicMethodJson: {},
      extrinsicType: ExtrinsicType.CrosschainTransferTransferOut,
      metadataJson: {
        actionType: 'transferOutToEthereum',
        localTransferId: oldId,
        moveToken: MoveToken.ARGN,
        amount: 100n,
        sourceWalletType: WalletType.argon,
        destinationAddress: walletKeys.coreEthereumAddress,
      },
      accountAddress: walletKeys.defaultArgonAddress,
      submittedAtBlockHeight: 1,
      submittedAtTime: new Date('2024-01-01T00:00:00Z'),
      txNonce: 0,
    });
    await db.transactionsTable.recordInBlock(failedRequest, {
      blockNumber: 10,
      blockHash: `0x${'62'.repeat(32)}`,
      blockTime: new Date('2024-01-01T00:10:00Z'),
      tip: 0n,
      feePlusTip: 1n,
      extrinsicIndex: 0,
      transactionEvents: [],
      extrinsicError: Object.assign(new Error('Synthetic request failure'), {
        txFee: 1n,
        errorCode: 'synthetic.Failure',
        details: 'Synthetic request failure',
      }),
    });
    await db.transactionsTable.markFinalized(failedRequest, {
      blockNumber: 10,
      blockTime: new Date('2024-01-01T00:10:00Z'),
    });
    await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
      id: oldId,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 100n,
      argonSourceAddress: walletKeys.defaultArgonAddress,
      destinationAddress: walletKeys.coreEthereumAddress,
      argonRequestTransactionId: failedRequest.id,
      progressJson: createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
    });
    await db.crosschainOutboundTransfersTable.recordFailed({ id: oldId, failureReason: 'Synthetic request failure' });
    await db.crosschainOutboundTransfersTable.upsert({
      id: currentId,
      transferId: `0x${'63'.repeat(32)}`,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 100n,
      argonSourceAddress: walletKeys.defaultArgonAddress,
      destinationAddress: walletKeys.coreEthereumAddress,
      status: CrosschainOutboundTransferStatus.RequestFinalizedOnArgon,
      progressJson: createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
    });
    // Preserve the two production writes' chronology; SQLite timestamps use its own wall clock.
    await db.execute('DROP TRIGGER CrosschainOutboundTransfersUpdateTimestamp');
    await db.execute('UPDATE CrosschainOutboundTransfers SET createdAt = ?, updatedAt = ? WHERE id = ?', [
      '2024-01-01 00:00:00',
      '2024-01-01 00:10:00',
      oldId,
    ]);
    await db.execute('UPDATE CrosschainOutboundTransfers SET createdAt = ?, updatedAt = ? WHERE id = ?', [
      '2025-01-01 00:00:00',
      '2025-01-01 00:10:00',
      currentId,
    ]);
    await db.execute(`CREATE TRIGGER CrosschainOutboundTransfersUpdateTimestamp AFTER UPDATE ON CrosschainOutboundTransfers
      BEGIN UPDATE CrosschainOutboundTransfers SET updatedAt = CURRENT_TIMESTAMP WHERE id = NEW.id; END`);
    const settled = (await db.crosschainOutboundTransfersTable.get(oldId))!;
    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 20, blockHash: `0x${'64'.repeat(32)}` },
      getApi: async () => ({}),
    });
    getMainchainClientMock.mockResolvedValue({});
    const transactions = new TransactionTracker(Promise.resolve(db), blockWatch.instance as any);
    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactions,
      blockWatch.instance as any,
      walletKeys,
      undefined,
    );
    let restoredTransactions: TransactionTracker | undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await tracker.load();
      expect(tracker.getLatestTransfer(MoveToken.ARGN)?.id).toBe(currentId);
      await transactions.data.txInfos[0].waitForPostProcessing.catch(() => undefined);
      blockWatch.emitFinalized({ blockNumber: 21, blockHash: `0x${'65'.repeat(32)}` });
      await transactions.data.txInfos[0].waitForPostProcessing.catch(() => undefined);
      expect((await db.crosschainOutboundTransfersTable.get(oldId))?.updatedAt).toEqual(settled.updatedAt);
      await tracker.dismissFailedTransfer(oldId);
      expect(tracker.getTransfer(oldId)).toBeUndefined();
      for (const blockNumber of [22, 23, 24]) {
        blockWatch.emitFinalized({ blockNumber, blockHash: `0x${'66'.repeat(32)}` });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(transactions.data.txInfos[0].hasFailedPostProcessing).toBe(false);
        expect(await db.crosschainOutboundTransfersTable.get(oldId)).toMatchObject({
          failureReason: 'Synthetic request failure',
          isFailureAcknowledged: true,
        });
        expect(tracker.getLatestTransfer(MoveToken.ARGN)?.id).toBe(currentId);
      }
      tracker.shutdown();
      await transactions.shutdown();

      const restoredWatch = createBlockWatch({
        initialHeader: { blockNumber: 24, blockHash: `0x${'66'.repeat(32)}` },
        getApi: async () => ({}),
      });
      restoredTransactions = new TransactionTracker(Promise.resolve(db), restoredWatch.instance as any);
      const restored = new EthereumOutboundTransferTracker(
        Promise.resolve(db),
        restoredTransactions,
        restoredWatch.instance as any,
        walletKeys,
        undefined,
      );
      restored.data = reactive(restored.data);
      const visible = computed(() => restored.getTransferStateForToken(MoveToken.ARGN));
      await restored.load();
      expect(restored.getLatestTransfer(MoveToken.ARGN)?.id).toBe(currentId);
      expect(isCrosschainTransferActive(visible.value)).toBe(true);
      expect(visible.value.needsAttention).toBe(false);
      for (const blockNumber of [25, 26]) {
        restoredWatch.emitFinalized({ blockNumber, blockHash: `0x${'67'.repeat(32)}` });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(restoredTransactions.data.txInfos[0].hasFailedPostProcessing).toBe(false);
        expect(await db.crosschainOutboundTransfersTable.get(oldId)).toMatchObject({
          failureReason: 'Synthetic request failure',
          isFailureAcknowledged: true,
        });
        expect(restored.getLatestTransfer(MoveToken.ARGN)?.id).toBe(currentId);
        expect(visible.value.needsAttention).toBe(false);
      }
    } finally {
      warn.mockRestore();
      tracker.shutdown();
      await transactions.shutdown();
      await restoredTransactions?.shutdown();
      await db.close();
    }
  });

  it('persists its Ethereum hash before sending and resumes receipt checks through restart and RPC delays', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys(TEST_MNEMONIC);
    const id = 'signed-ethereum-attempt';
    const gatewayAddress = `0x${'51'.repeat(20)}` as const;
    await db.crosschainOutboundTransfersTable.upsert({
      id,
      destinationChain: 'Ethereum',
      token: MoveToken.ARGN,
      amount: 100n,
      argonSourceAddress: walletKeys.defaultArgonAddress,
      destinationAddress: walletKeys.coreEthereumAddress,
      status: CrosschainOutboundTransferStatus.MintingAuthorized,
      finalizeRequestJson: {
        argonAccountId: `0x${'52'.repeat(32)}`,
        argonTransferNonce: 1n,
        chainId: 1n,
        microgonsPerArgonot: 3n,
        recipient: getAddress(walletKeys.coreEthereumAddress),
        validUntilBlock: 500n,
        token: `0x${'53'.repeat(20)}`,
        amount: 100n,
        mintingAuthorityTip: 1n,
      },
      finalizeProofJson: {
        authorizations: [
          {
            microgonCollateral: 100n,
            micronotCollateral: 0n,
            signature: `0x${'00'.repeat(64)}1c`,
          },
        ],
      },
      progressJson: createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
    });
    const request = (await db.crosschainOutboundTransfersTable.get(id))!.finalizeRequestJson!;
    const transferId = EvmContracts.hashMintingGatewayTransferOutOfArgonRequest(request);
    await db.crosschainOutboundTransfersTable.patch(id, { transferId });
    const finalizedEvent = EvmContracts.mintingGatewayAbi.find(
      item => item.type === 'event' && item.name === 'TransferOutOfArgonFinalized',
    )!;
    const canonicalTopics = encodeEventTopics({
      abi: EvmContracts.mintingGatewayAbi,
      eventName: 'TransferOutOfArgonFinalized',
    });
    const canonicalData = encodeAbiParameters(finalizedEvent.inputs, [
      transferId,
      request.token,
      100n,
      [],
      {
        gatewayActivityNonce: 9n,
        argonApprovalsNonce: 8n,
        argonCirculation: 100n,
        argonotCirculation: 0n,
      },
    ]);
    const blockHash = `0x${'58'.repeat(32)}` as const;
    let receiptAvailable = false;
    let gatewayFinalized = false;
    let receiptError: Error | undefined;
    let receiptChecks = 0;
    const sent: Hex[] = [];
    const persistedHashes: (Hex | undefined)[] = [];
    const blockWatch = createBlockWatch({
      initialHeader: { blockNumber: 20, blockHash: `0x${'54'.repeat(32)}` },
      getApi: async header => {
        if (header.blockNumber > 21) throw new Error('Receipt polling must not read native history');
        return { query: { crosschainTransfer: { transferOutById: async () => ({ state: { type: 'Ready' } }) } } };
      },
    });
    const getReceipt = async ({ hash }: { hash: Hex }) => {
      receiptChecks += 1;
      if (receiptError) throw receiptError;
      if (!receiptAvailable) throw new TransactionReceiptNotFoundError({ hash });
      return {
        transactionHash: hash,
        status: 'success',
        blockNumber: 400n,
        blockHash,
        logs: [{ address: gatewayAddress, data: canonicalData, topics: canonicalTopics }],
      };
    };
    const ethereumClient = new EthereumClient(walletKeys, 'https://ethereum.test');
    Object.assign(ethereumClient, {
      loadChainConfig: async () => ({ chainId: 1, gatewayAddress }),
      createExecutionClient: async () => ({
        chain: { id: 1 },
        publicClient: {
          estimateGas: async () => 100_000n,
          estimateFeesPerGas: async () => ({ gasPrice: 1n, maxFeePerGas: 5n, maxPriorityFeePerGas: 2n }),
          getBalance: async () => 10_000_000n,
          getBlockNumber: async () => 450n,
          getTransactionCount: async () => 3,
          readContract: async ({ functionName, args }: { functionName: string; args: Hex[] }) => {
            expect(functionName).toBe('finalizedTransferOutOfArgonIds');
            expect(args).toEqual([transferId]);
            return gatewayFinalized;
          },
          getLogs: () => {
            throw new Error('Receipt polling must not scan Ethereum history');
          },
          sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
            sent.push(serializedTransaction);
            persistedHashes.push((await db.crosschainOutboundTransfersTable.get(id))?.targetTxHash);
            return keccak256(serializedTransaction);
          },
          getTransactionReceipt: getReceipt,
          waitForTransactionReceipt: getReceipt,
          getTransaction: async ({ hash }: { hash: Hex }) => {
            throw new TransactionNotFoundError({ hash });
          },
        },
      }),
    });
    await db.execute(`CREATE TRIGGER RejectOutboundHash BEFORE UPDATE OF targetTxHash ON CrosschainOutboundTransfers
      BEGIN SELECT RAISE(ABORT, 'temporary hash write failure'); END`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = vi.spyOn(Date, 'now');
    getMainchainClientMock.mockResolvedValue({});
    const transactions = new TransactionTracker(Promise.resolve(db), blockWatch.instance as any);
    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactions,
      blockWatch.instance as any,
      walletKeys,
      ethereumClient,
    );
    let restored: EthereumOutboundTransferTracker | undefined;
    try {
      await tracker.load();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ message: 'temporary hash write failure' }),
        ),
      );
      expect(sent).toEqual([]);
      expect((await db.crosschainOutboundTransfersTable.get(id))?.targetTxHash).toBeUndefined();
      expect(tracker.getTransfer(id)?.persistedRecord?.status).toBe(CrosschainOutboundTransferStatus.MintingAuthorized);

      await db.execute('DROP TRIGGER RejectOutboundHash');
      blockWatch.emitFinalized({ blockNumber: 21, blockHash: `0x${'55'.repeat(32)}` });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      const hash = keccak256(sent[0]);
      expect(persistedHashes).toEqual([hash]);
      expect(parseTransaction(sent[0]).nonce).toBe(3);
      expect(await db.crosschainOutboundTransfersTable.get(id)).toMatchObject({
        status: CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain,
        targetTxHash: hash,
      });
      tracker.shutdown();

      // A days-old recorded hash still owns the transfer when its RPC is temporarily unavailable.
      gatewayFinalized = true;
      const record = (await db.crosschainOutboundTransfersTable.get(id))!;
      clock.mockReturnValue(record.updatedAt.getTime() + 3 * 24 * 60 * 60 * 1000);
      receiptError = new Error('temporary Ethereum receipt RPC failure');
      restored = new EthereumOutboundTransferTracker(
        Promise.resolve(db),
        transactions,
        blockWatch.instance as any,
        walletKeys,
        ethereumClient,
      );
      restored.data = reactive(restored.data);
      const visible = computed(() => restored?.getTransfer(id)?.transferState);
      await restored.load();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), receiptError));
      expect(visible.value?.amount).toBe(100n);
      expect(visible.value?.progress.currentStepDetail).toContain('Waiting for confirmation');
      expect(isCrosschainTransferActive(visible.value)).toBe(true);
      expect((await db.crosschainOutboundTransfersTable.get(id))?.failureReason).toBeUndefined();
      expect(sent).toHaveLength(1);

      // The gateway knows delivery while receipt indexing catches up. Keep the same hash.
      receiptError = undefined;
      const checksBefore = receiptChecks;
      blockWatch.emitFinalized({ blockNumber: 22, blockHash: `0x${'56'.repeat(32)}` });
      await vi.waitFor(() => expect(receiptChecks).toBeGreaterThan(checksBefore + 1));
      expect((await db.crosschainOutboundTransfersTable.get(id))?.targetTxHash).toBe(hash);
      expect(sent).toHaveLength(1);
      expect(visible.value?.needsAttention).toBe(false);

      receiptAvailable = true;
      blockWatch.emitFinalized({ blockNumber: 23, blockHash: `0x${'57'.repeat(32)}` });
      await vi.waitFor(async () => {
        expect(await db.crosschainOutboundTransfersTable.get(id)).toMatchObject({
          status: CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain,
          targetTxHash: hash,
          targetBlockNumber: 400,
          gatewayActivityNonce: 9n,
        });
        expect(visible.value?.isComplete).toBe(true);
      });
      expect((await db.crosschainOutboundTransfersTable.get(id))?.failureReason).toBeUndefined();
      expect(sent).toHaveLength(1);
    } finally {
      tracker.shutdown();
      restored?.shutdown();
      clock.mockRestore();
      warn.mockRestore();
      await transactions.shutdown();
      await db.close();
    }
  });

  it.each(['success', 'reverted'] as const)(
    'advances a sibling and observes Ethereum %s after Argon callbacks stop',
    async outcome => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const db = await createTestDb();
      const walletKeys = createMockWalletKeys(TEST_MNEMONIC);
      const id = 'unconfirmed-ethereum';
      const txHash = `0x${'81'.repeat(32)}` as const;
      const transferId = `0x${'82'.repeat(32)}` as const;
      const gatewayAddress = `0x${'83'.repeat(20)}` as const;
      const token = `0x${'84'.repeat(20)}` as const;

      const nativeRequest = await db.transactionsTable.insert({
        extrinsicHash: `0x${'91'.repeat(32)}`,
        extrinsicMethodJson: {},
        extrinsicType: ExtrinsicType.CrosschainTransferTransferOut,
        metadataJson: {
          actionType: 'transferOutToEthereum',
          localTransferId: 'awaiting-authorization',
          moveToken: MoveToken.ARGN,
          amount: 100n,
          sourceWalletType: WalletType.argon,
          destinationAddress: walletKeys.coreEthereumAddress,
        },
        accountAddress: walletKeys.defaultArgonAddress,
        submittedAtBlockHeight: 1,
        submittedAtTime: new Date('2025-12-31T00:00:00Z'),
        txNonce: 0,
      });
      await db.transactionsTable.markFinalized(nativeRequest, {
        blockNumber: 2,
        blockTime: new Date('2025-12-31T00:00:00Z'),
      });

      for (const record of [
        {
          id,
          transferId,
          finalizeRequestJson: {
            argonAccountId: `0x${'22'.repeat(32)}` as const,
            argonTransferNonce: 1n,
            chainId: 1n,
            microgonsPerArgonot: 3n,
            recipient: getAddress(walletKeys.coreEthereumAddress),
            validUntilBlock: 500n,
            token,
            amount: 100n,
            mintingAuthorityTip: 1n,
          },
          finalizeProofJson: {
            authorizations: [
              { microgonCollateral: 100n, micronotCollateral: 0n, signature: `0x${'00'.repeat(64)}1c` as const },
            ],
          },
          status: CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain,
          targetTxHash: txHash,
          createdAt: new Date('2025-12-30T00:00:00Z'),
        },
        {
          id: 'awaiting-authorization',
          argonRequestTransactionId: nativeRequest.id,
          transferId: `0x${'93'.repeat(32)}`,
          status: CrosschainOutboundTransferStatus.RequestFinalizedOnArgon,
          createdAt: new Date('2025-12-31T00:00:00Z'),
        },
      ]) {
        await db.crosschainOutboundTransfersTable.upsert({
          ...record,
          destinationChain: 'Ethereum',
          token: MoveToken.ARGN,
          amount: 100n,
          argonSourceAddress: walletKeys.defaultArgonAddress,
          destinationAddress: walletKeys.coreEthereumAddress,
          progressJson: createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
        });
      }
      const event = EvmContracts.mintingGatewayAbi.find(
        item => item.type === 'event' && item.name === 'TransferOutOfArgonFinalized',
      )!;
      const topics = encodeEventTopics({
        abi: EvmContracts.mintingGatewayAbi,
        eventName: 'TransferOutOfArgonFinalized',
      });
      const data = encodeAbiParameters(event.inputs, [
        transferId,
        token,
        100n,
        [],
        {
          gatewayActivityNonce: 7n,
          argonApprovalsNonce: 8n,
          argonCirculation: 100n,
          argonotCirculation: 0n,
        },
      ]);
      let hasReceipt = false;
      let receiptError: Error | undefined;
      let receiptStatus: 'success' | 'reverted' = 'success';
      let receiptBlock = 42n;
      let receiptBlockHash: Hex = `0x${'86'.repeat(32)}`;
      let executionHead = 43n;
      const receipt = vi.fn(async () => {
        if (receiptError) throw receiptError;
        if (!hasReceipt) throw new TransactionReceiptNotFoundError({ hash: txHash });
        return {
          status: receiptStatus,
          transactionHash: txHash,
          blockNumber: receiptBlock,
          blockHash: receiptBlockHash,
          logs: receiptStatus === 'success' ? [{ address: gatewayAddress, data, topics }] : [],
        };
      });
      const ethereumClient = new EthereumClient(walletKeys, 'https://ethereum.test');
      Object.assign(ethereumClient, {
        loadChainConfig: async () => ({ chainId: 1, gatewayAddress }),
        createExecutionClient: async () => ({
          chain: { id: 1 },
          publicClient: {
            getTransactionReceipt: receipt,
            waitForTransactionReceipt: receipt,
            getBlockNumber: async () => executionHead,
            getTransactionCount: async () => 0,
            estimateFeesPerGas: async () => ({ gasPrice: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
            estimateGas: async () => {
              throw new Error('temporary gas RPC failure');
            },
          },
        }),
      });
      vi.spyOn(ethereumClient, 'getTransactionFinalityBlocks').mockReturnValue(2);
      vi.spyOn(ethereumClient, 'getTransactionFinalityPollMs').mockReturnValue(1_000);
      let nativeLookupError: Error | undefined;
      const blockWatch = createBlockWatch({
        initialHeader: { blockNumber: 10, blockHash: '0xwaiting' },
        getApi: async header => ({
          query: {
            crosschainTransfer: {
              transferOutById: async () => {
                if (nativeLookupError) throw nativeLookupError;
                if (header.blockNumber < 2) return;
                if (header.blockNumber >= 13) return;
                if (header.blockNumber < 12) {
                  return {
                    state: { type: 'Started' },
                    amount: 100n,
                    totalAttachedCollateral: BigInt(header.blockNumber - 10) * 50n,
                  };
                }
                return {
                  state: { type: 'Ready' },
                  asset: { type: 'Argon' },
                  amount: 100n,
                  mintingAuthorityTip: 1n,
                  argonAccountId: walletKeys.defaultArgonAddress,
                  argonTransferNonce: 2n,
                  microgonsPerArgonot: 3n,
                  destinationAccount: walletKeys.coreEthereumAddress,
                  validUntilEthereumBlock: 500n,
                  mintingAuthorityCollateralBySigner: {
                    syntheticSigner: {
                      microgonCollateral: 100n,
                      micronotCollateral: 0n,
                      signature: `0x${'00'.repeat(64)}1c`,
                    },
                  },
                };
              },
              chainConfigBySourceChain: async () => ({
                type: 'Evm',
                value: { chainId: 1n, argonToken: token, argonotToken: `0x${'55'.repeat(20)}` },
              }),
            },
          },
        }),
      });
      getMainchainClientMock.mockResolvedValue({});
      const transactions = new TransactionTracker(Promise.resolve(db), blockWatch.instance as any);
      const tracker = new EthereumOutboundTransferTracker(
        Promise.resolve(db),
        transactions,
        blockWatch.instance as any,
        walletKeys,
        ethereumClient,
      );
      tracker.data = reactive(tracker.data);
      const visible = computed(() => tracker.getTransfer(id)?.transferState);
      const authorizationState = computed(() => tracker.getTransfer('awaiting-authorization')?.transferState);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await tracker.load();
        await vi.waitFor(() => expect(isCrosschainTransferActive(visible.value)).toBe(true));
        await vi.advanceTimersByTimeAsync(0);
        expect(tracker.getTransfer('awaiting-authorization')?.transferState.progress.steps[1].approvalPercent).toBe(0);
        expect(isCrosschainTransferActive(visible.value)).toBe(true);
        hasReceipt = true;
        blockWatch.emitFinalized({ blockNumber: 11, blockHash: '0xpartially-authorized' });
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => {
          expect(tracker.getTransfer('awaiting-authorization')?.transferState.progress.steps[1].approvalPercent).toBe(
            50,
          );
          expect(visible.value?.progress.steps[2]).toMatchObject({
            progressPct: 50,
            confirmations: 1,
            expectedConfirmations: 2,
          });
        });
        expect((await db.crosschainOutboundTransfersTable.get(id))?.failureReason).toBeUndefined();
        expect(isCrosschainTransferActive(visible.value)).toBe(true);
        const partialProgress = visible.value!.progress;

        receiptError = new Error('temporary Ethereum receipt RPC failure');
        blockWatch.emitFinalized({ blockNumber: 12, blockHash: '0xauthorized' });
        await vi.waitFor(async () => {
          expect(await db.crosschainOutboundTransfersTable.get('awaiting-authorization')).toMatchObject({
            status: CrosschainOutboundTransferStatus.MintingAuthorized,
            mintingAuthorizedMicrogons: 100n,
            mintingAuthorizedArgonBlockNumber: 12,
          });
          expect(tracker.getTransfer('awaiting-authorization')?.transferState.progress.steps[1].progressPct).toBe(100);
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(warn).toHaveBeenCalledWith(expect.any(String), receiptError);
        expect(visible.value!.progress).toEqual(partialProgress);
        expect(visible.value!.error).toBe('');
        expect((await db.crosschainOutboundTransfersTable.get(id))?.failureReason).toBeUndefined();

        // A lagging node's pre-request snapshot cannot invalidate the newer saved authorization.
        blockWatch.emitFinalized({ blockNumber: 1, blockHash: '0xlagging-native-node' });
        await vi.advanceTimersByTimeAsync(1_000);
        const savedAuthorization = await db.crosschainOutboundTransfersTable.get('awaiting-authorization');
        expect(savedAuthorization?.failureReason).toBeUndefined();
        expect(savedAuthorization?.mintingAuthorizedArgonBlockNumber).toBe(12);
        expect(isCrosschainTransferActive(authorizationState.value)).toBe(true);

        // The unsigned sibling keeps its saved proof through an outage, then exits when Argon expires it.
        nativeLookupError = new Error('temporary Argon state RPC failure');
        blockWatch.emitFinalized({ blockNumber: 13, blockHash: '0xnative-rpc-delay' });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(
          (await db.crosschainOutboundTransfersTable.get('awaiting-authorization'))?.failureReason,
        ).toBeUndefined();
        expect(isCrosschainTransferActive(authorizationState.value)).toBe(true);
        expect(authorizationState.value?.amount).toBe(100n);

        nativeLookupError = undefined;
        blockWatch.emitFinalized({ blockNumber: 14, blockHash: '0xexpired-native-request' });
        await vi.waitFor(async () => {
          const expired = await db.crosschainOutboundTransfersTable.get('awaiting-authorization');
          expect(isCrosschainTransferActive(authorizationState.value)).toBe(false);
          expect(expired?.failureReason).toContain('no longer available on Argon');
          expect(expired?.targetTxHash).toBeUndefined();
          expect(expired?.mintingAuthorizedMicrogons).toBe(100n);
          expect(authorizationState.value?.needsAttention).toBe(true);
          expect(authorizationState.value?.amount).toBe(100n);
        });

        receiptError = undefined;
        receiptStatus = 'reverted';
        receiptBlockHash = `0x${'87'.repeat(32)}`;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(isCrosschainTransferActive(visible.value)).toBe(true);
        expect((await db.crosschainOutboundTransfersTable.get(id))?.failureReason).toBeUndefined();

        if (outcome === 'success') {
          receiptStatus = 'success';
          receiptBlock = 43n;
          receiptBlockHash = `0x${'88'.repeat(32)}`;
          executionHead = 44n;
          await vi.advanceTimersByTimeAsync(1_000);
          expect(isCrosschainTransferActive(visible.value)).toBe(true);
          expect((await db.crosschainOutboundTransfersTable.get(id))?.targetBlockNumber).toBeUndefined();
        }
        executionHead = receiptBlock + 2n;
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(async () => {
          const record = await db.crosschainOutboundTransfersTable.get(id);
          if (outcome === 'success') {
            expect(record?.status).toBe(CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain);
            expect(record?.gatewayActivityNonce).toBe(7n);
            expect(record?.targetBlockNumber).toBe(43);
            expect(visible.value?.isComplete).toBe(true);
          } else {
            expect(record?.failureReason).toContain('reverted');
            expect(visible.value?.needsAttention).toBe(true);
          }
          expect(isCrosschainTransferActive(visible.value)).toBe(false);
          expect(visible.value?.amount).toBe(100n);
        });
        expect(blockWatch.instance.finalizedBlockHeader.blockNumber).toBe(14);
        const receiptReads = receipt.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(receipt).toHaveBeenCalledTimes(receiptReads);
      } finally {
        warn.mockRestore();
        tracker.shutdown();
        await transactions.shutdown();
        await db.close();
        vi.useRealTimers();
      }
    },
  );

  it.each(['succeeded', 'expired without inclusion', 'nonce was reused'] as const)(
    'reconciles a dismissed Argon request after restart when it $0',
    async outcome => {
      getMainchainClientMock.mockResolvedValue(createMainchainClient());
      const db = await createTestDb();
      const walletKeys = createMockWalletKeys(TEST_MNEMONIC);
      const transferId = 'outbound-unconfirmed-request';
      const metadata: ICrosschainTransferOutMetadata = {
        actionType: 'transferOutToEthereum',
        localTransferId: transferId,
        moveToken: MoveToken.ARGN,
        amount: 100n,
        sourceWalletType: WalletType.argon,
        destinationAddress: walletKeys.coreEthereumAddress,
        mortalityBlocks: 64,
      };
      const transaction = await db.transactionsTable.insert({
        extrinsicHash: `0x${'ab'.repeat(32)}`,
        extrinsicMethodJson: {},
        extrinsicType: ExtrinsicType.CrosschainTransferTransferOut,
        metadataJson: metadata,
        accountAddress: walletKeys.defaultArgonAddress,
        submittedAtBlockHeight: 1,
        submittedAtTime: new Date(),
        txNonce: 0,
      });
      await db.transactionsTable.recordSubmissionError(transaction, new Error('RPC connection lost'));
      await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
        id: transferId,
        destinationChain: 'Ethereum',
        token: MoveToken.ARGN,
        amount: 100n,
        argonSourceAddress: walletKeys.defaultArgonAddress,
        destinationAddress: walletKeys.coreEthereumAddress,
        argonRequestTransactionId: transaction.id,
        progressJson: createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
      });
      await db.crosschainOutboundTransfersTable.recordFailed({ id: transferId, failureReason: 'RPC connection lost' });

      const initialHeader = { blockNumber: 1, blockHash: '0xhead' };
      let finalizedNonce = 0;
      const getApi = async () => ({ query: { system: { account: async () => ({ nonce: finalizedNonce }) } } });
      const findTransaction = vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const firstBlockWatch = createBlockWatch({ initialHeader, getApi });
      const transactions = new TransactionTracker(Promise.resolve(db), firstBlockWatch.instance as any);
      let restoredTransactionTracker: TransactionTracker | undefined;
      try {
        const tracker = new EthereumOutboundTransferTracker(
          Promise.resolve(db),
          transactions,
          firstBlockWatch.instance as any,
          walletKeys,
          undefined,
        );
        await tracker.load();
        await vi.waitFor(() =>
          expect(tracker.getLatestTransfer(MoveToken.ARGN)?.transferState.needsAttention).toBe(true),
        );
        expect(
          tracker.getPendingAmount(walletKeys.defaultArgonAddress, walletKeys.coreEthereumAddress, MoveToken.ARGN),
        ).toBe(100n);

        await tracker.dismissFailedTransfer(transferId);
        expect(tracker.getLatestTransfer(MoveToken.ARGN)).toBeUndefined();
        expect(
          tracker.getPendingAmount(walletKeys.defaultArgonAddress, walletKeys.coreEthereumAddress, MoveToken.ARGN),
        ).toBe(100n);

        tracker.shutdown();
        await transactions.shutdown();
        const restoredBlockWatch = createBlockWatch({ initialHeader, getApi });
        restoredTransactionTracker = new TransactionTracker(Promise.resolve(db), restoredBlockWatch.instance as any);
        const restored = new EthereumOutboundTransferTracker(
          Promise.resolve(db),
          restoredTransactionTracker,
          restoredBlockWatch.instance as any,
          walletKeys,
          undefined,
        );
        restored.data = reactive(restored.data);
        const visibleTransferState = computed(() => restored.getTransferStateForToken(MoveToken.ARGN));
        const reservation = computed(() =>
          restored.getPendingAmount(walletKeys.defaultArgonAddress, walletKeys.coreEthereumAddress, MoveToken.ARGN),
        );
        await restored.load();
        expect(restored.getLatestTransfer(MoveToken.ARGN)).toBeUndefined();
        expect(reservation.value).toBe(100n);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(restoredTransactionTracker.data.txInfos[0].hasFailedPostProcessing).toBe(false);

        const lookupError = new Error('RPC unavailable');
        findTransaction.mockRejectedValue(lookupError);
        restoredBlockWatch.emitFinalized({ blockNumber: 2, blockHash: '0xretry' });
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), lookupError));
        expect((await db.crosschainOutboundTransfersTable.get(transferId))?.isFailureAcknowledged).toBe(true);
        expect(restored.getLatestTransfer(MoveToken.ARGN)).toBeUndefined();
        expect(reservation.value).toBe(100n);

        if (outcome === 'succeeded') {
          findTransaction.mockResolvedValue({
            blockNumber: 10,
            blockHash: `0x${'ab'.repeat(32)}`,
            blockTime: Date.now(),
            fee: 1n,
            tip: 0n,
            extrinsicIndex: 5,
            extrinsicEvents: [
              {
                section: 'crosschainTransfer',
                method: 'TransferOutStarted',
                data: {
                  destinationChain: { type: 'Ethereum' },
                  transferId: `0x${'77'.repeat(32)}`,
                  accountId: walletKeys.defaultArgonAddress,
                  asset: { type: 'Argon' },
                  amount: 100n,
                  mintingAuthorityTip: 0n,
                },
              },
            ] satisfies HistoricalEvent[],
          });
        } else {
          findTransaction.mockResolvedValue(undefined);
          restoredBlockWatch.emitFinalized({ blockNumber: 62, blockHash: '0xearly-timeout' });
          expect(reservation.value).toBe(100n);
          const expiredLookupError = new Error('RPC unavailable after timeout');
          findTransaction.mockRejectedValue(expiredLookupError);
          restoredBlockWatch.emitFinalized({ blockNumber: 66, blockHash: '0xmaturity' });
          await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), expiredLookupError));
          expect(reservation.value).toBe(100n);
        }
        if (outcome !== 'succeeded') findTransaction.mockResolvedValue(undefined);
        if (outcome === 'nonce was reused') finalizedNonce = 1;
        restoredBlockWatch.emitFinalized({
          blockNumber: outcome === 'succeeded' ? 10 : 67,
          blockHash: '0xtransfer-block',
        });
        await vi.waitFor(async () => {
          const journal = (await db.transactionsTable.fetchAll())[0];
          if (outcome === 'succeeded') expect(journal.status).toBe(TransactionStatus.Finalized);
          if (outcome === 'expired without inclusion')
            expect(journal.status).toBe(TransactionStatus.TimedOutWaitingForBlock);
          if (outcome === 'nonce was reused') {
            expect(journal.status).toBe(TransactionStatus.Error);
            expect(journal.isFinalized).toBe(false);
            expect(restoredTransactionTracker!.data.txInfos[0].txResult.submissionError?.message).toContain(
              'nonce was already used',
            );
          }
          expect((await db.crosschainOutboundTransfersTable.get(transferId))?.status).toBe(
            outcome === 'succeeded'
              ? CrosschainOutboundTransferStatus.RequestFinalizedOnArgon
              : CrosschainOutboundTransferStatus.RequestSubmittedToArgon,
          );
          expect(reservation.value).toBe(0n);
        });

        if (outcome === 'succeeded') {
          expect(restored.getLatestTransfer(MoveToken.ARGN)?.id).toBe(transferId);
          expect(isCrosschainTransferActive(visibleTransferState.value)).toBe(true);
          expect(visibleTransferState.value.progress.currentStepLabel).toBe(
            'Step 2 of 3: Waiting for Minting Authorization',
          );
          expect(visibleTransferState.value.error).toBe('');
        } else {
          expect(restored.getLatestTransfer(MoveToken.ARGN)).toBeUndefined();
          expect(restored.hasSignerDependentTransfer(walletKeys.coreEthereumAddress)).toBe(false);
          restoredBlockWatch.emitFinalized({ blockNumber: 68, blockHash: '0xafter-absence' });
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(restoredTransactionTracker.data.txInfos[0].hasFailedPostProcessing).toBe(false);
        }
      } finally {
        warn.mockRestore();
        findTransaction.mockRestore();
        await transactions.shutdown();
        await restoredTransactionTracker?.shutdown();
        await db.close();
      }
    },
  );
});

function createMainchainClient() {
  const now = BigInt(Date.now());

  return {
    rpc: { author: { pendingExtrinsics: vi.fn(async () => []) } },
    query: {
      ethereumVerifier: {
        latestExecutionHeaderAnchorBlockHash: vi.fn(async () => `0x${'aa'.repeat(32)}`),
        executionHeaderAnchors: vi.fn(async () => ({ timestampMillis: now })),
      },
    },
    consts: {
      crosschainTransfer: {
        maxVerifiedExecutionBlockAgeTicks: 60n,
      },
    },
  };
}

function createBlockWatch(args: {
  initialHeader: { blockNumber: number; blockHash: string };
  getApi: (header: { blockNumber: number; blockHash: string }) => Promise<unknown>;
}) {
  const events = new EventEmitter();
  const instance = {
    finalizedBlockHeader: { ...args.initialHeader, blockTime: Date.now() },
    bestBlockHeader: {
      ...args.initialHeader,
      blockTime: Date.now(),
    },
    start: vi.fn(async () => {}),
    getApi: vi.fn(args.getApi),
    events: {
      on: (eventName: string, handler: (headers: Array<{ blockNumber: number; blockHash: string }>) => void) => {
        events.on(eventName, handler);
        return () => events.off(eventName, handler);
      },
    },
  };

  return {
    instance,
    emitBest() {
      events.emit('best-blocks', [instance.bestBlockHeader]);
    },
    emitFinalized(header: { blockNumber: number; blockHash: string }) {
      instance.finalizedBlockHeader = { ...header, blockTime: Date.now() };
      instance.bestBlockHeader = {
        ...header,
        blockTime: Date.now(),
      };
      events.emit('finalized', [header]);
    },
  };
}
