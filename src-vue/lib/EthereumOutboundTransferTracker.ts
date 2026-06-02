import { MoveToken, NetworkConfig } from '@argonprotocol/apps-core';
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
  hydrateCrosschainTransferProgress,
  OUTBOUND_TRANSFER_STEP_TITLES,
  setOutboundArgonStepProgress,
  setOutboundEthereumStepProgress,
  setOutboundMintingAuthorizationStepProgress,
  type ICrosschainTransferProgress,
} from './CrosschainTransferProgress.ts';
import { WalletType } from './Wallet.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { MintingAuthorities, IMintingAuthorityAuthorizeMetadata } from './MintingAuthorities.ts';

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
  needsAcknowledgement: boolean;
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

export class EthereumOutboundTransferTracker {
  public data = {
    transfersById: {} as Record<string, IEthereumOutboundActiveTransfer>,
    latestTransferIdByToken: {} as Partial<Record<IEthereumMoveToken, string>>,
  };

  #hasLoadedTransfers = false;
  #loadPromise?: Promise<void>;
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
      !transfer.transferState.needsAcknowledgement
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

  public clearCompletedTransfer(id: string) {
    const transfer = this.data.transfersById[id];
    if (!transfer) {
      return;
    }

    if (transfer.transferState.isSubmitting || transfer.transferState.hasPersistedTransfer) {
      return;
    }

    this.discardTransfer(id, transfer.moveToken, transfer.persistedRecord?.transferId);
  }

  public async acknowledgeFailedTransfer(id: string) {
    const transfer = this.data.transfersById[id];
    if (!transfer?.transferState.needsAcknowledgement) {
      return;
    }

    if (hasUnacknowledgedFailure(transfer.persistedRecord)) {
      const db = await this.dbPromise;
      transfer.persistedRecord = await db.crosschainOutboundTransfersTable.acknowledgeFailed(id);
    }

    this.discardTransfer(id, transfer.moveToken, transfer.persistedRecord?.transferId);
  }

  public async retryFailedTransfer(id: string) {
    const transfer = this.data.transfersById[id];
    if (!transfer?.persistedRecord || !hasUnacknowledgedFailure(transfer.persistedRecord)) {
      return transfer;
    }

    const db = await this.dbPromise;
    const retriedRecord = await db.crosschainOutboundTransfersTable.patch(id, {
      failureReason: null,
      isFailureAcknowledged: false,
    });
    if (!retriedRecord) {
      return transfer;
    }

    transfer.persistedRecord = retriedRecord;
    transfer.transferState.error = '';
    transfer.transferState.isSubmitting = true;
    transfer.transferState.hasPersistedTransfer = true;
    transfer.transferState.needsAcknowledgement = false;
    void this.resumeTrackedTransfer(retriedRecord);
    return transfer;
  }

