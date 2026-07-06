import { MoveToken, type IEthereumGatewayRelayReasonCode } from '@argonprotocol/apps-core';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { nanoid } from 'nanoid';
import { formatEther } from 'viem';
import type { IArgonWalletType, IEthereumInboundTransferState } from '../interfaces/IEthereumInboundTransferTracker.ts';
import {
  completeInboundTransferProgress,
  createCrosschainTransferProgress,
  formatCrosschainBlockStepDetail,
  hydrateCrosschainTransferProgress,
  INBOUND_TRANSFER_STEP_TITLES,
  setInboundArgonStepProgress,
  setInboundEthereumStepProgress,
  setInboundRelayStepProgress,
  type ICrosschainTransferProgress,
} from './CrosschainTransferProgress.ts';
import { EthereumClient, type IEthereumMoveToken } from './EthereumClient.ts';
import { sleep } from './Utils.ts';
import {
  CrosschainInboundTransferStatus,
  type ICrosschainInboundTransferRecord,
} from './db/CrosschainInboundTransfersTable.ts';
import type { Db } from './Db.ts';
import type { ServerApiClient } from './ServerApiClient.ts';
import { requestEthereumGatewayCatchup, type IEthereumGatewayRelaySource } from './EthereumGatewayCatchup.ts';
import { getEthereumGatewayPauseReason } from '../stores/mainchain.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import type { UpstreamOperatorClient } from './UpstreamOperatorClient.ts';
import { WalletType } from './Wallet.ts';
import { convertEthereumTokenBaseUnitsToRuntimeAmount } from './WalletForEthereum.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { MyVault } from './MyVault.ts';

export type {
  IArgonWalletType,
  IEthereumInboundTransferState,
  IEthereumMoveToken,
} from '../interfaces/IEthereumInboundTransferTracker.ts';

export type IEthereumInboundActiveTransfer = {
  id: string;
  moveToken: IEthereumMoveToken;
  transferState: IEthereumInboundTransferState;
  persistedRecord?: ICrosschainInboundTransferRecord;
};

type IEthereumInboundTransferClient = Pick<
  EthereumClient,
  | 'sourceAddress'
  | 'executionRpcUrl'
  | 'startTransferToArgon'
  | 'estimateTransferToArgonFee'
  | 'getNativeBalanceWei'
  | 'confirmTransferToArgon'
  | 'getTransactionProgress'
  | 'getTransactionFinalityPollMs'
  | 'getTransactionFinalityBlocks'
  | 'getTransferToArgonPollMs'
  | 'getTransferToArgonWaitEstimateMs'
  | 'waitForTransactionFinality'
>;

class InboundTransferInvariantError extends Error {}

export class EthereumInboundTransferTracker {
  public data = {
    transfersById: {} as Record<string, IEthereumInboundActiveTransfer>,
    latestTransferIdByToken: {} as Partial<Record<IEthereumMoveToken, string>>,
  };

