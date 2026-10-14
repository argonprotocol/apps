import { bigIntMax, MoveToken, type IEthereumGatewayRelayReasonCode } from '@argonprotocol/apps-core';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { nanoid } from 'nanoid';
import { formatEther, type Hash } from 'viem';
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
import {
  EthereumClient,
  EthereumTransactionRevertedError,
  EthereumTransactionUnavailableError,
  type IEthereumMoveToken,
} from './EthereumClient.ts';
import { sleep } from './Utils.ts';
import {
  CrosschainInboundTransferStatus,
  type ICrosschainInboundTransferRecord,
} from './db/CrosschainInboundTransfersTable.ts';
import type { Db } from './Db.ts';
import type { ServerApiClient } from './ServerApiClient.ts';
import { requestEthereumGatewayCatchup, type IEthereumGatewayCatchupResult } from './EthereumGatewayCatchup.ts';
import { getEthereumGatewayPauseReason } from '../stores/mainchain.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import type { UpstreamOperatorClient } from './UpstreamOperatorClient.ts';
import { WalletType } from './Wallet.ts';
import { convertEthereumTokenBaseUnitsToRuntimeAmount, type WalletForEthereum } from './WalletForEthereum.ts';
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
  startedAt?: number;
  sourceAddress?: string;
  transferState: IEthereumInboundTransferState;
  persistedRecord?: ICrosschainInboundTransferRecord;
};

type IEthereumInboundTransferClient = Pick<
  EthereumClient,
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

type ServerRelayClient = Pick<ServerApiClient, 'getEthereumRelayStatus' | 'requestEthereumGatewayCatchUp'>;
type ServerRelayClientSource = ServerRelayClient | (() => ServerRelayClient | undefined) | undefined;

class InboundTransferInvariantError extends Error {}

