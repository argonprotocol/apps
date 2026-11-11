import { StabilizerBuy, type ArgonClient, type TxSigner } from '@argonprotocol/apps-core';
import type { StabilizerBuys } from '../StabilizerBuys.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { TransactionOperation, type TransactionOperationBuild } from './TransactionOperation.ts';

export interface StabilizerBuyBidInput {
  admissionFrame: number;
  rewardPercent: number;
  txSigner: TxSigner;
  client?: ArgonClient;
}

type BidMetadata = Pick<StabilizerBuyBidInput, 'admissionFrame' | 'rewardPercent'>;

export class StabilizerBuyBid extends TransactionOperation<
  StabilizerBuyBidInput,
  BidMetadata,
  TransactionOperationBuild<BidMetadata>
> {
  protected readonly extrinsicType = ExtrinsicType.StabilizerBuyBid;

  constructor(
    private readonly buys: StabilizerBuys,
    transactionTracker: TransactionTracker,
  ) {
    super(transactionTracker);
  }

  public getPendingForFrame(admissionFrame: number): TransactionInfo<BidMetadata> | undefined {
    return this.getPendingTransaction(
      info =>
        info.tx.accountAddress === this.buys.accountAddress && info.tx.metadataJson.admissionFrame === admissionFrame,
    );
  }

  protected async build({ admissionFrame, rewardPercent, txSigner, client: providedClient }: StabilizerBuyBidInput) {
    if (txSigner.address !== this.buys.accountAddress)
      throw new Error('Use the Argon account that received the purchase.');

    const client = providedClient ?? (await getMainchainClient(false));
    const metadata = { admissionFrame, rewardPercent };
    const tx = await StabilizerBuy.buildBidTx({ client, account: txSigner.address, ...metadata });

    return { client, txSigner, metadata, txs: [tx] };
  }

  protected async beforeSubmit({ client, txSigner, metadata }: TransactionOperationBuild<BidMetadata>) {
    await StabilizerBuy.buildBidTx({ client, account: txSigner.address, ...metadata });
  }

  protected getOperationKey({ admissionFrame, rewardPercent, txSigner }: StabilizerBuyBidInput): string {
    return `${txSigner.address}:${admissionFrame}:${rewardPercent}`;
  }

  protected matches(input: StabilizerBuyBidInput, info: TransactionInfo<BidMetadata>): boolean {
    return (
      info.tx.accountAddress === input.txSigner.address &&
      info.tx.metadataJson.admissionFrame === input.admissionFrame &&
      info.tx.metadataJson.rewardPercent === input.rewardPercent
    );
  }

  protected ownsTransaction(info: TransactionInfo<BidMetadata>): boolean {
    return info.tx.accountAddress === this.buys.accountAddress;
  }

  protected async onFinalized(info: TransactionInfo<BidMetadata>): Promise<void> {
    const blockNumber = info.txResult.blockNumber ?? info.tx.blockHeight;
    if (blockNumber === undefined) throw new Error('The finalized bid has no block identity; retry reconciliation.');

    await this.buys.refresh(await this.buys.blockWatch.getHeader(blockNumber));
  }

  protected async onFailed(info: TransactionInfo<BidMetadata>): Promise<void> {
    if (info.tx.isFinalized) await this.onFinalized(info);
  }
}