  #hasLoadedPendingMoves = false;
  #loadPromise?: Promise<void>;
  #resumePromises = new Map<string, Promise<void>>();
  #lastCatchUpProgressKey = new Map<string, string>();
  #lastCatchUpProgressAt = new Map<string, number>();
  #lastCatchUpRequestAt = new Map<string, number>();
  #argonRelayStartBlockByTransferId = new Map<string, number>();
  #argonFinalizationStartBlockByTransferId = new Map<string, number>();

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly transactionTracker: TransactionTracker,
    private readonly blockWatch: BlockWatch,
    private readonly walletKeys: WalletKeys,
    private readonly ethereumClient: IEthereumInboundTransferClient,
    private readonly serverApiClient:
      | Pick<ServerApiClient, 'getEthereumRelayStatus' | 'requestEthereumGatewayCatchUp'>
      | undefined,
    private readonly upstreamOperatorClient: Pick<
      UpstreamOperatorClient,
      'operatorHost' | 'requestEthereumGatewayCatchUp'
    >,
    private readonly myVault?: Pick<MyVault, 'createdVault'>,
  ) {}

  public async load(): Promise<void> {
    if (this.#loadPromise) {
      return this.#loadPromise;
    }

    this.#loadPromise = this.loadPendingMoves();
    return this.#loadPromise;
  }

  public getTransfer(id: string): IEthereumInboundActiveTransfer | undefined {
    return this.data.transfersById[id];
  }

  public getTransferStateForToken(moveToken: IEthereumMoveToken): IEthereumInboundTransferState {
    const id = this.data.latestTransferIdByToken[moveToken];
    if (!id) {
      return createEmptyTransferState();
    }

    return this.getTransferState(id);
  }

  public clearCompletedTransfer(id: string) {
    const transfer = this.data.transfersById[id];
    if (!transfer) {
      return;
    }

    if (transfer.transferState.isSubmitting || transfer.transferState.hasPersistedTransfer) {
      return;
    }
    if (!transfer.transferState.isComplete) {
      return;
    }

    this.discardTransfer(id, transfer.moveToken);
  }

  public async dismissFailedTransfer(id: string) {
    const transfer = this.data.transfersById[id];
    if (!transfer?.transferState.needsAttention) {
      return;
    }

    if (hasUnacknowledgedFailure(transfer.persistedRecord)) {
      const db = await this.dbPromise;
      transfer.persistedRecord = await db.crosschainInboundTransfersTable.acknowledgeFailed(id);
    }

    this.discardTransfer(id, transfer.moveToken);
  }

  public async startMove(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    targetWalletType: IArgonWalletType;
  }): Promise<IEthereumInboundActiveTransfer | undefined> {
    const { moveToken, amountBaseUnits, targetWalletType } = args;
    await this.load();

    const db = await this.dbPromise;
    const existingTransfer = await db.crosschainInboundTransfersTable.getLatestPendingByToken('Ethereum', moveToken);
    if (existingTransfer) {
      void this.resumeTrackedMove(existingTransfer);
      return this.getTransfer(existingTransfer.id);
    }

    if (amountBaseUnits <= 0n) {
      return;
    }

    const id = nanoid();
    const transfer = this.trackTransfer(id, moveToken);

    this.data.latestTransferIdByToken[moveToken] = id;
    transfer.transferState = {
      ...createEmptyTransferState(),
      amount: convertEthereumTokenBaseUnitsToRuntimeAmount(amountBaseUnits),
      isSubmitting: true,
      needsAttention: false,
      isComplete: false,
      targetWalletType,
    };
    transfer.transferState.progress = setInboundEthereumStepProgress(transfer.transferState.progress, {
      progressPct: 0,
      detail: 'Preparing Ethereum transfer...',
    });
    void this.runStartMove({
      db,
      id,
      moveToken,
      amountBaseUnits,
      targetWalletType,
    });

    return transfer;
  }

  public async estimateFeeWei(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    targetWalletType: IArgonWalletType;
  }): Promise<bigint | undefined> {
    const { moveToken, amountBaseUnits, targetWalletType } = args;
    if (amountBaseUnits <= 0n) {
      return;
    }

    const destinationAddress = this.walletKeys.getWalletAddress(targetWalletType);
    return await this.ethereumClient.estimateTransferToArgonFee?.({
      moveToken,
      amountBaseUnits,
      destinationAddress,
    });
  }

  private getTransferState(id: string): IEthereumInboundTransferState {
    return this.data.transfersById[id].transferState;
  }

  private trackTransfer(id: string, moveToken: IEthereumMoveToken): IEthereumInboundActiveTransfer {
    let transfer = this.data.transfersById[id];
    if (!transfer) {
      this.data.transfersById[id] = {
        id,
        moveToken,
        transferState: createEmptyTransferState(),
      };
      transfer = this.data.transfersById[id];
    }

    return transfer;
  }

  private async loadPendingMoves() {
    if (this.#hasLoadedPendingMoves) {
      return;
    }

    this.#hasLoadedPendingMoves = true;
    await this.transactionTracker.load();
    await this.blockWatch.start();

    const db = await this.dbPromise;
    const records = await db.crosschainInboundTransfersTable.fetchAll();

    for (const record of records) {
      const moveToken = getMoveToken(record);
      if (!moveToken) {
        continue;
      }

      const transfer = this.trackTransfer(record.id, moveToken);
      transfer.persistedRecord = record;
      this.data.latestTransferIdByToken[moveToken] ??= record.id;
      void this.resumeTrackedMove(record);
    }
  }

  private async resumeTrackedMove(record: ICrosschainInboundTransferRecord) {
    const moveToken = getMoveToken(record);
    if (!moveToken) {
      return;
    }

    const existingResumePromise = this.#resumePromises.get(record.id);
    if (existingResumePromise) {
      return existingResumePromise;
    }

    const resumePromise = this.runResumeTrackedMove(record, moveToken);
    this.#resumePromises.set(record.id, resumePromise);

    try {
      await resumePromise;
    } finally {
      this.#resumePromises.delete(record.id);
    }
  }

  private async runResumeTrackedMove(record: ICrosschainInboundTransferRecord, moveToken: IEthereumMoveToken) {
    const transfer = this.trackTransfer(record.id, moveToken);
    let targetWalletType: IArgonWalletType | undefined;
    if (record.argonDestinationAddress === this.walletKeys.defaultArgonAddress) {
      targetWalletType = WalletType.defaultArgon;
    } else if (record.argonDestinationAddress === this.walletKeys.defaultArgonAddress) {
      targetWalletType = WalletType.defaultArgon;
    } else if (record.argonDestinationAddress === this.walletKeys.defaultArgonAddress) {
      targetWalletType = WalletType.defaultArgon;
    } else if (record.argonDestinationAddress === this.walletKeys.vaultingAddress) {
      targetWalletType = WalletType.defaultArgon;
    }
    transfer.persistedRecord = record;
    if (!targetWalletType) {
      throw new InboundTransferInvariantError(
        `Unable to determine target wallet type for ${record.argonDestinationAddress}.`,
      );
    }

    this.data.latestTransferIdByToken[moveToken] ??= record.id;
    transfer.transferState = {
      ...createEmptyTransferState(),
      amount: convertEthereumTokenBaseUnitsToRuntimeAmount(record.amountBaseUnits),
      isSubmitting: !hasUnacknowledgedFailure(record),
      hasPersistedTransfer: true,
      needsAttention: hasUnacknowledgedFailure(record),
      isComplete: record.status === CrosschainInboundTransferStatus.ArgonFinalized,
      targetWalletType,
      progress: createInboundProgressFromRecord(record),
      error: record.failureReason ?? '',
    };

    await this.continueTrackedMove(transfer, moveToken, 'Unable to resume the Ethereum transfer.');
  }

  private async runStartMove(args: {
    db: Db;
    id: string;
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    targetWalletType: IArgonWalletType;
  }) {
    const { db, id, moveToken, amountBaseUnits, targetWalletType } = args;
    const transfer = this.trackTransfer(id, moveToken);
    const transferState = transfer.transferState;

    try {
      const destinationAddress = this.walletKeys.getWalletAddress(targetWalletType);
      await this.ensureSufficientEthereumFeeBalance({
        moveToken,
        amountBaseUnits,
        destinationAddress,
      });

      const submittedTransfer = await this.ethereumClient.startTransferToArgon({
        moveToken,
        amountBaseUnits,
        destinationAddress,
      });
      transferState.hasPersistedTransfer = true;

      transfer.persistedRecord = await db.crosschainInboundTransfersTable.insertSourceSubmitted({
        sourceChain: 'Ethereum',
        id,
        token: submittedTransfer.moveToken,
        amountBaseUnits: submittedTransfer.amountBaseUnits,
        sourceAddress: this.ethereumClient.sourceAddress,
        argonDestinationAddress: submittedTransfer.destinationAddress,
        sourceTxHash: submittedTransfer.sourceTxHash,
        progressJson: transferState.progress,
      });
      if (!transfer.persistedRecord) {
        throw new Error(`Transfer ${id} could not be persisted after Ethereum submission.`);
      }

      await this.continueTrackedMove(transfer, moveToken, 'Unable to move funds from Ethereum.');
    } catch (error) {
      await this.failTransfer(id, error instanceof Error ? error.message : 'Unable to move funds from Ethereum.');
    }
  }

  private async ensureSufficientEthereumFeeBalance(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    destinationAddress: string;
  }) {
    const feeEstimateWei = await this.ethereumClient.estimateTransferToArgonFee({
      moveToken: args.moveToken,
      amountBaseUnits: args.amountBaseUnits,
      destinationAddress: args.destinationAddress,
    });
    const ethereumBalanceWei = await this.ethereumClient.getNativeBalanceWei();
    if (ethereumBalanceWei >= feeEstimateWei) {
      return;
    }

    const missingWei = feeEstimateWei - ethereumBalanceWei;
    throw new Error(
      `Your Ethereum wallet has ${formatEther(ethereumBalanceWei)} ETH, but this transfer needs about ${formatEther(
        feeEstimateWei,
      )} ETH for network fees. Add about ${formatEther(missingWei)} ETH and retry.`,
    );
  }

  private async continueTrackedMove(
    transfer: IEthereumInboundActiveTransfer,
    moveToken: IEthereumMoveToken,
    fallbackErrorMessage: string,
  ) {
    try {
      while (true) {
        const activeRecord = transfer.persistedRecord;
        if (!activeRecord) {
          transfer.transferState.hasPersistedTransfer = false;
          transfer.transferState.isSubmitting = false;
          transfer.transferState.isComplete = false;
          return;
        }

        if (isAcknowledgedFailure(activeRecord)) {
          this.discardTransfer(activeRecord.id, moveToken);
          return;
        }

        if (activeRecord.status === CrosschainInboundTransferStatus.ArgonFinalized) {
          this.discardTransfer(activeRecord.id, moveToken);
          return;
        }

        if (hasUnacknowledgedFailure(activeRecord)) {
          return;
        }

        try {
          let nextRecord = activeRecord;
          if (
            nextRecord.status === CrosschainInboundTransferStatus.SourceSubmitted ||
            nextRecord.sourceBlockNumber == null ||
            nextRecord.sourceLogIndex == null ||
            nextRecord.gatewayActivityNonce == null
          ) {
            nextRecord = await this.confirmSourceTransfer(nextRecord);
            transfer.persistedRecord = nextRecord;
          }

          const isComplete = await this.advanceArgonFinalization(transfer);
          if (isComplete) {
            return;
          }
        } catch (error) {
          if (error instanceof InboundTransferInvariantError) {
            throw error;
          }

          console.warn(
            `[EthereumInboundTransferTracker] Unable to refresh inbound transfer state for ${activeRecord.id}; will retry on the next poll`,
            error,
          );
        }

        await sleep(this.ethereumClient.getTransferToArgonPollMs());
      }
    } catch (error) {
      await this.failTransfer(transfer.id, error instanceof Error ? error.message : fallbackErrorMessage);
    }
  }

  private async confirmSourceTransfer(record: ICrosschainInboundTransferRecord) {
    const transferState = this.getTransferState(record.id);
    transferState.progress = setInboundEthereumStepProgress(transferState.progress, {
      progressPct: 0,
      detail: 'Submitted to Ethereum. Waiting for confirmation...',
    });

    if (record.token !== MoveToken.ARGN && record.token !== MoveToken.ARGNOT) {
      throw new InboundTransferInvariantError(
        `Persisted inbound transfer ${record.id} is not an Ethereum Argon transfer.`,
      );
    }
    if (!record.sourceTxHash) {
      throw new InboundTransferInvariantError(
        `Persisted inbound transfer ${record.id} is missing its source transaction hash.`,
      );
    }

    const table = (await this.dbPromise).crosschainInboundTransfersTable;
    const activeRecord = record;
    const sourceTxHash = activeRecord.sourceTxHash;
    if (!sourceTxHash) {
      throw new InboundTransferInvariantError(
        `Persisted inbound transfer ${record.id} is missing its source transaction hash.`,
      );
    }
    const finalizedProgress = await this.ethereumClient.waitForTransactionFinality({
      txHash: sourceTxHash,
      blockNumber: activeRecord.sourceBlockNumber,
      blockHash: activeRecord.sourceBlockHash,
      onProgress: txProgress => {
        transferState.progress = setInboundEthereumStepProgress(transferState.progress, {
          progressPct: txProgress.progressPct,
          detail: formatCrosschainBlockStepDetail({
            blockType: 'Ethereum',
            confirmations: txProgress.confirmations,
            expectedConfirmations: txProgress.expectedConfirmations,
          }),
          confirmations: txProgress.confirmations,
          expectedConfirmations: txProgress.expectedConfirmations,
        });
      },
      onRpcDelay: txProgress => {
        transferState.error = '';
        transferState.progress = setInboundEthereumStepProgress(transferState.progress, {
          progressPct: Math.max(txProgress?.progressPct ?? transferState.progress.steps[0]?.progressPct ?? 0, 1),
          detail: 'Submitted to Ethereum. Waiting for confirmation...',
        });
      },
    });

    const confirmedTransfer = await this.ethereumClient.confirmTransferToArgon({
      moveToken: activeRecord.token,
      amountBaseUnits: activeRecord.amountBaseUnits,
      destinationAddress: activeRecord.argonDestinationAddress,
      executionRpcUrl: this.ethereumClient.executionRpcUrl,
      sourceTxHash,
      sourceBlockNumber: finalizedProgress.blockNumber,
      sourceBlockHash: finalizedProgress.blockHash,
      sourceLogIndex: activeRecord.sourceLogIndex,
      gatewayActivityNonce: activeRecord.gatewayActivityNonce,
    });
    const confirmedRecord = await table.recordConfirmedSourceTransfer({
      id: activeRecord.id,
      sourceBlockNumber: confirmedTransfer.sourceBlockNumber!,
      sourceBlockHash: confirmedTransfer.sourceBlockHash!,
      sourceLogIndex: confirmedTransfer.sourceLogIndex!,
      gatewayActivityNonce: confirmedTransfer.gatewayActivityNonce!,
    });
    if (!confirmedRecord) {
      throw new InboundTransferInvariantError(
        `Transfer ${activeRecord.id} could not record its confirmed Ethereum details.`,
      );
    }

    transferState.progress = setInboundRelayStepProgress(transferState.progress, {
      progressPct: 0,
      detail: 'Waiting for Argon to receive finalized Ethereum state...',
    });
    const persistedRecord = await table.recordSourceFinalized(activeRecord.id, transferState.progress);
    if (!persistedRecord) {
      throw new InboundTransferInvariantError(
        `Transfer ${activeRecord.id} could not record its finalized Ethereum state.`,
      );
    }

    return persistedRecord;
  }

  private async advanceArgonFinalization(transfer: IEthereumInboundActiveTransfer) {
    const transferState = transfer.transferState;

    const db = await this.dbPromise;
    const persistedRecord = transfer.persistedRecord;
    if (!persistedRecord) {
      transferState.hasPersistedTransfer = false;
      transferState.isSubmitting = false;
      return true;
    }
    if (persistedRecord.gatewayActivityNonce == null) {
      throw new InboundTransferInvariantError(
        `Transfer ${persistedRecord.id} is missing its Ethereum gateway activity nonce.`,
      );
    }

    const finalizedHeader = this.blockWatch.finalizedBlockHeader;
    const finalizedClient = await this.blockWatch.getApi(finalizedHeader);
    const finalizedArgonHeight = finalizedHeader.blockNumber;
    const latestRetainedAnchorHash =
      await finalizedClient.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash();
    const latestRetainedAnchor = latestRetainedAnchorHash.isNone
      ? undefined
      : await finalizedClient.query.ethereumVerifier.executionHeaderAnchors(latestRetainedAnchorHash.unwrap().toHex());
    const latestRetainedBlockNumber =
      latestRetainedAnchor && latestRetainedAnchor.isSome
        ? Number(latestRetainedAnchor.unwrap().blockNumber.toBigInt())
        : undefined;
    const gatewayState = await finalizedClient.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum');
    if (
      gatewayState.isSome &&
      gatewayState.unwrap().gatewayActivityNonce.toBigInt() >= persistedRecord.gatewayActivityNonce
    ) {
      transfer.persistedRecord = await db.crosschainInboundTransfersTable.recordArgonFinalized({
        id: persistedRecord.id,
        argonBlockNumber: finalizedArgonHeight,
        argonBlockHash: finalizedHeader.blockHash,
        progressJson: transferState.progress,
      });
      if (!transfer.persistedRecord) {
        throw new InboundTransferInvariantError(
          `Transfer ${persistedRecord.id} could not record its Argon finalization.`,
        );
      }

      transferState.progress = completeInboundTransferProgress(transferState.progress, 'Confirmed on Argon.');
      transferState.error = '';
      transferState.isSubmitting = false;
      transferState.hasPersistedTransfer = false;
      transferState.isComplete = true;
      return true;
    }

    if (
      latestRetainedBlockNumber != null &&
      persistedRecord.sourceBlockNumber != null &&
      latestRetainedBlockNumber < persistedRecord.sourceBlockNumber
    ) {
      const remainingRelayBlocks = persistedRecord.sourceBlockNumber - latestRetainedBlockNumber;
      const relayStartBlockNumber =
        this.#argonRelayStartBlockByTransferId.get(persistedRecord.id) ?? latestRetainedBlockNumber;
      this.#argonRelayStartBlockByTransferId.set(persistedRecord.id, relayStartBlockNumber);

      const totalRelayBlocks = Math.max(1, persistedRecord.sourceBlockNumber - relayStartBlockNumber);
      const relayedBlocks = Math.max(0, latestRetainedBlockNumber - relayStartBlockNumber);
      transferState.progress = setInboundRelayStepProgress(transferState.progress, {
        progressPct: Math.min(99, Math.round((Math.min(relayedBlocks, totalRelayBlocks) / totalRelayBlocks) * 100)),
        detail: `Waiting for Argon proof of ${remainingRelayBlocks.toLocaleString()} Ethereum blocks`,
      });
    } else {
      const argonStartHeight =
        this.#argonFinalizationStartBlockByTransferId.get(persistedRecord.id) ?? finalizedArgonHeight;
      this.#argonFinalizationStartBlockByTransferId.set(persistedRecord.id, argonStartHeight);
      const finalizedArgonBlocks = Math.max(0, finalizedArgonHeight - argonStartHeight);
      const expectedArgonBlocks = 4;
      const isWaitingForGatewayFinalization = finalizedArgonBlocks >= expectedArgonBlocks;
      transferState.progress = setInboundArgonStepProgress(transferState.progress, {
        progressPct: Math.min(
          99,
          Math.round((Math.min(finalizedArgonBlocks, expectedArgonBlocks) / expectedArgonBlocks) * 100),
        ),
        detail: formatCrosschainBlockStepDetail({
          blockType: 'Argon',
          confirmations: finalizedArgonBlocks,
          expectedConfirmations: expectedArgonBlocks,
        }),
        hint: isWaitingForGatewayFinalization
          ? 'Waiting for finalized gateway state on Argon.'
          : 'Argon is finalizing this transfer now.',
      });
    }

    await this.requestBackendCatchUp(transfer);
    return false;
  }

  private async requestBackendCatchUp(transfer: IEthereumInboundActiveTransfer) {
    const record = transfer.persistedRecord;
    if (!record) {
      return;
    }
    if (record.sourceBlockNumber == null) {
      return;
    }
    if (record.gatewayActivityNonce == null) {
      return;
    }

    const finalizedHeader = this.blockWatch.finalizedBlockHeader;
    const finalizedClient = await this.blockWatch.getApi(finalizedHeader);
    const gatewayPauseReason = await getEthereumGatewayPauseReason(finalizedClient);
    if (gatewayPauseReason) {
      transfer.transferState.error = gatewayPauseReason;
      return;
    }

    const latestRetainedAnchorHash =
      await finalizedClient.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash();
    if (latestRetainedAnchorHash.isNone) {
      return;
    }

    const latestRetainedAnchor = await finalizedClient.query.ethereumVerifier.executionHeaderAnchors(
      latestRetainedAnchorHash.unwrap().toHex(),
    );
    if (latestRetainedAnchor.isNone) {
      throw new Error(`Argon finalized execution header ${latestRetainedAnchorHash.unwrap().toHex()} is missing.`);
    }

    if (latestRetainedAnchor.unwrap().blockNumber.toBigInt() < BigInt(record.sourceBlockNumber)) {
      return;
    }

    const throughGatewayActivityNonce = record.gatewayActivityNonce;
    const gatewayState = await finalizedClient.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum');
    const argonGatewayActivityNonce = gatewayState.isSome ? gatewayState.unwrap().gatewayActivityNonce.toBigInt() : 0n;
    const relayProgressKey = `${argonGatewayActivityNonce}:${throughGatewayActivityNonce}`;
    const now = Date.now();
    if (this.#lastCatchUpProgressKey.get(record.id) !== relayProgressKey) {
      this.#lastCatchUpProgressKey.set(record.id, relayProgressKey);
      this.#lastCatchUpProgressAt.set(record.id, now);
    }

    const currentStepStartedAt =
      transfer.transferState.progress.steps[transfer.transferState.progress.currentStep - 1]?.startedAt;
    const waitEstimateMs = this.ethereumClient.getTransferToArgonWaitEstimateMs();
    const hasExceededWaitEstimate = currentStepStartedAt !== undefined && now - currentStepStartedAt >= waitEstimateMs;
    const lastCatchUpRequestAt = this.#lastCatchUpRequestAt.get(record.id);
    if (lastCatchUpRequestAt !== undefined) {
      const progressStartedAt = this.#lastCatchUpProgressAt.get(record.id) ?? now;
      const hasStalled = now - progressStartedAt >= waitEstimateMs;
      if (!hasStalled || now - lastCatchUpRequestAt < waitEstimateMs) {
        return;
      }
    }

    const upstreamOperatorHost = this.upstreamOperatorClient.operatorHost;
    if (this.serverApiClient || upstreamOperatorHost) {
      const relayResult = await requestEthereumGatewayCatchup({
        throughGatewayActivityNonce,
        serverApiClient: this.serverApiClient,
        upstreamOperatorClient: upstreamOperatorHost ? this.upstreamOperatorClient : undefined,
      });

      const shouldRetryImmediately =
        relayResult.localRelayAttemptOutcome === 'notReady' &&
        relayResult.relaySource === undefined &&
        relayResult.relayReasonCode === undefined &&
        relayResult.localRelayReasonCode === undefined;
      const shouldBackOffCatchUpRetry =
        !shouldRetryImmediately &&
        (relayResult.relaySource !== undefined ||
          relayResult.relayError !== '' ||
          relayResult.relayReasonCode !== undefined ||
          relayResult.localRelayReasonCode !== undefined);
      if (shouldBackOffCatchUpRetry) {
        this.#lastCatchUpRequestAt.set(record.id, now);
      } else {
        this.#lastCatchUpRequestAt.delete(record.id);
      }
      let isLocalRelaySetupComplete: boolean | undefined;
      if (isRelayFundingReason(relayResult.localRelayReasonCode)) {
        const delegateAddress = await this.walletKeys.getVaultDelegateKeypair().then(x => x.address);
        if (this.myVault?.createdVault) {
          isLocalRelaySetupComplete = this.myVault.createdVault.delegateAccountId === delegateAddress;
        }
      }
      const relayHint = getRelayProgressHint({
        relaySource: relayResult.relaySource,
        localRelayError: relayResult.localRelayError,
        localRelayReasonCode: relayResult.localRelayReasonCode,
        isLocalRelaySetupComplete,
        isFinalizingOnArgon: transfer.transferState.progress.currentStep >= 3,
      });
      if (relayHint) {
        const activeStepIndex = Math.max(0, transfer.transferState.progress.currentStep - 1);
        const nextSteps = transfer.transferState.progress.steps.map((step, index) => {
          if (index !== activeStepIndex) {
            return { ...step };
          }

          return {
            ...step,
            hint: relayHint,
          };
        });
        transfer.transferState.progress = hydrateCrosschainTransferProgress(nextSteps);
      }

      transfer.transferState.error = shouldSurfaceRelayError({
        relayError: relayResult.relayError,
        relayReasonCode: relayResult.relayReasonCode,
        hasExceededWaitEstimate,
      })
        ? getRelayErrorMessage({
            relayError: relayResult.relayError,
            relayReasonCode: relayResult.relayReasonCode,
            relaySource: relayResult.relaySource,
            localRelayError: relayResult.localRelayError,
            localRelayReasonCode: relayResult.localRelayReasonCode,
            isLocalRelaySetupComplete,
          })
        : '';
    }
  }

  private discardTransfer(id: string, moveToken: IEthereumMoveToken) {
    this.#lastCatchUpProgressKey.delete(id);
    this.#lastCatchUpProgressAt.delete(id);
    this.#lastCatchUpRequestAt.delete(id);
    this.#argonRelayStartBlockByTransferId.delete(id);
    this.#argonFinalizationStartBlockByTransferId.delete(id);

    if (this.data.latestTransferIdByToken[moveToken] === id) {
      delete this.data.latestTransferIdByToken[moveToken];
    }

    delete this.data.transfersById[id];
  }

  private async failTransfer(id: string, errorMessage: string) {
    const transfer = this.data.transfersById[id];
    if (!transfer) {
      return;
    }

    if (transfer.persistedRecord) {
      const db = await this.dbPromise;
      const failedRecord = await db.crosschainInboundTransfersTable.recordFailed({
        id,
        failureReason: errorMessage,
        progressJson: transfer.transferState.progress,
      });
      if (failedRecord) {
        transfer.persistedRecord = failedRecord;
      }
    }

    transfer.transferState.error = errorMessage;
    transfer.transferState.isSubmitting = false;
    transfer.transferState.hasPersistedTransfer = !!transfer.persistedRecord;
    transfer.transferState.needsAttention = true;
    transfer.transferState.isComplete = false;
  }
}

