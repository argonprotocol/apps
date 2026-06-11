import { MoveToken, NetworkConfig, SingleFileQueue } from '@argonprotocol/apps-core';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { nanoid } from 'nanoid';
import { formatEther } from 'viem';
import { getEthereumGatewayPauseReason, getMainchainClient } from '../stores/mainchain.ts';
import type { IArgonWalletType } from '../interfaces/IEthereumInboundTransferTracker.ts';
import type { Db } from './Db.ts';
import {
  EthereumClient,
  type IEthereumFinalizeTransferOutOfArgonArgs,
  type IEthereumMoveToken,
  getEthereumUserErrorMessage,
  loadEthereumChainConfig,
  toEvmRecoverableSignature,
} from './EthereumClient.ts';
import { getCappedPercent } from './Utils.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import { ExtrinsicType, TransactionStatus } from './db/TransactionsTable.ts';
import {
  CrosschainOutboundTransferStatus,
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

const NETWORK = 'Ethereum';
type IEthereumOutboundTransferClient = Pick<
  EthereumClient,
  | 'estimateFinalizeTransferOutOfArgonFee'
  | 'getNativeBalanceWei'
  | 'finalizeTransferOutOfArgon'
  | 'confirmTransferOutOfArgon'
  | 'getTransactionProgress'
  | 'getTransactionFinalityPollMs'
  | 'waitForTransactionFinality'
> &
  Partial<Pick<EthereumClient, 'estimateLikelyFinalizeTransferOutOfArgonFee'>>;

type ICrosschainTransferOutMetadata = {
  actionType: 'transferOutToEthereum';
  localTransferId: string;
  moveToken: IEthereumMoveToken;
  amount: bigint;
  sourceWalletType: IArgonWalletType;
  destinationAddress: string;
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

  #hasLoadedTransfers = false;
  #loadPromise?: Promise<void>;
  #blockQueue = new SingleFileQueue();
  #blockSubscription?: VoidFunction;
  #resumePromises = new Map<string, Promise<void>>();
  #pendingTransferOutPromises = new Map<string, Promise<void>>();
  #pendingArgonProgressByTransferId = new Map<string, { txId: number; unsubscribe: VoidFunction }>();

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly transactionTracker: TransactionTracker,
    private readonly blockWatch: BlockWatch,
    private readonly walletKeys: WalletKeys,
    private readonly ethereumClient: IEthereumOutboundTransferClient,
    private readonly mintingAuthorities?: Pick<MintingAuthorities, 'data' | 'refresh' | 'authorize'>,
  ) {}

  public async load(): Promise<void> {
    if (this.#loadPromise) {
      return this.#loadPromise;
    }

    this.#loadPromise = this.loadPendingTransfers();
    return this.#loadPromise;
  }

  public getTransfer(id: string): IEthereumOutboundActiveTransfer | undefined {
    const transfer = this.data.transfersById[id];
    if (
      transfer?.persistedRecord &&
      transfer.transferState.hasPersistedTransfer &&
      !transfer.transferState.isSubmitting &&
      !transfer.transferState.needsAttention &&
      !transfer.transferState.error
    ) {
      void this.resumeTrackedTransfer(transfer.persistedRecord);
    }

    return transfer;
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

  public async getTransferOutUnavailableReason(): Promise<string | undefined> {
    await this.blockWatch.start();
    const client = await getMainchainClient(false);
    const latestExecutionHeaderAnchorHash = await client.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash();
    if (latestExecutionHeaderAnchorHash.isNone) {
      return 'Ethereum state is still syncing. Transfers out will be available once finalized Ethereum state is available on Argon.';
    }

    const latestExecutionHeader = await client.query.ethereumVerifier.executionHeaderAnchors(
      latestExecutionHeaderAnchorHash.unwrap().toHex(),
    );
    if (latestExecutionHeader.isNone) {
      return 'Ethereum state is still syncing. Transfers out will be available once finalized Ethereum state is available on Argon.';
    }

    const anchor = latestExecutionHeader.unwrap();
    const anchorTimestampMillis = anchor.timestampMillis.toBigInt();
    const currentBlockTimeMillis = BigInt(this.blockWatch.bestBlockHeader.blockTime);
    const ageMillis =
      currentBlockTimeMillis > anchorTimestampMillis ? currentBlockTimeMillis - anchorTimestampMillis : 0n;
    const maxAgeMillis =
      client.consts.crosschainTransfer.maxVerifiedExecutionBlockAgeTicks.toBigInt() * BigInt(NetworkConfig.tickMillis);
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
  }): Promise<readonly [bigint, bigint] | undefined> {
    const { amount, moveToken } = args;
    if (amount <= 0n) {
      return;
    }
    if (!this.ethereumClient.estimateLikelyFinalizeTransferOutOfArgonFee) {
      return;
    }

    const chainConfig = await loadEthereumChainConfig();
    if (!chainConfig) {
      throw new Error('Ethereum gateway chain config is not available on this Argon network.');
    }

    const request = {
      argonAccountId: `0x${'11'.repeat(32)}`,
      argonTransferNonce: 1n,
      chainId: BigInt(chainConfig.chainId),
      microgonsPerArgonot: 1n,
      recipient: this.walletKeys.ethereumAddress,
      validUntilBlock: 1_000_000n,
      token: moveToken === MoveToken.ARGNOT ? chainConfig.argonotTokenAddress : chainConfig.argonTokenAddress,
      amount,
      mintingAuthorityTip: amount / 100n,
    } as IEthereumFinalizeTransferOutOfArgonArgs['request'];

    const [lowEstimateWei, highEstimateWei] = await Promise.all(
      [1, 3].map(async authorizationCount => {
        let remainingAmount = amount;

        return await this.ethereumClient.estimateLikelyFinalizeTransferOutOfArgonFee!({
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

  public async getMaximumTransferOutAmount(
    availableAmount: bigint,
    moveToken: MoveToken.ARGN | MoveToken.ARGNOT,
  ): Promise<bigint> {
    if (availableAmount <= 0n) {
      return 0n;
    }

    const client = await getMainchainClient(false);
    const tipBasisPoints = BigInt(
      client.consts.crosschainTransfer.transferOutMintingAuthorityTipBasisPoints.toNumber(),
    );
    return calculateMaximumTransferOutAmount(
      availableAmount,
      tipBasisPoints,
      moveToken === MoveToken.ARGNOT ? existentialDepositMicronots : existentialDepositMicrogons,
    );
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
    const transfer = this.data.transfersById[id];
    if (!transfer?.transferState.needsAttention) {
      return;
    }

    if (hasUnacknowledgedFailure(transfer.persistedRecord)) {
      const db = await this.dbPromise;
      transfer.persistedRecord = await db.crosschainOutboundTransfersTable.acknowledgeFailed(id);
    }

    this.discardTransfer(id, transfer.moveToken, transfer.persistedRecord?.transferId);
  }

  public async startMove(args: {
    moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
    amount: bigint;
    availableAmount?: bigint;
    sourceWalletType: IArgonWalletType;
  }): Promise<IEthereumOutboundActiveTransfer | undefined> {
    const { moveToken, amount, availableAmount, sourceWalletType } = args;
    if (availableAmount != null) {
      const maximumAmount = await this.getMaximumTransferOutAmount(availableAmount, moveToken);
      if (amount > maximumAmount) {
        throw new Error(
          `A small ${moveToken} tip is reserved and the account must keep its minimum balance, so you cannot move the full balance.`,
        );
      }
    }

    await this.load();

    const latestTransfer = this.getLatestTransfer(moveToken);
    if (
      latestTransfer &&
      (latestTransfer.transferState.isSubmitting || latestTransfer.transferState.hasPersistedTransfer)
    ) {
      if (!latestTransfer.transferState.isSubmitting && latestTransfer.persistedRecord) {
        void this.resumeTrackedTransfer(latestTransfer.persistedRecord);
      }
      return latestTransfer;
    }

    const db = await this.dbPromise;
    const existingTransfer = await db.crosschainOutboundTransfersTable.getLatestPendingByDestinationChainAndToken(
      NETWORK,
      moveToken,
    );
    if (existingTransfer) {
      void this.resumeTrackedTransfer(existingTransfer);
      return this.getTransfer(existingTransfer.id);
    }

    if (amount <= 0n) {
      return;
    }

    const transferOutUnavailableReason = await this.getTransferOutUnavailableReason();
    if (transferOutUnavailableReason) {
      throw new Error(transferOutUnavailableReason);
    }

    const transfer = this.trackTransfer(nanoid(), moveToken);
    this.data.latestTransferIdByToken[moveToken] = transfer.id;
    transfer.transferState = {
      ...createEmptyTransferState(),
      amount,
      sourceWalletType,
      isSubmitting: true,
      needsAttention: false,
      isComplete: false,
    };
    transfer.transferState.progress = setOutboundArgonStepProgress(transfer.transferState.progress, {
      progressPct: 0,
      detail: 'Submitting to Argon miners...',
    });

    void this.runStartMove({
      amount,
      moveToken,
      sourceWalletType,
      transfer,
    });

    return transfer;
  }

  private trackTransfer(id: string, moveToken: IEthereumMoveToken, markLatest = true) {
    let transfer = this.data.transfersById[id];
    if (!transfer) {
      this.data.transfersById[id] = {
        id,
        moveToken,
        transferState: createEmptyTransferState(),
      };
      transfer = this.data.transfersById[id];
    }

    if (markLatest) {
      this.data.latestTransferIdByToken[moveToken] = id;
    }
    return transfer;
  }

  private async loadPendingTransfers() {
    if (this.#hasLoadedTransfers) {
      return;
    }

    this.#hasLoadedTransfers = true;
    await this.transactionTracker.load();
    await this.blockWatch.start();
    this.subscribeToFinalizedBlocks();

    const db = await this.dbPromise;
    const records = await db.crosschainOutboundTransfersTable.fetchAll();
    for (const record of [...records].reverse()) {
      if (
        record.destinationChain !== NETWORK ||
        record.status === CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain
      ) {
        continue;
      }
      if (isAcknowledgedFailure(record)) {
        continue;
      }
      const transfer = this.trackTransfer(record.id, record.token, false);
      const latestTransferId = this.data.latestTransferIdByToken[record.token];
      const latestRecord = latestTransferId ? this.data.transfersById[latestTransferId]?.persistedRecord : undefined;
      if (
        !latestRecord ||
        record.updatedAt.getTime() > latestRecord.updatedAt.getTime() ||
        (record.updatedAt.getTime() === latestRecord.updatedAt.getTime() &&
          record.createdAt.getTime() > latestRecord.createdAt.getTime())
      ) {
        this.data.latestTransferIdByToken[record.token] = record.id;
      }
      transfer.persistedRecord = record;
      void this.resumeTrackedTransfer(record);
    }

    for (const txInfo of findPendingTransferOutTxInfos(this.transactionTracker.data.txInfos)) {
      const transferId = txInfo.tx.metadataJson.localTransferId ?? txInfo.tx.extrinsicHash;
      const existingRecord = records.find(
        record => record.id === transferId || record.argonRequestTransactionId === txInfo.tx.id,
      );
      if (existingRecord) {
        continue;
      }

      const transfer = this.trackTransfer(transferId, txInfo.tx.metadataJson.moveToken, false);
      const latestTransferId = this.data.latestTransferIdByToken[txInfo.tx.metadataJson.moveToken];
      let latestTransfer = latestTransferId ? this.data.transfersById[latestTransferId] : undefined;
      latestTransfer ??= transfer;
      const latestPersistedRecord = latestTransfer?.persistedRecord;
      const shouldPromotePendingTransfer =
        latestTransfer === transfer ||
        !latestPersistedRecord ||
        hasUnacknowledgedFailure(latestPersistedRecord) ||
        txInfo.tx.submittedAtTime.getTime() >= latestPersistedRecord.createdAt.getTime();
      if (shouldPromotePendingTransfer) {
        this.data.latestTransferIdByToken[txInfo.tx.metadataJson.moveToken] = transfer.id;
      }

      transfer.transferState = {
        ...createEmptyTransferState(),
        amount: txInfo.tx.metadataJson.amount,
        sourceWalletType: txInfo.tx.metadataJson.sourceWalletType,
        isSubmitting: true,
        needsAttention: false,
        isComplete: false,
      };
      transfer.transferState.progress = setOutboundArgonStepProgress(transfer.transferState.progress, {
        progressPct: Math.max(0, txInfo.getStatus().progressPct),
        detail: 'Submitted to Argon miners...',
        confirmations: txInfo.getStatus().confirmations,
        expectedConfirmations: txInfo.getStatus().expectedConfirmations,
      });
      void this.resumePendingTransferOut(txInfo, transfer);
    }
  }

  private async runStartMove(args: {
    amount: bigint;
    moveToken: IEthereumMoveToken;
    sourceWalletType: IArgonWalletType;
    transfer: IEthereumOutboundActiveTransfer;
  }) {
    const { amount, moveToken, sourceWalletType, transfer } = args;

    try {
      const client = await getMainchainClient(false);
      const txInfo = await this.transactionTracker.submitAndWatch({
        tx: client.tx.crosschainTransfer.transferOut(
          NETWORK,
          moveToken === MoveToken.ARGNOT ? 'Argonot' : 'Argon',
          this.walletKeys.ethereumAddress,
          amount,
        ),
        txSigner: await getSourceWalletKeypair(this.walletKeys, sourceWalletType),
        extrinsicType: ExtrinsicType.CrosschainTransferTransferOut,
        metadata: {
          actionType: 'transferOutToEthereum',
          localTransferId: transfer.id,
          moveToken,
          amount,
          sourceWalletType,
          destinationAddress: this.walletKeys.ethereumAddress,
        } satisfies ICrosschainTransferOutMetadata,
        useLatestNonce: true,
      });

      const db = await this.dbPromise;
      const persistedRecord = await db.crosschainOutboundTransfersTable.recordRequestSubmittedToArgon({
        id: transfer.id,
        destinationChain: NETWORK,
        token: moveToken,
        amount,
        argonSourceAddress: getSourceWalletAddress(this.walletKeys, sourceWalletType),
        destinationAddress: this.walletKeys.ethereumAddress,
        argonRequestTransactionId: txInfo.tx.id,
        progressJson: transfer.transferState.progress,
      });
      if (!persistedRecord) {
        throw new Error(`Transfer ${transfer.id} could not be persisted after Argon submission.`);
      }

      transfer.persistedRecord = persistedRecord;
      transfer.transferState.hasPersistedTransfer = true;
      await this.completeTransferOutOnArgon(txInfo, transfer, persistedRecord);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unable to move funds from Argon to Ethereum.';
      await this.failTransfer(
        errorMessage ===
          'Transaction failed due to insufficient funds. Please ensure your account has enough balance to cover the transaction fees.'
          ? `A small ${moveToken} tip is reserved and the account must keep its minimum balance, so you cannot move the full balance.`
          : errorMessage,
        transfer.id,
      );
    }
  }

  private async resumePendingTransferOut(
    txInfo: TransactionInfo<ICrosschainTransferOutMetadata>,
    transfer: IEthereumOutboundActiveTransfer,
  ) {
    const existingResumePromise = this.#pendingTransferOutPromises.get(txInfo.tx.extrinsicHash);
    if (existingResumePromise) {
      return existingResumePromise;
    }

    const resumePromise = this.completeTransferOutOnArgon(txInfo, transfer, transfer.persistedRecord).catch(error =>
      this.failTransfer(error, transfer.id, 'Unable to resume the Argon transfer to Ethereum.'),
    );
    this.#pendingTransferOutPromises.set(txInfo.tx.extrinsicHash, resumePromise);

    try {
      await resumePromise;
    } finally {
      this.#pendingTransferOutPromises.delete(txInfo.tx.extrinsicHash);
    }
  }

  private async completeTransferOutOnArgon(
    txInfo: TransactionInfo<ICrosschainTransferOutMetadata>,
    transfer: IEthereumOutboundActiveTransfer,
    persistedRecord?: ICrosschainOutboundTransferRecord,
  ) {
    const initialStatus = txInfo.getStatus();
    transfer.transferState.progress = setOutboundArgonStepProgress(transfer.transferState.progress, {
      progressPct: Math.max(0, initialStatus.progressPct),
      detail: formatCrosschainBlockStepDetail({
        blockType: 'Argon',
        confirmations: initialStatus.confirmations,
        expectedConfirmations: initialStatus.expectedConfirmations,
      }),
      confirmations: initialStatus.confirmations,
      expectedConfirmations: initialStatus.expectedConfirmations,
    });

    const unsubscribeProgress = txInfo.subscribeToProgress((progressArgs, error) => {
      transfer.transferState.progress = setOutboundArgonStepProgress(transfer.transferState.progress, {
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
        transfer.transferState.error = error.message;
      }
    });

    try {
      await txInfo.txResult.waitForFinalizedBlock;
      const minimumReadyBlockNumber = txInfo.tx.blockHeight ?? txInfo.tx.finalizedHeadHeight;

      await this.transactionTracker.ensureStoredEvents(txInfo);
      const transferId = await extractTransferId(txInfo);
      const argonFinalizedProgress = setOutboundMintingAuthorizationStepProgress(
        setOutboundArgonStepProgress(transfer.transferState.progress, {
          progressPct: 100,
          detail: 'Argon finalized.',
        }),
        {
          progressPct: 0,
          detail: getOutboundMintingAuthorizationWaitingDetail({ approvalPercent: 0 }),
        },
      );
      const db = await this.dbPromise;
      const argonFinalizedRecord = await db.crosschainOutboundTransfersTable.recordRequestFinalizedOnArgon({
        id: transfer.id,
        transferId,
        progressJson: argonFinalizedProgress,
      });
      if (!argonFinalizedRecord) {
        throw new Error(`Transfer ${transfer.id} could not be persisted after Argon finalization.`);
      }

      transfer.persistedRecord = argonFinalizedRecord;
      transfer.transferState.progress = argonFinalizedProgress;
      transfer.transferState.hasPersistedTransfer = true;
      await this.reconcileRequestFinalizedTransfer(
        transfer,
        argonFinalizedRecord,
        this.blockWatch.finalizedBlockHeader,
        minimumReadyBlockNumber,
      );
    } finally {
      unsubscribeProgress();
    }
  }

  private async resumeTrackedTransfer(record: ICrosschainOutboundTransferRecord) {
    const existingResumePromise = this.#resumePromises.get(record.id);
    if (existingResumePromise) {
      return existingResumePromise;
    }

    const resumePromise = this.runResumeTrackedTransfer(record);
    this.#resumePromises.set(record.id, resumePromise);

    try {
      await resumePromise;
    } finally {
      this.#resumePromises.delete(record.id);
    }
  }

  private async runResumeTrackedTransfer(record: ICrosschainOutboundTransferRecord) {
    const transfer = this.trackTransfer(record.id, record.token, false);
    const isComplete = record.status === CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain;
    const isSubmittedToEthereum =
      record.status === CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain && !!record.targetTxHash;
    const hasFailure = hasUnacknowledgedFailure(record) && !isSubmittedToEthereum;
    const shouldDiscardAcknowledgedFailure = isAcknowledgedFailure(record);
    transfer.persistedRecord = record;
    transfer.transferState = {
      ...createEmptyTransferState(),
      amount: record.amount,
      sourceWalletType: getSourceWalletTypeForAddress(this.walletKeys, record.argonSourceAddress),
      ethereumFeeEstimateWei: transfer.transferState.ethereumFeeEstimateWei,
      isSubmitting: !isComplete && !hasFailure && !shouldDiscardAcknowledgedFailure,
      hasPersistedTransfer: !isComplete,
      needsAttention: hasFailure,
      isComplete,
      progress: createOutboundProgressFromRecord(record),
      error: hasFailure ? (record.failureReason ?? '') : '',
    };

    try {
      if (shouldDiscardAcknowledgedFailure) {
        this.discardTransfer(record.id, record.token, record.transferId);
        return;
      }

      if (isComplete) {
        return;
      }

      if (hasFailure) {
        return;
      }

      if (record.status === CrosschainOutboundTransferStatus.RequestSubmittedToArgon) {
        const pendingTxInfo = this.transactionTracker.findLatestTxInfo<ICrosschainTransferOutMetadata>(
          candidate =>
            candidate.tx.id === record.argonRequestTransactionId ||
            candidate.tx.metadataJson.localTransferId === record.id,
        );
        if (!pendingTxInfo) {
          throw new Error(`Transfer ${record.id} is missing its pending Argon transaction.`);
        }

        await this.completeTransferOutOnArgon(pendingTxInfo, transfer, record);
        return;
      }

      await this.reconcilePersistedTransfer(transfer, record, this.blockWatch.finalizedBlockHeader);
    } catch (error) {
      await this.failTransfer(error, record.id, 'Unable to finalize the Ethereum transfer.');
    }
  }

  private async reconcilePersistedTransfer(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
    finalizedHeader: BlockWatch['finalizedBlockHeader'],
  ) {
    if (record.status === CrosschainOutboundTransferStatus.RequestFinalizedOnArgon) {
      await this.reconcileRequestFinalizedTransfer(transfer, record, finalizedHeader);
      return;
    }

    if (
      record.status === CrosschainOutboundTransferStatus.MintingAuthorized ||
      record.status === CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain
    ) {
      await this.reconcileEthereumTransfer(transfer, record);
    }
  }

  private async reconcileRequestFinalizedTransfer(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
    finalizedHeader: BlockWatch['finalizedBlockHeader'],
    minimumReadyBlockNumber?: number,
  ) {
    transfer.transferState.error = '';
    if (!record.transferId) {
      throw new OutboundTransferChainError(`Transfer ${record.id} is missing its Argon transfer id.`);
    }

    if (minimumReadyBlockNumber != null && finalizedHeader.blockNumber < minimumReadyBlockNumber) {
      return;
    }
    if (transfer.transferState.progress.currentStep < 2) {
      transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
        progressPct: 0,
        detail: getOutboundMintingAuthorizationWaitingDetail({ approvalPercent: 0 }),
      });
    }

    let readyTransfer:
      | {
          blockHash: string;
          blockNumber: number;
          mintingAuthorizedMicrogons: bigint;
          mintingAuthorizedMicronots: bigint;
          finalizeArgs: IEthereumFinalizeTransferOutOfArgonArgs;
        }
      | undefined;
    try {
      const finalizedClient = await this.blockWatch.getApi(finalizedHeader);
      const transferOption = await finalizedClient.query.crosschainTransfer.transferOutById(record.transferId);
      if (transferOption.isNone) {
        throw new OutboundTransferChainError(`Transfer ${record.transferId} is no longer available on Argon.`);
      }

      const chainTransfer = transferOption.unwrap();
      if (!chainTransfer.state.isReady) {
        const amount = chainTransfer.amount.toBigInt();
        const totalAttachedCollateral = chainTransfer.totalAttachedCollateral.toBigInt();
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
      if (chainConfigOption.isNone || !chainConfigOption.unwrap().isEvm) {
        throw new OutboundTransferChainError('Ethereum transfer gateway is not configured on this network.');
      }
      const evmChainConfig = chainConfigOption.unwrap().asEvm;

      const authorizations = Array.from(chainTransfer.mintingAuthorityCollateralBySigner.values()).map(collateral => ({
        microgonCollateral: collateral.microgonCollateral.toBigInt(),
        micronotCollateral: collateral.micronotCollateral.toBigInt(),
        signature: toEvmRecoverableSignature(collateral.signature.toHex()),
      }));
      if (!authorizations.length) {
        throw new OutboundTransferChainError(
          `Transfer ${record.transferId} became ready on Argon without any minting-authority signatures.`,
        );
      }

      readyTransfer = {
        blockHash: finalizedHeader.blockHash,
        blockNumber: finalizedHeader.blockNumber,
        mintingAuthorizedMicrogons: sumCollateral(authorizations, 'microgonCollateral'),
        mintingAuthorizedMicronots: sumCollateral(authorizations, 'micronotCollateral'),
        finalizeArgs: {
          request: {
            argonAccountId: chainTransfer.argonAccountId.toHex(),
            argonTransferNonce: chainTransfer.argonTransferNonce.toBigInt(),
            chainId: evmChainConfig.chainId.toBigInt(),
            recipient: chainTransfer.destinationAccount.toHex(),
            validUntilBlock: chainTransfer.validUntilEthereumBlock.toBigInt(),
            token: chainTransfer.asset.isArgon
              ? evmChainConfig.argonToken.toHex()
              : evmChainConfig.argonotToken.toHex(),
            amount: chainTransfer.amount.toBigInt(),
            mintingAuthorityTip: chainTransfer.mintingAuthorityTip.toBigInt(),
            microgonsPerArgonot: chainTransfer.microgonsPerArgonot.toBigInt(),
          },
          proof: { authorizations },
        },
      };
    } catch (error) {
      if (error instanceof OutboundTransferChainError) {
        throw error;
      }

      console.warn(
        `[EthereumOutboundTransferTracker] Unable to refresh finalized transfer state for ${record.transferId}; will retry on the next finalized block`,
        error,
      );
      return;
    }
    if (!readyTransfer) {
      return;
    }

    this.clearPendingArgonProgress(record.transferId);
    transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
      progressPct: 100,
      detail: OUTBOUND_MINTING_AUTHORIZATION_COMPLETE_DETAIL,
    });

    if (transfer.transferState.ethereumFeeEstimateWei == null) {
      transfer.transferState.ethereumFeeEstimateWei = await this.ethereumClient.estimateFinalizeTransferOutOfArgonFee(
        readyTransfer.finalizeArgs,
      );
    }

    transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
      progressPct: 0,
      detail: 'Preparing Ethereum transfer...',
    });
    const db = await this.dbPromise;
    const mintingAuthorizedRecord = (await db.crosschainOutboundTransfersTable.recordMintingAuthorized({
      id: record.id,
      mintingAuthorizationTransactionId: transfer.persistedRecord?.mintingAuthorizationTransactionId,
      mintingAuthorizedMicrogons: readyTransfer.mintingAuthorizedMicrogons,
      mintingAuthorizedMicronots: readyTransfer.mintingAuthorizedMicronots,
      mintingAuthorizedArgonBlockNumber: readyTransfer.blockNumber,
      mintingAuthorizedArgonBlockHash: readyTransfer.blockHash,
      finalizeRequestJson: readyTransfer.finalizeArgs.request,
      finalizeProofJson: readyTransfer.finalizeArgs.proof,
      progressJson: transfer.transferState.progress,
    }))!;
    transfer.persistedRecord = mintingAuthorizedRecord;
    await this.reconcileEthereumTransfer(transfer, mintingAuthorizedRecord);
  }

  private async reconcileEthereumTransfer(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
  ) {
    try {
      await this.finalizeOnEthereum(transfer, record);
    } catch (error) {
      if (error instanceof OutboundTransferBlockedError) {
        this.setBlockedTransfer(transfer, error);
        return;
      }
      if (error instanceof OutboundTransferChainError) {
        throw error;
      }

      console.warn(
        `[EthereumOutboundTransferTracker] Unable to advance Ethereum transfer for ${record.id}; will retry on the next finalized block`,
        error,
      );
    }
  }

  private async finalizeOnEthereum(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
  ) {
    const finalizeRequest = record.finalizeRequestJson;
    const finalizeProof = record.finalizeProofJson;
    if (!finalizeRequest || !finalizeProof) {
      throw new OutboundTransferChainError(`Transfer ${record.id} is missing the finalized Ethereum proof payload.`);
    }

    transfer.transferState.error = '';
    let activeRecord = record;
    if (activeRecord.status === CrosschainOutboundTransferStatus.MintingAuthorized) {
      transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
        progressPct: 0,
        detail: 'Preparing Ethereum transfer...',
      });
      if (transfer.transferState.ethereumFeeEstimateWei == null) {
        try {
          transfer.transferState.ethereumFeeEstimateWei =
            await this.ethereumClient.estimateFinalizeTransferOutOfArgonFee({
              request: finalizeRequest,
              proof: finalizeProof,
            });
        } catch (error) {
          throw new Error(getEthereumUserErrorMessage(error, 'Unable to prepare the Ethereum transfer right now.'));
        }
      }
      await this.ensureSufficientEthereumFeeBalance(transfer.transferState.ethereumFeeEstimateWei);

      transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
        progressPct: 0,
        detail: 'Submitting transfer to Ethereum...',
      });
      const targetTxHash = await this.ethereumClient.finalizeTransferOutOfArgon({
        request: finalizeRequest,
        proof: finalizeProof,
      });
      const db = await this.dbPromise;
      activeRecord = (await db.crosschainOutboundTransfersTable.recordTransferSubmittedToTargetChain({
        id: activeRecord.id,
        targetTxHash,
        progressJson: transfer.transferState.progress,
      }))!;
      transfer.persistedRecord = activeRecord;
    } else {
      transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
        progressPct: Math.max(transfer.transferState.progress.steps[2]?.progressPct ?? 0, 1),
        detail: 'Submitted to Ethereum. Waiting for confirmation...',
      });
    }

    if (!activeRecord.targetTxHash) {
      throw new OutboundTransferChainError(`Transfer ${activeRecord.id} is missing its Ethereum transaction hash.`);
    }
    const targetTxHash = activeRecord.targetTxHash;

    const finalizedProgress = await this.ethereumClient.waitForTransactionFinality({
      txHash: targetTxHash,
      blockNumber: activeRecord.targetBlockNumber,
      blockHash: activeRecord.targetBlockHash,
      onProgress: txProgress => {
        let progressPct = 1;
        let detail = 'Submitted to Ethereum. Waiting for confirmation...';
        let hint: string | undefined;

        if (txProgress.confirmations >= 0) {
          progressPct = Math.max(1, txProgress.progressPct);
          detail = formatCrosschainBlockStepDetail({
            blockType: 'Ethereum',
            confirmations: txProgress.confirmations,
            expectedConfirmations: txProgress.expectedConfirmations,
          });
          hint = 'You can close this and check back later.';
        }

        transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
          progressPct,
          detail,
          hint,
          confirmations: txProgress.confirmations,
          expectedConfirmations: txProgress.expectedConfirmations,
        });
      },
      onRpcDelay: txProgress => {
        transfer.transferState.error = '';
        transfer.transferState.isSubmitting = true;
        transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
          progressPct: Math.max(
            txProgress?.progressPct ?? transfer.transferState.progress.steps[2]?.progressPct ?? 0,
            1,
          ),
          detail: 'Submitted to Ethereum. Waiting for confirmation...',
          hint: 'You can close this and check back later.',
          confirmations: txProgress?.confirmations,
          expectedConfirmations: txProgress?.expectedConfirmations,
        });
      },
    });

    const confirmedTarget = await this.ethereumClient.confirmTransferOutOfArgon({
      targetTxHash,
      targetBlockNumber: finalizedProgress.blockNumber,
      targetBlockHash: finalizedProgress.blockHash,
      gatewayActivityNonce: activeRecord.gatewayActivityNonce,
    });
    if (
      confirmedTarget.targetBlockNumber == null ||
      confirmedTarget.targetBlockHash == null ||
      confirmedTarget.gatewayActivityNonce == null
    ) {
      throw new OutboundTransferChainError(
        `Ethereum transfer ${activeRecord.id} was missing finalized receipt details after confirmation.`,
      );
    }

    const db = await this.dbPromise;
    activeRecord = (await db.crosschainOutboundTransfersTable.recordTransferFinalizedOnTargetChain({
      id: activeRecord.id,
      targetBlockNumber: confirmedTarget.targetBlockNumber,
      targetBlockHash: confirmedTarget.targetBlockHash,
      gatewayActivityNonce: confirmedTarget.gatewayActivityNonce,
      progressJson: transfer.transferState.progress,
    }))!;
    transfer.persistedRecord = activeRecord;

    transfer.transferState.progress = completeOutboundTransferProgress(
      transfer.transferState.progress,
      'Confirmed on Ethereum.',
    );
    transfer.transferState.isSubmitting = false;
    transfer.transferState.hasPersistedTransfer = false;
    transfer.transferState.needsAttention = false;
    transfer.transferState.isComplete = true;
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

  private async ensureSufficientEthereumFeeBalance(feeEstimateWei: bigint) {
    const ethereumBalanceWei = await this.ethereumClient.getNativeBalanceWei();
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

    let pendingTxInfo = this.mintingAuthorities.data.pendingMintingAuthorizeTxInfosByTransferId.get(transferId);
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
      const txInfo = await this.mintingAuthorities.authorize(transferId);
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
        const relayPauseReason = this.mintingAuthorities.data.authorities.some(
          authority => authority.isPendingActivation,
        )
          ? await getEthereumGatewayPauseReason(finalizedClient)
          : undefined;

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

    void txInfo.waitForPostProcessing.finally(() => {
      const tracked = this.#pendingArgonProgressByTransferId.get(transferId);
      if (tracked?.txId !== txInfo.tx.id) {
        return;
      }

      tracked.unsubscribe();
      this.#pendingArgonProgressByTransferId.delete(transferId);
    });
  }

  private async failTransfer(error: unknown, id: string, fallbackMessage?: string) {
    const transfer = this.data.transfersById[id];
    if (!transfer) {
      return;
    }
    const errorMessage = error instanceof Error ? error.message : (fallbackMessage ?? String(error));

    if (
      transfer.persistedRecord?.status === CrosschainOutboundTransferStatus.TransferSubmittedToTargetChain &&
      transfer.persistedRecord.targetTxHash
    ) {
      transfer.transferState.error = '';
      transfer.transferState.isSubmitting = true;
      transfer.transferState.hasPersistedTransfer = true;
      transfer.transferState.needsAttention = false;
      transfer.transferState.isComplete = false;
      transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
        progressPct: Math.max(transfer.transferState.progress.steps[2]?.progressPct ?? 0, 1),
        detail: 'Submitted to Ethereum. Waiting for confirmation...',
        hint: 'We will keep checking in the background.',
      });
      return;
    }

    if (transfer.persistedRecord) {
      const db = await this.dbPromise;
      const failedRecord = await db.crosschainOutboundTransfersTable.recordFailed({
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

  private discardTransfer(id: string, moveToken: IEthereumMoveToken, transferId?: string) {
    this.clearPendingArgonProgress(transferId);

    if (this.data.latestTransferIdByToken[moveToken] === id) {
      delete this.data.latestTransferIdByToken[moveToken];
    }

    delete this.data.transfersById[id];
  }

  private clearPendingArgonProgress(transferId: string | undefined) {
    if (!transferId) {
      return;
    }

    const tracked = this.#pendingArgonProgressByTransferId.get(transferId);
    tracked?.unsubscribe();
    this.#pendingArgonProgressByTransferId.delete(transferId);
  }

  private subscribeToFinalizedBlocks() {
    if (this.#blockSubscription) {
      return;
    }

    this.#blockSubscription = this.blockWatch.events.on('finalized', headers => {
      if (!headers.at(-1)) {
        return;
      }

      void this.#blockQueue.add(() => this.reconcileTransfersAtFinalizedHeader(), {
        timeoutMs: 120e3,
      });
    });
  }

  private async reconcileTransfersAtFinalizedHeader() {
    for (const transfer of Object.values(this.data.transfersById)) {
      const record = transfer.persistedRecord;
      if (
        !record ||
        record.status === CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain ||
        record.status === CrosschainOutboundTransferStatus.RequestSubmittedToArgon
      ) {
        continue;
      }
      if (hasUnacknowledgedFailure(record)) {
        continue;
      }
      if (isAcknowledgedFailure(record)) {
        continue;
      }

      try {
        await this.reconcilePersistedTransfer(transfer, record, this.blockWatch.finalizedBlockHeader);
      } catch (error) {
        await this.failTransfer(error, record.id, 'Unable to refresh the Ethereum transfer state.');
      }
    }
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

async function extractTransferId(txInfo: TransactionInfo<ICrosschainTransferOutMetadata>) {
  const client = await getMainchainClient(false);
  await txInfo.txResult.waitForInFirstBlock;

  for (const event of txInfo.txResult.events) {
    if (!client.events.crosschainTransfer.TransferOutStarted.is(event)) {
      continue;
    }

    return event.data.transferId.toHex();
  }

  throw new Error('TransferOutStarted event not found in transaction events.');
}

function getSourceWalletAddress(walletKeys: WalletKeys, sourceWalletType: IArgonWalletType) {
  switch (sourceWalletType) {
    case WalletType.investment:
      return walletKeys.investmentAddress;
    case WalletType.miningHold:
      return walletKeys.miningHoldAddress;
    case WalletType.vaulting:
      return walletKeys.vaultingAddress;
  }
}

async function getSourceWalletKeypair(walletKeys: WalletKeys, sourceWalletType: IArgonWalletType) {
  return await walletKeys.getWalletKeypair(sourceWalletType);
}

function getSourceWalletTypeForAddress(
  walletKeys: WalletKeys,
  argonSourceAddress: string,
): IArgonWalletType | undefined {
  if (argonSourceAddress === walletKeys.investmentAddress) {
    return WalletType.investment;
  }
  if (argonSourceAddress === walletKeys.miningHoldAddress) {
    return WalletType.miningHold;
  }
  if (argonSourceAddress === walletKeys.vaultingAddress) {
    return WalletType.vaulting;
  }
}

function findPendingTransferOutTxInfos(txInfos: TransactionInfo[]) {
  return txInfos.filter(txInfo => {
    const metadata = txInfo.tx.metadataJson as ICrosschainTransferOutMetadata;
    return (
      txInfo.tx.extrinsicType === ExtrinsicType.CrosschainTransferTransferOut &&
      metadata.actionType === 'transferOutToEthereum' &&
      (txInfo.tx.status === TransactionStatus.Submitted || txInfo.tx.status === TransactionStatus.InBlock) &&
      !txInfo.txResult.submissionError
    );
  }) as TransactionInfo<ICrosschainTransferOutMetadata>[];
}

function sumCollateral(
  authorizations: IEthereumFinalizeTransferOutOfArgonArgs['proof']['authorizations'],
  key: 'microgonCollateral' | 'micronotCollateral',
): bigint {
  if (key === 'microgonCollateral') {
    return authorizations.reduce((total, authorization) => total + authorization.microgonCollateral, 0n);
  }

  return authorizations.reduce((total, authorization) => total + authorization.micronotCollateral, 0n);
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
  const spendableAmount = availableAmount > existentialDeposit ? availableAmount - existentialDeposit : 0n;
  if (tipBasisPoints <= 0n) {
    return spendableAmount;
  }

  let amount = (spendableAmount * 10_000n) / (10_000n + tipBasisPoints);
  while (amount > 0n && amount + calculateTransferOutMintingAuthorityTip(amount, tipBasisPoints) > spendableAmount) {
    amount -= 1n;
  }
  return amount;
}

function calculateTransferOutMintingAuthorityTip(amount: bigint, tipBasisPoints: bigint) {
  return (amount * tipBasisPoints) / 10_000n;
}
