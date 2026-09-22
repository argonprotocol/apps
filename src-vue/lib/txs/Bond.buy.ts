import { BondLot, type ArgonClient, TreasuryBonds, type TxSigningAccount } from '@argonprotocol/apps-core';
import type { ArgonBonds } from '../ArgonBonds.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { WalletKeys } from '../WalletKeys.ts';
import { ExtrinsicType, TransactionStatus } from '../db/TransactionsTable.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { TransactionOperation, type TransactionOperationBuild } from './TransactionOperation.ts';

export interface BondBuyInput {
  vaultId: number;
  bondPurchaseMicrogons: bigint;
  txSigner: TxSigningAccount;
  client?: ArgonClient;
}

export interface IBuyBondMetadata {
  vaultId: number;
  bondPurchaseMicrogons: bigint;
}

export class BondBuy extends TransactionOperation<
  BondBuyInput,
  IBuyBondMetadata,
  TransactionOperationBuild<IBuyBondMetadata>
> {
  protected readonly extrinsicType = ExtrinsicType.TreasuryBuyBonds;

  constructor(
    private readonly argonBonds: ArgonBonds,
    private readonly walletKeys: WalletKeys,
    transactionTracker: TransactionTracker,
  ) {
    super(transactionTracker);
  }

  public getPendingForVault(vaultId: number): TransactionInfo<IBuyBondMetadata> | undefined {
    return this.getPendingTransaction(
      info =>
        info.tx.accountAddress === this.walletKeys.defaultArgonAddress &&
        info.tx.metadataJson?.vaultId === vaultId &&
        (info.tx.metadataJson?.bondPurchaseMicrogons ?? 0n) > 0n &&
        (info.tx.status === TransactionStatus.Submitted || info.tx.status === TransactionStatus.InBlock),
    );
  }

  protected async build({ vaultId, bondPurchaseMicrogons, txSigner, client: providedClient }: BondBuyInput) {
    const client = providedClient ?? (await getMainchainClient(false));
    const tx = await TreasuryBonds.buildBuyBondTx({ client, vaultId, bondPurchaseMicrogons });
    return {
      client,
      txs: [tx],
      txSigner,
      unavailableBalance: bondPurchaseMicrogons,
      metadata: { vaultId, bondPurchaseMicrogons },
    };
  }

  protected getOperationKey({ vaultId, bondPurchaseMicrogons, txSigner }: BondBuyInput): string {
    return `${txSigner.address}:${vaultId}:${bondPurchaseMicrogons}`;
  }

  protected matches(input: BondBuyInput, info: TransactionInfo<IBuyBondMetadata>): boolean {
    return (
      info.tx.accountAddress === input.txSigner.address &&
      info.tx.metadataJson.vaultId === input.vaultId &&
      info.tx.metadataJson.bondPurchaseMicrogons === input.bondPurchaseMicrogons
    );
  }

  protected ownsTransaction(info: TransactionInfo<IBuyBondMetadata>): boolean {
    return (
      info.tx.accountAddress === this.walletKeys.defaultArgonAddress &&
      (info.tx.metadataJson?.bondPurchaseMicrogons ?? 0n) > 0n
    );
  }

  protected async onFinalized(info: TransactionInfo<IBuyBondMetadata>): Promise<void> {
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
      await this.argonBonds.recordPurchasedBondLot({
        kind: 'purchase',
        lot,
        block,
        extrinsicIndex: info.tx.blockExtrinsicIndex ?? info.txResult.extrinsicIndex,
        isFlexibleAtPurchase: false,
      });
    } catch (error) {
      console.warn(`[BondBuy] Bond history is pending after finalized block ${blockNumber}`, error);
    } finally {
      // The domain cursor is a durable fallback if a local read or publication fails.
      void this.argonBonds.recordFinalizedTransaction(blockNumber).catch(error => {
        console.warn(`[BondBuy] Bond history catch-up is pending after block ${blockNumber}`, error);
      });
    }
  }
}
