import { BondLot, type ArgonClient, TreasuryBonds, type TxSigningAccount } from '@argonprotocol/apps-core';
import type { ArgonBonds } from '../ArgonBonds.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { WalletKeys } from '../WalletKeys.ts';
import { ExtrinsicType, TransactionStatus } from '../db/TransactionsTable.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { TransactionOperation, type TransactionOperationBuild } from './TransactionOperation.ts';

export interface BondLotReleaseInput {
  bondLot: BondLot;
  txSigner: TxSigningAccount;
  client?: ArgonClient;
}

export interface IBondLotReleaseMetadata {
  bondLotId: number;
  releasedBondMicrogons: bigint;
}

export class BondLotRelease extends TransactionOperation<
  BondLotReleaseInput,
  IBondLotReleaseMetadata,
  TransactionOperationBuild<IBondLotReleaseMetadata>
> {
  protected readonly extrinsicType = ExtrinsicType.TreasuryReleaseBondLot;

  constructor(
    private readonly argonBonds: ArgonBonds,
    private readonly walletKeys: WalletKeys,
    transactionTracker: TransactionTracker,
  ) {
    super(transactionTracker);
  }

  public getPendingForLot(
    bondLotId: number,
    accountAddress: string,
  ): TransactionInfo<IBondLotReleaseMetadata> | undefined {
    return this.getPendingTransaction(
      info =>
        info.tx.metadataJson?.bondLotId === bondLotId &&
        (info.tx.metadataJson?.releasedBondMicrogons ?? 0n) > 0n &&
        info.tx.accountAddress === accountAddress &&
        (info.tx.status === TransactionStatus.Submitted || info.tx.status === TransactionStatus.InBlock),
    );
  }

  protected async build({ bondLot, txSigner, client: providedClient }: BondLotReleaseInput) {
    const client = providedClient ?? (await getMainchainClient(false));
    return {
      client,
      txs: [await TreasuryBonds.buildReleaseBondLotTx({ client, bondLotId: bondLot.id })],
      txSigner,
      metadata: { bondLotId: bondLot.id, releasedBondMicrogons: bondLot.bondMicrogons },
    };
  }

  protected getOperationKey({ bondLot, txSigner }: BondLotReleaseInput): string {
    return `${txSigner.address}:${bondLot.id}`;
  }

  protected matches(input: BondLotReleaseInput, info: TransactionInfo<IBondLotReleaseMetadata>): boolean {
    return info.tx.accountAddress === input.txSigner.address && info.tx.metadataJson.bondLotId === input.bondLot.id;
  }

  protected ownsTransaction(info: TransactionInfo<IBondLotReleaseMetadata>): boolean {
    return info.tx.metadataJson?.bondLotId !== undefined && (info.tx.metadataJson?.releasedBondMicrogons ?? 0n) > 0n;
  }

  protected async onFinalized(info: TransactionInfo<IBondLotReleaseMetadata>): Promise<void> {
    if (info.tx.accountAddress !== this.walletKeys.defaultArgonAddress) return;
    const blockNumber = info.txResult.blockNumber ?? info.tx.blockHeight;
    if (blockNumber === undefined) return;
    try {
      await this.transactionTracker.ensureStoredEvents(info);
      const event = info.txResult.events.find(
        event =>
          event.section === 'treasury' &&
          event.method === 'BondLotReleaseScheduled' &&
          event.data.accountId === this.walletKeys.defaultArgonAddress &&
          event.data.bondLotId === info.tx.metadataJson.bondLotId,
      );
      if (!event) return;
      const block = await this.argonBonds.miningFrames.blockWatch.getHeader(blockNumber);
      const api = await this.argonBonds.miningFrames.blockWatch.getApi(block);
      const storedLot = await api.query.treasury.bondLotById(info.tx.metadataJson.bondLotId);
      if (!storedLot) return;
      const lot = BondLot.fromRuntime(info.tx.metadataJson.bondLotId, storedLot, this.walletKeys.defaultArgonAddress);
      await this.argonBonds.recordBondReleaseRequest(lot, block);
    } catch (error) {
      console.warn(`[BondLotRelease] Bond history is pending after finalized block ${blockNumber}`, error);
    } finally {
      void this.argonBonds.recordFinalizedTransaction(blockNumber).catch(error => {
        console.warn(`[BondLotRelease] Bond history catch-up is pending after block ${blockNumber}`, error);
      });
    }
  }
}
