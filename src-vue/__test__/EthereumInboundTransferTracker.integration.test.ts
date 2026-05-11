import { createDeferred, MoveToken } from '@argonprotocol/apps-core';
import type { Hash } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import type { EthereumClient, IEthereumBurnTransfer, IEthereumMoveToken } from '../lib/EthereumClient.ts';
import { EthereumInboundTransferTracker } from '../lib/EthereumInboundTransferTracker.ts';
import {
  CrosschainInboundTransferStatus,
  type ICrosschainInboundTransferRecord,
} from '../lib/db/CrosschainInboundTransfersTable.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import { TransactionTracker, TxAttemptState } from '../lib/TransactionTracker.ts';
import { WalletType } from '../lib/Wallet.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({
    tx: {
      crosschainTransfer: {
        proveTransfer: vi.fn((args: unknown) => args),
      },
    },
  })),
}));

type IEthereumProofTxMetadata = {
  txHash: string;
  logIndex: number;
  recipientAddress: string;
  moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
};

describe('EthereumInboundTransferTracker integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists a new transfer through Argon proof submission', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const approveTransfer = createDeferred<void>();
    const submittedBurnTransfer = createBurnTransfer({
      moveToken: MoveToken.ARGN,
      destinationAddress: walletKeys.investmentAddress,
      burnTxHash: `0x${'11'.repeat(32)}`,
    });
    const confirmedBurnTransfer = {
      ...submittedBurnTransfer,
      burnBlockNumber: 42,
      burnBlockHash: `0x${'22'.repeat(32)}`,
      burnLogIndex: 7,
    } satisfies IEthereumBurnTransfer;
    const txInfo = createTxInfo({
      id: 91,
      extrinsicHash: `0x${'33'.repeat(32)}`,
      metadataJson: {
        txHash: confirmedBurnTransfer.burnTxHash,
        logIndex: confirmedBurnTransfer.burnLogIndex,
        recipientAddress: confirmedBurnTransfer.destinationAddress,
        moveToken: confirmedBurnTransfer.moveToken,
      },
    });
    const submitBurnTransfer = vi.fn(async () => submittedBurnTransfer);
    const confirmBurnTransfer = vi.fn(async () => confirmedBurnTransfer);
    const submitAndWatch = vi.fn(async () => txInfo);
    const ethereumClient = createEthereumClient(walletKeys.ethereumAddress, {
      approveTransfer: vi.fn(() => approveTransfer.promise),
      submitBurnTransfer,
      confirmBurnTransfer,
      buildBurnProof: vi.fn(async () => ({ eventLog: { id: 'event-log' }, proof: { id: 'proof' } })),
    });
    const transactionTracker = createTransactionTracker({
      submitAndWatch,
    });
    const tracker = new EthereumInboundTransferTracker(
      Promise.resolve(db),
      transactionTracker,
      walletKeys,
      ethereumClient,
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGN,
      amountBaseUnits: 5_000_000_000_000n,
      targetWalletType: WalletType.investment,
    });

    expect(activeTransfer).toBeTruthy();
    expect(activeTransfer?.moveToken).toBe(MoveToken.ARGN);
    expect(activeTransfer?.transferState.isSubmitting).toBe(true);
    expect(submitBurnTransfer).not.toHaveBeenCalled();

    approveTransfer.resolve();

    await vi.waitFor(() => {
      expect(submitAndWatch).toHaveBeenCalledWith(
        expect.objectContaining({
          extrinsicType: ExtrinsicType.CrosschainTransferProve,
          metadata: {
            txHash: confirmedBurnTransfer.burnTxHash,
            logIndex: confirmedBurnTransfer.burnLogIndex,
            recipientAddress: confirmedBurnTransfer.destinationAddress,
            moveToken: confirmedBurnTransfer.moveToken,
          },
        }),
      );
    });

    await vi.waitFor(async () => {
      const persisted = await db.crosschainInboundTransfersTable.get(activeTransfer!.transferId);
      expect(persisted).toMatchObject({
        transferId: activeTransfer!.transferId,
        sourceChain: 'ethereum',
        token: MoveToken.ARGN,
        sourceAddress: walletKeys.ethereumAddress,
        sourceTxHash: confirmedBurnTransfer.burnTxHash,
        sourceBlockNumber: confirmedBurnTransfer.burnBlockNumber,
        sourceBlockHash: confirmedBurnTransfer.burnBlockHash,
        argonDestinationAddress: walletKeys.investmentAddress,
        status: CrosschainInboundTransferStatus.ArgonProofSubmitted,
        argonTxId: txInfo.tx.id,
        argonTxHash: txInfo.tx.extrinsicHash,
      });
      expect(persisted?.sourceReferenceJson).toEqual({ burnLogIndex: confirmedBurnTransfer.burnLogIndex });
    });
  });

  it('reattaches to a persisted proof attempt by burn metadata', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const persistedRecord = await insertTransferRecord(db, walletKeys.ethereumAddress, {
      transferId: 'eth-transfer-1',
      token: MoveToken.ARGNOT,
      argonDestinationAddress: walletKeys.vaultingAddress,
      status: CrosschainInboundTransferStatus.SourceFinalized,
    });
    const txInfo = createTxInfo({
      id: 92,
      extrinsicHash: `0x${'44'.repeat(32)}`,
      metadataJson: {
        txHash: persistedRecord.sourceTxHash!,
        logIndex: persistedRecord.sourceReferenceJson.burnLogIndex,
        recipientAddress: persistedRecord.argonDestinationAddress,
        moveToken: MoveToken.ARGNOT,
      },
    });
    const findLatestTxInfo = vi.fn((matcher: (txInfo: TransactionInfo<IEthereumProofTxMetadata>) => boolean) =>
      matcher(txInfo) ? txInfo : undefined,
    );
    const getTxAttemptState = vi.fn(async () => TxAttemptState.Follow);
    const submitAndWatch = vi.fn(async () => {
      throw new Error('submitAndWatch should not be called in this test');
    });
    const confirmBurnTransfer = vi.fn(async () => {
      throw new Error('confirmBurnTransfer should not be called in this test');
    });
    const transactionTracker = createTransactionTracker({
      findLatestTxInfo,
      getTxAttemptState,
      submitAndWatch,
    });
    const relayEthereumClient = createEthereumClient(walletKeys.ethereumAddress, {
      confirmBurnTransfer,
    });
    const tracker = new EthereumInboundTransferTracker(
      Promise.resolve(db),
      transactionTracker,
      walletKeys,
      relayEthereumClient,
    );

    const activeTransfer = await tracker.startMove({
      moveToken: MoveToken.ARGNOT,
      amountBaseUnits: 1n,
      targetWalletType: WalletType.vaulting,
    });

    expect(activeTransfer?.transferId).toBe(persistedRecord.transferId);
    expect(activeTransfer?.transferState.isSubmitting).toBe(true);
    expect(activeTransfer?.transferState.phase).toBe('confirmingArgon');
    expect(activeTransfer?.transferState.argonProgress).toBeUndefined();

    await vi.waitFor(async () => {
      const updated = await db.crosschainInboundTransfersTable.get(persistedRecord.transferId);
      expect(updated?.status).toBe(CrosschainInboundTransferStatus.ArgonProofSubmitted);
      expect(updated?.argonTxId).toBe(txInfo.tx.id);
      expect(updated?.argonTxHash).toBe(txInfo.tx.extrinsicHash);
    });

    expect(submitAndWatch).not.toHaveBeenCalled();
    expect(confirmBurnTransfer).not.toHaveBeenCalled();
  });

  it('marks a matched finalized proof as complete without resubmitting', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const persistedRecord = await insertTransferRecord(db, walletKeys.ethereumAddress, {
      transferId: 'eth-transfer-2',
      token: MoveToken.ARGN,
      argonDestinationAddress: walletKeys.investmentAddress,
      status: CrosschainInboundTransferStatus.SourceFinalized,
    });
    const txInfo = createTxInfo({
      id: 93,
      extrinsicHash: `0x${'55'.repeat(32)}`,
      metadataJson: {
        txHash: persistedRecord.sourceTxHash!,
        logIndex: persistedRecord.sourceReferenceJson.burnLogIndex,
        recipientAddress: persistedRecord.argonDestinationAddress,
        moveToken: MoveToken.ARGN,
      },
      blockHeight: 144,
      blockHash: `0x${'66'.repeat(32)}`,
    });
    const findLatestTxInfo = vi.fn((matcher: (txInfo: TransactionInfo<IEthereumProofTxMetadata>) => boolean) =>
      matcher(txInfo) ? txInfo : undefined,
    );
    const getTxAttemptState = vi.fn(async () => TxAttemptState.Finalized);
    const submitAndWatch = vi.fn(async () => {
      throw new Error('submitAndWatch should not be called in this test');
    });
    const confirmBurnTransfer = vi.fn(async () => {
      throw new Error('confirmBurnTransfer should not be called in this test');
    });
    const transactionTracker = createTransactionTracker({
      findLatestTxInfo,
      getTxAttemptState,
      submitAndWatch,
    });
    const ethereumClient = createEthereumClient(walletKeys.ethereumAddress, {
      confirmBurnTransfer,
    });
    const tracker = new EthereumInboundTransferTracker(
      Promise.resolve(db),
      transactionTracker,
      walletKeys,
      ethereumClient,
    );

    await tracker.load();

    await vi.waitFor(async () => {
      const updated = await db.crosschainInboundTransfersTable.get(persistedRecord.transferId);
      expect(updated).toMatchObject({
        status: CrosschainInboundTransferStatus.ArgonFinalized,
        argonTxId: txInfo.tx.id,
        argonTxHash: txInfo.tx.extrinsicHash,
        argonBlockNumber: txInfo.tx.blockHeight,
        argonBlockHash: txInfo.tx.blockHash,
      });
    });

    expect(tracker.getTransferStateForToken(MoveToken.ARGN)).toEqual({
      isSubmitting: false,
      hasPersistedTransfer: false,
      phase: 'idle',
      error: '',
    });

    expect(submitAndWatch).not.toHaveBeenCalled();
    expect(confirmBurnTransfer).not.toHaveBeenCalled();
  });
});

