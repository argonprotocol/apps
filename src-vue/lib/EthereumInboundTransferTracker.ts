import { MoveToken } from '@argonprotocol/apps-core';
import { nanoid } from 'nanoid';
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
import { requestEthereumGatewayCatchUpThroughOperator, type ServerApiClient } from './ServerApiClient.ts';
import { getEthereumGatewayPauseReason, getMainchainClient } from '../stores/mainchain.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import type { UpstreamOperatorClient } from './UpstreamOperatorClient.ts';
import { WalletType } from './Wallet.ts';
import type { WalletKeys } from './WalletKeys.ts';

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
  | 'confirmTransferToArgon'
  | 'getTransactionProgress'
  | 'getTransactionFinalityPollMs'
  | 'getTransactionFinalityBlocks'
  | 'getTransferToArgonPollMs'
  | 'getTransferToArgonWaitEstimateMs'
  | 'waitForTransactionFinality'
> &
  Partial<Pick<EthereumClient, 'estimateTransferToArgonFee'>>;

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
    private readonly walletKeys: WalletKeys,
    private readonly ethereumClient: IEthereumInboundTransferClient,
    private readonly serverApiClient:
      | Pick<ServerApiClient, 'getEthereumRelayStatus' | 'requestEthereumGatewayCatchUp'>
      | undefined,
    private readonly upstreamOperatorClient: Pick<
      UpstreamOperatorClient,
      'operatorHost' | 'requestEthereumGatewayCatchUp'
    >,
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

    this.discardTransfer(id, transfer.moveToken);
  }

  public async acknowledgeFailedTransfer(id: string) {
    const transfer = this.data.transfersById[id];
    if (!transfer?.transferState.needsAcknowledgement) {
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
      isSubmitting: true,
      needsAcknowledgement: false,
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

    let destinationAddress: string;
    if (targetWalletType === WalletType.investment) {
      destinationAddress = this.walletKeys.investmentAddress;
    } else if (targetWalletType === WalletType.miningHold) {
      destinationAddress = this.walletKeys.miningHoldAddress;
    } else {
      destinationAddress = this.walletKeys.vaultingAddress;
    }

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
    if (record.argonDestinationAddress === this.walletKeys.investmentAddress) {
      targetWalletType = WalletType.investment;
    } else if (record.argonDestinationAddress === this.walletKeys.miningHoldAddress) {
      targetWalletType = WalletType.miningHold;
    } else if (record.argonDestinationAddress === this.walletKeys.vaultingAddress) {
      targetWalletType = WalletType.vaulting;
    }
    transfer.persistedRecord = record;
    if (!targetWalletType) {
      throw new Error(`Unable to determine target wallet type for ${record.argonDestinationAddress}.`);
    }

    this.data.latestTransferIdByToken[moveToken] ??= record.id;
    transfer.transferState = {
      ...createEmptyTransferState(),
      isSubmitting: !hasUnacknowledgedFailure(record),
      hasPersistedTransfer: true,
      needsAcknowledgement: hasUnacknowledgedFailure(record),
      targetWalletType,
      progress: createInboundProgressFromRecord(record),
      error: record.failureReason ?? '',
    };

    try {
      if (isAcknowledgedFailure(record)) {
        this.discardTransfer(record.id, moveToken);
        return;
      }

      if (record.status === CrosschainInboundTransferStatus.ArgonFinalized) {
        this.discardTransfer(record.id, moveToken);
        return;
      }

      if (hasUnacknowledgedFailure(record)) {
        return;
      }

      let activeRecord = record;
      if (
        activeRecord.status === CrosschainInboundTransferStatus.SourceSubmitted ||
        activeRecord.sourceBlockNumber == null ||
        activeRecord.sourceLogIndex == null ||
        activeRecord.gatewayActivityNonce == null
      ) {
        activeRecord = await this.confirmSourceTransfer(activeRecord);
        transfer.persistedRecord = activeRecord;
      }

      await this.waitForArgonFinalization(transfer);
    } catch (error) {
      await this.failTransfer(
        record.id,
        error instanceof Error ? error.message : 'Unable to resume the Ethereum transfer.',
      );
    }
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
      let destinationAddress: string;
      if (targetWalletType === WalletType.investment) {
        destinationAddress = this.walletKeys.investmentAddress;
      } else if (targetWalletType === WalletType.miningHold) {
        destinationAddress = this.walletKeys.miningHoldAddress;
      } else {
        destinationAddress = this.walletKeys.vaultingAddress;
      }

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

      transfer.persistedRecord = await this.confirmSourceTransfer(transfer.persistedRecord);
      await this.waitForArgonFinalization(transfer);
    } catch (error) {
      await this.failTransfer(id, error instanceof Error ? error.message : 'Unable to move funds from Ethereum.');
    }
  }

  private async confirmSourceTransfer(record: ICrosschainInboundTransferRecord) {
    const transferState = this.getTransferState(record.id);
    transferState.progress = setInboundEthereumStepProgress(transferState.progress, {
      progressPct: 0,
      detail: 'Submitted to Ethereum. Waiting for confirmation...',
    });

    if (record.token !== MoveToken.ARGN && record.token !== MoveToken.ARGNOT) {
      throw new Error(`Persisted inbound transfer ${record.id} is not an Ethereum Argon transfer.`);
    }
    if (!record.sourceTxHash) {
      throw new Error(`Persisted inbound transfer ${record.id} is missing its source transaction hash.`);
    }

    const table = (await this.dbPromise).crosschainInboundTransfersTable;
    const activeRecord = record;
    const sourceTxHash = activeRecord.sourceTxHash;
    if (!sourceTxHash) {
      throw new Error(`Persisted inbound transfer ${record.id} is missing its source transaction hash.`);
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
          detail: 'Submitted to Ethereum. Waiting for the RPC to confirm the transfer...',
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
      throw new Error(`Transfer ${activeRecord.id} could not record its confirmed Ethereum details.`);
    }

    transferState.progress = setInboundRelayStepProgress(transferState.progress, {
      progressPct: 0,
      detail: 'Waiting for Argon to receive finalized Ethereum state...',
    });
    const persistedRecord = await table.recordSourceFinalized(activeRecord.id, transferState.progress);
    if (!persistedRecord) {
      throw new Error(`Transfer ${activeRecord.id} could not record its finalized Ethereum state.`);
    }

    return persistedRecord;
  }

  private async waitForArgonFinalization(transfer: IEthereumInboundActiveTransfer) {
    const transferState = transfer.transferState;
    transferState.error = '';

    const db = await this.dbPromise;

    while (true) {
      const persistedRecord = transfer.persistedRecord;
      if (!persistedRecord) {
        transferState.hasPersistedTransfer = false;
        transferState.isSubmitting = false;
        return;
      }

      const client = await getMainchainClient(false);
      const finalizedHead = await client.rpc.chain.getFinalizedHead();
      const finalizedClient = await client.at(finalizedHead);
      const finalizedHeader = await client.rpc.chain.getHeader(finalizedHead);
      const finalizedArgonHeight = finalizedHeader.number.toNumber();
      const latestRetainedAnchorHash = await client.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash();
      const latestRetainedAnchor = latestRetainedAnchorHash.isNone
        ? undefined
        : await client.query.ethereumVerifier.executionHeaderAnchors(latestRetainedAnchorHash.unwrap().toHex());
      const latestRetainedBlockNumber =
        latestRetainedAnchor && latestRetainedAnchor.isSome
          ? Number(latestRetainedAnchor.unwrap().blockNumber.toBigInt())
          : undefined;
      const gatewayState = await finalizedClient.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum');
      if (
        gatewayState.isSome &&
        gatewayState.unwrap().gatewayActivityNonce.toBigInt() >= persistedRecord.gatewayActivityNonce!
      ) {
        transfer.persistedRecord = await db.crosschainInboundTransfersTable.recordArgonFinalized({
          id: persistedRecord.id,
          argonBlockNumber: finalizedArgonHeight,
          argonBlockHash: finalizedHead.toHex(),
          progressJson: transferState.progress,
        });
        if (!transfer.persistedRecord) {
          throw new Error(`Transfer ${persistedRecord.id} could not record its Argon finalization.`);
        }

        transferState.progress = completeInboundTransferProgress(transferState.progress, 'Confirmed on Argon.');
        transferState.isSubmitting = false;
        transferState.hasPersistedTransfer = false;
        return;
      }

      if (
        latestRetainedBlockNumber != null &&
        persistedRecord.sourceBlockNumber != null &&
        latestRetainedBlockNumber < persistedRecord.sourceBlockNumber
      ) {
        const relayStartBlockNumber =
          this.#argonRelayStartBlockByTransferId.get(persistedRecord.id) ?? latestRetainedBlockNumber;
        this.#argonRelayStartBlockByTransferId.set(persistedRecord.id, relayStartBlockNumber);

        const totalRelayBlocks = Math.max(1, persistedRecord.sourceBlockNumber - relayStartBlockNumber);
        const relayedBlocks = Math.max(0, latestRetainedBlockNumber - relayStartBlockNumber);
        transferState.progress = setInboundRelayStepProgress(transferState.progress, {
          progressPct: Math.min(99, Math.round((Math.min(relayedBlocks, totalRelayBlocks) / totalRelayBlocks) * 100)),
          detail: `Ethereum block ${latestRetainedBlockNumber.toLocaleString()} of ${persistedRecord.sourceBlockNumber.toLocaleString()}`,
        });
      } else {
        const argonStartHeight =
          this.#argonFinalizationStartBlockByTransferId.get(persistedRecord.id) ?? finalizedArgonHeight;
        this.#argonFinalizationStartBlockByTransferId.set(persistedRecord.id, argonStartHeight);
        const finalizedArgonBlocks = Math.max(0, finalizedArgonHeight - argonStartHeight);
        const expectedArgonBlocks = 4;
        transferState.progress = setInboundArgonStepProgress(transferState.progress, {
          progressPct: Math.min(
            99,
            Math.round((Math.min(finalizedArgonBlocks, expectedArgonBlocks) / expectedArgonBlocks) * 100),
          ),
          detail: `Argon block ${Math.min(expectedArgonBlocks, finalizedArgonBlocks) + 1} of ${expectedArgonBlocks}`,
          hint: 'Waiting for the relay to finalize on Argon.',
        });
      }

      await this.requestBackendCatchUp(transfer);
      await sleep(this.ethereumClient.getTransferToArgonPollMs());
    }
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

    const mainchainClient = await getMainchainClient(false);
    const finalizedHead = await mainchainClient.rpc.chain.getFinalizedHead();
    const finalizedClient = await mainchainClient.at(finalizedHead);
    const gatewayPauseReason = await getEthereumGatewayPauseReason(finalizedClient);
    if (gatewayPauseReason) {
      transfer.transferState.error = gatewayPauseReason;
      return;
    }

    const latestRetainedAnchorHash =
      await mainchainClient.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash();
    if (latestRetainedAnchorHash.isNone) {
      return;
    }

    const latestRetainedAnchor = await mainchainClient.query.ethereumVerifier.executionHeaderAnchors(
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
    const relayProgressKey = `${latestRetainedAnchor.unwrap().blockNumber.toBigInt()}:${argonGatewayActivityNonce}:${throughGatewayActivityNonce}`;
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
      this.#lastCatchUpRequestAt.set(record.id, now);
      const relayError = await requestEthereumGatewayCatchUpThroughOperator({
        throughGatewayActivityNonce,
        serverApiClient: this.serverApiClient,
        upstreamOperatorClient: upstreamOperatorHost ? this.upstreamOperatorClient : undefined,
      });
      transfer.transferState.error = shouldSurfaceRelayError(relayError ?? '', hasExceededWaitEstimate)
        ? (relayError ?? '')
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
    transfer.transferState.needsAcknowledgement = true;
  }
}