  public async startMove(args: {
    moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
    amount: bigint;
    sourceWalletType: IArgonWalletType;
  }): Promise<IEthereumOutboundActiveTransfer | undefined> {
    const { moveToken, amount, sourceWalletType } = args;
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
      needsAcknowledgement: false,
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

    const db = await this.dbPromise;
    const records = await db.crosschainOutboundTransfersTable.fetchAll();
    for (const record of [...records].reverse()) {
      if (
        record.destinationChain !== NETWORK ||
        record.status === CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain ||
        isAcknowledgedFailure(record)
      ) {
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
      const existingRecord = await (
        await this.dbPromise
      ).crosschainOutboundTransfersTable.getLatestPendingByDestinationChainAndToken(
        NETWORK,
        txInfo.tx.metadataJson.moveToken,
      );
      if (existingRecord) {
        continue;
      }

      const transfer = this.trackTransfer(
        txInfo.tx.metadataJson.localTransferId ?? txInfo.tx.extrinsicHash,
        txInfo.tx.metadataJson.moveToken,
      );
      transfer.transferState = {
        ...createEmptyTransferState(),
        amount: txInfo.tx.metadataJson.amount,
        sourceWalletType: txInfo.tx.metadataJson.sourceWalletType,
        isSubmitting: true,
        needsAcknowledgement: false,
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
      await this.failTransfer(
        transfer.id,
        error instanceof Error ? error.message : 'Unable to move funds from Argon to Ethereum.',
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
      this.failTransfer(
        transfer.id,
        error instanceof Error ? error.message : 'Unable to resume the Argon transfer to Ethereum.',
      ),
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
          detail: 'Waiting for Minting Authorization (0% authorized)',
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
      await this.completeRequestFinalizedTransfer(transfer, argonFinalizedRecord, minimumReadyBlockNumber);
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
    const hasFailure = hasUnacknowledgedFailure(record);
    transfer.persistedRecord = record;
    transfer.transferState = {
      ...createEmptyTransferState(),
      amount: record.amount,
      sourceWalletType: getSourceWalletTypeForAddress(this.walletKeys, record.argonSourceAddress),
      ethereumFeeEstimateWei: transfer.transferState.ethereumFeeEstimateWei,
      isSubmitting: !isComplete && !hasFailure,
      hasPersistedTransfer: !isComplete,
      needsAcknowledgement: hasFailure,
      progress: createOutboundProgressFromRecord(record),
      error: record.failureReason ?? '',
    };

    try {
      if (isAcknowledgedFailure(record)) {
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

      if (record.status === CrosschainOutboundTransferStatus.RequestFinalizedOnArgon) {
        await this.completeRequestFinalizedTransfer(transfer, record);
        return;
      }

      await this.finalizeOnEthereum(transfer, record);
    } catch (error) {
      await this.failTransfer(
        record.id,
        error instanceof Error ? error.message : 'Unable to finalize the Ethereum transfer.',
      );
    }
  }

  private async completeRequestFinalizedTransfer(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
    minimumReadyBlockNumber?: number,
  ) {
    transfer.transferState.error = '';
    if (!record.transferId) {
      throw new Error(`Transfer ${record.id} is missing its Argon transfer id.`);
    }

    transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
      progressPct: 0,
      detail: 'Waiting for Minting Authorization (0% authorized)',
    });
    const readyTransfer = await waitForReadyTransfer(
      record.transferId,
      this.blockWatch,
      async finalizedHeader => {
        await this.tryAutoAuthorizeTransfer(record.transferId!, transfer, finalizedHeader);
      },
      minimumReadyBlockNumber,
    );
    transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
      progressPct: 100,
      detail: 'Minting Authorization complete.',
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
    await this.finalizeOnEthereum(transfer, mintingAuthorizedRecord);
  }

  private async finalizeOnEthereum(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
  ) {
    const finalizeRequest = record.finalizeRequestJson;
    const finalizeProof = record.finalizeProofJson;
    if (!finalizeRequest || !finalizeProof) {
      throw new Error(`Transfer ${record.id} is missing the finalized Ethereum proof payload.`);
    }

    transfer.transferState.error = '';
    transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
      progressPct: 0,
      detail: 'Preparing Ethereum transfer...',
    });
    if (transfer.transferState.ethereumFeeEstimateWei == null) {
      transfer.transferState.ethereumFeeEstimateWei = await this.ethereumClient.estimateFinalizeTransferOutOfArgonFee({
        request: finalizeRequest,
        proof: finalizeProof,
      });
    }
    await this.ensureSufficientEthereumFeeBalance(transfer.transferState.ethereumFeeEstimateWei);

    let activeRecord = record;
    if (activeRecord.status === CrosschainOutboundTransferStatus.MintingAuthorized) {
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
    }

    if (!activeRecord.targetTxHash) {
      throw new Error(`Transfer ${activeRecord.id} is missing its Ethereum transaction hash.`);
    }
    const targetTxHash = activeRecord.targetTxHash;

    const finalizedProgress = await this.ethereumClient.waitForTransactionFinality({
      txHash: targetTxHash,
      blockNumber: activeRecord.targetBlockNumber,
      blockHash: activeRecord.targetBlockHash,
      onProgress: txProgress => {
        transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
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
        transfer.transferState.error = '';
        transfer.transferState.isSubmitting = true;
        transfer.transferState.progress = setOutboundEthereumStepProgress(transfer.transferState.progress, {
          progressPct: Math.max(
            txProgress?.progressPct ?? transfer.transferState.progress.steps[2]?.progressPct ?? 0,
            1,
          ),
          detail: 'Submitted to Ethereum. Waiting for the RPC to confirm the transfer...',
          hint: 'We will keep checking in the background.',
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
      throw new Error(`Ethereum transfer ${activeRecord.id} was missing finalized receipt details after confirmation.`);
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
    transfer.transferState.needsAcknowledgement = false;
  }

  private async ensureSufficientEthereumFeeBalance(feeEstimateWei: bigint) {
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

  private async tryAutoAuthorizeTransfer(
    transferId: string,
    transfer: IEthereumOutboundActiveTransfer,
    finalizedHeader: BlockWatch['finalizedBlockHeader'],
  ) {
    if (!this.mintingAuthorities) {
      return;
    }

    const matchesPendingAuthorization = (candidate?: TransactionInfo<IMintingAuthorityAuthorizeMetadata>) => {
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
    if (!matchesPendingAuthorization(pendingTxInfo)) {
      pendingTxInfo = this.transactionTracker.findLatestTxInfo<IMintingAuthorityAuthorizeMetadata>(candidate =>
        matchesPendingAuthorization(candidate),
      );
    }

    if (pendingTxInfo && matchesPendingAuthorization(pendingTxInfo)) {
      await this.attachPendingArgonProgress({
        transferId,
        transfer,
        txInfo: pendingTxInfo,
        initialDetail: 'Submitting Minting Authorization to Argon...',
      });
      transfer.transferState.error = '';
      return;
    }

    const finalizedClient = await this.blockWatch.getApi(finalizedHeader);
    await this.mintingAuthorities.refresh(finalizedClient);
    const transferIdLower = transferId.toLowerCase();
    const remainingMintingAuthorizationMicrogons = (
      await finalizedClient.query.crosschainTransfer.pendingCollateralizationRequestsByChain(NETWORK)
    )
      .find(request => request.transferId.toHex().toLowerCase() === transferIdLower)
      ?.remainingCollateral.toBigInt();
    const ownAuthorityAlreadyAuthorized = this.mintingAuthorities.data.authorities.some(authority =>
      authority.activePendingTransferIds.includes(transferIdLower),
    );
    const ownAuthorityPendingActivation = this.mintingAuthorities.data.authorities.some(
      authority => authority.isPendingActivation,
    );

    try {
      const txInfo = await this.mintingAuthorities.authorize(transferId);
      await this.attachPendingArgonProgress({
        transferId,
        transfer,
        txInfo,
        initialDetail: 'Submitting Minting Authorization to Argon...',
      });
      transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
        progressPct: 0,
        detail: 'Submitting Minting Authorization to Argon...',
        remainingMintingAuthorizationMicrogons,
      });
      transfer.transferState.error = '';

      if (!txInfo.isPostProcessed) {
        void txInfo.waitForPostProcessing.finally(() => {
          if (transfer.transferState.hasPersistedTransfer) {
            void this.tryAutoAuthorizeTransfer(transferId, transfer, this.blockWatch.finalizedBlockHeader);
          }
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Transfer ${transferId} is not currently available to authorize.`
      ) {
        const relayPauseReason = ownAuthorityPendingActivation
          ? await getEthereumGatewayPauseReason(finalizedClient)
          : undefined;
        let detail = 'Waiting for Minting Authorization (0% authorized)';
        let approvalPercent = 0;
        if (remainingMintingAuthorizationMicrogons != null && transfer.transferState.amount) {
          const authorizedMicrogons = transfer.transferState.amount - remainingMintingAuthorizationMicrogons;
          approvalPercent = getCappedPercent(authorizedMicrogons, transfer.transferState.amount);
          detail = `Waiting for Minting Authorization (${approvalPercent}% authorized)`;
        }
        if (ownAuthorityAlreadyAuthorized) {
          detail = detail.replace('Waiting for', 'Waiting for the remaining');
        }

        transfer.transferState.progress = setOutboundMintingAuthorizationStepProgress(transfer.transferState.progress, {
          progressPct: approvalPercent,
          detail,
          approvalPercent,
          remainingMintingAuthorizationMicrogons,
        });
        transfer.transferState.error = relayPauseReason ?? '';
        return;
      }

      console.warn(
        `[EthereumOutboundTransferTracker] Unable to auto-submit Minting Authorization for ${transferId}`,
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
        if (isTransferAlreadyFullyCoveredError(error)) {
          transfer.transferState.error = '';
          return;
        }
        transfer.transferState.error = error.message;
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

  private async failTransfer(id: string, errorMessage: string) {
    const transfer = this.data.transfersById[id];
    if (!transfer) {
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
    transfer.transferState.needsAcknowledgement = true;
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
}

function createEmptyTransferState(): IEthereumOutboundTransferState {
  return {
    isSubmitting: false,
    hasPersistedTransfer: false,
    needsAcknowledgement: false,
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
        detail: 'Waiting for Minting Authorization (0% authorized)',
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

function isTransferAlreadyFullyCoveredError(error: Error) {
  return error.message.includes('cannot accept more collateral because it is already fully covered');
}

async function waitForReadyTransfer(
  transferId: string,
  blockWatch: BlockWatch,
  onAwaitingMintingAuthorization?: (finalizedHeader: BlockWatch['finalizedBlockHeader']) => Promise<void>,
  minimumBlockNumber?: number,
): Promise<{
  blockHash: string;
  blockNumber: number;
  mintingAuthorizedMicrogons: bigint;
  mintingAuthorizedMicronots: bigint;
  finalizeArgs: IEthereumFinalizeTransferOutOfArgonArgs;
}> {
  await blockWatch.start();
  if (minimumBlockNumber == null || blockWatch.finalizedBlockHeader.blockNumber >= minimumBlockNumber) {
    await onAwaitingMintingAuthorization?.(blockWatch.finalizedBlockHeader);
    const readyTransfer = await readReadyTransferAtHeader(transferId, blockWatch, blockWatch.finalizedBlockHeader);
    if (readyTransfer) {
      return readyTransfer;
    }
  }

  return await new Promise((resolve, reject) => {
    let lastSeenBlockHash = blockWatch.finalizedBlockHeader.blockHash;
    let isChecking = false;

    const unsubscribe = blockWatch.events.on('finalized', headers => {
      const latestHeader = headers.at(-1);
      if (
        !latestHeader ||
        latestHeader.blockHash === lastSeenBlockHash ||
        isChecking ||
        (minimumBlockNumber != null && latestHeader.blockNumber < minimumBlockNumber)
      ) {
        return;
      }

      lastSeenBlockHash = latestHeader.blockHash;
      isChecking = true;

      void Promise.resolve(onAwaitingMintingAuthorization?.(latestHeader))
        .then(() => readReadyTransferAtHeader(transferId, blockWatch, latestHeader))
        .then(ready => {
          if (!ready) {
            return;
          }

          unsubscribe();
          resolve(ready);
        })
        .catch(error => {
          unsubscribe();
          reject(error);
        })
        .finally(() => {
          isChecking = false;
        });
    });
  });
}

async function readReadyTransferAtHeader(
  transferId: string,
  blockWatch: BlockWatch,
  finalizedHeader: BlockWatch['finalizedBlockHeader'],
): Promise<
  | {
      blockHash: string;
      blockNumber: number;
      mintingAuthorizedMicrogons: bigint;
      mintingAuthorizedMicronots: bigint;
      finalizeArgs: IEthereumFinalizeTransferOutOfArgonArgs;
    }
  | undefined
> {
  const finalizedClient = await blockWatch.getApi(finalizedHeader);
  const transferOption = await finalizedClient.query.crosschainTransfer.transferOutById(transferId);
  if (transferOption.isNone) {
    throw new Error(`Transfer ${transferId} is no longer available on Argon.`);
  }

  const transfer = transferOption.unwrap();
  if (!transfer.state.isReady) {
    return;
  }

  const chainConfigOption = await finalizedClient.query.crosschainTransfer.chainConfigBySourceChain(NETWORK);
  if (chainConfigOption.isNone || !chainConfigOption.unwrap().isEvm) {
    throw new Error('Ethereum transfer gateway is not configured on this network.');
  }
  const evmChainConfig = chainConfigOption.unwrap().asEvm;

  const authorizations = Array.from(transfer.mintingAuthorityCollateralBySigner.values()).map(collateral => ({
    microgonCollateral: collateral.microgonCollateral.toBigInt(),
    micronotCollateral: collateral.micronotCollateral.toBigInt(),
    signature: toEvmRecoverableSignature(collateral.signature.toHex()),
  }));
  if (!authorizations.length) {
    throw new Error(`Transfer ${transferId} became ready on Argon without any minting-authority signatures.`);
  }

  const request: IEthereumFinalizeTransferOutOfArgonArgs['request'] = {
    argonAccountId: transfer.argonAccountId.toHex(),
    argonTransferNonce: transfer.argonTransferNonce.toBigInt(),
    chainId: evmChainConfig.chainId.toBigInt(),
    recipient: transfer.destinationAccount.toHex(),
    validUntilBlock: transfer.validUntilEthereumBlock.toBigInt(),
    token: transfer.asset.isArgon ? evmChainConfig.argonToken.toHex() : evmChainConfig.argonotToken.toHex(),
    amount: transfer.amount.toBigInt(),
    mintingAuthorityTip: transfer.mintingAuthorityTip.toBigInt(),
    microgonsPerArgonot: transfer.microgonsPerArgonot.toBigInt(),
  };

  return {
    blockHash: finalizedHeader.blockHash,
    blockNumber: finalizedHeader.blockNumber,
    mintingAuthorizedMicrogons: sumCollateral(authorizations, 'microgonCollateral'),
    mintingAuthorizedMicronots: sumCollateral(authorizations, 'micronotCollateral'),
    finalizeArgs: {
      request,
      proof: { authorizations },
    },
  };
}
