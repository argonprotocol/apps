import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import type { IBitcoinFissionRatchetRecord, IBitcoinFissionRecord } from '../../interfaces/IBitcoinFissionRecord.ts';
import { BaseTable, type IFieldTypes } from './BaseTable.ts';

type StoredFissionRatchet = IBitcoinFissionRatchetRecord & Pick<IBitcoinFissionRecord, 'fissionId'>;

export class BitcoinFissionsTable extends BaseTable {
  private readonly recordFieldTypes: IFieldTypes = {
    bigint: [
      'satoshis',
      'microgonsAtTargetPerBtc',
      'liquidityPromised',
      'redemptionAmount',
      'closeTxFee',
      'btcPriceAtCloseMicrogons',
    ] satisfies (keyof IBitcoinFissionRecord)[],
    date: ['createdBlockTime', 'closedBlockTime', 'createdAt', 'updatedAt'] satisfies (keyof IBitcoinFissionRecord)[],
  };

  private readonly ratchetFieldTypes: IFieldTypes = {
    bigint: [
      'microgonsAtTargetPerBtc',
      'liquidityPromised',
      'amountMinted',
      'amountBurned',
      'mintPending',
      'securityFee',
      'securityFeeCoupon',
      'txFee',
    ] satisfies (keyof IBitcoinFissionRatchetRecord)[],
    date: ['blockTime'] satisfies (keyof IBitcoinFissionRatchetRecord)[],
  };

  public async fetchAll(ownerAccount: string): Promise<IBitcoinFissionRecord[]> {
    const storedRecords = await this.db.select<Omit<IBitcoinFissionRecord, 'ratchets'>[]>(
      `SELECT
         fissions.origin,
         fissions.ownerAccount,
         fissions.fissionId,
         fissions.liquidId,
         fissions.utxoId,
         fissions.satoshis,
         fissions.microgonsAtTargetPerBtc,
         fissions.liquidityPromised,
         fissions.createdAtArgonBlock,
         fissions.ratchetNumber,
         fissions.lastUpdatedArgonBlock,
         fissions.feeHistoryCompleteThroughBlock,
         fissions.createdAtTick,
         fissions.createdBlockHash,
         fissions.createdBlockTime,
         fissions.createdExtrinsicIndex,
         fissions.closedAtArgonBlock,
         fissions.closedAtTick,
         fissions.closedBlockHash,
         fissions.closedBlockTime,
         fissions.closedExtrinsicIndex,
         fissions.closeReason,
         fissions.redemptionAmount,
         fissions.closeTxFee,
         fissions.btcPriceAtCloseMicrogons,
         fissions.createdAt,
         fissions.updatedAt
       FROM BitcoinFissions fissions
       WHERE fissions.ownerAccount = ?
       ORDER BY fissions.fissionId`,
      toSqlParams([ownerAccount]),
    );
    const records = convertFromSqliteFields<Omit<IBitcoinFissionRecord, 'ratchets'>[]>(
      storedRecords,
      this.recordFieldTypes,
    );

    const storedRatchets = await this.db.select<StoredFissionRatchet[]>(
      `SELECT
         fissionId,
         source,
         sourceRatchetIndex,
         ratchetNumber,
         microgonsAtTargetPerBtc,
         liquidityPromised,
         amountMinted,
         amountBurned,
         mintPending,
         securityFee,
         securityFeeCoupon,
         txFee,
         blockNumber,
         tick,
         blockHash,
         blockTime,
         extrinsicIndex
       FROM BitcoinFissionRatchets ratchets
       WHERE ratchets.ownerAccount = ?
       ORDER BY blockNumber, COALESCE(extrinsicIndex, -1), sourceRatchetIndex, source`,
      toSqlParams([ownerAccount]),
    );
    const ratchets = convertFromSqliteFields<StoredFissionRatchet[]>(storedRatchets, this.ratchetFieldTypes);
    const ratchetsByFissionId = new Map<number, IBitcoinFissionRatchetRecord[]>();

    for (const { fissionId, ...ratchet } of ratchets) {
      const fissionRatchets = ratchetsByFissionId.get(fissionId) ?? [];
      fissionRatchets.push(ratchet);
      ratchetsByFissionId.set(fissionId, fissionRatchets);
    }

    return records.map(record => ({
      ...record,
      ratchets: ratchetsByFissionId.get(record.fissionId) ?? [],
    }));
  }

  public async replaceRecords(records: readonly IBitcoinFissionRecord[]): Promise<void> {
    await this.db.transaction(async transaction => {
      for (const record of records) await transaction.bitcoinFissionsTable.replaceRecord(record);
    });
  }

  public async replaceRecord(record: IBitcoinFissionRecord): Promise<void> {
    await this.upsertFission(record);
    await this.db.execute(
      'DELETE FROM BitcoinFissionRatchets WHERE ownerAccount = ? AND fissionId = ?',
      toSqlParams([record.ownerAccount, record.fissionId]),
    );
    for (const ratchet of record.ratchets) await this.upsertRatchet(record, ratchet);
  }