function createEmptyTransferState(): IEthereumInboundTransferState {
  return {
    isSubmitting: false,
    hasPersistedTransfer: false,
    needsAcknowledgement: false,
    progress: createCrosschainTransferProgress(INBOUND_TRANSFER_STEP_TITLES),
    error: '',
  };
}

function createInboundProgressFromRecord(record: ICrosschainInboundTransferRecord): ICrosschainTransferProgress {
  if (record.progressJson?.steps?.length === INBOUND_TRANSFER_STEP_TITLES.length) {
    return hydrateCrosschainTransferProgress(record.progressJson.steps);
  }

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

function shouldSurfaceRelayError(reason: string, hasExceededWaitEstimate: boolean): boolean {
  return hasExceededWaitEstimate && !shouldWaitForRelay(reason);
}

function shouldWaitForRelay(reason: string): boolean {
  return (
    reason.includes('Vault delegate needs more funds before Ethereum relays can run.') ||
    reason.includes('Vault delegate cannot afford Ethereum gateway relay.')
  );
}

function hasUnacknowledgedFailure(record: ICrosschainInboundTransferRecord | undefined): boolean {
  return !!record?.failureReason && !record.isFailureAcknowledged;
}

function isAcknowledgedFailure(record: ICrosschainInboundTransferRecord | undefined): boolean {
  return !!record?.failureReason && record.isFailureAcknowledged;
}
