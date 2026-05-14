import { MoveToken } from '@argonprotocol/apps-core';
import type { TxSigningAccount } from '@argonprotocol/mainchain';
import { nanoid } from 'nanoid';
import type { IArgonWalletType, IEthereumInboundTransferState } from '../interfaces/IEthereumInboundTransferTracker.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import type { TransactionInfo } from './TransactionInfo.ts';
import { EthereumClient, type IEthereumBurnTransfer, type IEthereumMoveToken } from './EthereumClient.ts';
import {
  CrosschainInboundTransferStatus,
  type ICrosschainInboundTransferRecord,
} from './db/CrosschainInboundTransfersTable.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import type { Db } from './Db.ts';
import { TransactionTracker, TxAttemptState } from './TransactionTracker.ts';
import { WalletType } from './Wallet.ts';
import type { WalletKeys } from './WalletKeys.ts';
export type {
  IArgonWalletType,
  IEthereumInboundArgonProgress,
  IEthereumInboundSourceFinalization,
  IEthereumInboundTransferPhase,
  IEthereumInboundTransferState,
  IEthereumMoveToken,
} from '../interfaces/IEthereumInboundTransferTracker.ts';

type IEthereumInboundTransferTxMetadata = {
  txHash: string;
  logIndex: number;
  recipientAddress: string;
  moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
};

export type IEthereumInboundActiveTransfer = {
  transferId: string;
  moveToken: IEthereumMoveToken;
  transferState: IEthereumInboundTransferState;
};

export class EthereumInboundTransferTracker {
  public data = {
    transfersById: {} as Record<string, IEthereumInboundActiveTransfer>,
    latestTransferIdByToken: {} as Partial<Record<IEthereumMoveToken, string>>,
  };

