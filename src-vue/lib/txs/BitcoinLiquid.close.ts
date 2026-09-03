import { BitcoinFission, type Currency, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';

import type { BitcoinFissions } from '../BitcoinFissions.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import {
  TransactionOperation,
  type PreparedTransactionOperation,
  type TransactionOperationBuild,
} from './TransactionOperation.ts';

export interface BitcoinLiquidCloseInput {
  liquidId: number;
  txSigner: TxSigningAccount;
  tip?: bigint;
  client?: ArgonClient;
}

export interface IBitcoinLiquidCloseMetadata {
  liquidId: number;
  fissionIds: number[];
  redemptionAmount: bigint;
}

type BitcoinLiquidCloseBuild = TransactionOperationBuild<IBitcoinLiquidCloseMetadata>;

export class BitcoinLiquidClose extends TransactionOperation<
  BitcoinLiquidCloseInput,
  IBitcoinLiquidCloseMetadata,
  BitcoinLiquidCloseBuild
> {
  protected readonly extrinsicType = ExtrinsicType.BitcoinLiquidClose;

  constructor(
    private readonly fissions: BitcoinFissions,
    transactionTracker: TransactionTracker,
    private readonly currency: Currency,
  ) {
    super(transactionTracker);
  }

  protected async build(args: BitcoinLiquidCloseInput): Promise<BitcoinLiquidCloseBuild> {
    const { liquidId, txSigner, tip, client: providedClient } = args;
    if (txSigner.address !== this.fissions.ownerAccount) {
      throw new Error('This Liquid belongs to a different account.');
    }

    const client = providedClient ?? (await getMainchainClient(false));
    const finalizedHead = await client.rpc.chain.getFinalizedHead();
    const snapshotClient = await client.at(finalizedHead);
    const liquidFissions = (await this.fissions.loadActive(snapshotClient)).filter(
      fission => fission.liquidId === liquidId,
    );
    if (!liquidFissions.length) throw new Error(`Liquid #${liquidId} is unavailable from current chain state.`);

    const priceIndex = await this.currency.fetchPriceIndex(snapshotClient);
    const redemptionAmount = liquidFissions.reduce(
      (total, fission) => total + fission.calculateRedemptionAmount(priceIndex),
      0n,
    );

    return {
      client,
      txs: liquidFissions.map(fission => BitcoinFission.createCloseTx({ client, fissionId: fission.fissionId })),
      txSigner,
      tip,
      unavailableBalance: redemptionAmount,
      metadata: {
        liquidId,
        fissionIds: liquidFissions.map(fission => fission.fissionId),
        redemptionAmount,
      },
    };
  }

  protected getOperationKey(args: BitcoinLiquidCloseInput): string {
    const { liquidId, txSigner } = args;
    return `${txSigner.address}:${liquidId}`;
  }

  protected matches(args: BitcoinLiquidCloseInput, txInfo: TransactionInfo<IBitcoinLiquidCloseMetadata>): boolean {
    const { liquidId, txSigner } = args;
    return txInfo.tx.accountAddress === txSigner.address && txInfo.tx.metadataJson.liquidId === liquidId;
  }

  public getPendingLiquidTxInfo(liquidId: number): TransactionInfo<IBitcoinLiquidCloseMetadata> | undefined {
    return this.getPendingTransaction(txInfo => txInfo.tx.metadataJson.liquidId === liquidId);
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinLiquidCloseMetadata>): Promise<void> {
    await this.fissions.load();
    await this.transactionTracker.ensureStoredEvents(txInfo);
    await this.fissions.recordFinalizedTransaction(txInfo);
  }

  protected createInsufficientFundsError(
    prepared: PreparedTransactionOperation<IBitcoinLiquidCloseMetadata, BitcoinLiquidCloseBuild>,
  ): Error {
    return new Error(
      `You need ${prepared.metadata.redemptionAmount} microgons plus the transaction fee to close this Liquid.`,
    );
  }
}
