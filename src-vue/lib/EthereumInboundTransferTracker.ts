import { MoveToken } from '@argonprotocol/apps-core';
import { nanoid } from 'nanoid';
import type { IArgonWalletType, IEthereumInboundTransferState } from '../interfaces/IEthereumInboundTransferTracker.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { EthereumClient, type IEthereumMoveToken } from './EthereumClient.ts';
import {
  CrosschainInboundTransferStatus,
  type ICrosschainInboundTransferRecord,
} from './db/CrosschainInboundTransfersTable.ts';
import type { Db } from './Db.ts';
import type { ServerApiClient } from './ServerApiClient.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import type { UpstreamOperatorClient } from './UpstreamOperatorClient.ts';
import { WalletType } from './Wallet.ts';
import type { WalletKeys } from './WalletKeys.ts';

export type {
  IArgonWalletType,
  IEthereumInboundArgonProgress,
  IEthereumInboundArgonReadiness,
  IEthereumInboundTransferPhase,
  IEthereumInboundTransferState,
  IEthereumMoveToken,
} from '../interfaces/IEthereumInboundTransferTracker.ts';

export type IEthereumInboundActiveTransfer = {
  transferId: string;
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
  | 'getTransferToArgonPollMs'
  | 'getTransferToArgonWaitEstimateMs'
>;

const CATCH_UP_RETRY_MS = 30_000;

export class EthereumInboundTransferTracker {
  public data = {
    transfersById: {} as Record<string, IEthereumInboundActiveTransfer>,
    latestTransferIdByToken: {} as Partial<Record<IEthereumMoveToken, string>>,
  };

  #hasLoadedPendingMoves = false;
  #loadPromise?: Promise<void>;
  #resumePromises = new Map<string, Promise<void>>();
  #lastCatchUpRequestAt = new Map<string, number>();

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

      const transfer = this.trackTransfer(record.transferId, moveToken);
      transfer.persistedRecord = record;
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

    this.data.latestTransferIdByToken[moveToken] ??= record.transferId;
    transfer.transferState = {
      ...createEmptyTransferState(),
      isSubmitting: true,
      hasPersistedTransfer: true,
      targetWalletType,
      phase:
        record.status === CrosschainInboundTransferStatus.SourceSubmitted ? 'confirmingEthereum' : 'confirmingArgon',
    };

    try {
      if (record.status === CrosschainInboundTransferStatus.ArgonFinalized) {
        this.discardTransfer(record.transferId, moveToken);
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
      const transferState = this.getTransferState(record.transferId);
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
    const transfer = this.trackTransfer(transferId, moveToken);
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

      transferState.phase = 'confirmingEthereum';
      const submittedTransfer = await this.ethereumClient.startTransferToArgon({
        moveToken,
        amountBaseUnits,
        destinationAddress,
      });
      transferState.hasPersistedTransfer = true;

      transfer.persistedRecord = await db.crosschainInboundTransfersTable.insertSourceSubmitted({
        transferId,
        token: submittedTransfer.moveToken,
        amountBaseUnits: submittedTransfer.amountBaseUnits,
        sourceAddress: this.ethereumClient.sourceAddress,
        argonDestinationAddress: submittedTransfer.destinationAddress,
        sourceTxHash: submittedTransfer.sourceTxHash,
      });
      if (!transfer.persistedRecord) {
        throw new Error(`Transfer ${transferId} could not be persisted after Ethereum submission.`);
      }

      const confirmedTransfer = await this.ethereumClient.confirmTransferToArgon(submittedTransfer);
      transfer.persistedRecord = await db.crosschainInboundTransfersTable.recordConfirmedSourceTransfer({
        transferId,
        sourceBlockNumber: confirmedTransfer.sourceBlockNumber!,
        sourceBlockHash: confirmedTransfer.sourceBlockHash!,
        sourceLogIndex: confirmedTransfer.sourceLogIndex!,
        gatewayActivityNonce: confirmedTransfer.gatewayActivityNonce!,
      });
      if (!transfer.persistedRecord) {
        throw new Error(`Transfer ${transferId} could not record its confirmed Ethereum details.`);
      }

      transfer.persistedRecord = await db.crosschainInboundTransfersTable.recordSourceFinalized(transferId);
      if (!transfer.persistedRecord) {
        throw new Error(`Transfer ${transferId} could not record its finalized Ethereum state.`);
      }

      await this.waitForArgonFinalization(transfer);
    } catch (error) {
      transferState.error = error instanceof Error ? error.message : 'Unable to move funds from Ethereum.';
      transferState.isSubmitting = false;
    }
  }

  private async confirmSourceTransfer(record: ICrosschainInboundTransferRecord) {
    const transferState = this.getTransferState(record.transferId);
    transferState.phase = 'confirmingEthereum';

    if (record.token !== MoveToken.ARGN && record.token !== MoveToken.ARGNOT) {
      throw new Error(`Persisted inbound transfer ${record.transferId} is not an Ethereum Argon transfer.`);
    }
    if (!record.sourceTxHash) {
      throw new Error(`Persisted inbound transfer ${record.transferId} is missing its source transaction hash.`);
    }

    const confirmedTransfer = await this.ethereumClient.confirmTransferToArgon({
      moveToken: record.token,
      amountBaseUnits: record.amountBaseUnits,
      destinationAddress: record.argonDestinationAddress,
      executionRpcUrl: this.ethereumClient.executionRpcUrl,
      sourceTxHash: record.sourceTxHash,
      sourceBlockNumber: record.sourceBlockNumber,
      sourceBlockHash: record.sourceBlockHash,
      sourceLogIndex: record.sourceLogIndex,
      gatewayActivityNonce: record.gatewayActivityNonce,
    });
    const table = (await this.dbPromise).crosschainInboundTransfersTable;

    const confirmedRecord = await table.recordConfirmedSourceTransfer({
      transferId: record.transferId,
      sourceBlockNumber: confirmedTransfer.sourceBlockNumber!,
      sourceBlockHash: confirmedTransfer.sourceBlockHash!,
      sourceLogIndex: confirmedTransfer.sourceLogIndex!,
      gatewayActivityNonce: confirmedTransfer.gatewayActivityNonce!,
    });
    if (!confirmedRecord) {
      throw new Error(`Transfer ${record.transferId} could not record its confirmed Ethereum details.`);
    }

    const persistedRecord = await table.recordSourceFinalized(record.transferId);
    if (!persistedRecord) {
      throw new Error(`Transfer ${record.transferId} could not record its finalized Ethereum state.`);
    }

    return persistedRecord;
  }

  private async waitForArgonFinalization(transfer: IEthereumInboundActiveTransfer) {
    const transferState = transfer.transferState;
    transferState.phase = 'confirmingArgon';
    transferState.argonReadiness = {
      startedAt: Date.now(),
      estimatedDurationMs: this.ethereumClient.getTransferToArgonWaitEstimateMs(),
      pollMs: this.ethereumClient.getTransferToArgonPollMs(),
    };
    transferState.error = '';

    const db = await this.dbPromise;

    while (true) {
      const persistedRecord = transfer.persistedRecord;
      if (!persistedRecord) {
        transferState.hasPersistedTransfer = false;
        transferState.isSubmitting = false;
        return;
      }

      const finalizedAt = await this.getArgonFinalization(persistedRecord);
      if (finalizedAt) {
        transfer.persistedRecord = await db.crosschainInboundTransfersTable.recordArgonFinalized({
          transferId: persistedRecord.transferId,
          argonBlockNumber: finalizedAt.blockNumber,
          argonBlockHash: finalizedAt.blockHash,
        });
        if (!transfer.persistedRecord) {
          throw new Error(`Transfer ${persistedRecord.transferId} could not record its Argon finalization.`);
        }

        transferState.phase = 'confirmedOnArgon';
        transferState.isSubmitting = false;
        transferState.hasPersistedTransfer = false;
        transferState.argonReadiness = undefined;
        return;
      }

      await this.requestBackendCatchUp(transfer);
      await new Promise<void>(resolve => {
        setTimeout(resolve, this.ethereumClient.getTransferToArgonPollMs());
      });
    }
  }

  private async getArgonFinalization(record: ICrosschainInboundTransferRecord) {
    if (record.gatewayActivityNonce == null) {
      throw new Error(`Persisted inbound transfer ${record.transferId} is missing gateway activity nonce.`);
    }

    const client = await getMainchainClient(false);
    const finalizedHead = await client.rpc.chain.getFinalizedHead();
    const finalizedClient = await client.at(finalizedHead);
    const gatewayState = await finalizedClient.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum');
    if (gatewayState.isNone) {
      return undefined;
    }

    const provenNonce = gatewayState.unwrap().gatewayActivityNonce.toBigInt();
    if (provenNonce < record.gatewayActivityNonce) {
      return undefined;
    }

    const finalizedHeader = await client.rpc.chain.getHeader(finalizedHead);
    return {
      blockNumber: finalizedHeader.number.toNumber(),
      blockHash: finalizedHead.toHex(),
    };
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

    if (!shouldRetry(this.#lastCatchUpRequestAt.get(record.transferId), CATCH_UP_RETRY_MS)) {
      return;
    }

    const throughGatewayActivityNonce = record.gatewayActivityNonce;
    const shouldSurfaceRelayError =
      transfer.transferState.argonReadiness !== undefined &&
      Date.now() - transfer.transferState.argonReadiness.startedAt >=
        this.ethereumClient.getTransferToArgonWaitEstimateMs();
    const upstreamOperatorHost = this.upstreamOperatorClient.operatorHost;
    if (this.serverApiClient) {
      this.#lastCatchUpRequestAt.set(record.transferId, Date.now());
      let localRelayError = '';

      try {
        const relayStatus = await this.serverApiClient.getEthereumRelayStatus();
        if (relayStatus.isReady) {
          const response = await this.serverApiClient.requestEthereumGatewayCatchUp({
            sourceChain: 'Ethereum',
            throughGatewayActivityNonce,
          });
          if (response.outcome !== 'Rejected') {
            transfer.transferState.error = '';
            return;
          }

          localRelayError = response.reason;
        } else {
          localRelayError = relayStatus.reason ?? '';
        }
      } catch (error) {
        console.warn('[EthereumInboundTransferTracker] Local server catch-up request failed', error);
        localRelayError = error instanceof Error ? error.message : String(error);
      }

      if (!upstreamOperatorHost) {
        transfer.transferState.error = shouldSurfaceRelayError ? localRelayError : '';
        return;
      }
    }

    if (upstreamOperatorHost) {
      this.#lastCatchUpRequestAt.set(record.transferId, Date.now());
      try {
        const response = await this.upstreamOperatorClient.requestEthereumGatewayCatchUp({
          sourceChain: 'Ethereum',
          throughGatewayActivityNonce,
        });
        transfer.transferState.error =
          response.outcome === 'Rejected' && shouldSurfaceRelayError ? response.reason : '';
      } catch (error) {
        console.warn('[EthereumInboundTransferTracker] Upstream catch-up request failed', error);
        transfer.transferState.error = shouldSurfaceRelayError
          ? error instanceof Error
            ? error.message
            : String(error)
          : '';
      }
    }
  }

  private discardTransfer(transferId: string, moveToken: IEthereumMoveToken) {
    this.#lastCatchUpRequestAt.delete(transferId);

    if (this.data.latestTransferIdByToken[moveToken] === transferId) {
      delete this.data.latestTransferIdByToken[moveToken];
    }

    delete this.data.transfersById[transferId];
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

function shouldRetry(lastAttemptAt: number | undefined, retryMs: number): boolean {
  return lastAttemptAt == null || Date.now() - lastAttemptAt >= retryMs;
}