export class EthereumInboundTransferTracker {
  public data = {
    transfersById: {} as Record<string, IEthereumInboundActiveTransfer>,
    latestTransferIdByToken: {} as Partial<Record<IEthereumMoveToken, string>>,
  };

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
    private readonly ethereumClient: IEthereumInboundTransferClient | undefined,
    private readonly serverApiClientSource: ServerRelayClientSource,
    private readonly upstreamOperatorClient: Pick<
      UpstreamOperatorClient,
      'resolveOperatorHost' | 'requestEthereumGatewayCatchUp'
    >,
    private readonly myVault?: Pick<MyVault, 'createdVault'>,
  ) {}

  public async load(): Promise<void> {
    if (this.#loadPromise) return this.#loadPromise;

    const loadPromise = this.loadTransfers().catch(error => {
      if (this.#loadPromise === loadPromise) this.#loadPromise = undefined;
      throw error;
    });
    this.#loadPromise = loadPromise;
    return loadPromise;
  }

  public async startMove(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    targetWalletType: IArgonWalletType;
    ethereumWallet: WalletForEthereum;
  }): Promise<IEthereumInboundActiveTransfer | undefined> {
    const { moveToken, amountBaseUnits, targetWalletType, ethereumWallet } = args;
    await this.load();

    if (amountBaseUnits <= 0n) {
      return;
    }
    this.requireEthereumClient();

    const db = await this.dbPromise;
    const id = nanoid();
    const transfer = this.trackTransfer(id, moveToken);
    transfer.sourceAddress = ethereumWallet.address;

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
      ethereumWallet,
    });

    return transfer;
  }

  public async estimateFeeWei(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    targetWalletType: IArgonWalletType;
    ethereumWallet: WalletForEthereum;
  }): Promise<bigint | undefined> {
    const { moveToken, amountBaseUnits, targetWalletType, ethereumWallet } = args;
    if (amountBaseUnits <= 0n) {
      return;
    }

    const destinationAddress = this.walletKeys.getWalletAddress(targetWalletType);
    return this.requireEthereumClient().estimateTransferToArgonFee?.({
      moveToken,
      amountBaseUnits,
      destinationAddress,
      ethereumWallet,
    });
  }

  public getTransfer(id: string): IEthereumInboundActiveTransfer | undefined {
    return this.data.transfersById[id];
  }

  public getTransferStateForToken(moveToken: IEthereumMoveToken): IEthereumInboundTransferState {
    const id = this.data.latestTransferIdByToken[moveToken];
    if (!id) {
      return createEmptyTransferState();
    }

    return this.data.transfersById[id].transferState;
  }

  public getAvailableAmount(ethereumWallet: WalletForEthereum, moveToken: IEthereumMoveToken): bigint {
    const { availableMicrogons, availableMicronots, balanceUpdatedAt } = ethereumWallet.data;
    const balance = moveToken === MoveToken.ARGNOT ? availableMicronots : availableMicrogons;
    const sourceAddress = ethereumWallet.address.toLowerCase();
    let reservedAmount = 0n;

    for (const transfer of Object.values(this.data.transfersById)) {
      if (transfer.moveToken !== moveToken) continue;
      const record = transfer.persistedRecord;
      const transferSourceAddress = record?.sourceAddress ?? transfer.sourceAddress;
      if (transferSourceAddress?.toLowerCase() !== sourceAddress) continue;

      if (!record) {
        // A failed attempt must not reduce the amount available to its retry.
        if (transfer.transferState.isSubmitting) {
          reservedAmount += transfer.transferState.amount;
        }
        continue;
      }

      if (record.status === CrosschainInboundTransferStatus.SourceSubmitted) {
        // A terminal confirmation failure ends this attempt. Transient RPC
        // errors are retried by reconciliation and do not set failureReason.
        if (record.failureReason) continue;
        reservedAmount += transfer.transferState.amount;
        continue;
      }

      if (record.status === CrosschainInboundTransferStatus.SourceFinalized) {
        // Ethereum has consumed the tokens. Keep reserving them only until a
        // wallet balance snapshot includes that debit, so it is not counted twice.
        if (!balanceUpdatedAt || balanceUpdatedAt < record.updatedAt) {
          reservedAmount += transfer.transferState.amount;
        }
      }
    }

    return bigIntMax(balance - reservedAmount, 0n);
  }

  public hasSignerDependentTransfer(sourceAddress: string): boolean {
    const normalizedAddress = sourceAddress.toLowerCase();
    return Object.values(this.data.transfersById).some(transfer => {
      const transferSourceAddress = transfer.persistedRecord?.sourceAddress ?? transfer.sourceAddress;
      return (
        transfer.transferState.isSubmitting &&
        !transfer.transferState.hasPersistedTransfer &&
        transferSourceAddress?.toLowerCase() === normalizedAddress
      );
    });
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

  private async runStartMove(args: {
    db: Db;
    id: string;
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    targetWalletType: IArgonWalletType;
    ethereumWallet: WalletForEthereum;
  }) {
    const { db, id, moveToken, amountBaseUnits, targetWalletType, ethereumWallet } = args;
    const transfer = this.trackTransfer(id, moveToken);
    const transferState = transfer.transferState;

    try {
      const destinationAddress = this.walletKeys.getWalletAddress(targetWalletType);
      await this.ensureSufficientEthereumFeeBalance({
        moveToken,
        amountBaseUnits,
        destinationAddress,
        ethereumWallet,
      });

      const submittedTransfer = await this.requireEthereumClient().startTransferToArgon({
        moveToken,
        amountBaseUnits,
        destinationAddress,
        ethereumWallet,
      });
      transfer.persistedRecord = await db.crosschainInboundTransfersTable.insertSourceSubmitted({
        sourceChain: 'Ethereum',
        id,
        token: submittedTransfer.moveToken,
        amountBaseUnits: submittedTransfer.amountBaseUnits,
        sourceAddress: submittedTransfer.sourceAddress ?? transfer.sourceAddress,
        argonDestinationAddress: submittedTransfer.destinationAddress,
        sourceTxHash: submittedTransfer.sourceTxHash,
        progressJson: transferState.progress,
      });
      if (!transfer.persistedRecord) {
        throw new Error(`Transfer ${id} could not be persisted after Ethereum submission.`);
      }
      transferState.hasPersistedTransfer = true;

      await this.reconcileTransfer(transfer, 'Unable to move funds from Ethereum.');
    } catch (error) {
      await this.failTransfer(id, error instanceof Error ? error.message : 'Unable to move funds from Ethereum.');
    }
  }

  private async ensureSufficientEthereumFeeBalance(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    destinationAddress: string;
    ethereumWallet: WalletForEthereum;
  }) {
    const { moveToken, amountBaseUnits, destinationAddress, ethereumWallet } = args;
    const ethereumClient = this.requireEthereumClient();
    const feeEstimateWei = await ethereumClient.estimateTransferToArgonFee({
      moveToken,
      amountBaseUnits,
      destinationAddress,
      ethereumWallet,
    });
    const ethereumBalanceWei = await ethereumClient.getNativeBalanceWei(ethereumWallet);
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

  private async loadTransfers() {
    await this.transactionTracker.load();
    await this.blockWatch.start();

    const db = await this.dbPromise;
    const records = await db.crosschainInboundTransfersTable.fetchAll();

    for (const record of records) {
      // A dismissed failure stays dismissed even without an Ethereum client.
      if (isAcknowledgedFailure(record)) continue;

      const moveToken = getMoveToken(record);
      if (!moveToken) {
        continue;
      }

      const transfer = this.trackTransfer(record.id, moveToken);
      transfer.startedAt = record.createdAt.getTime();
      transfer.sourceAddress = record.sourceAddress;
      transfer.persistedRecord = record;
      this.data.latestTransferIdByToken[moveToken] ??= record.id;
      void this.resumeTransfer(record);
    }
  }

  private async resumeTransfer(record: ICrosschainInboundTransferRecord) {
    const moveToken = getMoveToken(record);
    if (!moveToken) {
      return;
    }

    const existingResumePromise = this.#resumePromises.get(record.id);
    if (existingResumePromise) {
      return existingResumePromise;
    }

    // Each restored transfer has its own loop. An Ethereum confirmation wait
    // must not prevent another transfer from reaching Argon finalization.
    const resumePromise = this.restoreTransfer(record, moveToken);
    this.#resumePromises.set(record.id, resumePromise);

    try {
      await resumePromise;
    } finally {
      this.#resumePromises.delete(record.id);
    }
  }

  private async restoreTransfer(record: ICrosschainInboundTransferRecord, moveToken: IEthereumMoveToken) {
    const transfer = this.trackTransfer(record.id, moveToken);
    transfer.persistedRecord = record;
    transfer.startedAt = record.createdAt.getTime();
    transfer.sourceAddress = record.sourceAddress;

    this.data.latestTransferIdByToken[moveToken] ??= record.id;
    // The current UI has one inbound wallet. Older transfers keep their recorded
    // destination after the default wallet address changes.
    transfer.transferState = {
      ...createEmptyTransferState(),
      amount: convertEthereumTokenBaseUnitsToRuntimeAmount(record.amountBaseUnits),
      isSubmitting: !hasUnacknowledgedFailure(record),
      hasPersistedTransfer: true,
      needsAttention: hasUnacknowledgedFailure(record),
      isComplete: record.status === CrosschainInboundTransferStatus.ArgonFinalized,
      targetWalletType: WalletType.argon,
      progress: createInboundProgressFromRecord(record),
      error: record.failureReason ?? '',
    };

    if (!this.ethereumClient) return;
    await this.reconcileTransfer(transfer, 'Unable to resume the Ethereum transfer.');
  }

  private async reconcileTransfer(transfer: IEthereumInboundActiveTransfer, fallbackErrorMessage: string) {
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
          this.discardTransfer(activeRecord.id, transfer.moveToken);
          return;
        }

        if (activeRecord.status === CrosschainInboundTransferStatus.ArgonFinalized) {
          this.discardTransfer(activeRecord.id, transfer.moveToken);
          return;
        }

        if (hasUnacknowledgedFailure(activeRecord)) {
          return;
        }

        try {
          // The durable phases are Ethereum submission, Ethereum finalization,
          // then Argon's proven gateway nonce. Older rows may need their missing
          // Ethereum event details repaired before the final phase can advance.
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
          if (
            error instanceof InboundTransferInvariantError ||
            error instanceof EthereumTransactionRevertedError ||
            error instanceof EthereumTransactionUnavailableError
          ) {
            throw error;
          }

          console.warn(
            `[EthereumInboundTransferTracker] Unable to refresh inbound transfer state for ${activeRecord.id}; will retry on the next poll`,
            error,
          );
        }

        await sleep(this.requireEthereumClient().getTransferToArgonPollMs());
      }
    } catch (error) {
      await this.failTransfer(transfer.id, error instanceof Error ? error.message : fallbackErrorMessage);
    }
  }

  private async confirmSourceTransfer(record: ICrosschainInboundTransferRecord) {
    const moveToken = getMoveToken(record);
    if (!moveToken) throw new InboundTransferInvariantError(`Unsupported Ethereum transfer token: ${record.token}`);
    const { sourceTxHash } = record;
    if (!sourceTxHash) {
      throw new InboundTransferInvariantError(
        `Persisted inbound transfer ${record.id} is missing its source transaction hash.`,
      );
    }

    const transferState = this.data.transfersById[record.id].transferState;
    const finalizedProgress = await this.waitForSourceFinality(record, sourceTxHash, transferState);

    // Finality establishes the block; the gateway event supplies the nonce
    // Argon must prove before this transfer can complete.
    const ethereumClient = this.requireEthereumClient();
    const confirmedTransfer = await ethereumClient.confirmTransferToArgon({
      moveToken,
      amountBaseUnits: record.amountBaseUnits,
      destinationAddress: record.argonDestinationAddress,
      executionRpcUrl: ethereumClient.executionRpcUrl,
      sourceTxHash,
      sourceBlockNumber: finalizedProgress.blockNumber,
      sourceBlockHash: finalizedProgress.blockHash,
      sourceLogIndex: record.sourceLogIndex,
      gatewayActivityNonce: record.gatewayActivityNonce,
    });

    // Save the event identity before advancing the durable phase. A retry can
    // repeat either write using the same submitted Ethereum transaction.
    const table = (await this.dbPromise).crosschainInboundTransfersTable;
    const confirmedRecord = await table.recordConfirmedSourceTransfer({
      id: record.id,
      sourceBlockNumber: confirmedTransfer.sourceBlockNumber!,
      sourceBlockHash: confirmedTransfer.sourceBlockHash!,
      sourceLogIndex: confirmedTransfer.sourceLogIndex!,
      gatewayActivityNonce: confirmedTransfer.gatewayActivityNonce!,
    });
    if (!confirmedRecord) {
      throw new InboundTransferInvariantError(`Transfer ${record.id} could not record its confirmed Ethereum details.`);
    }

    transferState.progress = setInboundRelayStepProgress(transferState.progress, {
      progressPct: 0,
      detail: 'Waiting for Argon to receive finalized Ethereum state...',
    });
    const sourceFinalizedRecord = await table.recordSourceFinalized(record.id, transferState.progress);
    if (!sourceFinalizedRecord) {
      throw new InboundTransferInvariantError(`Transfer ${record.id} could not record its finalized Ethereum state.`);
    }

    return sourceFinalizedRecord;
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
    let latestRetainedBlockNumber: number | undefined;
    if (latestRetainedAnchorHash) {
      const anchor = await finalizedClient.query.ethereumVerifier.executionHeaderAnchors(latestRetainedAnchorHash);
      if (anchor) latestRetainedBlockNumber = Number(anchor.blockNumber);
    }
    const gatewayState = await finalizedClient.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum');

    // Persist the proven gateway nonce before publishing success to the panel.
    if (gatewayState && gatewayState.gatewayActivityNonce >= persistedRecord.gatewayActivityNonce) {
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

    this.updateArgonProgress(transfer, latestRetainedBlockNumber, finalizedArgonHeight);
    await this.requestBackendCatchUp(transfer, finalizedClient);
    return false;
  }

  private async requestBackendCatchUp(
    transfer: IEthereumInboundActiveTransfer,
    finalizedClient: Awaited<ReturnType<BlockWatch['getApi']>>,
  ) {
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

    // Catch-up decisions use the same finalized snapshot as the progress above.
    // A newer live head must not change the meaning of this reconciliation pass.
    const gatewayPauseReason = await getEthereumGatewayPauseReason(finalizedClient);
    if (gatewayPauseReason) {
      transfer.transferState.error = gatewayPauseReason;
      return;
    }

    const latestRetainedAnchorHash =
      await finalizedClient.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash();
    if (!latestRetainedAnchorHash) return;

    const latestRetainedAnchor =
      await finalizedClient.query.ethereumVerifier.executionHeaderAnchors(latestRetainedAnchorHash);
    if (!latestRetainedAnchor)
      throw new Error(`Argon finalized execution header ${latestRetainedAnchorHash} is missing.`);

    if (latestRetainedAnchor.blockNumber < BigInt(record.sourceBlockNumber)) {
      return;
    }

    const throughGatewayActivityNonce = record.gatewayActivityNonce;
    const gatewayState = await finalizedClient.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum');
    const argonGatewayActivityNonce = gatewayState?.gatewayActivityNonce ?? 0n;
    const relayProgressKey = `${argonGatewayActivityNonce}:${throughGatewayActivityNonce}`;
    const now = Date.now();
    // Back off repeated requests while the same gateway nonce is progressing.
    // A stalled nonce becomes eligible again after one transfer wait estimate.
    if (this.#lastCatchUpProgressKey.get(record.id) !== relayProgressKey) {
      this.#lastCatchUpProgressKey.set(record.id, relayProgressKey);
      this.#lastCatchUpProgressAt.set(record.id, now);
    }

    const currentStepStartedAt =
      transfer.transferState.progress.steps[transfer.transferState.progress.currentStep - 1]?.startedAt;
    const waitEstimateMs = this.requireEthereumClient().getTransferToArgonWaitEstimateMs();
    const hasExceededWaitEstimate = currentStepStartedAt !== undefined && now - currentStepStartedAt >= waitEstimateMs;
    const lastCatchUpRequestAt = this.#lastCatchUpRequestAt.get(record.id);
    if (lastCatchUpRequestAt !== undefined) {
      const progressStartedAt = this.#lastCatchUpProgressAt.get(record.id) ?? now;
      const hasStalled = now - progressStartedAt >= waitEstimateMs;
      if (!hasStalled) return;
      if (now - lastCatchUpRequestAt < waitEstimateMs) return;
    }

    const serverApiClient =
      typeof this.serverApiClientSource === 'function' ? this.serverApiClientSource() : this.serverApiClientSource;
    const upstreamOperatorHost = await this.upstreamOperatorClient.resolveOperatorHost();
    if (!serverApiClient && !upstreamOperatorHost) return;

    const relayResult = await requestEthereumGatewayCatchup({
      throughGatewayActivityNonce,
      serverApiClient,
      upstreamOperatorClient: upstreamOperatorHost ? this.upstreamOperatorClient : undefined,
    });

    if (shouldWaitBeforeCatchUpRetry(relayResult)) {
      this.#lastCatchUpRequestAt.set(record.id, now);
    } else {
      this.#lastCatchUpRequestAt.delete(record.id);
    }

    await this.updateRelayFeedback(transfer, relayResult, hasExceededWaitEstimate);
  }

  private async waitForSourceFinality(
    record: ICrosschainInboundTransferRecord,
    sourceTxHash: Hash,
    transferState: IEthereumInboundTransferState,
  ) {
    transferState.progress = setInboundEthereumStepProgress(transferState.progress, {
      progressPct: 0,
      detail: 'Submitted to Ethereum. Waiting for confirmation...',
    });
    const ethereumClient = this.requireEthereumClient();
    return ethereumClient.waitForTransactionFinality({
      txHash: sourceTxHash,
      blockNumber: record.sourceBlockNumber,
      blockHash: record.sourceBlockHash,
      submittedAtMs: record.createdAt.getTime(),
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
        // RPC delays leave the submitted transaction pending; they must not
        // turn it into a terminal failure or release its reserved balance.
        transferState.error = '';
        transferState.progress = setInboundEthereumStepProgress(transferState.progress, {
          progressPct: Math.max(txProgress?.progressPct ?? transferState.progress.steps[0]?.progressPct ?? 0, 1),
          detail: 'Submitted to Ethereum. Waiting for confirmation...',
        });
      },
    });
  }

  private updateArgonProgress(
    transfer: IEthereumInboundActiveTransfer,
    retainedEthereumBlockNumber: number | undefined,
    finalizedArgonHeight: number,
  ) {
    const { id, persistedRecord, transferState } = transfer;
    const sourceBlockNumber = persistedRecord?.sourceBlockNumber;

    // Argon first needs Ethereum headers through the source block. The progress
    // baselines estimate waiting time; they cannot establish completion.
    if (retainedEthereumBlockNumber != null && sourceBlockNumber != null) {
      if (retainedEthereumBlockNumber < sourceBlockNumber) {
        const relayStartBlock = this.#argonRelayStartBlockByTransferId.get(id) ?? retainedEthereumBlockNumber;
        this.#argonRelayStartBlockByTransferId.set(id, relayStartBlock);

        const totalRelayBlocks = Math.max(1, sourceBlockNumber - relayStartBlock);
        const relayedBlocks = Math.max(0, retainedEthereumBlockNumber - relayStartBlock);
        const remainingRelayBlocks = sourceBlockNumber - retainedEthereumBlockNumber;
        transferState.progress = setInboundRelayStepProgress(transferState.progress, {
          progressPct: Math.min(99, Math.round((relayedBlocks / totalRelayBlocks) * 100)),
          detail: `Waiting for Argon proof of ${remainingRelayBlocks.toLocaleString()} Ethereum blocks`,
        });
        return;
      }
    }

    const argonStartHeight = this.#argonFinalizationStartBlockByTransferId.get(id) ?? finalizedArgonHeight;
    this.#argonFinalizationStartBlockByTransferId.set(id, argonStartHeight);

    const finalizedArgonBlocks = Math.max(0, finalizedArgonHeight - argonStartHeight);
    const expectedArgonBlocks = 4;
    let hint = 'Argon is finalizing this transfer now.';
    if (finalizedArgonBlocks >= expectedArgonBlocks) {
      hint = 'Waiting for finalized gateway state on Argon.';
    }
    transferState.progress = setInboundArgonStepProgress(transferState.progress, {
      progressPct: Math.min(99, Math.round((finalizedArgonBlocks / expectedArgonBlocks) * 100)),
      detail: formatCrosschainBlockStepDetail({
        blockType: 'Argon',
        confirmations: finalizedArgonBlocks,
        expectedConfirmations: expectedArgonBlocks,
      }),
      hint,
    });
  }

  private async updateRelayFeedback(
    transfer: IEthereumInboundActiveTransfer,
    relayResult: IEthereumGatewayCatchupResult,
    hasExceededWaitEstimate: boolean,
  ) {
    let isLocalRelaySetupComplete: boolean | undefined;
    if (isRelayFundingReason(relayResult.localRelayReasonCode)) {
      const delegateAddress = await this.walletKeys.getVaultDelegateKeypair().then(x => x.address);
      if (this.myVault?.createdVault) {
        isLocalRelaySetupComplete = this.myVault.createdVault.delegateAccountId === delegateAddress;
      }
    }

    const { transferState } = transfer;
    const relayHint = getRelayProgressHint(relayResult, transferState.progress, isLocalRelaySetupComplete);
    if (relayHint) {
      const activeStepIndex = Math.max(0, transferState.progress.currentStep - 1);
      const nextSteps = transferState.progress.steps.map((step, index) => {
        if (index !== activeStepIndex) {
          return { ...step };
        }

        return {
          ...step,
          hint: relayHint,
        };
      });
      transferState.progress = hydrateCrosschainTransferProgress(nextSteps);
    }

    // A relay funding rejection stays in the hint. Other errors surface only
    // after the current step has exceeded its normal wait estimate.
    transferState.error = '';
    if (!relayResult.relayError) return;
    if (isRelayFundingReason(relayResult.relayReasonCode)) return;
    if (!hasExceededWaitEstimate) return;

    if (isRelayFundingReason(relayResult.localRelayReasonCode)) {
      transferState.error = getLocalRelayFundingMessage(isLocalRelaySetupComplete);
      return;
    }
    transferState.error = relayResult.relayError;
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

  private trackTransfer(id: string, moveToken: IEthereumMoveToken): IEthereumInboundActiveTransfer {
    let transfer = this.data.transfersById[id];
    if (!transfer) {
      this.data.transfersById[id] = {
        id,
        moveToken,
        startedAt: Date.now(),
        transferState: createEmptyTransferState(),
      };
      transfer = this.data.transfersById[id];
    }

    return transfer;
  }

  private discardTransfer(id: string, moveToken: IEthereumMoveToken) {
    this.#lastCatchUpProgressKey.delete(id);
    this.#lastCatchUpProgressAt.delete(id);
    this.#lastCatchUpRequestAt.delete(id);
    this.#argonRelayStartBlockByTransferId.delete(id);
    this.#argonFinalizationStartBlockByTransferId.delete(id);

    if (this.data.latestTransferIdByToken[moveToken] === id) {
      this.recomputeLatestTransfer(moveToken, id);
    }

    delete this.data.transfersById[id];
  }

  private recomputeLatestTransfer(moveToken: IEthereumMoveToken, excludedId?: string) {
    const latest = Object.values(this.data.transfersById)
      .filter(transfer => transfer.id !== excludedId && transfer.moveToken === moveToken)
      .sort((a, b) => {
        const aTime = a.persistedRecord?.updatedAt.getTime() ?? a.startedAt ?? 0;
        const bTime = b.persistedRecord?.updatedAt.getTime() ?? b.startedAt ?? 0;
        return bTime - aTime;
      })[0];

    if (latest) this.data.latestTransferIdByToken[moveToken] = latest.id;
    else delete this.data.latestTransferIdByToken[moveToken];
  }

  private requireEthereumClient(): IEthereumInboundTransferClient {
    if (!this.ethereumClient) {
      throw new Error('Ethereum execution RPC is not configured for this app instance.');
    }
    return this.ethereumClient;
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

function shouldWaitBeforeCatchUpRetry(relayResult: IEthereumGatewayCatchupResult): boolean {
  // An accepted request or a reason code requires a wait, even if the local
  // server also reported that it was not ready.
  if (relayResult.relaySource !== undefined) return true;
  if (relayResult.relayReasonCode !== undefined) return true;
  if (relayResult.localRelayReasonCode !== undefined) return true;

  // With no relay or reason code, the server may simply be starting. Check it
  // again next poll rather than imposing the full transfer wait estimate.
  if (relayResult.localRelayAttemptOutcome === 'notReady') return false;

  return relayResult.relayError !== '';
}

function isRelayFundingReason(reasonCode: IEthereumGatewayRelayReasonCode | undefined): boolean {
  return reasonCode === 'delegateInsufficientFunds';
}

function getRelayProgressHint(
  relayResult: IEthereumGatewayCatchupResult,
  progress: ICrosschainTransferProgress,
  isLocalRelaySetupComplete: boolean | undefined,
): string | undefined {
  const { relaySource, localRelayReasonCode } = relayResult;
  if (relaySource && progress.currentStep >= 3) {
    return 'Argon is finalizing this transfer now.';
  }

  if (relaySource === 'localServer') {
    return 'Your server is sending this transfer to Argon.';
  }

  if (isRelayFundingReason(localRelayReasonCode)) {
    return getLocalRelayFundingMessage(isLocalRelaySetupComplete);
  }

  if (relaySource === 'upstreamOperator') {
    return 'The Argon network is sending this transfer now.';
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
