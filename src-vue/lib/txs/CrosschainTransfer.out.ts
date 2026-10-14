import { MoveToken, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';
import { ExtrinsicType, TransactionStatus } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type {
  EthereumOutboundTransferTracker,
  ICrosschainTransferOutMetadata,
} from '../EthereumOutboundTransferTracker.ts';
import { TransactionOperation, type TransactionOperationBuild } from './TransactionOperation.ts';

export interface CrosschainTransferOutInput {
  client: ArgonClient;
  txSigner: TxSigningAccount;
  metadata: ICrosschainTransferOutMetadata & { localTransferId: string };
}

export class CrosschainTransferOut extends TransactionOperation<
  CrosschainTransferOutInput,
  ICrosschainTransferOutMetadata,
  TransactionOperationBuild<CrosschainTransferOutInput['metadata']>
> {
  public static readonly mortalityBlocks = 64;
  protected readonly extrinsicType = ExtrinsicType.CrosschainTransferTransferOut;

  constructor(
    transactionTracker: TransactionTracker,
    private readonly transfers: EthereumOutboundTransferTracker,
  ) {
    super(transactionTracker);
  }

  protected async build({ client, txSigner, metadata }: CrosschainTransferOutInput) {
    return {
      client,
      txSigner,
      metadata,
      txs: [CrosschainTransferOut.createTransaction(client, metadata)],
      era: metadata.mortalityBlocks ?? CrosschainTransferOut.mortalityBlocks,
    };
  }

  protected getOperationKey({ txSigner, metadata }: CrosschainTransferOutInput): string {
    return `${txSigner.address}:${metadata.localTransferId}`;
  }

  protected matches(
    { txSigner, metadata }: CrosschainTransferOutInput,
    txInfo: TransactionInfo<ICrosschainTransferOutMetadata>,
  ): boolean {
    return (
      txInfo.tx.accountAddress === txSigner.address &&
      txInfo.tx.metadataJson.localTransferId === metadata.localTransferId
    );
  }

  protected ownsTransaction(txInfo: TransactionInfo<ICrosschainTransferOutMetadata>): boolean {
    return txInfo.tx.metadataJson.actionType === 'transferOutToEthereum';
  }

  protected async getTransactionsToRestore(
    transactions: TransactionInfo<ICrosschainTransferOutMetadata>[],
  ): Promise<TransactionInfo<ICrosschainTransferOutMetadata>[]> {
    // Finalized commands can still need publication. Ambiguous local timeouts require domain reconciliation first.
    const requests = transactions.filter(txInfo => {
      if (txInfo.tx.status === TransactionStatus.TimedOutWaitingForBlock) return false;
      const localId = txInfo.tx.metadataJson.localTransferId;
      if (!localId) return true;

      const latest = this.transactionTracker.findLatestTxInfo<ICrosschainTransferOutMetadata>(
        candidate =>
          candidate.tx.extrinsicType === this.extrinsicType && candidate.tx.metadataJson.localTransferId === localId,
      );
      return latest === txInfo;
    });
    return this.transfers.getUnpublishedArgonRequests(requests);
  }

  protected async beforeSubmit(prepared: CrosschainTransferOutInput): Promise<void> {
    await this.transfers.onArgonRequestPrepared(prepared);
  }

  protected async onSubmitted(txInfo: TransactionInfo<ICrosschainTransferOutMetadata>): Promise<void> {
    await this.transactionTracker.ensureStoredEvents(txInfo);
    const id = txInfo.tx.metadataJson.localTransferId ?? txInfo.tx.extrinsicHash;
    let transferId: string | undefined;
    if (txInfo.tx.isFinalized) transferId = this.getStartedTransferId(txInfo);
    if (txInfo.tx.isFinalized && !txInfo.tx.blockExtrinsicErrorJson && !transferId) {
      throw new Error('TransferOutStarted event is not available yet; retry after transaction events are restored.');
    }
    const canonicalId = await this.transfers.onArgonRequestSubmitted(txInfo, id, transferId);
    this.transfers.updateArgonRequestProgress(txInfo, canonicalId);
    const unsubscribe = txInfo.subscribeToProgress((_, error) => {
      this.transfers.updateArgonRequestProgress(txInfo, canonicalId, error);
    });
    void txInfo.txResult.waitForFinalizedBlock.finally(unsubscribe).catch(() => undefined);
  }

  protected async onFinalized(txInfo: TransactionInfo<ICrosschainTransferOutMetadata>): Promise<void> {
    await this.transactionTracker.ensureStoredEvents(txInfo);
    const transferId = this.getStartedTransferId(txInfo);
    if (!transferId) throw new Error('TransferOutStarted event not found in transaction events.');
    const id = await this.transfers.onArgonRequestSubmitted(
      txInfo,
      txInfo.tx.metadataJson.localTransferId ?? txInfo.tx.extrinsicHash,
      transferId,
    );
    await this.transfers.onArgonRequestFinalized(id, transferId);
  }

  protected async onFailed(txInfo: TransactionInfo<ICrosschainTransferOutMetadata>, error: Error): Promise<void> {
    await this.transfers.onArgonRequestFailed(txInfo, error);
  }

  public static createTransaction(
    client: ArgonClient,
    {
      moveToken,
      destinationAddress,
      amount,
    }: Pick<ICrosschainTransferOutMetadata, 'moveToken' | 'destinationAddress' | 'amount'>,
  ) {
    return client.tx.crosschainTransfer.transferOut(
      'Ethereum',
      moveToken === MoveToken.ARGNOT ? 'Argonot' : 'Argon',
      destinationAddress,
      amount,
    );
  }

  private getStartedTransferId(txInfo: TransactionInfo): string | undefined {
    for (const event of txInfo.txResult.events) {
      if (event.section === 'crosschainTransfer' && event.method === 'TransferOutStarted') return event.data.transferId;
    }
  }
}