function createEthereumClient(
  sourceAddress: string,
  overrides: Partial<{
    approveTransfer: () => Promise<void>;
    submitBurnTransfer: (args: {
      moveToken: IEthereumMoveToken;
      amountBaseUnits: bigint;
      destinationAddress: string;
    }) => Promise<IEthereumBurnTransfer>;
    confirmBurnTransfer: (burnTransfer: IEthereumBurnTransfer) => Promise<IEthereumBurnTransfer>;
    buildBurnProof: (burnTransfer: IEthereumBurnTransfer) => Promise<{ eventLog: unknown; proof: unknown }>;
    getBurnProofPollMs: () => number;
    getBurnProofWaitEstimateMs: () => number;
  }> = {},
): EthereumClient {
  return {
    sourceAddress,
    approveTransfer: overrides.approveTransfer ?? vi.fn(async () => undefined),
    submitBurnTransfer:
      overrides.submitBurnTransfer ??
      vi.fn(async () => {
        throw new Error('submitBurnTransfer should not be called in this test');
      }),
    confirmBurnTransfer:
      overrides.confirmBurnTransfer ??
      vi.fn(async () => {
        throw new Error('confirmBurnTransfer should not be called in this test');
      }),
    buildBurnProof:
      overrides.buildBurnProof ??
      vi.fn(async () => {
        throw new Error('buildBurnProof should not be called in this test');
      }),
    getBurnProofPollMs: overrides.getBurnProofPollMs ?? (() => 1_000),
    getBurnProofWaitEstimateMs: overrides.getBurnProofWaitEstimateMs ?? (() => 1_000),
  } as unknown as EthereumClient;
}