  private async upsertFission(record: IBitcoinFissionRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO BitcoinFissions (
         ownerAccount,
         origin,
         fissionId,
         liquidId,
         utxoId,
         satoshis,
         microgonsAtTargetPerBtc,
         liquidityPromised,
         createdAtArgonBlock,
         ratchetNumber,
         lastUpdatedArgonBlock,
         feeHistoryCompleteThroughBlock,
         createdAtTick,
         createdBlockHash,
         createdBlockTime,
         createdExtrinsicIndex,
         closedAtArgonBlock,
         closedAtTick,
         closedBlockHash,
         closedBlockTime,
         closedExtrinsicIndex,
         closeReason,
         redemptionAmount,
         closeTxFee,
         btcPriceAtCloseMicrogons,
         createdAt,
         updatedAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ownerAccount, fissionId) DO UPDATE SET
         origin = excluded.origin,
         liquidId = excluded.liquidId,
         utxoId = excluded.utxoId,
         satoshis = excluded.satoshis,
         microgonsAtTargetPerBtc = excluded.microgonsAtTargetPerBtc,
         liquidityPromised = excluded.liquidityPromised,
         createdAtArgonBlock = excluded.createdAtArgonBlock,
         ratchetNumber = excluded.ratchetNumber,
         lastUpdatedArgonBlock = excluded.lastUpdatedArgonBlock,
         feeHistoryCompleteThroughBlock = excluded.feeHistoryCompleteThroughBlock,
         createdAtTick = excluded.createdAtTick,
         createdBlockHash = excluded.createdBlockHash,
         createdBlockTime = excluded.createdBlockTime,
         createdExtrinsicIndex = excluded.createdExtrinsicIndex,
         closedAtArgonBlock = excluded.closedAtArgonBlock,
         closedAtTick = excluded.closedAtTick,
         closedBlockHash = excluded.closedBlockHash,
         closedBlockTime = excluded.closedBlockTime,
         closedExtrinsicIndex = excluded.closedExtrinsicIndex,
         closeReason = excluded.closeReason,
         redemptionAmount = excluded.redemptionAmount,
         closeTxFee = excluded.closeTxFee,
         btcPriceAtCloseMicrogons = excluded.btcPriceAtCloseMicrogons,
         createdAt = excluded.createdAt,
         updatedAt = excluded.updatedAt`,
      toSqlParams([
        record.ownerAccount,
        record.origin,
        record.fissionId,
        record.liquidId,
        record.utxoId,
        record.satoshis,
        record.microgonsAtTargetPerBtc,
        record.liquidityPromised,
        record.createdAtArgonBlock,
        record.ratchetNumber,
        record.lastUpdatedArgonBlock,
        record.feeHistoryCompleteThroughBlock,
        record.createdAtTick,
        record.createdBlockHash,
        record.createdBlockTime,
        record.createdExtrinsicIndex,
        record.closedAtArgonBlock,
        record.closedAtTick,
        record.closedBlockHash,
        record.closedBlockTime,
        record.closedExtrinsicIndex,
        record.closeReason,
        record.redemptionAmount,
        record.closeTxFee,
        record.btcPriceAtCloseMicrogons,
        record.createdAt,
        record.updatedAt,
      ]),
    );
  }

  private async upsertRatchet(record: IBitcoinFissionRecord, ratchet: IBitcoinFissionRatchetRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO BitcoinFissionRatchets (
         ownerAccount,
         fissionId,
         liquidId,
         utxoId,
         source,
         sourceRatchetIndex,
         ratchetNumber,
         microgonsAtTargetPerBtc,
         liquidityPromised,
         amountMinted,
         amountBurned,
         mintPending,
         securityFee,
         securityFeeCoupon,
         txFee,
         blockNumber,
         tick,
         blockHash,
         blockTime,
         extrinsicIndex
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ownerAccount, fissionId, source, sourceRatchetIndex) DO UPDATE SET
         liquidId = excluded.liquidId,
         utxoId = excluded.utxoId,
         ratchetNumber = excluded.ratchetNumber,
         microgonsAtTargetPerBtc = excluded.microgonsAtTargetPerBtc,
         liquidityPromised = excluded.liquidityPromised,
         amountMinted = excluded.amountMinted,
         amountBurned = excluded.amountBurned,
         mintPending = excluded.mintPending,
         securityFee = excluded.securityFee,
         securityFeeCoupon = excluded.securityFeeCoupon,
         txFee = excluded.txFee,
         blockNumber = excluded.blockNumber,
         tick = excluded.tick,
         blockHash = excluded.blockHash,
         blockTime = excluded.blockTime,
         extrinsicIndex = excluded.extrinsicIndex,
         updatedAt = CURRENT_TIMESTAMP`,
      toSqlParams([
        record.ownerAccount,
        record.fissionId,
        record.liquidId,
        record.utxoId,
        ratchet.source,
        ratchet.sourceRatchetIndex,
        ratchet.ratchetNumber,
        ratchet.microgonsAtTargetPerBtc,
        ratchet.liquidityPromised,
        ratchet.amountMinted,
        ratchet.amountBurned,
        ratchet.mintPending,
        ratchet.securityFee,
        ratchet.securityFeeCoupon,
        ratchet.txFee,
        ratchet.blockNumber,
        ratchet.tick,
        ratchet.blockHash,
        ratchet.blockTime,
        ratchet.extrinsicIndex,
      ]),
    );
  }
}