function createEmptyTransferState(): IEthereumInboundTransferState {
  return {
    isSubmitting: false,
    hasPersistedTransfer: false,
    needsAttention: false,
    isComplete: false,
    amount: 0n,
    progress: createCrosschainTransferProgress(INBOUND_TRANSFER_STEP_TITLES),
    error: '',
  };
}

function createInboundProgressFromRecord(record: ICrosschainInboundTransferRecord): ICrosschainTransferProgress {
  if (record.status === CrosschainInboundTransferStatus.ArgonFinalized) {
    return completeInboundTransferProgress(
      createCrosschainTransferProgress(INBOUND_TRANSFER_STEP_TITLES),
      'Confirmed on Argon.',
    );
  }

  if (record.status === CrosschainInboundTransferStatus.SourceFinalized) {
    return setInboundRelayStepProgress(createCrosschainTransferProgress(INBOUND_TRANSFER_STEP_TITLES), {
      progressPct: 0,
      detail: 'Waiting for Argon to receive finalized Ethereum state...',
    });
  }

  return setInboundEthereumStepProgress(createCrosschainTransferProgress(INBOUND_TRANSFER_STEP_TITLES), {
    progressPct: 0,
    detail: 'Submitting transfer to Ethereum...',
  });
}

function getMoveToken(record: ICrosschainInboundTransferRecord): IEthereumMoveToken | undefined {
  if (record.sourceChain !== 'Ethereum') {
    return;
  }

  if (record.token === MoveToken.ARGN || record.token === MoveToken.ARGNOT) {
    return record.token;
  }
}

