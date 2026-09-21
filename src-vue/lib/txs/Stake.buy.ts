import { BondLot, type ArgonClient, type Currency, type TxSigningAccount } from '@argonprotocol/apps-core';
import type { ArgonBonds } from '../ArgonBonds.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { WalletKeys } from '../WalletKeys.ts';
import { ExtrinsicType, TransactionStatus } from '../db/TransactionsTable.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { TransactionOperation, type TransactionOperationBuild } from './TransactionOperation.ts';

export interface StakeBuyInput {
  purchaseBonds: number;
  bondPurchaseMicronots: bigint;
  txSigner: TxSigningAccount;
  client?: ArgonClient;
}

export interface IBuyStakeMetadata {
  bondPurchaseMicronots: bigint;
}

export class StakeBuy extends TransactionOperation<
  StakeBuyInput,
  IBuyStakeMetadata,
  TransactionOperationBuild<IBuyStakeMetadata>
> {
  protected readonly extrinsicType = ExtrinsicType.TreasuryBuyArgonotBonds;

  constructor(
    private readonly argonBonds: ArgonBonds,
    private readonly currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>,
    private readonly walletKeys: WalletKeys,
    transactionTracker: TransactionTracker,
  ) {
    super(transactionTracker);
  }

  public getPendingPurchase(): TransactionInfo<IBuyStakeMetadata> | undefined {
    return this.getPendingTransaction(
      info =>
        info.tx.accountAddress === this.walletKeys.defaultArgonAddress &&
        (info.tx.metadataJson?.bondPurchaseMicronots ?? 0n) > 0n &&
        (info.tx.status === TransactionStatus.Submitted || info.tx.status === TransactionStatus.InBlock),
    );
  }

  protected async build({ purchaseBonds, bondPurchaseMicronots, txSigner, client: providedClient }: StakeBuyInput) {
    const client = providedClient ?? (await getMainchainClient(false));
    return {
      client,
      txs: [client.tx.treasury.buyArgonotBonds(purchaseBonds)],
      txSigner,
      metadata: { bondPurchaseMicronots },
    };
  }

  protected getOperationKey({ purchaseBonds, bondPurchaseMicronots, txSigner }: StakeBuyInput): string {
    return `${txSigner.address}:${purchaseBonds}:${bondPurchaseMicronots}`;
  }

  protected matches(input: StakeBuyInput, info: TransactionInfo<IBuyStakeMetadata>): boolean {
    return (
      info.tx.accountAddress === input.txSigner.address &&
      info.tx.metadataJson.bondPurchaseMicronots === input.bondPurchaseMicronots
    );
  }

  protected ownsTransaction(info: TransactionInfo<IBuyStakeMetadata>): boolean {
    return (
      info.tx.accountAddress === this.walletKeys.defaultArgonAddress &&
      (info.tx.metadataJson?.bondPurchaseMicronots ?? 0n) > 0n
    );
  }

  protected async onFinalized(info: TransactionInfo<IBuyStakeMetadata>): Promise<void> {
    const blockNumber = info.txResult.blockNumber ?? info.tx.blockHeight;
    if (blockNumber === undefined) return;
    try {
      await this.transactionTracker.ensureStoredEvents(info);
      const event = info.txResult.events.find(
        event =>
          event.section === 'treasury' &&
          event.method === 'BondLotPurchased' &&
          event.data.accountId === this.walletKeys.defaultArgonAddress,
      );
      if (!event || event.section !== 'treasury' || event.method !== 'BondLotPurchased') return;
      const block = await this.argonBonds.miningFrames.blockWatch.getHeader(blockNumber);
      const api = await this.argonBonds.miningFrames.blockWatch.getApi(block);
      const storedLot = await api.query.treasury.bondLotById(event.data.bondLotId);
      if (!storedLot) return;
      const lot = BondLot.fromRuntime(event.data.bondLotId, storedLot, this.walletKeys.defaultArgonAddress);
      const entryArgonotRateMicrogons = (await this.currency.fetchMainchainRatesAtBlock({ api, block })).ARGNOT;
      await this.argonBonds.recordPurchasedBondLot({
        kind: 'purchase',
        lot,
        block,
        extrinsicIndex: info.tx.blockExtrinsicIndex ?? info.txResult.extrinsicIndex,
        entryArgonotRateMicrogons,
        isFlexibleAtPurchase: false,
      });
    } catch (error) {
      console.warn(`[StakeBuy] Bond history is pending after finalized block ${blockNumber}`, error);
    } finally {
      void this.argonBonds.recordFinalizedTransaction(blockNumber).catch(error => {
        console.warn(`[StakeBuy] Bond history catch-up is pending after block ${blockNumber}`, error);
      });
    }
  }
}
