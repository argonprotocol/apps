import {
  BondLot,
  type Currency,
  type IBlockHeaderInfo,
  type MiningFrames,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import type { Db } from '../Db.ts';
import type { WalletKeys } from '../WalletKeys.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';

type HistoricalBondLot = NonNullable<HistoricalQueryRecord<'treasury', 'bondLotById'>>;

export class ArgonBondsRecovery {
  private readonly dbPromise: Promise<Db>;
  private readonly currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>;
  private readonly miningFrames: MiningFrames;
  private readonly walletKeys: WalletKeys;
  private readonly transactionTracker: TransactionTracker;

  constructor({
    dbPromise,
    currency,
    miningFrames,
    walletKeys,
    transactionTracker,
  }: {
    dbPromise: Promise<Db>;
    currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>;
    miningFrames: MiningFrames;
    walletKeys: WalletKeys;
    transactionTracker: TransactionTracker;
  }) {
    this.dbPromise = dbPromise;
    this.currency = currency;
    this.miningFrames = miningFrames;
    this.walletKeys = walletKeys;
    this.transactionTracker = transactionTracker;
  }

  public async repairLocalPurchases(): Promise<boolean> {
    const history = await (await this.dbPromise).bondLotHistoryTable.fetchAll(this.walletKeys.defaultArgonAddress);
    const missingBondLotIds = new Set(
      history.flatMap(record => {
        const lacksPurchase = !record.purchaseBlockHash;
        const lacksArgonotPrice = record.programType === 'Argonot' && record.entryArgonotRateMicrogons == null;
        return lacksPurchase || lacksArgonotPrice ? [record.bondLotId] : [];
      }),
    );
    if (!missingBondLotIds.size) return false;

    await this.transactionTracker.load();
    let didRepair = false;

    for (const txInfo of this.transactionTracker.data.txInfos) {
      const { tx } = txInfo;
      const isBondPurchase =
        tx.extrinsicType === ExtrinsicType.TreasuryBuyBonds ||
        tx.extrinsicType === ExtrinsicType.TreasuryBuyArgonotBonds;
      if (!isBondPurchase || tx.accountAddress !== this.walletKeys.defaultArgonAddress || !tx.isFinalized) continue;
      if (tx.submissionErrorJson || tx.blockExtrinsicErrorJson || tx.blockHeight === undefined || !tx.blockHash)
        continue;

      try {
        await this.transactionTracker.ensureStoredEvents(txInfo);
        const events = txInfo.txResult.events;
        const block = await this.miningFrames.blockWatch.getHeader(tx.blockHeight);
        if (block.blockHash.toLowerCase() !== tx.blockHash.toLowerCase()) {
          throw new Error(`stored transaction hash does not match finalized block ${tx.blockHeight}`);
        }

        for (const event of events) {
          if (event.section !== 'treasury' || event.method !== 'BondLotPurchased') continue;
          if (event.data.accountId !== this.walletKeys.defaultArgonAddress) {
            continue;
          }

          const { bondLotId } = event.data;
          if (!missingBondLotIds.has(bondLotId)) continue;

          await this.recordPurchase(block, bondLotId, tx.blockExtrinsicIndex);
          missingBondLotIds.delete(bondLotId);
          didRepair = true;
        }
      } catch (error) {
        console.warn(`[ArgonBonds] Unable to restore purchase history from local transaction #${tx.id}`, error);
      }

      if (!missingBondLotIds.size) break;
    }

    return didRepair;
  }

  public async importBlock(block: IBlockHeaderInfo, events: readonly RuntimeSystemEventRecord[]): Promise<void> {
    for (const { event, phase } of events) {
      if (event.section !== 'treasury' || (event.method !== 'BondLotPurchased' && event.method !== 'BondLotReleased')) {
        continue;
      }

      if (event.data.accountId !== this.walletKeys.defaultArgonAddress) continue;

      const { bondLotId } = event.data;
      const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : undefined;
      if (event.method === 'BondLotPurchased') {
        await this.recordPurchase(block, bondLotId, extrinsicIndex);
      } else {
        await this.recordRelease(block, bondLotId, extrinsicIndex);
      }
    }
  }

  public async recordPurchase(block: IBlockHeaderInfo, bondLotId: number, extrinsicIndex?: number): Promise<void> {
    const api = await this.miningFrames.blockWatch.getApi(block);
    const lotQuery = api.query.treasury.bondLotById(bondLotId);
    if (!lotQuery) throw new Error(`Bond lot storage is unavailable at block ${block.blockNumber}`);

    const storedLot = await lotQuery;
    if (!storedLot) {
      throw new Error(`Purchased bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);
    }

    const lot = this.decodeStoredBondLot(bondLotId, storedLot);
    await (
      await this.dbPromise
    ).bondLotHistoryTable.recordObservation({
      lot,
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      purchase: {
        blockTime: new Date(block.blockTime),
        extrinsicIndex,
        entryArgonotRateMicrogons: lot.programType === 'Argonot' ? await this.getArgonotPrice(block) : undefined,
      },
    });
  }

  private async recordRelease(block: IBlockHeaderInfo, bondLotId: number, extrinsicIndex?: number): Promise<void> {
    let parent: IBlockHeaderInfo;
    try {
      parent = await this.miningFrames.blockWatch.getParentHeader(block);
    } catch (error) {
      if (!block.isFinalized || block.blockNumber === 0) throw error;

      console.warn(
        `[ArgonBonds] Parent hash lookup failed for finalized block ${block.blockNumber}; retrying by block number`,
        error,
      );
      parent = await this.miningFrames.blockWatch.getHeader(block.blockNumber - 1);
    }
    const parentApi = await this.miningFrames.blockWatch.getApi(parent);
    const lotQuery = parentApi.query.treasury.bondLotById(bondLotId);
    if (!lotQuery) throw new Error(`Bond lot storage is unavailable before block ${block.blockNumber}`);

    const storedLot = await lotQuery;
    if (!storedLot) {
      throw new Error(`Released bond lot ${bondLotId} is unavailable before block ${block.blockNumber}`);
    }

    const lot = this.decodeStoredBondLot(bondLotId, storedLot);
    await (
      await this.dbPromise
    ).bondLotHistoryTable.recordRelease({
      lot,
      parentBlockNumber: parent.blockNumber,
      parentBlockHash: parent.blockHash,
      release: {
        blockNumber: block.blockNumber,
        blockHash: block.blockHash,
        blockTime: new Date(block.blockTime),
        extrinsicIndex,
        closingArgonotRateMicrogons: lot.programType === 'Argonot' ? await this.getArgonotPrice(block) : undefined,
      },
    });
  }

  private decodeStoredBondLot(id: number, lot: HistoricalBondLot): BondLot {
    const vaultTerms = lot.program?.type === 'Vault' ? lot.program.value : undefined;
    const vaultId = vaultTerms?.vaultId ?? lot.vaultId;
    const programType = lot.program?.type === 'Argonot' ? 'Argonot' : 'Vault';
    if (programType === 'Vault' && vaultId === undefined) {
      throw new Error(`Historical vault bond lot ${id} is missing its vault`);
    }

    const sharingRatio = vaultTerms?.sharingPercent ?? lot.sharingPercent;
    const bonusRatio = vaultTerms?.bonusPercent ?? lot.bonusPercent;
    const participatedFrames = lot.participatedFrames;
    return new BondLot({
      id,
      programType,
      accountId: lot.owner,
      vaultId,
      bonds: lot.bonds,
      createdFrame: Number(lot.createdFrameId),
      participatedFrames,
      lastEarningsFrame: lot.lastFrameEarningsFrameId === null ? null : Number(lot.lastFrameEarningsFrameId),
      lastEarnings: lot.lastFrameEarnings ?? 0n,
      lifetimeEarnings: lot.cumulativeEarnings,
      lifetimeBondedFrameMicrogons:
        programType === 'Vault' ? BondLot.bondsToMicrogons(lot.bonds) * BigInt(participatedFrames) : 0n,
      sharingPercent: sharingRatio?.times(100).toNumber(),
      bonusPercent: bonusRatio?.times(100).toNumber() ?? 0,
      releaseFrame: lot.releaseFrameId === null ? null : Number(lot.releaseFrameId),
      releaseReason: lot.releaseReason?.type,
      isReleasing: lot.releaseReason != null,
      isFlexible: lot.isFlexible ?? lot.isBackfill ?? false,
      isOwn: lot.owner === this.walletKeys.defaultArgonAddress,
      canRelease: lot.owner === this.walletKeys.defaultArgonAddress,
    });
  }

  private async getArgonotPrice(block: IBlockHeaderInfo): Promise<bigint | undefined> {
    const api = await this.miningFrames.blockWatch.getApi(block);
    return (await this.currency.fetchMainchainRatesAtBlock({ api, block })).ARGNOT;
  }
}
