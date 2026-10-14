import { MoveToken, NetworkConfig, SingleFileQueue, bigIntMin } from '@argonprotocol/apps-core';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { nanoid } from 'nanoid';
import { formatEther } from 'viem';
import { getEthereumGatewayPauseReason, getMainchainClient } from '../stores/mainchain.ts';
import type { IArgonWalletType } from '../interfaces/IEthereumInboundTransferTracker.ts';
import type { Db } from './Db.ts';
import {
  EthereumClient,
  EthereumTransactionRevertedError,
  type IEthereumFinalizeTransferOutOfArgonArgs,
  type IEthereumMoveToken,
  getEthereumExecutionRpcUrl,
  loadEthereumChainConfig,
  toArgonAccountIdHex,
  toEvmRecoverableSignature,
  toHexValue,
} from './EthereumClient.ts';
import { getCappedPercent } from './Utils.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import { ExtrinsicType, TransactionStatus } from './db/TransactionsTable.ts';
import {
  CrosschainOutboundTransferStatus,
  type ICrosschainOutboundTransferPatch,
  type ICrosschainOutboundTransferRecord,
} from './db/CrosschainOutboundTransfersTable.ts';
import {
  completeOutboundTransferProgress,
  createCrosschainTransferProgress,
  formatCrosschainBlockStepDetail,
  getOutboundMintingAuthorizationWaitingDetail,
  hydrateCrosschainTransferProgress,
  OUTBOUND_MINTING_AUTHORIZATION_COMPLETE_DETAIL,
  OUTBOUND_MINTING_AUTHORIZATION_SUBMITTING_DETAIL,
  OUTBOUND_TRANSFER_STEP_TITLES,
  setOutboundArgonStepProgress,
  setOutboundEthereumStepProgress,
  setOutboundMintingAuthorizationStepProgress,
  type ICrosschainTransferProgress,
} from './CrosschainTransferProgress.ts';
import { WalletType } from './Wallet.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { MintingAuthorities, IMintingAuthorityAuthorizeMetadata } from './MintingAuthorities.ts';
import { existentialDepositMicrogons, existentialDepositMicronots } from './WalletForArgon.ts';
import { WalletForEthereum } from './WalletForEthereum.ts';
import { CrosschainTransferOut, type CrosschainTransferOutInput } from './txs/CrosschainTransfer.out.ts';

const NETWORK = 'Ethereum';
const ETHEREUM_TRANSACTION_NOT_FOUND_TIMEOUT_MS = 120_000;
export type ICrosschainTransferOutMetadata = {
  actionType: 'transferOutToEthereum';
  localTransferId?: string;
  moveToken: IEthereumMoveToken;
  amount: bigint;
  sourceWalletType: IArgonWalletType;
  destinationAddress: string;
  mortalityBlocks?: number;
};

export type IEthereumOutboundTransferState = {
  isSubmitting: boolean;
  hasPersistedTransfer: boolean;
  needsAttention: boolean;
  isComplete: boolean;
  amount?: bigint;
  sourceWalletType?: IArgonWalletType;
  progress: ICrosschainTransferProgress;
  error: string;
  ethereumFeeEstimateWei?: bigint;
};

export type IEthereumOutboundActiveTransfer = {
  id: string;
  moveToken: IEthereumMoveToken;
  startedAt?: number;
  argonSourceAddress?: string;
  destinationAddress?: string;
  transferState: IEthereumOutboundTransferState;
  persistedRecord?: ICrosschainOutboundTransferRecord;
};

class OutboundTransferChainError extends Error {}

class OutboundTransferBlockedError extends Error {
  constructor(
    message: string,
    public readonly progressDetail: string,
    public readonly progressHint?: string,
  ) {
    super(message);
  }
}

export class EthereumOutboundTransferTracker {
  public data = {
    transfersById: {} as Record<string, IEthereumOutboundActiveTransfer>,
    latestTransferIdByToken: {} as Partial<Record<IEthereumMoveToken, string>>,
  };

  #loadPromise?: Promise<void>;

  #blockSubscription?: VoidFunction;

  #transferQueuesById: Record<string, SingleFileQueue> = {};

  #advancingTransfers = new Map<string, Promise<void>>();

  #advanceRequested = new Set<string>();
  #ethereumPollTimer?: ReturnType<typeof setTimeout>;
  #isStopped = false;

  #argonRequest: CrosschainTransferOut;
  #confirmedAbsentArgonRequests = new Set<number>();