function shouldSurfaceRelayError(args: {
  relayError: string;
  relayReasonCode?: IEthereumGatewayRelayReasonCode;
  hasExceededWaitEstimate: boolean;
}): boolean {
  const { relayError, relayReasonCode, hasExceededWaitEstimate } = args;
  if (!relayError) {
    return false;
  }

  if (isRelayFundingReason(relayReasonCode)) {
    return false;
  }

  return hasExceededWaitEstimate;
}

function isRelayFundingReason(reasonCode: IEthereumGatewayRelayReasonCode | undefined): boolean {
  return reasonCode === 'delegateInsufficientFunds';
}

function getRelayErrorMessage(args: {
  relayError: string;
  relayReasonCode?: IEthereumGatewayRelayReasonCode;
  relaySource?: IEthereumGatewayRelaySource;
  localRelayError?: string;
  localRelayReasonCode?: IEthereumGatewayRelayReasonCode;
  isLocalRelaySetupComplete?: boolean;
}): string {
  const { relayError, relayReasonCode, relaySource, localRelayReasonCode, isLocalRelaySetupComplete } = args;
  const serverOutOfRelayFunds = isRelayFundingReason(localRelayReasonCode);
  const relayRejectedForFunding = isRelayFundingReason(relayReasonCode);

  if (!serverOutOfRelayFunds && !relayRejectedForFunding) {
    return relayError;
  }

  if (serverOutOfRelayFunds) {
    return getLocalRelayFundingMessage(isLocalRelaySetupComplete);
  }

  if (relaySource === 'upstreamOperator') {
    return 'This transfer has not been picked up on Argon yet.';
  }

  return relayError;
}