function createTransactionTracker(
  overrides: Partial<{
    load: () => Promise<void>;
    submitAndWatch: (args: unknown) => Promise<TransactionInfo<IEthereumProofTxMetadata>>;
    findLatestTxInfo: (
      matcher: (txInfo: TransactionInfo<IEthereumProofTxMetadata>) => boolean,
    ) => TransactionInfo<IEthereumProofTxMetadata> | undefined;
    getTxAttemptState: (txInfo: TransactionInfo<IEthereumProofTxMetadata>, window: number) => Promise<TxAttemptState>;
  }> = {},
): TransactionTracker {
  return {
    load: overrides.load ?? vi.fn(async () => undefined),
    submitAndWatch:
      overrides.submitAndWatch ??
      vi.fn(async () => {
        throw new Error('submitAndWatch should not be called in this test');
      }),
    findLatestTxInfo: overrides.findLatestTxInfo ?? vi.fn(() => undefined),
    getTxAttemptState: overrides.getTxAttemptState ?? vi.fn(async () => TxAttemptState.Replace),
  } as unknown as TransactionTracker;
}

function createTxInfo(args: {
  id: number;
  extrinsicHash: string;
  metadataJson: IEthereumProofTxMetadata;
  blockHeight?: number;
  blockHash?: string;
}): TransactionInfo<IEthereumProofTxMetadata> {
  return {
    tx: {
      id: args.id,
      extrinsicHash: args.extrinsicHash,
      extrinsicType: ExtrinsicType.CrosschainTransferProve,
      metadataJson: args.metadataJson,
      status: TransactionStatus.Submitted,
      blockHeight: args.blockHeight,
      blockHash: args.blockHash,
      isFinalized: args.blockHeight !== undefined,
    },
    subscribeToProgress: vi.fn(() => () => undefined),
  } as unknown as TransactionInfo<IEthereumProofTxMetadata>;
}

function createBurnTransfer(args: {
  moveToken: IEthereumMoveToken;
  destinationAddress: string;
  burnTxHash: Hash;
}): IEthereumBurnTransfer {
  return {
    moveToken: args.moveToken,
    amountBaseUnits: 5_000_000_000_000n,
    destinationAddress: args.destinationAddress,
    executionRpcUrl: 'http://ethereum.test',
    burnTxHash: args.burnTxHash,
  };
}

async function insertTransferRecord(
  db: Awaited<ReturnType<typeof createTestDb>>,
  sourceAddress: string,
  args: {
    transferId: string;
    token: IEthereumMoveToken;
    argonDestinationAddress: string;
    status: CrosschainInboundTransferStatus;
  },
): Promise<ICrosschainInboundTransferRecord> {
  return (await db.crosschainInboundTransfersTable.upsert({
    transferId: args.transferId,
    sourceChain: 'ethereum',
    token: args.token,
    amountBaseUnits: 5_000_000_000_000n,
    sourceAddress,
    argonDestinationAddress: args.argonDestinationAddress,
    sourceTxHash: `0x${'77'.repeat(32)}`,
    sourceBlockNumber: 88,
    sourceBlockHash: `0x${'88'.repeat(32)}`,
    sourceReferenceJson: { burnLogIndex: 5 },
    status: args.status,
  }))!;
}