  #pendingArgonProgressByTransferId = new Map<string, { txId: number; unsubscribe: VoidFunction }>();

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly transactionTracker: TransactionTracker,
    private readonly blockWatch: BlockWatch,
    private readonly walletKeys: WalletKeys,
    private readonly ethereumClient: EthereumClient | undefined,
    private readonly mintingAuthorities?: MintingAuthorities,
    private readonly configuredExecutionRpcUrl?: string,
    private readonly ethereumWalletResolver?: (address: string) => Promise<WalletForEthereum | undefined>,
  ) {
    this.#argonRequest = new CrosschainTransferOut(transactionTracker, this);
  }

  public get executionRpcUrl(): string | undefined {
    return getEthereumExecutionRpcUrl(this.configuredExecutionRpcUrl);
  }

  public async load(): Promise<void> {
    if (this.#loadPromise) return this.#loadPromise;

    const loadPromise = this.loadPendingTransfers().catch(error => {
      if (this.#loadPromise === loadPromise) this.#loadPromise = undefined;
      throw error;
    });
    this.#loadPromise = loadPromise;
    return loadPromise;
  }

  public shutdown(): void {
    this.#isStopped = true;
    this.#advanceRequested.clear();
    this.#blockSubscription?.();
    clearTimeout(this.#ethereumPollTimer);
    this.#ethereumPollTimer = undefined;
    for (const { unsubscribe } of this.#pendingArgonProgressByTransferId.values()) unsubscribe();
    this.#pendingArgonProgressByTransferId.clear();
  }

  public async startMove(args: {
    moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
    amount: bigint;
    amountToSpend?: bigint;
    availableAmount?: bigint;
    availableArgonAmount?: bigint;
    sourceWalletType: IArgonWalletType;
    ethereumWallet: WalletForEthereum;
  }): Promise<IEthereumOutboundActiveTransfer | undefined> {
    const {
      moveToken,
      amount,
      amountToSpend,
      availableAmount,
      availableArgonAmount,
      sourceWalletType,
      ethereumWallet,
    } = args;
    if (amountToSpend != null || availableAmount != null || availableArgonAmount != null) {
      const fees = await this.estimateArgonFees({ moveToken, amount, sourceWalletType, ethereumWallet });
      let spentAmount = amount + fees.mintingAuthorityTip;
      let minimumBalance = existentialDepositMicronots;
      if (moveToken === MoveToken.ARGN) {
        spentAmount += fees.transactionFeeMicrogons;
        minimumBalance = existentialDepositMicrogons;
      }

      if (amountToSpend != null && spentAmount > amountToSpend) {
        throw new Error('The Argon network fee changed. Review the amount to send and try again.');
      }
      if (availableAmount != null && spentAmount + minimumBalance > availableAmount) {
        throw new Error(
          `Leave enough ${moveToken} for the transfer, tip, and minimum balance, plus ARGN for the network fee.`,
        );
      }
      if (
        moveToken === MoveToken.ARGNOT &&
        availableArgonAmount != null &&
        fees.transactionFeeMicrogons + existentialDepositMicrogons > availableArgonAmount
      ) {
        throw new Error('Your wallet does not have enough ARGN to pay the network fee.');
      }
    }

    await this.load();

    if (amount <= 0n) {
      return;
    }

    const transferOutUnavailableReason = await this.getTransferOutUnavailableReason();
    if (transferOutUnavailableReason) {
      throw new Error(transferOutUnavailableReason);
    }

    const transfer = this.trackTransfer(nanoid(), moveToken);
    transfer.argonSourceAddress = this.walletKeys.getWalletAddress(sourceWalletType);
    transfer.destinationAddress = ethereumWallet.address;
    this.data.latestTransferIdByToken[moveToken] = transfer.id;
    transfer.transferState = {
      ...createEmptyTransferState(),
      amount,
      sourceWalletType,
      isSubmitting: true,
    };
    transfer.transferState.progress = setOutboundArgonStepProgress(transfer.transferState.progress, {
      progressPct: 0,
      detail: 'Submitting to Argon miners...',
    });

    void (async () => {
      const client = await getMainchainClient(false);
      const txSigner = await this.walletKeys.getWalletKeypair(sourceWalletType);
      await this.#argonRequest.submit({
        client,
        txSigner,
        metadata: {
          actionType: 'transferOutToEthereum',
          localTransferId: transfer.id,
          moveToken,
          amount,
          sourceWalletType,
          destinationAddress: ethereumWallet.address,
          mortalityBlocks: CrosschainTransferOut.mortalityBlocks,
        },
      });
    })().catch(error => this.failTransfer(error, transfer.id, 'Unable to move funds from Argon to Ethereum.'));

    return transfer;
  }

  public async getUnpublishedArgonRequests(
    requests: TransactionInfo<ICrosschainTransferOutMetadata>[],
  ): Promise<TransactionInfo<ICrosschainTransferOutMetadata>[]> {
    const db = await this.dbPromise;
    const records = await db.crosschainOutboundTransfersTable.fetchAll();
    const recordsById = new Map(records.map(record => [record.id, record]));
    const recordsByRequestId = new Map(records.map(record => [record.argonRequestTransactionId, record]));

    return requests.filter(request => {
      const localId = request.tx.metadataJson.localTransferId ?? request.tx.extrinsicHash;
      const record = recordsByRequestId.get(request.tx.id) ?? recordsById.get(localId);
      // Missing rows and historical command links are genuine publication gaps.
      if (!record) return true;
      if (record.status === CrosschainOutboundTransferStatus.RequestPendingSubmission) return true;
      if (record.status !== CrosschainOutboundTransferStatus.RequestSubmittedToArgon) return false;
      if (record.failureReason) return false;
      return true;
    });
  }

  public async onArgonRequestPrepared({ metadata, txSigner }: CrosschainTransferOutInput): Promise<void> {
    const { localTransferId: id, moveToken, amount, destinationAddress } = metadata;
    await this.runInQueueForTransfer(id, async () => {
      const db = await this.dbPromise;
      const record = (await db.crosschainOutboundTransfersTable.upsert({
        id,
        destinationChain: NETWORK,
        token: moveToken,
        amount,
        argonSourceAddress: txSigner.address,
        destinationAddress,
        status: CrosschainOutboundTransferStatus.RequestPendingSubmission,
        progressJson: createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
      }))!;
      this.publishRecord(record);
    });
  }

  public async onArgonRequestSubmitted(
    txInfo: TransactionInfo<ICrosschainTransferOutMetadata>,
    id: string,
    transferId?: string,
  ): Promise<string> {
    const db = await this.dbPromise;
    const provisionalId = id;
    if (transferId) {
      const canonicalRecord = await db.crosschainOutboundTransfersTable.getByTransferId(transferId);
      if (canonicalRecord) id = canonicalRecord.id;
    }

    await this.runInQueueForTransfer(id, async () => {
      let record = await db.crosschainOutboundTransfersTable.get(id);
      if (record) {
        // Older journals have no local ID. Join their command result to the existing transfer.
        const provisionalRecord =
          provisionalId !== id ? await db.crosschainOutboundTransfersTable.get(provisionalId) : undefined;
        const duplicatesRequest =
          provisionalRecord?.status === CrosschainOutboundTransferStatus.RequestSubmittedToArgon &&
          provisionalRecord.argonRequestTransactionId === txInfo.tx.id;
        const currentRequest = this.getArgonRequestTxInfo(record);
        if (currentRequest && currentRequest.tx.id !== txInfo.tx.id) return;
        const pendingSubmission = record.status === CrosschainOutboundTransferStatus.RequestPendingSubmission;
        if (record.argonRequestTransactionId === txInfo.tx.id && !duplicatesRequest && !pendingSubmission) {
          if (this.data.transfersById[id]) this.publishRecord(record);
          return;
        }
        const existingRecord = record;
        record = await db.transaction(async transaction => {
          let canonicalRecord = existingRecord;
          if (canonicalRecord.argonRequestTransactionId !== txInfo.tx.id || pendingSubmission) {
            const patch: ICrosschainOutboundTransferPatch = {
              argonRequestTransactionId: txInfo.tx.id,
            };
            if (pendingSubmission) patch.status = CrosschainOutboundTransferStatus.RequestSubmittedToArgon;
            if (
              pendingSubmission ||
              canonicalRecord.status === CrosschainOutboundTransferStatus.RequestSubmittedToArgon
            ) {
              patch.failureReason = null;
              patch.isFailureAcknowledged = false;
            }
            canonicalRecord = (await transaction.crosschainOutboundTransfersTable.patch(id, patch))!;
          }
          if (duplicatesRequest) await transaction.crosschainOutboundTransfersTable.delete(provisionalId);
          return canonicalRecord;
        });
        if (this.data.transfersById[id]) this.publishRecord(record);
        if (duplicatesRequest) this.discardTransfer(provisionalId, record.token);
        return;
      }

      const { moveToken, amount, sourceWalletType, destinationAddress } = txInfo.tx.metadataJson;
      // The durable command is enough to retain the intent and retry a failed first row write.
      const transfer = this.trackTransfer(id, moveToken);
      transfer.startedAt = txInfo.tx.submittedAtTime.getTime();
      transfer.argonSourceAddress = txInfo.tx.accountAddress;
      transfer.destinationAddress = destinationAddress;
      transfer.transferState.amount = amount;
      transfer.transferState.sourceWalletType = sourceWalletType;
      transfer.transferState.isSubmitting = true;
      const latest = this.getLatestTransfer(moveToken);
      if (
        !latest ||
        hasUnacknowledgedFailure(latest.persistedRecord) ||
        (latest.startedAt ?? 0) <= transfer.startedAt
      ) {
        this.data.latestTransferIdByToken[moveToken] = id;
      }

      record = (await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
        id,
        destinationChain: NETWORK,
        token: moveToken,
        amount,
        argonSourceAddress: transfer.argonSourceAddress,
        destinationAddress,
        argonRequestTransactionId: txInfo.tx.id,
        createdAt: txInfo.tx.submittedAtTime,
        progressJson: createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
      }))!;
      this.publishRecord(record);
    });
    return id;
  }

  public updateArgonRequestProgress(
    txInfo: TransactionInfo<ICrosschainTransferOutMetadata>,
    id: string,
    error?: Error,
  ): void {
    const transfer = this.data.transfersById[id];
    if (transfer?.persistedRecord?.status !== CrosschainOutboundTransferStatus.RequestSubmittedToArgon) return;
    if (this.getArgonRequestTxInfo(transfer.persistedRecord)?.tx.id !== txInfo.tx.id) return;

    const progress = txInfo.getStatus();
    transfer.transferState.progress = setOutboundArgonStepProgress(transfer.transferState.progress, {
      progressPct: Math.max(0, progress.progressPct),
      detail: formatCrosschainBlockStepDetail({
        blockType: 'Argon',
        confirmations: progress.confirmations,
        expectedConfirmations: progress.expectedConfirmations,
      }),
      confirmations: progress.confirmations,
      expectedConfirmations: progress.expectedConfirmations,
    });
    if (error) transfer.transferState.error = error.message;
  }

  public async onArgonRequestFinalized(id: string, transferId: string): Promise<void> {
    const didFinalize = await this.runInQueueForTransfer(id, async () => {
      const transfer = this.data.transfersById[id];
      if (transfer?.persistedRecord?.status !== CrosschainOutboundTransferStatus.RequestSubmittedToArgon) return false;

      const progress = setOutboundMintingAuthorizationStepProgress(
        setOutboundArgonStepProgress(transfer.transferState.progress, { progressPct: 100, detail: 'Argon finalized.' }),
        { progressPct: 0, detail: getOutboundMintingAuthorizationWaitingDetail({ approvalPercent: 0 }) },
      );
      const db = await this.dbPromise;
      const record = (await db.crosschainOutboundTransfersTable.recordRequestFinalizedOnArgon({
        id,
        transferId,
        progressJson: progress,
      }))!;
      this.publishRecord(record);
      if (!this.data.latestTransferIdByToken[record.token]) {
        this.data.latestTransferIdByToken[record.token] = record.id;
      }
      return true;
    });
    if (didFinalize) void this.advanceTransfer(id);
  }

  public async onArgonRequestFailed(
    txInfo: TransactionInfo<ICrosschainTransferOutMetadata>,
    error: unknown,
  ): Promise<void> {
    const existing = Object.values(this.data.transfersById).find(
      transfer => transfer.persistedRecord?.argonRequestTransactionId === txInfo.tx.id,
    );
    const id = existing?.id ?? txInfo.tx.metadataJson.localTransferId ?? txInfo.tx.extrinsicHash;
    await this.runInQueueForTransfer(id, async () => {
      // A rejected subscription may arrive after reconciliation has established canonical success.
      if (txInfo.tx.isFinalized && !txInfo.tx.blockExtrinsicErrorJson) return;
      const transfer = this.data.transfersById[id];
      const record = transfer?.persistedRecord;
      if (record?.status !== CrosschainOutboundTransferStatus.RequestSubmittedToArgon) return;
      if (this.getArgonRequestTxInfo(record)?.tx.id !== txInfo.tx.id) return;
      if (isAcknowledgedFailure(record) && this.hasConfirmedFailedArgonRequest(record)) {
        this.discardTransfer(id, record.token);
        return;
      }
      if (record.failureReason && !this.hasConfirmedFailedArgonRequest(record)) return;
      await this.failTransfer(error, id, 'Unable to finalize the Argon request.');
    });
  }

  private async loadPendingTransfers(): Promise<void> {
    await this.transactionTracker.load();
    await this.blockWatch.start();
    this.subscribeToFinalizedBlocks();
    const db = await this.dbPromise;
    const records = await db.crosschainOutboundTransfersTable.fetchAll();
    for (const record of [...records].reverse()) {
      if (
        record.destinationChain !== NETWORK ||
        record.status === CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain
      )
        continue;
      if (isAcknowledgedFailure(record) && record.status !== CrosschainOutboundTransferStatus.RequestSubmittedToArgon)
        continue;

      this.publishRecord(record);
      if (isAcknowledgedFailure(record)) continue;
      const latest = this.getLatestTransfer(record.token)?.persistedRecord;
      if (
        !latest ||
        record.updatedAt > latest.updatedAt ||
        (record.updatedAt.getTime() === latest.updatedAt.getTime() && record.createdAt > latest.createdAt)
      ) {
        this.data.latestTransferIdByToken[record.token] = record.id;
      }
    }

    await this.#argonRequest.load();

    // No command could have been sent without first writing its native journal.
    for (const transfer of Object.values(this.data.transfersById)) {
      const record = transfer.persistedRecord;
      if (record?.status !== CrosschainOutboundTransferStatus.RequestPendingSubmission) continue;
      if (record.failureReason || this.getArgonRequestTxInfo(record)) continue;
      await this.runInQueueForTransfer(record.id, () =>
        this.failTransfer(new Error('This transfer was not sent. Start a new transfer to try again.'), record.id),
      );
    }
    this.refreshPendingTransfers();
  }

  private subscribeToFinalizedBlocks(): void {
    if (this.#blockSubscription) return;
    this.#blockSubscription = this.blockWatch.events.on('finalized', headers => {
      if (headers.at(-1)) this.refreshPendingTransfers();
    });
  }

  private refreshPendingTransfers(): void {
    if (this.#isStopped) return;

    void this.#argonRequest.load().catch(error => {
      console.warn('[EthereumOutboundTransferTracker] Unable to restore Argon commands; will retry', error);
    });

    // A local timeout still reserves funds until canonical inclusion or mortal-era absence is established.
    const requests = this.transactionTracker.data.txInfos.filter(
      txInfo => txInfo.tx.extrinsicType === ExtrinsicType.CrosschainTransferTransferOut,
    ) as TransactionInfo<ICrosschainTransferOutMetadata>[];

    for (const request of requests) {
      if (request.tx.status !== TransactionStatus.TimedOutWaitingForBlock) continue;
      if (request.tx.metadataJson.actionType !== 'transferOutToEthereum') continue;

      const id = request.tx.metadataJson.localTransferId ?? request.tx.extrinsicHash;
      const record = this.getTransfer(id)?.persistedRecord;
      if (record?.argonRequestTransactionId != null) continue;

      const latestRequest = requests.find(
        candidate => (candidate.tx.metadataJson.localTransferId ?? candidate.tx.extrinsicHash) === id,
      );
      if (latestRequest !== request) continue;

      void this.onArgonRequestSubmitted(request, id)
        .then(canonicalId => this.advanceTransfer(canonicalId))
        .catch(error => {
          console.warn('[EthereumOutboundTransferTracker] Unable to restore the timed-out request; will retry', error);
        });
    }

    for (const transfer of Object.values(this.data.transfersById)) {
      const record = transfer.persistedRecord;
      if (record?.status === CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain) continue;
      if (record?.failureReason && record.status !== CrosschainOutboundTransferStatus.RequestSubmittedToArgon) continue;
      void this.advanceTransfer(transfer.id);
    }
  }

  private scheduleEthereumChecks(): void {
    const transfers = this.getPendingEthereumTransfers();
    if (this.#isStopped || !this.ethereumClient || !transfers.length) {
      clearTimeout(this.#ethereumPollTimer);
      this.#ethereumPollTimer = undefined;
      return;
    }
    if (this.#ethereumPollTimer) return;

    const pollMs = Math.max(1_000, this.ethereumClient.getTransactionFinalityPollMs());
    this.#ethereumPollTimer = setTimeout(() => {
      this.#ethereumPollTimer = undefined;
      for (const transfer of this.getPendingEthereumTransfers()) void this.advanceTransfer(transfer.id);
      this.scheduleEthereumChecks();
    }, pollMs);
    this.#ethereumPollTimer.unref?.();
  }

  /** Keep at most one follow-up check when a new block arrives during an active check. */
  private async advanceTransfer(id: string): Promise<void> {
    if (this.#isStopped) return;
    this.#advanceRequested.add(id);
    const active = this.#advancingTransfers.get(id);
    if (active) return active;

    const advance = (async () => {
      while (this.#advanceRequested.delete(id)) {
        await this.runInQueueForTransfer(id, () => this.runTransferSteps(id));
      }
    })();
    this.#advancingTransfers.set(id, advance);
    try {
      await advance;
    } finally {
      if (this.#advancingTransfers.get(id) === advance) this.#advancingTransfers.delete(id);
      if (this.#advanceRequested.has(id)) void this.advanceTransfer(id);
    }
  }

  private async runTransferSteps(id: string): Promise<void> {
    if (this.#isStopped) return;
    const transfer = this.data.transfersById[id];
    if (!transfer) return;
    let record = transfer.persistedRecord;
    if (!record) return;
    if (record.status === CrosschainOutboundTransferStatus.RequestPendingSubmission) return;
    if (record.status === CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain) return;

    try {
      // Reconcile uncertain native attempts without holding their command's finalization promise in this lane.
      if (record.status === CrosschainOutboundTransferStatus.RequestSubmittedToArgon) {
        await this.reconcileArgonRequest(record);
        return;
      }
      if (record.failureReason || !this.ethereumClient) return;

      // 1. Read current collateral and persist the authorized proof before Ethereum preparation.
      if (record.status === CrosschainOutboundTransferStatus.RequestFinalizedOnArgon) {
        await this.collectMintingAuthorization(transfer, record, this.blockWatch.finalizedBlockHeader);
        record = transfer.persistedRecord!;
      }

      // 2. A definitively missing submitted attempt may return to the signing phase.
      if (record.status === CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain) {
        await this.reconcileDroppedEthereumAttempt(transfer, record);
        record = transfer.persistedRecord!;
      }

      // 3. Save signed identity before broadcast, then observe that exact Ethereum attempt.
      if (record.status === CrosschainOutboundTransferStatus.MintingAuthorized) {
        await this.submitEthereumTransfer(transfer, record);
        record = transfer.persistedRecord!;
      }
      if (record.status === CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain) {
        await this.observeEthereumTransfer(transfer, record);
      }
    } catch (error) {
      if (error instanceof OutboundTransferBlockedError) {
        this.setBlockedTransfer(transfer, error);
      } else if (error instanceof EthereumTransactionRevertedError) {
        await this.failTransfer(error, id);
      } else if (error instanceof OutboundTransferChainError) {
        await this.failTransfer(error, id);
      } else {
        console.warn(
          '[EthereumOutboundTransferTracker] Unable to advance transfer; will retry on the next finalized block',
          error,
        );
      }
    }
  }

  private async reconcileArgonRequest(record: ICrosschainOutboundTransferRecord): Promise<void> {
    const txInfo = this.getArgonRequestTxInfo(record);
    if (!txInfo)
      throw new OutboundTransferChainError(`Transfer ${record.id} is missing its Argon request transaction.`);

    if (txInfo.tx.isFinalized && txInfo.tx.blockExtrinsicErrorJson) {
      if (isAcknowledgedFailure(record)) this.discardTransfer(record.id, record.token);
      else
        await this.failTransfer(
          txInfo.txResult.extrinsicError ?? new Error(txInfo.tx.blockExtrinsicErrorJson.message),
          record.id,
        );
      return;
    }

    if (record.failureReason || txInfo.tx.status === TransactionStatus.TimedOutWaitingForBlock) {
      // Earlier requests used the client's default era, whose longest configured period is 512 blocks.
      const absent = await this.transactionTracker.reconcileUnconfirmedTransaction(
        txInfo,
        txInfo.tx.metadataJson.mortalityBlocks ?? 512,
      );
      if (absent) {
        this.#confirmedAbsentArgonRequests.add(txInfo.tx.id);
        if (!record.failureReason) {
          await this.failTransfer(
            txInfo.txResult.extrinsicError ??
              txInfo.txResult.submissionError ??
              new Error('The Argon request expired before block inclusion.'),
            record.id,
          );
        }
      }
      if (this.hasConfirmedFailedArgonRequest(record)) {
        if (isAcknowledgedFailure(record)) this.discardTransfer(record.id, record.token);
        return;
      }
      if (!txInfo.tx.isFinalized) return;
    }
    this.#argonRequest.resume(txInfo);
  }

  private async collectMintingAuthorization(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
    finalizedHeader: BlockWatch['finalizedBlockHeader'],
  ) {
    transfer.transferState.error = '';
    if (!record.transferId) {
      throw new OutboundTransferChainError(`Transfer ${record.id} is missing its Argon transfer id.`);
    }

    const pendingTxInfo = this.transactionTracker.findLatestTxInfo<ICrosschainTransferOutMetadata>(
      candidate => candidate.tx.id === record.argonRequestTransactionId,
    );
    const minimumReadyBlockNumber = pendingTxInfo?.tx.blockHeight ?? pendingTxInfo?.tx.finalizedHeadHeight;
    if (minimumReadyBlockNumber != null && finalizedHeader.blockNumber < minimumReadyBlockNumber) {
      return;
    }

    if (transfer.transferState.progress.currentStep < 2) {
      transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
        progressPct: 0,
        detail: getOutboundMintingAuthorizationWaitingDetail({ approvalPercent: 0 }),
      });
    }

    const finalizedClient = await this.blockWatch.getApi(finalizedHeader);
    const transferOption = await finalizedClient.query.crosschainTransfer.transferOutById(record.transferId);
    if (!transferOption) {
      throw new OutboundTransferChainError(`Transfer ${record.transferId} is no longer available on Argon.`);
    }

    const chainTransfer = transferOption;
    if (chainTransfer.state.type !== 'Ready') {
      const amount = chainTransfer.amount;
      const totalAttachedCollateral = chainTransfer.totalAttachedCollateral;
      const remainingMintingAuthorizationMicrogons =
        totalAttachedCollateral >= amount ? 0n : amount - totalAttachedCollateral;
      const approvalPercent = getCappedPercent(amount - remainingMintingAuthorizationMicrogons, amount);

      transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
        progressPct: approvalPercent,
        detail: getOutboundMintingAuthorizationWaitingDetail({
          approvalPercent,
        }),
        approvalPercent: Math.round(approvalPercent),
        remainingMintingAuthorizationMicrogons,
      });
      await this.maybeSubmitMintingAuthorization({
        transferId: record.transferId,
        transfer,
        finalizedClient,
        approvalPercent,
        remainingMintingAuthorizationMicrogons,
      });
      return;
    }

    const chainConfigOption = await finalizedClient.query.crosschainTransfer.chainConfigBySourceChain(NETWORK);
    if (!chainConfigOption || chainConfigOption.type !== 'Evm') {
      throw new OutboundTransferChainError('Ethereum transfer gateway is not configured on this network.');
    }
    const evmChainConfig = chainConfigOption.value;

    const authorizations = Object.values(chainTransfer.mintingAuthorityCollateralBySigner).map(collateral => ({
      microgonCollateral: collateral.microgonCollateral,
      micronotCollateral: collateral.micronotCollateral,
      signature: toEvmRecoverableSignature(toHexValue(collateral.signature)),
    }));
    if (!authorizations.length) {
      throw new OutboundTransferChainError(
        `Transfer ${record.transferId} became ready on Argon without any minting-authority signatures.`,
      );
    }

    const finalizeRequest = {
      argonAccountId: toArgonAccountIdHex(chainTransfer.argonAccountId),
      argonTransferNonce: chainTransfer.argonTransferNonce,
      chainId: evmChainConfig.chainId,
      recipient: toHexValue(chainTransfer.destinationAccount),
      validUntilBlock: chainTransfer.validUntilEthereumBlock,
      token: toHexValue(chainTransfer.asset.type === 'Argon' ? evmChainConfig.argonToken : evmChainConfig.argonotToken),
      amount: chainTransfer.amount,
      mintingAuthorityTip: chainTransfer.mintingAuthorityTip,
      microgonsPerArgonot: chainTransfer.microgonsPerArgonot,
    };
    this.clearPendingArgonProgress(record.transferId);
    transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
      progressPct: 100,
      detail: OUTBOUND_MINTING_AUTHORIZATION_COMPLETE_DETAIL,
    });

    transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
      progressPct: 0,
      detail: 'Preparing Ethereum transfer...',
    });
    const db = await this.dbPromise;
    const mintingAuthorizedRecord = (await db.crosschainOutboundTransfersTable.recordMintingAuthorized({
      id: record.id,
      mintingAuthorizationTransactionId: transfer.persistedRecord?.mintingAuthorizationTransactionId,
      mintingAuthorizedMicrogons: sumCollateral(authorizations, 'microgonCollateral'),
      mintingAuthorizedMicronots: sumCollateral(authorizations, 'micronotCollateral'),
      mintingAuthorizedArgonBlockNumber: finalizedHeader.blockNumber,
      mintingAuthorizedArgonBlockHash: finalizedHeader.blockHash,
      finalizeRequestJson: finalizeRequest,
      finalizeProofJson: { authorizations },
      progressJson: transfer.transferState.progress,
    }))!;
    this.publishRecord(mintingAuthorizedRecord);
  }

  private async reconcileDroppedEthereumAttempt(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
  ): Promise<void> {
    if (!record.targetTxHash) return;
    if (Date.now() - record.updatedAt.getTime() < ETHEREUM_TRANSACTION_NOT_FOUND_TIMEOUT_MS) return;

    const ethereumClient = this.requireEthereumClient();
    try {
      if ((await ethereumClient.isTransactionVisible(record.targetTxHash)) !== false) return;
    } catch (error) {
      console.warn(
        `[EthereumOutboundTransferTracker] Unable to verify Ethereum transaction visibility for ${record.id}; continuing to wait for finality`,
        error,
      );
      return;
    }
    // The gateway replay marker covers both delivery and cancellation. Neither should be submitted again.
    if (record.finalizeRequestJson) {
      if (await ethereumClient.isTransferOutOfArgonFinalized(record.finalizeRequestJson)) return;
    }

    const progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
      progressPct: 0,
      detail: 'Preparing Ethereum transfer retry...',
    });
    const db = await this.dbPromise;
    const recordToRetry = (await db.crosschainOutboundTransfersTable.patch(record.id, {
      status: CrosschainOutboundTransferStatus.MintingAuthorized,
      progressJson: progress,
    }))!;
    this.publishRecord(recordToRetry);
  }

  private async submitEthereumTransfer(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
  ): Promise<void> {
    transfer.transferState.error = '';
    const finalizeRequest = record.finalizeRequestJson;
    const finalizeProof = record.finalizeProofJson;
    if (!finalizeRequest || !finalizeProof) {
      throw new OutboundTransferChainError(`Transfer ${record.id} is missing its finalized Ethereum proof payload.`);
    }

    if (!record.targetTxHash) {
      if (!record.transferId)
        throw new OutboundTransferChainError(`Transfer ${record.id} is missing its Argon transfer id.`);
      const finalizedHeader = this.blockWatch.finalizedBlockHeader;
      if (finalizedHeader.blockNumber < (record.mintingAuthorizedArgonBlockNumber ?? 0)) return;
      const finalizedClient = await this.blockWatch.getApi(finalizedHeader);
      const currentRequest = await finalizedClient.query.crosschainTransfer.transferOutById(record.transferId);
      if (!currentRequest) {
        throw new OutboundTransferChainError(`Transfer ${record.transferId} is no longer available on Argon.`);
      }
    }

    const ethereumWallet = await this.getEthereumWalletForAddress(record.destinationAddress);
    transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
      progressPct: 0,
      detail: 'Preparing Ethereum transfer...',
    });
    if (transfer.transferState.ethereumFeeEstimateWei == null) {
      transfer.transferState.ethereumFeeEstimateWei =
        await this.requireEthereumClient().estimateFinalizeTransferOutOfArgonFee({
          request: finalizeRequest,
          proof: finalizeProof,
          ethereumWallet,
        });
    }
    await this.ensureSufficientEthereumFeeBalance(transfer.transferState.ethereumFeeEstimateWei, ethereumWallet);

    transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
      progressPct: 0,
      detail: 'Submitting transfer to Ethereum...',
    });
    await this.requireEthereumClient().finalizeTransferOutOfArgon({
      request: finalizeRequest,
      proof: finalizeProof,
      ethereumWallet,
      beforeBroadcast: async targetTxHash => {
        const progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
          progressPct: 1,
          detail: 'Submitted to Ethereum. Waiting for confirmation...',
        });
        const db = await this.dbPromise;
        const submittedRecord = (await db.crosschainOutboundTransfersTable.recordTransferSubmittedToTargetChain({
          id: record.id,
          targetTxHash,
          progressJson: progress,
        }))!;
        this.publishRecord(submittedRecord);
      },
    });
  }

  private async observeEthereumTransfer(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
  ): Promise<void> {
    if (!record.targetTxHash) {
      throw new OutboundTransferChainError(`Transfer ${record.id} is missing its Ethereum transaction hash.`);
    }
    const targetTxHash = record.targetTxHash;

    // Each scheduled check takes one snapshot, releasing this transfer's lane while it waits for confirmations.
    const txProgress = await this.requireEthereumClient().getTransactionProgress({ txHash: targetTxHash });
    let detail = 'Submitted to Ethereum. Waiting for confirmation...';
    if (txProgress.confirmations >= 0) {
      detail = formatCrosschainBlockStepDetail({
        blockType: 'Ethereum',
        confirmations: txProgress.confirmations,
        expectedConfirmations: txProgress.expectedConfirmations,
      });
    }
    transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
      progressPct: Math.max(1, txProgress.progressPct),
      detail,
      hint: 'You can close this and check back later.',
      confirmations: txProgress.confirmations,
      expectedConfirmations: txProgress.expectedConfirmations,
    });

    if (!txProgress.isFinalized || txProgress.blockNumber == null || !txProgress.blockHash) {
      return;
    }

    const confirmedTarget = await this.requireEthereumClient().confirmTransferOutOfArgon({
      targetTxHash,
      targetBlockNumber: txProgress.blockNumber,
      targetBlockHash: txProgress.blockHash,
      gatewayActivityNonce: record.gatewayActivityNonce,
    });
    if (
      confirmedTarget.targetBlockNumber == null ||
      confirmedTarget.targetBlockHash == null ||
      confirmedTarget.gatewayActivityNonce == null
    ) {
      throw new OutboundTransferChainError(
        `Ethereum transfer ${record.id} was missing finalized receipt details after confirmation.`,
      );
    }

    const db = await this.dbPromise;
    const progress = completeOutboundTransferProgress(transfer.transferState.progress, 'Confirmed on Ethereum.');
    const finalizedRecord = (await db.crosschainOutboundTransfersTable.recordTransferFinalizedOnTargetChain({
      id: record.id,
      targetBlockNumber: confirmedTarget.targetBlockNumber,
      targetBlockHash: confirmedTarget.targetBlockHash,
      gatewayActivityNonce: confirmedTarget.gatewayActivityNonce,
      progressJson: progress,
    }))!;
    this.publishRecord(finalizedRecord);
  }

  public getTransfer(id: string): IEthereumOutboundActiveTransfer | undefined {
    return this.data.transfersById[id];
  }

  public getLatestTransfer(moveToken: IEthereumMoveToken): IEthereumOutboundActiveTransfer | undefined {
    const transferId = this.data.latestTransferIdByToken[moveToken];
    if (!transferId) {
      return;
    }

    return this.getTransfer(transferId);
  }

  public getTransferStateForToken(moveToken: IEthereumMoveToken): IEthereumOutboundTransferState {
    return this.getLatestTransfer(moveToken)?.transferState ?? createEmptyTransferState();
  }

  public getPendingAmount(
    argonSourceAddress: string,
    destinationAddress: string,
    moveToken: IEthereumMoveToken,
  ): bigint {
    return Object.values(this.data.transfersById).reduce((total, transfer) => {
      const record = transfer.persistedRecord;
      if (!record && !transfer.transferState.isSubmitting) return total;
      if (
        record &&
        record.status !== CrosschainOutboundTransferStatus.RequestSubmittedToArgon &&
        record.status !== CrosschainOutboundTransferStatus.RequestPendingSubmission
      )
        return total;
      if (record?.status === CrosschainOutboundTransferStatus.RequestPendingSubmission && record.failureReason)
        return total;
      if (record && this.hasConfirmedFailedArgonRequest(record)) return total;
      const transferArgonSourceAddress = record?.argonSourceAddress ?? transfer.argonSourceAddress;
      const transferDestinationAddress = record?.destinationAddress ?? transfer.destinationAddress;
      return transfer.moveToken === moveToken &&
        transferArgonSourceAddress === argonSourceAddress &&
        transferDestinationAddress?.toLowerCase() === destinationAddress.toLowerCase()
        ? total + (record?.amount ?? transfer.transferState.amount ?? 0n)
        : total;
    }, 0n);
  }

  public hasSignerDependentTransfer(destinationAddress: string): boolean {
    const normalizedAddress = destinationAddress.toLowerCase();
    return Object.values(this.data.transfersById).some(transfer => {
      const record = transfer.persistedRecord;
      const transferDestinationAddress = record?.destinationAddress ?? transfer.destinationAddress;
      if (transferDestinationAddress?.toLowerCase() !== normalizedAddress) return false;
      if (!record) return transfer.transferState.isSubmitting;
      if (record.status === CrosschainOutboundTransferStatus.RequestPendingSubmission) return !record.failureReason;
      return (
        record.status !== CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain &&
        record.status !== CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain &&
        (!isAcknowledgedFailure(record) ||
          (record.status === CrosschainOutboundTransferStatus.RequestSubmittedToArgon &&
            !this.hasConfirmedFailedArgonRequest(record)))
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

    this.discardTransfer(id, transfer.moveToken, transfer.persistedRecord?.transferId);
  }

  public async dismissFailedTransfer(id: string) {
    await this.runInQueueForTransfer(id, async () => {
      const transfer = this.data.transfersById[id];
      if (!transfer?.transferState.needsAttention) return;

      if (hasUnacknowledgedFailure(transfer.persistedRecord)) {
        const db = await this.dbPromise;
        const record = (await db.crosschainOutboundTransfersTable.acknowledgeFailed(id))!;
        this.publishRecord(record);
      }

      if (
        transfer.persistedRecord?.status === CrosschainOutboundTransferStatus.RequestSubmittedToArgon &&
        !this.hasConfirmedFailedArgonRequest(transfer.persistedRecord)
      ) {
        this.recomputeLatestTransfer(transfer.moveToken, id);
        return;
      }

      this.discardTransfer(id, transfer.moveToken, transfer.persistedRecord?.transferId);
    });
  }

  public async getTransferOutUnavailableReason(): Promise<string | undefined> {
    if (!this.ethereumClient || !this.executionRpcUrl) {
      return 'Ethereum transfers are unavailable because an Ethereum execution RPC is not configured.';
    }

    await this.blockWatch.start();
    const client = await getMainchainClient(false);
    const latestExecutionHeaderAnchorHash = await client.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash();
    if (!latestExecutionHeaderAnchorHash) {
      return 'Ethereum state is still syncing. Transfers out will be available once finalized Ethereum state is available on Argon.';
    }

    const latestExecutionHeader = await client.query.ethereumVerifier.executionHeaderAnchors(
      latestExecutionHeaderAnchorHash,
    );
    if (!latestExecutionHeader) {
      return 'Ethereum state is still syncing. Transfers out will be available once finalized Ethereum state is available on Argon.';
    }

    const anchorTimestampMillis = latestExecutionHeader.timestampMillis;
    const currentBlockTimeMillis = BigInt(this.blockWatch.bestBlockHeader.blockTime);
    const ageMillis =
      currentBlockTimeMillis > anchorTimestampMillis ? currentBlockTimeMillis - anchorTimestampMillis : 0n;
    const maxAgeMillis =
      client.consts.crosschainTransfer.maxVerifiedExecutionBlockAgeTicks * BigInt(NetworkConfig.tickMillis);
    if (ageMillis <= maxAgeMillis) {
      return;
    }

    const minuteMillis = 60_000n;
    const ageMinutes = Number((ageMillis + minuteMillis - 1n) / minuteMillis);
    const maxAgeMinutes = Number((maxAgeMillis + minuteMillis - 1n) / minuteMillis);
    return `Ethereum state is still syncing ${ageMinutes} minutes behind. Transfers out will be available once it is within about ${maxAgeMinutes} minutes.`;
  }

  public async estimateFeeRangeWei(args: {
    moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
    amount: bigint;
    ethereumWallet: WalletForEthereum;
  }): Promise<readonly [bigint, bigint] | undefined> {
    const { amount, moveToken } = args;
    if (amount <= 0n) {
      return;
    }
    const ethereumClient = this.ethereumClient;
    if (!ethereumClient) {
      return;
    }

    const chainConfig = await loadEthereumChainConfig(this.configuredExecutionRpcUrl);
    if (!chainConfig) {
      throw new Error('Ethereum gateway chain config is not available on this Argon network.');
    }

    const request = {
      argonAccountId: `0x${'11'.repeat(32)}`,
      argonTransferNonce: 1n,
      chainId: BigInt(chainConfig.chainId),
      microgonsPerArgonot: 1n,
      recipient: args.ethereumWallet.address,
      validUntilBlock: 1_000_000n,
      token: moveToken === MoveToken.ARGNOT ? chainConfig.argonotTokenAddress : chainConfig.argonTokenAddress,
      amount,
      mintingAuthorityTip: amount / 100n,
    } as IEthereumFinalizeTransferOutOfArgonArgs['request'];

    const [lowEstimateWei, highEstimateWei] = await Promise.all(
      [1, 3].map(async authorizationCount => {
        let remainingAmount = amount;

        return await ethereumClient.estimateLikelyFinalizeTransferOutOfArgonFee({
          request,
          proof: {
            authorizations: Array.from({ length: authorizationCount }, (_, index) => {
              const slotsRemaining = BigInt(authorizationCount - index);
              const collateralAmount = remainingAmount / slotsRemaining;
              remainingAmount -= collateralAmount;

              return {
                microgonCollateral: moveToken === MoveToken.ARGN ? collateralAmount : 0n,
                micronotCollateral: moveToken === MoveToken.ARGNOT ? collateralAmount : 0n,
                signature: `0x${'00'.repeat(65)}`,
              };
            }),
          },
        });
      }),
    );

    return [lowEstimateWei, highEstimateWei] as const;
  }

  public async estimateArgonFees(args: {
    moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
    amount: bigint;
    sourceWalletType: IArgonWalletType;
    ethereumWallet: WalletForEthereum;
  }): Promise<{ transactionFeeMicrogons: bigint; mintingAuthorityTip: bigint }> {
    const { amount, moveToken, sourceWalletType, ethereumWallet } = args;
    if (amount <= 0n) {
      return { transactionFeeMicrogons: 0n, mintingAuthorityTip: 0n };
    }

    const client = await getMainchainClient(false);
    const transaction = CrosschainTransferOut.createTransaction(client, {
      moveToken,
      destinationAddress: ethereumWallet.address,
      amount,
    });
    const fee = await transaction.paymentInfo(this.walletKeys.getWalletAddress(sourceWalletType));
    const tipBasisPoints = BigInt(client.consts.crosschainTransfer.transferOutMintingAuthorityTipBasisPoints);

    return {
      transactionFeeMicrogons: fee.partialFee.toBigInt(),
      mintingAuthorityTip: calculateTransferOutMintingAuthorityTip(amount, tipBasisPoints),
    };
  }

  public async quoteTransferOut(args: {
    amount: bigint;
    availableAmount: bigint;
    moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
    sourceWalletType: IArgonWalletType;
    ethereumWallet: WalletForEthereum;
  }): Promise<{
    amountToTransfer: bigint;
    amountToSpend: bigint;
    transactionFeeMicrogons: bigint;
    mintingAuthorityTip: bigint;
  }> {
    const { amount, availableAmount, moveToken, sourceWalletType, ethereumWallet } = args;
    if (amount <= 0n) {
      return { amountToTransfer: 0n, amountToSpend: 0n, transactionFeeMicrogons: 0n, mintingAuthorityTip: 0n };
    }

    const client = await getMainchainClient(false);
    const transaction = CrosschainTransferOut.createTransaction(client, {
      moveToken,
      destinationAddress: ethereumWallet.address,
      amount,
    });
    const fee = await transaction.paymentInfo(this.walletKeys.getWalletAddress(sourceWalletType));
    const transactionFeeMicrogons = fee.partialFee.toBigInt();
    const tipBasisPoints = BigInt(client.consts.crosschainTransfer.transferOutMintingAuthorityTipBasisPoints);
    let transactionFeeInSendToken = 0n;
    let minimumBalance = existentialDepositMicronots;
    if (moveToken === MoveToken.ARGN) {
      transactionFeeInSendToken = transactionFeeMicrogons;
      minimumBalance = existentialDepositMicrogons;
    }

    const availableForTransfer = availableAmount - transactionFeeInSendToken;
    const maximumAmount = calculateMaximumTransferOutAmount(availableForTransfer, tipBasisPoints, minimumBalance);
    const amountToTransfer = bigIntMin(amount, maximumAmount);

    const mintingAuthorityTip = calculateTransferOutMintingAuthorityTip(amountToTransfer, tipBasisPoints);
    const amountToSpend = amountToTransfer + mintingAuthorityTip + transactionFeeInSendToken;
    return {
      amountToTransfer,
      amountToSpend,
      transactionFeeMicrogons,
      mintingAuthorityTip,
    };
  }

  private async maybeSubmitMintingAuthorization(args: {
    transferId: string;
    transfer: IEthereumOutboundActiveTransfer;
    finalizedClient: Awaited<ReturnType<BlockWatch['getApi']>>;
    approvalPercent: number;
    remainingMintingAuthorizationMicrogons?: bigint;
  }) {
    const { transferId, transfer, finalizedClient, approvalPercent, remainingMintingAuthorizationMicrogons } = args;
    if (!this.mintingAuthorities) {
      return;
    }

    const matchesLiveAuthorization = (candidate?: TransactionInfo<IMintingAuthorityAuthorizeMetadata>) => {
      if (!candidate) {
        return false;
      }
      if (candidate.tx.extrinsicType !== ExtrinsicType.CrosschainTransferAuthorize) {
        return false;
      }
      if (candidate.isPostProcessed || candidate.txResult.submissionError || candidate.txResult.extrinsicError) {
        return false;
      }

      const trackedTransferId = transfer.persistedRecord?.mintingAuthorizationTransactionId;
      if (candidate.tx.id === trackedTransferId) {
        return true;
      }

      const isLiveTx =
        candidate.tx.status === TransactionStatus.Submitted ||
        candidate.tx.status === TransactionStatus.InBlock ||
        candidate.tx.status === TransactionStatus.Finalized;
      if (!isLiveTx) {
        return false;
      }

      for (const { transferId: authorizedTransferId } of candidate.tx.metadataJson.authorizations) {
        if (authorizedTransferId === transferId) {
          return true;
        }
      }

      return false;
    };

    let pendingTxInfo = this.mintingAuthorities.data.pendingMintingAuthorizeTxInfosByTransferId.get(
      transferId.toLowerCase(),
    );
    if (!matchesLiveAuthorization(pendingTxInfo)) {
      pendingTxInfo = this.transactionTracker.findLatestTxInfo<IMintingAuthorityAuthorizeMetadata>(candidate =>
        matchesLiveAuthorization(candidate),
      );
    }

    if (pendingTxInfo && matchesLiveAuthorization(pendingTxInfo)) {
      await this.attachPendingArgonProgress({
        transferId,
        transfer,
        txInfo: pendingTxInfo,
        initialDetail: OUTBOUND_MINTING_AUTHORIZATION_SUBMITTING_DETAIL,
      });
      transfer.transferState.error = '';
      return;
    }

    const transferIdLower = transferId.toLowerCase();
    await this.mintingAuthorities.refresh(finalizedClient);

    const ownAuthorityAlreadyAuthorized = this.mintingAuthorities.data.authorities.some(authority =>
      authority.activePendingTransferIds.includes(transferIdLower),
    );
    const displayedApprovalPercent = Math.round(approvalPercent);
    const waitingDetail = getOutboundMintingAuthorizationWaitingDetail({
      approvalPercent,
      isWaitingForRemainingAuthorizations: ownAuthorityAlreadyAuthorized,
    });

    try {
      const txInfo = await this.mintingAuthorities.authorize([transferId]);
      await this.attachPendingArgonProgress({
        transferId,
        transfer,
        txInfo,
        initialDetail: OUTBOUND_MINTING_AUTHORIZATION_SUBMITTING_DETAIL,
      });
      transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
        progressPct: 0,
        detail: OUTBOUND_MINTING_AUTHORIZATION_SUBMITTING_DETAIL,
        remainingMintingAuthorizationMicrogons,
      });
      transfer.transferState.error = '';
    } catch (error) {
      const pendingAuthorization = this.mintingAuthorities.data.pendingMintingAuthorizations.find(
        authorization => authorization.transferId === transferId,
      );

      if (!pendingAuthorization) {
        let relayPauseReason: string | undefined;
        if (this.mintingAuthorities.data.authorities.some(authority => authority.isPendingActivation)) {
          relayPauseReason = await getEthereumGatewayPauseReason(finalizedClient);
        }

        transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
          progressPct: approvalPercent,
          detail: waitingDetail,
          approvalPercent: displayedApprovalPercent,
          remainingMintingAuthorizationMicrogons,
        });
        transfer.transferState.error = relayPauseReason ?? '';
        return;
      }

      transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
        progressPct: approvalPercent,
        detail: waitingDetail,
        approvalPercent: displayedApprovalPercent,
        remainingMintingAuthorizationMicrogons,
      });
      transfer.transferState.error = error instanceof Error ? error.message : 'Unable to submit Minting Authorization.';
      console.warn(
        `[EthereumOutboundTransferTracker] Unable to advance Minting Authorization for ${transferId}`,
        error,
      );
    }
  }

  private async attachPendingArgonProgress(args: {
    transferId: string;
    transfer: IEthereumOutboundActiveTransfer;
    txInfo: TransactionInfo;
    initialDetail: string;
  }) {
    const { transferId, transfer, txInfo, initialDetail } = args;
    const existing = this.#pendingArgonProgressByTransferId.get(transferId);
    if (existing?.txId === txInfo.tx.id) {
      return;
    }

    existing?.unsubscribe();
    this.#pendingArgonProgressByTransferId.delete(transferId);

    const status = txInfo.getStatus();
    transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
      progressPct: Math.max(0, status.progressPct),
      detail: initialDetail,
      confirmations: status.confirmations,
      expectedConfirmations: status.expectedConfirmations,
    });
    if (transfer.persistedRecord) {
      const db = await this.dbPromise;
      const persistedRecord = await db.crosschainOutboundTransfersTable.patch(transfer.persistedRecord.id, {
        mintingAuthorizationTransactionId: txInfo.tx.id,
        progressJson: transfer.transferState.progress,
      });
      if (persistedRecord) {
        transfer.persistedRecord = persistedRecord;
      }
    }

    const unsubscribe = txInfo.subscribeToProgress((progressArgs, error) => {
      if (transfer.persistedRecord?.status !== CrosschainOutboundTransferStatus.RequestFinalizedOnArgon) return;
      transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
        progressPct: progressArgs.progressPct,
        detail: formatCrosschainBlockStepDetail({
          blockType: 'Argon',
          confirmations: progressArgs.confirmations,
          expectedConfirmations: progressArgs.expectedConfirmations,
        }),
        confirmations: progressArgs.confirmations,
        expectedConfirmations: progressArgs.expectedConfirmations,
      });

      if (error) {
        // Minting Authorization progress is reconciled from finalized chain state, so transient tx-level
        // errors here should not replace the transfer's durable status.
        transfer.transferState.error = '';
      }
    });

    this.#pendingArgonProgressByTransferId.set(transferId, { txId: txInfo.tx.id, unsubscribe });

    const clearPendingProgress = () => {
      const tracked = this.#pendingArgonProgressByTransferId.get(transferId);
      if (tracked?.txId !== txInfo.tx.id) {
        return;
      }

      tracked.unsubscribe();
      this.#pendingArgonProgressByTransferId.delete(transferId);
    };

    void txInfo.waitForPostProcessing.then(clearPendingProgress, clearPendingProgress);
  }

  private setBlockedTransfer(transfer: IEthereumOutboundActiveTransfer, error: OutboundTransferBlockedError) {
    const ethereumStep = transfer.transferState.progress.steps[2];
    transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
      progressPct: Math.max(ethereumStep?.progressPct ?? 0, 1),
      detail: error.progressDetail,
      hint: error.progressHint,
      confirmations: ethereumStep?.confirmations,
      expectedConfirmations: ethereumStep?.expectedConfirmations,
    });
    transfer.transferState.error = error.message;
    transfer.transferState.isSubmitting = false;
    transfer.transferState.hasPersistedTransfer = !!transfer.persistedRecord;
    transfer.transferState.needsAttention = false;
    transfer.transferState.isComplete = false;
  }

  private async ensureSufficientEthereumFeeBalance(feeEstimateWei: bigint, ethereumWallet: WalletForEthereum) {
    const ethereumBalanceWei = await this.requireEthereumClient().getNativeBalanceWei(ethereumWallet);
    if (ethereumBalanceWei >= feeEstimateWei) {
      return;
    }

    const missingWei = feeEstimateWei - ethereumBalanceWei;
    throw new OutboundTransferBlockedError(
      `Your Ethereum wallet has ${formatEther(ethereumBalanceWei)} ETH, but this transfer needs about ${formatEther(
        feeEstimateWei,
      )} ETH for network fees. Add about ${formatEther(missingWei)} ETH and retry.`,
      'Waiting for ETH to cover the Ethereum network fee.',
      'This transfer will continue automatically after the wallet is funded.',
    );
  }

  private publishRecord(record: ICrosschainOutboundTransferRecord): IEthereumOutboundActiveTransfer {
    const transfer = this.trackTransfer(record.id, record.token);
    const previousRecord = transfer.persistedRecord;
    const complete = record.status === CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain;
    const acknowledged = isAcknowledgedFailure(record);
    let progress: ICrosschainTransferProgress;
    if (
      previousRecord?.status === record.status &&
      previousRecord.targetTxHash === record.targetTxHash &&
      transfer.transferState.hasPersistedTransfer
    ) {
      progress = transfer.transferState.progress;
    } else {
      progress = createOutboundProgressFromRecord(record);
      if (record.status === CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain) {
        progress = setOutboundEthereumStepProgress(progress, {
          progressPct: Math.max(progress.steps[2]?.progressPct ?? 0, 1),
          detail: 'Submitted to Ethereum. Waiting for confirmation...',
        });
      }
    }
    if (complete) progress = completeOutboundTransferProgress(progress, 'Confirmed on Ethereum.');

    transfer.persistedRecord = record;
    transfer.startedAt = record.createdAt.getTime();
    transfer.argonSourceAddress = record.argonSourceAddress;
    transfer.destinationAddress = record.destinationAddress;
    transfer.transferState = {
      amount: record.amount,
      sourceWalletType: getSourceWalletTypeForAddress(this.walletKeys, record.argonSourceAddress),
      ethereumFeeEstimateWei: transfer.transferState.ethereumFeeEstimateWei,
      isSubmitting: !complete && !record.failureReason,
      hasPersistedTransfer: !complete && !acknowledged,
      needsAttention: hasUnacknowledgedFailure(record),
      isComplete: complete,
      progress,
      error: hasUnacknowledgedFailure(record) ? record.failureReason! : '',
    };
    this.scheduleEthereumChecks();
    return transfer;
  }

  private async failTransfer(error: unknown, id: string, fallbackMessage?: string) {
    const transfer = this.data.transfersById[id];
    if (!transfer) {
      return;
    }
    const errorMessage = error instanceof Error ? error.message : (fallbackMessage ?? String(error));
    if (transfer.persistedRecord?.failureReason === errorMessage) return;

    if (
      !transfer.persistedRecord ||
      transfer.persistedRecord.status === CrosschainOutboundTransferStatus.RequestPendingSubmission
    ) {
      const request = this.transactionTracker.findLatestTxInfo<ICrosschainTransferOutMetadata>(
        candidate =>
          candidate.tx.extrinsicType === ExtrinsicType.CrosschainTransferTransferOut &&
          candidate.tx.metadataJson.localTransferId === id,
      );
      if (request) {
        // The native journal owns the submitted intent even when its outbound-row publication fails.
        transfer.transferState.error = errorMessage;
        console.warn('[EthereumOutboundTransferTracker] Unable to publish the Argon request; will retry', error);
        return;
      }
    }

    if (transfer.persistedRecord) {
      const db = await this.dbPromise;
      const failedRecord = await db.crosschainOutboundTransfersTable.recordFailed({
        id,
        failureReason: errorMessage,
        progressJson: transfer.transferState.progress,
      });
      if (failedRecord) {
        this.publishRecord(failedRecord);
      }
    }

    transfer.transferState.error = errorMessage;
    transfer.transferState.isSubmitting = false;
    transfer.transferState.hasPersistedTransfer = !!transfer.persistedRecord;
    transfer.transferState.needsAttention = true;
    transfer.transferState.isComplete = false;
  }

  private getPendingEthereumTransfers(): IEthereumOutboundActiveTransfer[] {
    return Object.values(this.data.transfersById).filter(({ persistedRecord }) => {
      if (!persistedRecord || persistedRecord.failureReason) return false;
      return (
        persistedRecord.status === CrosschainOutboundTransferStatus.MintingAuthorized ||
        persistedRecord.status === CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain
      );
    });
  }

  /** Serialize command-result publication and background checks for the same transfer. */
  private runInQueueForTransfer<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.#transferQueuesById[id] ??= new SingleFileQueue();
    return this.#transferQueuesById[id].add(work).promise;
  }

  private trackTransfer(id: string, moveToken: IEthereumMoveToken) {
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

  private discardTransfer(id: string, moveToken: IEthereumMoveToken, transferId?: string) {
    this.clearPendingArgonProgress(transferId);

    if (this.data.latestTransferIdByToken[moveToken] === id) {
      this.recomputeLatestTransfer(moveToken, id);
    }

    delete this.data.transfersById[id];
    this.scheduleEthereumChecks();
  }

  private recomputeLatestTransfer(moveToken: IEthereumMoveToken, excludedId?: string) {
    const latest = Object.values(this.data.transfersById)
      .filter(
        transfer =>
          transfer.id !== excludedId &&
          transfer.moveToken === moveToken &&
          !isAcknowledgedFailure(transfer.persistedRecord),
      )
      .sort((a, b) => {
        const aTime = a.persistedRecord?.updatedAt.getTime() ?? a.startedAt ?? 0;
        const bTime = b.persistedRecord?.updatedAt.getTime() ?? b.startedAt ?? 0;
        return bTime - aTime;
      })[0];

    if (latest) this.data.latestTransferIdByToken[moveToken] = latest.id;
    else delete this.data.latestTransferIdByToken[moveToken];
  }

  private hasConfirmedFailedArgonRequest(record: ICrosschainOutboundTransferRecord): boolean {
    const txInfo = this.getArgonRequestTxInfo(record);
    return (
      (!!txInfo?.tx.isFinalized && !!txInfo.tx.blockExtrinsicErrorJson) ||
      (txInfo !== undefined && this.#confirmedAbsentArgonRequests.has(txInfo.tx.id))
    );
  }

  private getArgonRequestTxInfo(record: ICrosschainOutboundTransferRecord) {
    return this.transactionTracker.findLatestTxInfo<ICrosschainTransferOutMetadata>(
      candidate =>
        candidate.tx.extrinsicType === ExtrinsicType.CrosschainTransferTransferOut &&
        (candidate.tx.id === record.argonRequestTransactionId ||
          candidate.tx.metadataJson.localTransferId === record.id),
    );
  }

  private requireEthereumClient(): EthereumClient {
    if (!this.ethereumClient) {
      throw new Error('Ethereum execution RPC is not configured for this app instance.');
    }
    return this.ethereumClient;
  }

  private async getEthereumWalletForAddress(address: string): Promise<WalletForEthereum> {
    const resolvedWallet = await this.ethereumWalletResolver?.(address);
    if (resolvedWallet) return resolvedWallet;

    const db = await this.dbPromise;
    const record = (await db.walletsTable.fetchEthereumWallets()).find(
      wallet => wallet.address.toLowerCase() === address.toLowerCase(),
    );
    if (!record && !this.walletKeys.isCoreEthereumAddress(address)) {
      throw new OutboundTransferBlockedError(
        'The Ethereum wallet needed to finish this transfer is disconnected.',
        'Reconnect the destination Ethereum wallet to continue.',
      );
    }
    return record
      ? new WalletForEthereum(record.address, undefined, record, this.walletKeys.isCoreEthereumWallet(record))
      : new WalletForEthereum(this.walletKeys.coreEthereumAddress, undefined, undefined, true);
  }

  private clearPendingArgonProgress(transferId: string | undefined) {
    if (!transferId) {
      return;
    }

    const tracked = this.#pendingArgonProgressByTransferId.get(transferId);
    tracked?.unsubscribe();
    this.#pendingArgonProgressByTransferId.delete(transferId);
  }
}

function createEmptyTransferState(): IEthereumOutboundTransferState {
  return {
    isSubmitting: false,
    hasPersistedTransfer: false,
    needsAttention: false,
    isComplete: false,
    progress: createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
    error: '',
  };
}

function createOutboundProgressFromRecord(record: ICrosschainOutboundTransferRecord): ICrosschainTransferProgress {
  if (record.progressJson?.steps?.length === OUTBOUND_TRANSFER_STEP_TITLES.length) {
    return hydrateCrosschainTransferProgress(record.progressJson.steps);
  }

  if (record.status === CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain) {
    const progress = createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES);
    return completeOutboundTransferProgress(progress, 'Confirmed on Ethereum.');
  }

  if (
    record.status === CrosschainOutboundTransferStatus.MintingAuthorized ||
    record.status === CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain
  ) {
    return setOutboundEthereumStepProgress(createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES), {
      progressPct: 0,
      detail: record.targetTxHash
        ? 'Submitted to Ethereum. Waiting for confirmation...'
        : 'Preparing Ethereum transfer...',
    });
  }

  if (record.status === CrosschainOutboundTransferStatus.RequestFinalizedOnArgon) {
    return setOutboundMintingAuthorizationStepProgress(
      createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
      {
        progressPct: 0,
        detail: getOutboundMintingAuthorizationWaitingDetail({ approvalPercent: 0 }),
      },
    );
  }

  return setOutboundArgonStepProgress(createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES), {
    progressPct: 0,
    detail: 'Submitting to Argon miners...',
  });
}

