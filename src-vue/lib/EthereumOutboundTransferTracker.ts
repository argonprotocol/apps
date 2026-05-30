import { MoveToken } from '@argonprotocol/apps-core';
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
import { TransactionInfo } from './TransactionInfo.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import { ExtrinsicType, TransactionStatus } from './db/TransactionsTable.ts';
import {
  CrosschainOutboundTransferStatus,
  type ICrosschainOutboundTransferRecord,
} from './db/CrosschainOutboundTransfersTable.ts';
import { WalletType } from './Wallet.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { MintingAuthorities } from './MintingAuthorities.ts';

const NETWORK = 'Ethereum';

type IEthereumOutboundTransferClient = Pick<
  EthereumClient,
  | 'estimateFinalizeTransferOutOfArgonFee'
  | 'getNativeBalanceWei'
  | 'finalizeTransferOutOfArgon'
  | 'confirmTransferOutOfArgon'
> &
  Partial<Pick<EthereumClient, 'estimateLikelyFinalizeTransferOutOfArgonFee'>>;

type ICrosschainTransferOutMetadata = {
  actionType: 'transferOutToEthereum';
  moveToken: IEthereumMoveToken;
  amount: bigint;
  sourceWalletType: IArgonWalletType;
  destinationAddress: string;
};

export type IEthereumOutboundTransferState = {
  isSubmitting: boolean;
  hasPersistedTransfer: boolean;
  isCollateralizingOnArgon: boolean;
  awaitingCollateralizationLabel?: string;
  remainingCollateralMicrogons?: bigint;
  amount?: bigint;
  sourceWalletType?: IArgonWalletType;
  phase:
    | 'idle'
    | 'preparing'
    | 'confirmingArgon'
    | 'awaitingCollateralization'
    | 'confirmingEthereum'
    | 'confirmedOnEthereum';
  error: string;
  ethereumFeeEstimateWei?: bigint;
};