  #hasLoadedPendingMoves = false;
  #loadPromise?: Promise<void>;
  #progressUnsubscribes = new Map<string, () => void>();
  #resumePromises = new Map<string, Promise<void>>();

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly transactionTracker: TransactionTracker,
    private readonly walletKeys: WalletKeys,
    private readonly ethereumClient: EthereumClient,
  ) {}

  public async load(): Promise<void> {
    if (this.#loadPromise) {
      return this.#loadPromise;
    }

    this.#loadPromise = this.loadPendingMoves();
    return this.#loadPromise;
  }

  public getTransfer(transferId: string): IEthereumInboundActiveTransfer | undefined {
    return this.data.transfersById[transferId];
  }

  public getTransferStateForToken(moveToken: IEthereumMoveToken): IEthereumInboundTransferState {
    const transferId = this.data.latestTransferIdByToken[moveToken];
    if (!transferId) {
      return createEmptyTransferState();
    }

    return this.getTransferState(transferId);
  }

  public clearCompletedTransfer(transferId: string) {
    const transfer = this.data.transfersById[transferId];
    if (!transfer) {
      return;
    }

    if (transfer.transferState.isSubmitting || transfer.transferState.hasPersistedTransfer) {
      return;
    }

    this.discardTransfer(transferId, transfer.moveToken);
  }

  public async startMove(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    targetWalletType: IArgonWalletType;
  }): Promise<IEthereumInboundActiveTransfer | undefined> {
    const { moveToken, amountBaseUnits, targetWalletType } = args;
    await this.load();

    const db = await this.dbPromise;
    const existingTransfer = await db.crosschainInboundTransfersTable.getLatestPendingByToken(moveToken);
    if (existingTransfer) {
      void this.resumeTrackedMove(existingTransfer);
      return this.getTransfer(existingTransfer.transferId);
    }

    if (amountBaseUnits <= 0n) {
      return;
    }

    const transferId = nanoid();
    const transfer = this.trackTransfer(transferId, moveToken);

    this.data.latestTransferIdByToken[moveToken] = transferId;
    this.#progressUnsubscribes.get(transferId)?.();
    this.#progressUnsubscribes.delete(transferId);
    transfer.transferState = {
      ...createEmptyTransferState(),
      isSubmitting: true,
      targetWalletType,
      phase: 'preparing',
    };
    void this.runStartMove({
      db,
      transferId,
      moveToken,
      amountBaseUnits,
      targetWalletType,
    });

    return transfer;
  }

  private getTransferState(transferId: string): IEthereumInboundTransferState {
    return this.data.transfersById[transferId].transferState;
  }

  private trackTransfer(transferId: string, moveToken: IEthereumMoveToken): IEthereumInboundActiveTransfer {
    let transfer = this.data.transfersById[transferId];
    if (!transfer) {
      transfer = {
        transferId,
        moveToken,
        transferState: createEmptyTransferState(),
      };
      this.data.transfersById[transferId] = transfer;
    }

    return transfer;
  }

  private async loadPendingMoves() {
    if (this.#hasLoadedPendingMoves) {
      return;
    }

    this.#hasLoadedPendingMoves = true;
    await this.transactionTracker.load();

    const db = await this.dbPromise;
    const records = await db.crosschainInboundTransfersTable.fetchAll();

    for (const record of records) {
      const moveToken = getMoveToken(record);
      if (!moveToken) {
        continue;
      }

      this.trackTransfer(record.transferId, moveToken);
      this.data.latestTransferIdByToken[moveToken] ??= record.transferId;
      void this.resumeTrackedMove(record);
    }
  }

  private async resumeTrackedMove(record: ICrosschainInboundTransferRecord) {
    const moveToken = getMoveToken(record);
    if (!moveToken) {
      return;
    }

    const existingResumePromise = this.#resumePromises.get(record.transferId);
    if (existingResumePromise) {
      return existingResumePromise;
    }

    const resumePromise = this.runResumeTrackedMove(record, moveToken);
    this.#resumePromises.set(record.transferId, resumePromise);

    try {
      await resumePromise;
    } finally {
      this.#resumePromises.delete(record.transferId);
    }
  }

  private async runResumeTrackedMove(record: ICrosschainInboundTransferRecord, moveToken: IEthereumMoveToken) {
    const transfer = this.trackTransfer(record.transferId, moveToken);
    const targetWalletType = this.getTargetWalletType(record.argonDestinationAddress);

    this.data.latestTransferIdByToken[moveToken] ??= record.transferId;
    transfer.transferState = {
      ...createEmptyTransferState(),
      isSubmitting: true,
      hasPersistedTransfer: true,
      targetWalletType,
      phase:
        record.status === CrosschainInboundTransferStatus.SourceBurned ? 'awaitingEthereumBurn' : 'confirmingArgon',
    };
    const transferState = transfer.transferState;
    const table = (await this.dbPromise).crosschainInboundTransfersTable;

    try {
      let activeRecord = record;

      if (activeRecord.status === CrosschainInboundTransferStatus.ArgonFinalized) {
        this.discardTransfer(record.transferId, moveToken);
        return;
      }

      if (
        activeRecord.status === CrosschainInboundTransferStatus.SourceFinalized ||
        activeRecord.status === CrosschainInboundTransferStatus.ArgonProofSubmitted
      ) {
        if (await this.tryTrackPersistedArgonProof(activeRecord)) {
          return;
        }
      }

      if (activeRecord.status === CrosschainInboundTransferStatus.ArgonProofSubmitted) {
        activeRecord = await (
          await this.dbPromise
        ).crosschainInboundTransfersTable.rewindToSourceStage(
          activeRecord,
          CrosschainInboundTransferStatus.SourceFinalized,
        );
      }

      transferState.phase = 'awaitingEthereumBurn';
      const confirmedBurnTransfer = await this.ethereumClient.confirmBurnTransfer(this.toBurnTransfer(activeRecord));
      if (
        confirmedBurnTransfer.burnBlockNumber == null ||
        confirmedBurnTransfer.burnBlockHash == null ||
        confirmedBurnTransfer.burnLogIndex == null
      ) {
        throw new Error('Ethereum burn transfer must be confirmed before recording burn details.');
      }

      const persistedBurnTransfer = await table.recordConfirmedBurn({
        transferId: record.transferId,
        sourceBlockNumber: confirmedBurnTransfer.burnBlockNumber,
        sourceBlockHash: confirmedBurnTransfer.burnBlockHash,
        burnLogIndex: confirmedBurnTransfer.burnLogIndex,
      });
      if (persistedBurnTransfer) {
        activeRecord = persistedBurnTransfer;
      }

      const { txSigner } = await this.getDestinationAndSigner(targetWalletType);
      await this.submitTransferToArgon({
        transferId: activeRecord.transferId,
        burnTransfer: confirmedBurnTransfer,
        txSigner,
      });
    } catch (error) {
      transferState.error = error instanceof Error ? error.message : 'Unable to resume the Ethereum transfer.';
      transferState.isSubmitting = false;
    }
  }

  private async runStartMove(args: {
    db: Db;
    transferId: string;
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    targetWalletType: IArgonWalletType;
  }) {
    const { db, transferId, moveToken, amountBaseUnits, targetWalletType } = args;
    const transferState = this.getTransferState(transferId);

    try {
      const { destinationAddress, txSigner } = await this.getDestinationAndSigner(targetWalletType);

      transferState.phase = 'awaitingEthereumApproval';
      await this.ethereumClient.approveTransfer({
        moveToken,
        amountBaseUnits,
      });

      transferState.phase = 'awaitingEthereumBurn';
      const submittedBurnTransfer = await this.ethereumClient.submitBurnTransfer({
        moveToken,
        amountBaseUnits,
        destinationAddress,
      });
      transferState.hasPersistedTransfer = true;
      await db.crosschainInboundTransfersTable.insertSourceBurned({
        transferId,
        token: submittedBurnTransfer.moveToken,
        amountBaseUnits: submittedBurnTransfer.amountBaseUnits,
        sourceAddress: this.ethereumClient.sourceAddress,
        argonDestinationAddress: submittedBurnTransfer.destinationAddress,
        sourceTxHash: submittedBurnTransfer.burnTxHash,
      });

      const confirmedBurnTransfer = await this.ethereumClient.confirmBurnTransfer(submittedBurnTransfer);
      if (
        confirmedBurnTransfer.burnBlockNumber == null ||
        confirmedBurnTransfer.burnBlockHash == null ||
        confirmedBurnTransfer.burnLogIndex == null
      ) {
        throw new Error('Ethereum burn transfer must be confirmed before recording burn details.');
      }
      await db.crosschainInboundTransfersTable.recordConfirmedBurn({
        transferId,
        sourceBlockNumber: confirmedBurnTransfer.burnBlockNumber,
        sourceBlockHash: confirmedBurnTransfer.burnBlockHash,
        burnLogIndex: confirmedBurnTransfer.burnLogIndex,
      });

      await this.submitTransferToArgon({
        transferId,
        burnTransfer: confirmedBurnTransfer,
        txSigner,
      });
    } catch (error) {
      transferState.error = error instanceof Error ? error.message : 'Unable to move funds from Ethereum.';
      transferState.isSubmitting = false;
    }
  }

  private async tryTrackPersistedArgonProof(record: ICrosschainInboundTransferRecord): Promise<boolean> {
    const txInfo = this.transactionTracker.findLatestTxInfo<IEthereumInboundTransferTxMetadata>(txInfo => {
      if (txInfo.tx.extrinsicType !== ExtrinsicType.CrosschainTransferProve) {
        return false;
      }

      if (record.argonTxId && txInfo.tx.id === record.argonTxId) {
        return true;
      }

      const metadata = txInfo.tx.metadataJson;
      return (
        metadata?.txHash === record.sourceTxHash &&
        metadata?.logIndex === record.sourceReferenceJson?.burnLogIndex &&
        metadata?.recipientAddress === record.argonDestinationAddress &&
        metadata?.moveToken === record.token
      );
    });
    if (!txInfo) {
      return false;
    }

    const txAttemptState = await this.transactionTracker.getTxAttemptState(txInfo, 2);
    if (txAttemptState === TxAttemptState.Replace) {
      return false;
    }

    if (txAttemptState === TxAttemptState.Finalized) {
      if (txInfo.tx.blockHeight == null || txInfo.tx.blockHash == null) {
        throw new Error('Argon proof transaction must be finalized before recording Argon finalization.');
      }
      await (
        await this.dbPromise
      ).crosschainInboundTransfersTable.recordArgonFinalized({
        transferId: record.transferId,
        argonTxId: txInfo.tx.id,
        argonTxHash: txInfo.tx.extrinsicHash,
        argonBlockNumber: txInfo.tx.blockHeight,
        argonBlockHash: txInfo.tx.blockHash,
      });
      const moveToken = getMoveToken(record);
      if (moveToken) {
        this.discardTransfer(record.transferId, moveToken);
      }
      return true;
    }

    await (
      await this.dbPromise
    ).crosschainInboundTransfersTable.recordArgonProofSubmitted({
      transferId: record.transferId,
      argonTxId: txInfo.tx.id,
      argonTxHash: txInfo.tx.extrinsicHash,
    });

    const transferState = this.getTransferState(record.transferId);
    transferState.phase = 'confirmingArgon';
    this.trackArgonProgress(record.transferId, txInfo);
    return true;
  }

  private async submitTransferToArgon(args: {
    transferId: string;
    burnTransfer: IEthereumBurnTransfer;
    txSigner: TxSigningAccount;
  }) {
    const { transferId, burnTransfer, txSigner } = args;
    const eventProof = await this.buildBurnProof(transferId, burnTransfer);
    const table = (await this.dbPromise).crosschainInboundTransfersTable;

    await table.recordSourceFinalized(transferId);

    const transferState = this.getTransferState(transferId);
    transferState.phase = 'confirmingArgon';
    const mainchainClient = await getMainchainClient(false);
    const txInfo = await this.transactionTracker.submitAndWatch({
      tx: mainchainClient.tx.crosschainTransfer.proveTransfer({
        Ethereum: {
          sourceChain: 'Ethereum',
          eventLog: eventProof.eventLog,
          proof: eventProof.proof,
        },
      }),
      txSigner,
      extrinsicType: ExtrinsicType.CrosschainTransferProve,
      metadata: {
        txHash: burnTransfer.burnTxHash,
        logIndex: burnTransfer.burnLogIndex!,
        recipientAddress: burnTransfer.destinationAddress,
        moveToken: burnTransfer.moveToken,
      } satisfies IEthereumInboundTransferTxMetadata,
    });

    await table.recordArgonProofSubmitted({
      transferId,
      argonTxId: txInfo.tx.id,
      argonTxHash: txInfo.tx.extrinsicHash,
    });

    this.trackArgonProgress(transferId, txInfo);
  }

  private async buildBurnProof(transferId: string, burnTransfer: IEthereumBurnTransfer) {
    const transferState = this.getTransferState(transferId);
    transferState.phase = 'waitingForRetainedAnchor';
    transferState.sourceFinalization = {
      startedAt: Date.now(),
      estimatedDurationMs: this.ethereumClient.getBurnProofWaitEstimateMs(),
      pollMs: this.ethereumClient.getBurnProofPollMs(),
    };

    return await this.ethereumClient.buildBurnProof(burnTransfer);
  }

  private trackArgonProgress(transferId: string, txInfo: TransactionInfo<IEthereumInboundTransferTxMetadata>) {
    this.#progressUnsubscribes.get(transferId)?.();
    this.#progressUnsubscribes.set(
      transferId,
      txInfo.subscribeToProgress(async (progress, error) => {
        const transferState = this.getTransferState(transferId);
        transferState.phase = 'confirmingArgon';
        transferState.argonProgress = {
          progressPct: progress.progressPct,
          confirmations: progress.confirmations,
          expectedConfirmations: progress.expectedConfirmations,
        };

        if (error) {
          transferState.error = error.message;
          transferState.isSubmitting = false;
          const table = (await this.dbPromise).crosschainInboundTransfersTable;
          const record = await table.get(transferId);

          if (record && record.status !== CrosschainInboundTransferStatus.ArgonFinalized) {
            await table.rewindToSourceStage(record, CrosschainInboundTransferStatus.SourceFinalized);
          }
          return;
        }

        if (progress.progressPct >= 100) {
          transferState.phase = 'confirmedOnArgon';
          transferState.isSubmitting = false;

          const record = await (await this.dbPromise).crosschainInboundTransfersTable.get(transferId);
          if (!record) {
            transferState.hasPersistedTransfer = false;
            return;
          }
          if (record.status === CrosschainInboundTransferStatus.ArgonFinalized) {
            transferState.hasPersistedTransfer = false;
            return;
          }

          if (txInfo.tx.blockHeight == null || txInfo.tx.blockHash == null) {
            throw new Error('Argon proof transaction must be finalized before recording Argon finalization.');
          }
          await (
            await this.dbPromise
          ).crosschainInboundTransfersTable.recordArgonFinalized({
            transferId: record.transferId,
            argonTxId: txInfo.tx.id,
            argonTxHash: txInfo.tx.extrinsicHash,
            argonBlockNumber: txInfo.tx.blockHeight,
            argonBlockHash: txInfo.tx.blockHash,
          });
          transferState.hasPersistedTransfer = false;
        }
      }),
    );
  }

  private discardTransfer(transferId: string, moveToken: IEthereumMoveToken) {
    this.#progressUnsubscribes.get(transferId)?.();
    this.#progressUnsubscribes.delete(transferId);

    if (this.data.latestTransferIdByToken[moveToken] === transferId) {
      delete this.data.latestTransferIdByToken[moveToken];
    }

    delete this.data.transfersById[transferId];
  }

  private async getDestinationAndSigner(targetWalletType: IArgonWalletType): Promise<{
    destinationAddress: string;
    txSigner: TxSigningAccount;
  }> {
    switch (targetWalletType) {
      case WalletType.investment:
        return {
          destinationAddress: this.walletKeys.investmentAddress,
          txSigner: (await this.walletKeys.getInvestmentKeypair()) as TxSigningAccount,
        };
      case WalletType.miningHold:
        return {
          destinationAddress: this.walletKeys.miningHoldAddress,
          txSigner: (await this.walletKeys.getMiningHoldKeypair()) as TxSigningAccount,
        };
      case WalletType.vaulting:
        return {
          destinationAddress: this.walletKeys.vaultingAddress,
          txSigner: (await this.walletKeys.getVaultingKeypair()) as TxSigningAccount,
        };
    }

    const unhandledWalletType: never = targetWalletType;
    void unhandledWalletType;
    throw new Error('Unsupported target wallet type.');
  }

  private getTargetWalletType(argonDestinationAddress: string): IArgonWalletType {
    if (argonDestinationAddress === this.walletKeys.investmentAddress) {
      return WalletType.investment;
    }
    if (argonDestinationAddress === this.walletKeys.miningHoldAddress) {
      return WalletType.miningHold;
    }
    if (argonDestinationAddress === this.walletKeys.vaultingAddress) {
      return WalletType.vaulting;
    }

    throw new Error(`Unable to determine target wallet type for ${argonDestinationAddress}.`);
  }

  private toBurnTransfer(record: ICrosschainInboundTransferRecord): IEthereumBurnTransfer {
    if (record.token !== MoveToken.ARGN && record.token !== MoveToken.ARGNOT) {
      throw new Error(`Persisted inbound transfer ${record.transferId} is not an Ethereum Argon transfer.`);
    }
    if (!record.sourceTxHash) {
      throw new Error(`Persisted inbound transfer ${record.transferId} is missing its source transaction hash.`);
    }

    return {
      moveToken: record.token,
      amountBaseUnits: record.amountBaseUnits,
      destinationAddress: record.argonDestinationAddress,
      executionRpcUrl: this.ethereumClient.executionRpcUrl,
      burnTxHash: record.sourceTxHash,
      burnBlockNumber: record.sourceBlockNumber,
      burnBlockHash: record.sourceBlockHash,
      burnLogIndex: record.sourceReferenceJson?.burnLogIndex,
    };
  }
}

function createEmptyTransferState(): IEthereumInboundTransferState {
  return {
    isSubmitting: false,
    hasPersistedTransfer: false,
    phase: 'idle',
    error: '',
  };
}

function getMoveToken(record: ICrosschainInboundTransferRecord): IEthereumMoveToken | undefined {
  if (record.sourceChain !== 'ethereum') {
    return;
  }

  if (record.token === MoveToken.ARGN || record.token === MoveToken.ARGNOT) {
    return record.token;
  }
}