function getSourceWalletTypeForAddress(walletKeys: WalletKeys, address: string): IArgonWalletType | undefined {
  if (address === walletKeys.defaultArgonAddress || address === walletKeys.vaultingAddress) return WalletType.argon;
  if (address === walletKeys.miningBotAddress) return WalletType.miningBot;
}

function sumCollateral(
  authorizations: IEthereumFinalizeTransferOutOfArgonArgs['proof']['authorizations'],
  key: 'microgonCollateral' | 'micronotCollateral',
): bigint {
  return authorizations.reduce((total, authorization) => total + authorization[key], 0n);
}

function hasUnacknowledgedFailure(record: ICrosschainOutboundTransferRecord | undefined): boolean {
  return !!record?.failureReason && !record.isFailureAcknowledged;
}

function isAcknowledgedFailure(record: ICrosschainOutboundTransferRecord | undefined): boolean {
  return !!record?.failureReason && record.isFailureAcknowledged;
}

function calculateMaximumTransferOutAmount(
  availableAmount: bigint,
  tipBasisPoints: bigint,
  existentialDeposit: bigint,
) {
  if (availableAmount <= existentialDeposit) {
    return 0n;
  }

  const spendableAmount = availableAmount - existentialDeposit;
  if (tipBasisPoints <= 0n) {
    return spendableAmount;
  }

  const amount = (spendableAmount * 10_000n) / (10_000n + tipBasisPoints);
  const nextAmount = amount + 1n;
  const nextAmountTip = calculateTransferOutMintingAuthorityTip(nextAmount, tipBasisPoints);
  const nextAmountToSpend = nextAmount + nextAmountTip;
  if (nextAmountToSpend <= spendableAmount) {
    return nextAmount;
  }
  return amount;
}

function calculateTransferOutMintingAuthorityTip(amount: bigint, tipBasisPoints: bigint) {
  return (amount * tipBasisPoints) / 10_000n;
}