export type IEthereumOutboundActiveTransfer = {
  transferId: string;
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

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly transactionTracker: TransactionTracker,
    private readonly blockWatch: BlockWatch,
    private readonly walletKeys: WalletKeys,
    private readonly ethereumClient: IEthereumOutboundTransferClient,
    private readonly mintingAuthorities?: Pick<MintingAuthorities, 'data' | 'refresh' | 'collateralize'>,
  ) {}

  public async load(): Promise<void> {
    if (this.#loadPromise) {
      return this.#loadPromise;
    }

    this.#loadPromise = this.loadPendingTransfers();
    return this.#loadPromise;
  }

  public getTransfer(transferId: string): IEthereumOutboundActiveTransfer | undefined {
    const transfer = this.data.transfersById[transferId];
    if (
      transfer?.persistedRecord &&
      transfer.transferState.hasPersistedTransfer &&
      !transfer.transferState.isSubmitting
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

  public clearCompletedTransfer(transferId: string) {
    const transfer = this.data.transfersById[transferId];
    if (!transfer) {
      return;
    }

    if (transfer.transferState.isSubmitting || transfer.transferState.hasPersistedTransfer) {
      return;
    }

    if (this.data.latestTransferIdByToken[transfer.moveToken] === transferId) {
      delete this.data.latestTransferIdByToken[transfer.moveToken];
    }
    delete this.data.transfersById[transferId];
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
      return this.getTransfer(existingTransfer.transferId);
    }

    if (amount <= 0n) {
      return;
    }

    const transfer = this.trackTransfer(nanoid(), moveToken);
    this.data.latestTransferIdByToken[moveToken] = transfer.transferId;
    transfer.transferState = {
      ...createEmptyTransferState(),
      amount,
      sourceWalletType,
      isSubmitting: true,
      phase: 'preparing',
    };

    void this.runStartMove({
      amount,
      moveToken,
      sourceWalletType,
      transfer,
    });

    return transfer;
  }

  public async startTransfer(args: {
    transferId: string;
    moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
    finalizeRequest: IEthereumFinalizeTransferOutOfArgonArgs['request'];
    collateralizedArgonBlockNumber?: number;
    collateralizedArgonBlockHash?: string;
    authorizations: IEthereumFinalizeTransferOutOfArgonArgs['proof']['authorizations'];
  }): Promise<IEthereumOutboundActiveTransfer> {
    await this.load();

    const db = await this.dbPromise;
    const finalizeArgs = {
      request: args.finalizeRequest,
      proof: { authorizations: args.authorizations },
    } satisfies IEthereumFinalizeTransferOutOfArgonArgs;

    const existingTransfer = await db.crosschainOutboundTransfersTable.get(args.transferId);
    if (existingTransfer) {
      const persistedRecord =
        existingTransfer.status === CrosschainOutboundTransferStatus.RequestFinalizedOnArgon
          ? await db.crosschainOutboundTransfersTable.recordCollateralized({
              transferId: existingTransfer.transferId,
              collateralizedMicrogons: sumCollateral(args.authorizations, 'microgonCollateral'),
              collateralizedMicronots: sumCollateral(args.authorizations, 'micronotCollateral'),
              collateralizedArgonBlockNumber: args.collateralizedArgonBlockNumber,
              collateralizedArgonBlockHash: args.collateralizedArgonBlockHash,
              finalizeRequestJson: finalizeArgs.request,
              finalizeProofJson: finalizeArgs.proof,
            })
          : existingTransfer;
      void this.resumeTrackedTransfer(persistedRecord ?? existingTransfer);
      return this.trackTransfer(existingTransfer.transferId, existingTransfer.token);
    }

    const requestFinalizedRecord = await db.crosschainOutboundTransfersTable.insertRequestFinalizedOnArgon({
      transferId: args.transferId,
      destinationChain: NETWORK,
      token: args.moveToken,
      amount: args.finalizeRequest.amount,
      argonSourceAddress: args.finalizeRequest.argonAccountId,
      destinationAddress: args.finalizeRequest.recipient,
    });
    if (!requestFinalizedRecord) {
      throw new Error(`Transfer ${args.transferId} could not be persisted before Ethereum finalization.`);
    }

    const persistedRecord = await db.crosschainOutboundTransfersTable.recordCollateralized({
      transferId: requestFinalizedRecord.transferId,
      collateralizedMicrogons: sumCollateral(args.authorizations, 'microgonCollateral'),
      collateralizedMicronots: sumCollateral(args.authorizations, 'micronotCollateral'),
      collateralizedArgonBlockNumber: args.collateralizedArgonBlockNumber,
      collateralizedArgonBlockHash: args.collateralizedArgonBlockHash,
      finalizeRequestJson: finalizeArgs.request,
      finalizeProofJson: finalizeArgs.proof,
    });
    if (!persistedRecord) {
      throw new Error(`Transfer ${args.transferId} could not be updated after collateralization.`);
    }

    const transfer = this.trackTransfer(persistedRecord.transferId, persistedRecord.token);
    transfer.persistedRecord = persistedRecord;
    transfer.transferState = {
      ...transfer.transferState,
      amount: persistedRecord.amount,
      sourceWalletType: getSourceWalletTypeForAddress(this.walletKeys, persistedRecord.argonSourceAddress),
      isSubmitting: true,
      hasPersistedTransfer: true,
      phase: 'confirmingEthereum',
    };

    if (transfer.transferState.ethereumFeeEstimateWei == null) {
      transfer.transferState.ethereumFeeEstimateWei =
        await this.ethereumClient.estimateFinalizeTransferOutOfArgonFee(finalizeArgs);
    }

    void this.resumeTrackedTransfer(persistedRecord);
    return transfer;
  }

  private trackTransfer(transferId: string, moveToken: IEthereumMoveToken, markLatest = true) {
    let transfer = this.data.transfersById[transferId];
    if (!transfer) {
      this.data.transfersById[transferId] = {
        transferId,
        moveToken,
        transferState: createEmptyTransferState(),
      };
      transfer = this.data.transfersById[transferId];
    }

    if (markLatest) {
      this.data.latestTransferIdByToken[moveToken] = transferId;
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

    const records = await (await this.dbPromise).crosschainOutboundTransfersTable.fetchAll();
    for (const record of [...records].reverse()) {
      if (record.destinationChain !== NETWORK || record.status === CrosschainOutboundTransferStatus.TargetFinalized) {
        continue;
      }

      const transfer = this.trackTransfer(record.transferId, record.token, false);
      const latestTransferId = this.data.latestTransferIdByToken[record.token];
      const latestRecord = latestTransferId ? this.data.transfersById[latestTransferId]?.persistedRecord : undefined;
      if (
        !latestRecord ||
        record.updatedAt.getTime() > latestRecord.updatedAt.getTime() ||
        (record.updatedAt.getTime() === latestRecord.updatedAt.getTime() &&
          record.createdAt.getTime() > latestRecord.createdAt.getTime())
      ) {
        this.data.latestTransferIdByToken[record.token] = record.transferId;
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

      const transfer = this.trackTransfer(txInfo.tx.extrinsicHash, txInfo.tx.metadataJson.moveToken);
      transfer.transferState = {
        ...createEmptyTransferState(),
        amount: txInfo.tx.metadataJson.amount,
        sourceWalletType: txInfo.tx.metadataJson.sourceWalletType,
        isSubmitting: true,
        phase: 'confirmingArgon',
      };
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
          moveToken,
          amount,
          sourceWalletType,
          destinationAddress: this.walletKeys.ethereumAddress,
        } satisfies ICrosschainTransferOutMetadata,
        useLatestNonce: true,
      });

      transfer.transferState.phase = 'confirmingArgon';
      await this.completeTransferOutOnArgon(txInfo, transfer);
    } catch (error) {
      transfer.transferState.error =
        error instanceof Error ? error.message : 'Unable to move funds from Argon to Ethereum.';
      transfer.transferState.isSubmitting = false;
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

    const resumePromise = this.completeTransferOutOnArgon(txInfo, transfer).catch(error => {
      transfer.transferState.error =
        error instanceof Error ? error.message : 'Unable to resume the Argon transfer to Ethereum.';
      transfer.transferState.isSubmitting = false;
    });
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
  ) {
    await txInfo.txResult.waitForFinalizedBlock;
    const minimumReadyBlockNumber = txInfo.tx.blockHeight ?? txInfo.tx.finalizedHeadHeight;

    await this.transactionTracker.ensureStoredEvents(txInfo);
    const transferId = await extractTransferId(txInfo);
    const priorTransferId = transfer.transferId;
    const requestFinalizedRecord = await (
      await this.dbPromise
    ).crosschainOutboundTransfersTable.insertRequestFinalizedOnArgon({
      transferId,
      destinationChain: NETWORK,
      token: txInfo.tx.metadataJson.moveToken,
      amount: txInfo.tx.metadataJson.amount,
      argonSourceAddress: getSourceWalletAddress(this.walletKeys, txInfo.tx.metadataJson.sourceWalletType),
      destinationAddress: txInfo.tx.metadataJson.destinationAddress,
    });
    if (!requestFinalizedRecord) {
      throw new Error(`Transfer ${transferId} could not be persisted after Argon finalization.`);
    }

    transfer.transferId = transferId;
    this.data.transfersById[transferId] = transfer;
    this.data.latestTransferIdByToken[transfer.moveToken] = transferId;
    if (priorTransferId !== transferId) {
      delete this.data.transfersById[priorTransferId];
    }
    transfer.persistedRecord = requestFinalizedRecord;
    transfer.transferState.hasPersistedTransfer = true;
    transfer.transferState.phase = 'awaitingCollateralization';

    await this.completeRequestFinalizedTransfer(transfer, requestFinalizedRecord, minimumReadyBlockNumber);
  }

  private async resumeTrackedTransfer(record: ICrosschainOutboundTransferRecord) {
    const existingResumePromise = this.#resumePromises.get(record.transferId);
    if (existingResumePromise) {
      return existingResumePromise;
    }

    const resumePromise = this.runResumeTrackedTransfer(record);
    this.#resumePromises.set(record.transferId, resumePromise);

    try {
      await resumePromise;
    } finally {
      this.#resumePromises.delete(record.transferId);
    }
  }

  private async runResumeTrackedTransfer(record: ICrosschainOutboundTransferRecord) {
    const transfer = this.trackTransfer(record.transferId, record.token, false);
    const isComplete = record.status === CrosschainOutboundTransferStatus.TargetFinalized;
    transfer.persistedRecord = record;
    transfer.transferState = {
      ...createEmptyTransferState(),
      amount: record.amount,
      sourceWalletType: getSourceWalletTypeForAddress(this.walletKeys, record.argonSourceAddress),
      ethereumFeeEstimateWei: transfer.transferState.ethereumFeeEstimateWei,
      isSubmitting: !isComplete,
      hasPersistedTransfer: !isComplete,
      phase: getTransferPhase(record.status),
      error: '',
    };

    try {
      if (isComplete) {
        return;
      }

      if (record.status === CrosschainOutboundTransferStatus.RequestFinalizedOnArgon) {
        await this.completeRequestFinalizedTransfer(transfer, record);
        return;
      }

      await this.finalizeOnEthereum(transfer, record);
    } catch (error) {
      transfer.transferState.error =
        error instanceof Error ? error.message : 'Unable to finalize the Ethereum transfer.';
      transfer.transferState.isSubmitting = false;
    }
  }

  private async completeRequestFinalizedTransfer(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
    minimumReadyBlockNumber?: number,
  ) {
    transfer.transferState.phase = 'awaitingCollateralization';
    transfer.transferState.awaitingCollateralizationLabel = undefined;
    transfer.transferState.remainingCollateralMicrogons = undefined;
    transfer.transferState.error = '';
    const readyTransfer = await waitForReadyTransfer(
      record.transferId,
      this.blockWatch,
      async finalizedHeader => {
        await this.tryAutoCollateralizeTransfer(record.transferId, transfer, finalizedHeader);
      },
      minimumReadyBlockNumber,
    );
    transfer.transferState.isCollateralizingOnArgon = false;
    transfer.transferState.awaitingCollateralizationLabel = undefined;
    transfer.transferState.remainingCollateralMicrogons = undefined;

    if (transfer.transferState.ethereumFeeEstimateWei == null) {
      transfer.transferState.ethereumFeeEstimateWei = await this.ethereumClient.estimateFinalizeTransferOutOfArgonFee(
        readyTransfer.finalizeArgs,
      );
    }

    const collateralizedRecord = (await (
      await this.dbPromise
    ).crosschainOutboundTransfersTable.recordCollateralized({
      transferId: record.transferId,
      collateralizedMicrogons: readyTransfer.collateralizedMicrogons,
      collateralizedMicronots: readyTransfer.collateralizedMicronots,
      collateralizedArgonBlockNumber: readyTransfer.blockNumber,
      collateralizedArgonBlockHash: readyTransfer.blockHash,
      finalizeRequestJson: readyTransfer.finalizeArgs.request,
      finalizeProofJson: readyTransfer.finalizeArgs.proof,
    }))!;
    transfer.persistedRecord = collateralizedRecord;
    await this.finalizeOnEthereum(transfer, collateralizedRecord);
  }

  private async finalizeOnEthereum(
    transfer: IEthereumOutboundActiveTransfer,
    record: ICrosschainOutboundTransferRecord,
  ) {
    const finalizeRequest = record.finalizeRequestJson;
    const finalizeProof = record.finalizeProofJson;
    if (!finalizeRequest || !finalizeProof) {
      throw new Error(`Transfer ${record.transferId} is missing the finalized Ethereum proof payload.`);
    }

    transfer.transferState.phase = 'confirmingEthereum';
    if (transfer.transferState.ethereumFeeEstimateWei == null) {
      transfer.transferState.ethereumFeeEstimateWei = await this.ethereumClient.estimateFinalizeTransferOutOfArgonFee({
        request: finalizeRequest,
        proof: finalizeProof,
      });
    }
    await this.ensureSufficientEthereumFeeBalance(transfer.transferState.ethereumFeeEstimateWei);

    let activeRecord = record;
    if (activeRecord.status === CrosschainOutboundTransferStatus.Collateralized) {
      const targetTxHash = await this.ethereumClient.finalizeTransferOutOfArgon({
        request: finalizeRequest,
        proof: finalizeProof,
      });
      activeRecord = (await (
        await this.dbPromise
      ).crosschainOutboundTransfersTable.recordTargetSubmitted({
        transferId: activeRecord.transferId,
        targetTxHash,
      }))!;
      transfer.persistedRecord = activeRecord;
    }

    if (
      activeRecord.status === CrosschainOutboundTransferStatus.TargetSubmitted ||
      activeRecord.targetBlockNumber == null ||
      activeRecord.gatewayActivityNonce == null
    ) {
      const confirmedTarget = await this.ethereumClient.confirmTransferOutOfArgon({
        targetTxHash: activeRecord.targetTxHash!,
        targetBlockNumber: activeRecord.targetBlockNumber,
        targetBlockHash: activeRecord.targetBlockHash,
        gatewayActivityNonce: activeRecord.gatewayActivityNonce,
      });
      if (
        confirmedTarget.targetBlockNumber == null ||
        confirmedTarget.targetBlockHash == null ||
        confirmedTarget.gatewayActivityNonce == null
      ) {
        throw new Error(
          `Ethereum transfer ${activeRecord.transferId} was missing finalized receipt details after confirmation.`,
        );
      }

      activeRecord = (await (
        await this.dbPromise
      ).crosschainOutboundTransfersTable.recordTargetFinalized({
        transferId: activeRecord.transferId,
        targetBlockNumber: confirmedTarget.targetBlockNumber,
        targetBlockHash: confirmedTarget.targetBlockHash,
        gatewayActivityNonce: confirmedTarget.gatewayActivityNonce,
      }))!;
      transfer.persistedRecord = activeRecord;
    }

    transfer.transferState.phase = 'confirmedOnEthereum';
    transfer.transferState.isSubmitting = false;
    transfer.transferState.hasPersistedTransfer = false;
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

  private async tryAutoCollateralizeTransfer(
    transferId: string,
    transfer: IEthereumOutboundActiveTransfer,
    finalizedHeader: BlockWatch['finalizedBlockHeader'],
  ) {
    if (!this.mintingAuthorities) {
      return;
    }

    const pendingTxInfo = this.mintingAuthorities.data.pendingCollateralizeTxInfosByTransferId.get(transferId);
    if (pendingTxInfo?.tx.metadataJson.collateralizations.some(x => x.transferId === transferId)) {
      transfer.transferState.isCollateralizingOnArgon = !pendingTxInfo.isPostProcessed;
      transfer.transferState.awaitingCollateralizationLabel = undefined;
      transfer.transferState.error = '';
      return;
    }

    const finalizedClient = await this.blockWatch.getApi(finalizedHeader);
    await this.mintingAuthorities.refresh(finalizedClient);
    const transferIdLower = transferId.toLowerCase();
    const remainingCollateralMicrogons = (
      await finalizedClient.query.crosschainTransfer.pendingCollateralizationRequestsByChain(NETWORK)
    )
      .find(request => request.transferId.toHex().toLowerCase() === transferIdLower)
      ?.remainingCollateral.toBigInt();
    const ownAuthorityAlreadyCollateralized = this.mintingAuthorities.data.authorities.some(authority =>
      authority.activePendingTransferIds.includes(transferIdLower),
    );
    const ownAuthorityPendingActivation = this.mintingAuthorities.data.authorities.some(
      authority => authority.isPendingActivation,
    );

    try {
      const txInfo = await this.mintingAuthorities.collateralize(transferId);
      transfer.transferState.isCollateralizingOnArgon = !txInfo.isPostProcessed;
      transfer.transferState.awaitingCollateralizationLabel = undefined;
      transfer.transferState.remainingCollateralMicrogons = remainingCollateralMicrogons;
      transfer.transferState.error = '';

      if (!txInfo.isPostProcessed) {
        void txInfo.waitForPostProcessing.finally(() => {
          const activeTransfer = this.data.transfersById[transferId];
          if (activeTransfer?.transferState.phase === 'awaitingCollateralization') {
            activeTransfer.transferState.isCollateralizingOnArgon = false;
            void this.tryAutoCollateralizeTransfer(transferId, activeTransfer, this.blockWatch.finalizedBlockHeader);
          }
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Transfer ${transferId} is not currently available to collateralize.`
      ) {
        const relayPauseReason = ownAuthorityPendingActivation
          ? await getEthereumGatewayPauseReason(finalizedClient)
          : undefined;
        let awaitingCollateralizationLabel =
          'Waiting for a minting authority to collateralize this transfer on Argon...';
        if (ownAuthorityAlreadyCollateralized) {
          awaitingCollateralizationLabel =
            'Waiting for another minting authority to add the remaining collateral on Argon...';
        }

        transfer.transferState.isCollateralizingOnArgon = false;
        transfer.transferState.remainingCollateralMicrogons = remainingCollateralMicrogons;
        transfer.transferState.error = relayPauseReason ?? '';
        transfer.transferState.awaitingCollateralizationLabel = awaitingCollateralizationLabel;
        return;
      }

      console.warn(`[EthereumOutboundTransferTracker] Unable to auto-collateralize transfer ${transferId}`, error);
      transfer.transferState.isCollateralizingOnArgon = false;
    }
  }
}

function createEmptyTransferState(): IEthereumOutboundTransferState {
  return {
    isSubmitting: false,
    hasPersistedTransfer: false,
    isCollateralizingOnArgon: false,
    awaitingCollateralizationLabel: undefined,
    remainingCollateralMicrogons: undefined,
    phase: 'idle',
    error: '',
  };
}

function getTransferPhase(status: CrosschainOutboundTransferStatus): IEthereumOutboundTransferState['phase'] {
  if (status === CrosschainOutboundTransferStatus.RequestFinalizedOnArgon) {
    return 'awaitingCollateralization';
  }
  if (
    status === CrosschainOutboundTransferStatus.Collateralized ||
    status === CrosschainOutboundTransferStatus.TargetSubmitted
  ) {
    return 'confirmingEthereum';
  }
  return 'confirmedOnEthereum';
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
  switch (sourceWalletType) {
    case WalletType.investment:
      return await walletKeys.getInvestmentKeypair();
    case WalletType.miningHold:
      return await walletKeys.getMiningHoldKeypair();
    case WalletType.vaulting:
      return await walletKeys.getVaultingKeypair();
  }
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

async function waitForReadyTransfer(
  transferId: string,
  blockWatch: BlockWatch,
  onAwaitingCollateralization?: (finalizedHeader: BlockWatch['finalizedBlockHeader']) => Promise<void>,
  minimumBlockNumber?: number,
): Promise<{
  blockHash: string;
  blockNumber: number;
  collateralizedMicrogons: bigint;
  collateralizedMicronots: bigint;
  finalizeArgs: IEthereumFinalizeTransferOutOfArgonArgs;
}> {
  await blockWatch.start();
  if (minimumBlockNumber == null || blockWatch.finalizedBlockHeader.blockNumber >= minimumBlockNumber) {
    await onAwaitingCollateralization?.(blockWatch.finalizedBlockHeader);
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

      void Promise.resolve(onAwaitingCollateralization?.(latestHeader))
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
      collateralizedMicrogons: bigint;
      collateralizedMicronots: bigint;
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
    collateralizedMicrogons: sumCollateral(authorizations, 'microgonCollateral'),
    collateralizedMicronots: sumCollateral(authorizations, 'micronotCollateral'),
    finalizeArgs: {
      request,
      proof: { authorizations },
    },
  };
}