function getRelayProgressHint(args: {
  relaySource?: IEthereumGatewayRelaySource;
  localRelayError?: string;
  localRelayReasonCode?: IEthereumGatewayRelayReasonCode;
  isLocalRelaySetupComplete?: boolean;
  isFinalizingOnArgon: boolean;
}): string | undefined {
  const { relaySource, localRelayReasonCode, isLocalRelaySetupComplete, isFinalizingOnArgon } = args;
  if (relaySource === 'localServer') {
    return isFinalizingOnArgon
      ? 'Argon is finalizing this transfer now.'
      : 'Your server is sending this transfer to Argon.';
  }

  if (relaySource === 'upstreamOperator') {
    if (isFinalizingOnArgon) {
      return 'Argon is finalizing this transfer now.';
    }

    if (isRelayFundingReason(localRelayReasonCode)) {
      return getLocalRelayFundingMessage(isLocalRelaySetupComplete);
    }

    return 'The Argon network is sending this transfer now.';
  }

  if (isRelayFundingReason(localRelayReasonCode)) {
    return getLocalRelayFundingMessage(isLocalRelaySetupComplete);
  }
}

function getLocalRelayFundingMessage(isLocalRelaySetupComplete?: boolean): string {
  if (isLocalRelaySetupComplete === false) {
    return "Your server isn't set up to send this transfer yet, so this transfer is waiting for the Argon network to pick it up.";
  }

  return "Your server doesn't have enough relay funds, so this transfer is waiting for the Argon network to pick it up.";
}

function hasUnacknowledgedFailure(record: ICrosschainInboundTransferRecord | undefined): boolean {
  return !!record?.failureReason && !record.isFailureAcknowledged;
}

function isAcknowledgedFailure(record: ICrosschainInboundTransferRecord | undefined): boolean {
  return !!record?.failureReason && record.isFailureAcknowledged;
}
