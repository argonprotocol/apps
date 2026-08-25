import { BaseTable, IFieldTypes } from './BaseTable';

import { bigIntMax, JsonExt, type IBitcoinLock, BitcoinLock } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { nanoid } from 'nanoid';
import {
  type IBitcoinLockBlockExtrinsicError,
  BitcoinLockStatus,
  type IBitcoinLockRecord,
  type IRatchet,
} from '../../interfaces/IBitcoinLockRecord.ts';
export {
  type IBitcoinLockBlockExtrinsicError,
  BitcoinLockStatus,
  type IBitcoinLockRecord,
  type IRatchet,
} from '../../interfaces/IBitcoinLockRecord.ts';

export function applyBitcoinLockMintState(lock: IBitcoinLockRecord): void {
  const remainingMint = lock.ratchets.reduce((total, ratchet) => total + ratchet.mintPending, 0n);
  if (
    remainingMint === 0n &&
    (lock.status === BitcoinLockStatus.LockPendingFunding || lock.status === BitcoinLockStatus.LockedAndIsMinting)
  ) {
    lock.status = BitcoinLockStatus.LockedAndMinted;
  } else if (lock.status === BitcoinLockStatus.LockPendingFunding) {
    lock.status = BitcoinLockStatus.LockedAndIsMinting;
  }
}

export function applyCanonicalPreFundingState(record: IBitcoinLockRecord, chainLock: BitcoinLock): bigint {
  const creationRatchet = record.ratchets[0];
  if (!creationRatchet) throw new Error(`Bitcoin lock ${record.utxoId} is missing its creation ratchet`);

  const currentSatoshis = chainLock.utxoSatoshis ?? chainLock.satoshis;
  chainLock.couponFeesPaid = bigIntMax(chainLock.couponFeesPaid, record.lockDetails?.couponFeesPaid ?? 0n);
  record.satoshis = currentSatoshis;
  record.liquidityPromised = chainLock.liquidityPromised;
  record.lockedTargetPrice = chainLock.lockedTargetPrice;
  record.lockDetails = chainLock;
  creationRatchet.mintAmount = chainLock.liquidityPromised;
  creationRatchet.mintPending = chainLock.liquidityPromised;
  creationRatchet.lockedTargetPrice = chainLock.lockedTargetPrice;
  creationRatchet.securityFee = chainLock.securityFees;
  return currentSatoshis;
}

export function createBitcoinLockCreationRatchets(
  lock: IBitcoinLock,
  createdAtArgonBlockHeight: number,
  finalFee: bigint,
): IBitcoinLockRecord['ratchets'] {
  return [
    {
      mintAmount: lock.liquidityPromised,
      mintPending: lock.liquidityPromised,
      lockedTargetPrice: lock.lockedTargetPrice,
      blockHeight: createdAtArgonBlockHeight,
      burned: 0n,
      securityFee: lock.securityFees,
      txFee: finalFee,
      oracleBitcoinBlockHeight: lock.createdAtHeight,
    },
  ];
}

export class BitcoinLocksTable extends BaseTable {
  private fieldTypes: IFieldTypes = {
    bigint: [
      'satoshis',
      'lockedTargetPrice',
      'liquidityPromised',
      'releaseRedemptionMicrogons',
      'releaseArgonTxFeeMicrogons',
      'releaseCompensationMicrogons',
      'btcPriceAtRemovalMicrogons',
    ],
    boolean: ['isHistoryRecoveryPending'],
    json: ['lockDetails', 'ratchets', 'blockExtrinsicErrorJson'],
    date: ['removalBlockTime', 'createdAt', 'updatedAt'],
  };

  public override async loadState(): Promise<void> {
    const records = await this.fetchAll();

    for (const lock of records) {
      let needsSave = false;
      type LegacyRatchet = IRatchet & { lockedMarketRate?: bigint; peggedPrice?: bigint };
      for (const ratchet of lock.ratchets as LegacyRatchet[]) {
        if (ratchet.lockedMarketRate !== undefined) {
          ratchet.lockedTargetPrice = ratchet.lockedMarketRate;
          delete ratchet.lockedMarketRate;
          needsSave = true;
        } else if (ratchet.peggedPrice !== undefined) {
          ratchet.lockedTargetPrice = ratchet.peggedPrice;
          delete ratchet.peggedPrice;
          needsSave = true;
        }
      }
      if (needsSave) {
        await this.db.execute(
          `UPDATE BitcoinLocks SET ratchets = ? WHERE uuid = ?`,
          toSqlParams([lock.ratchets, lock.uuid]),
        );
      }
    }
  }

  public static createUuid(): string {
    return nanoid(5);
  }

  public async findPendingByHdPath(hdPath: string): Promise<IBitcoinLockRecord | undefined> {
    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      'SELECT * FROM BitcoinLocks WHERE hdPath = ? AND utxoId IS NULL',
      toSqlParams([hdPath]),
    );
    if (rawRecords.length === 0) return undefined;
    return this.toLockRecord(rawRecords[0]);
  }

  public async getUtxoIdByUuid(uuid: string): Promise<number | undefined> {
    const rawRecords = await this.db.select<{ utxoId: number }[]>(
      'SELECT utxoId FROM BitcoinLocks WHERE uuid = ?',
      toSqlParams([uuid]),
    );
    if (rawRecords.length === 0) return undefined;
    return rawRecords[0].utxoId;
  }

  public async insertPending(
    lock: Pick<
      IBitcoinLockRecord,
      'uuid' | 'status' | 'satoshis' | 'cosignVersion' | 'network' | 'hdPath' | 'vaultId'
    > & { lockedTargetPrice?: bigint; liquidityPromised?: bigint },
  ): Promise<IBitcoinLockRecord> {
    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      `INSERT INTO BitcoinLocks (
        uuid, status, satoshis, lockedTargetPrice, liquidityPromised, cosignVersion, network, hdPath, vaultId, fundingUtxoRecordId
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      ) RETURNING *`,
      toSqlParams([
        lock.uuid,
        lock.status,
        lock.satoshis,
        lock.lockedTargetPrice ?? 0n,
        lock.liquidityPromised ?? 0n,
        lock.cosignVersion,
        lock.network,
        lock.hdPath,
        lock.vaultId,
        null,
      ]),
    );
    if (!rawRecords.length) {
      throw new Error(`Failed to insert pending Bitcoin lock`);
    }
    return this.toLockRecord(rawRecords[0]);
  }

  public async finalizePending(args: {
    uuid: string;
    lock: IBitcoinLock;
    createdAtArgonBlockHeight: number;
    finalFee: bigint;
  }): Promise<IBitcoinLockRecord> {
    const { uuid, lock, createdAtArgonBlockHeight, finalFee } = args;
    const status = BitcoinLockStatus.LockPendingFunding;

    const ratchets = createBitcoinLockCreationRatchets(lock, createdAtArgonBlockHeight, finalFee);

    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks SET
        status = ?,
        utxoId = ?,
        liquidityPromised = ?,
        lockedTargetPrice = ?,
        lockDetails = ?,
        ratchets = ?
      WHERE uuid = ? AND utxoId IS NULL RETURNING *`,
      toSqlParams([status, lock.utxoId, lock.liquidityPromised, lock.lockedTargetPrice, lock, ratchets, uuid]),
    );
    if (!rawRecords.length) {
      const existingRecord = await this.db
        .select<IBitcoinLockRecord[]>('SELECT * FROM BitcoinLocks WHERE uuid = ?', toSqlParams([uuid]))
        .then(records => records[0]);
      if (existingRecord?.utxoId === lock.utxoId) {
        return this.toLockRecord(existingRecord);
      }
      throw new Error(`Failed to finalize Bitcoin lock record (uuid = ${uuid}, utxoId = ${lock.utxoId})`);
    }
    return this.toLockRecord(rawRecords[0]);
  }

  public async setStatus(lock: IBitcoinLockRecord, status: BitcoinLockStatus): Promise<void> {
    if (lock.status === status) return;
    lock.status = status;
    await this.db.execute(`UPDATE BitcoinLocks SET status = ? WHERE uuid = ?`, toSqlParams([lock.status, lock.uuid]));
  }

  public async setLockPendingFunding(lock: IBitcoinLockRecord): Promise<void> {
    await this.setStatus(lock, BitcoinLockStatus.LockPendingFunding);
  }

  public async getByUtxoId(utxoId: number): Promise<IBitcoinLockRecord | undefined> {
    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      'SELECT * FROM BitcoinLocks WHERE utxoId = ?',
      toSqlParams([utxoId]),
    );
    if (rawRecords.length === 0) return undefined;
    return this.toLockRecord(rawRecords[0]);
  }

  public async setHistoryRecoveryPending(uuid: string, isPending: boolean): Promise<void> {
    await this.db.execute(
      'UPDATE BitcoinLocks SET isHistoryRecoveryPending = ? WHERE uuid = ?',
      toSqlParams([isPending, uuid]),
    );
  }

  public async fetchAll(): Promise<IBitcoinLockRecord[]> {
    return await this.db
      .select<IBitcoinLockRecord[]>('SELECT * FROM BitcoinLocks ORDER BY createdAt DESC', [])
      .then(x => x.map(rawRecord => this.toLockRecord(rawRecord)));
  }

  public async saveNewRatchet(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.LockedAndIsMinting;
    await this.db.execute(
      `UPDATE BitcoinLocks SET status = ?, lockedTargetPrice = ?, liquidityPromised = ?, lockDetails = ?, ratchets = ? WHERE uuid = ?`,
      toSqlParams([
        lock.status,
        lock.lockedTargetPrice,
        lock.liquidityPromised,
        lock.lockDetails,
        lock.ratchets,
        lock.uuid,
      ]),
    );
  }

  public async saveRecoveredHistory(lock: IBitcoinLockRecord, createdAt?: Date): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinLocks SET
        status = ?, satoshis = ?, lockedTargetPrice = ?, liquidityPromised = ?, lockDetails = ?, ratchets = ?,
        releaseRedemptionMicrogons = ?, releaseArgonTxFeeMicrogons = ?, releaseCompensationMicrogons = ?,
        removalBlockNumber = ?, removalBlockHash = ?, removalBlockTime = ?, removalExtrinsicIndex = ?,
        removalReason = ?, btcPriceAtRemovalMicrogons = ?,
        createdAt = COALESCE(?, createdAt)
       WHERE uuid = ?`,
      toSqlParams([
        lock.status,
        lock.satoshis,
        lock.lockedTargetPrice,
        lock.liquidityPromised,
        lock.lockDetails,
        lock.ratchets,
        lock.releaseRedemptionMicrogons,
        lock.releaseArgonTxFeeMicrogons,
        lock.releaseCompensationMicrogons,
        lock.removalBlockNumber,
        lock.removalBlockHash,
        lock.removalBlockTime,
        lock.removalExtrinsicIndex,
        lock.removalReason,
        lock.btcPriceAtRemovalMicrogons,
        createdAt,
        lock.uuid,
      ]),
    );
    if (createdAt) lock.createdAt = createdAt;
  }

  public async updateMintState(lock: IBitcoinLockRecord): Promise<void> {
    applyBitcoinLockMintState(lock);
    const ratchets = JsonExt.stringify(lock.ratchets);
    await this.db.execute(
      `UPDATE BitcoinLocks SET ratchets = ?, status = ? WHERE uuid = ?`,
      toSqlParams([ratchets, lock.status, lock.uuid]),
    );
  }

  public async setLockedAndIsMinting(lock: IBitcoinLockRecord): Promise<void> {
    if (lock.status === BitcoinLockStatus.LockPendingFunding) {
      lock.status = BitcoinLockStatus.LockedAndIsMinting;
    }
    await this.db.execute(
      `UPDATE BitcoinLocks SET status = ?, satoshis = ?, fundingUtxoRecordId = ?, lockDetails = ?, lockedTargetPrice = ?, liquidityPromised = ?, ratchets = ?
       WHERE uuid = ?`,
      toSqlParams([
        lock.status,
        lock.satoshis,
        lock.fundingUtxoRecordId,
        lock.lockDetails,
        lock.lockedTargetPrice,
        lock.liquidityPromised,
        lock.ratchets,
        lock.uuid,
      ]),
    );
  }

  public async setFundingUtxoRecordId(lock: IBitcoinLockRecord, fundingUtxoRecordId: number): Promise<void> {
    lock.fundingUtxoRecordId = fundingUtxoRecordId;
    await this.db.execute(
      `UPDATE BitcoinLocks SET fundingUtxoRecordId = ? WHERE uuid = ?`,
      toSqlParams([fundingUtxoRecordId, lock.uuid]),
    );
  }

  public async retireDelegatedPendingLocks(): Promise<IBitcoinLockRecord[]> {
    const records = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks
       SET status = ?, blockExtrinsicErrorJson = ?, relayMetadataJson = NULL
       WHERE utxoId IS NULL AND relayMetadataJson IS NOT NULL
       RETURNING *`,
      toSqlParams([
        BitcoinLockStatus.LockFailed,
        { message: 'Delegated Bitcoin lock initialization is no longer supported.' },
      ]),
    );
    return records.map(record => this.toLockRecord(record));
  }

  public async hasDelegatedPendingLocks(): Promise<boolean> {
    const records = await this.db.select<Array<{ found: number }>>(
      'SELECT 1 AS found FROM BitcoinLocks WHERE utxoId IS NULL AND relayMetadataJson IS NOT NULL LIMIT 1',
    );
    return !!records[0]?.found;
  }

  public async setLockExpiredWaitingForFunding(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.LockExpiredWaitingForFunding;
    await this.db.execute('UPDATE BitcoinLocks SET status = ? WHERE uuid = ?', toSqlParams([lock.status, lock.uuid]));
  }

  public async setLockExpiredWaitingForFundingAcknowledged(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged;
    await this.db.execute('UPDATE BitcoinLocks SET status = ? WHERE uuid = ?', toSqlParams([lock.status, lock.uuid]));
  }

  public async setLockFailedAcknowledged(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.LockFailedAcknowledged;
    await this.db.execute('UPDATE BitcoinLocks SET status = ? WHERE uuid = ?', toSqlParams([lock.status, lock.uuid]));
  }

  public async setLockFundingReadyToResume(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.LockFundingReadyToResume;
    await this.db.execute('UPDATE BitcoinLocks SET status = ? WHERE uuid = ?', toSqlParams([lock.status, lock.uuid]));
  }

  public async setLockFailed(
    lock: IBitcoinLockRecord,
    blockExtrinsicErrorJson: IBitcoinLockBlockExtrinsicError,
  ): Promise<void> {
    lock.status = BitcoinLockStatus.LockFailed;
    lock.blockExtrinsicErrorJson = blockExtrinsicErrorJson;
    await this.db.execute(
      'UPDATE BitcoinLocks SET status = ?, blockExtrinsicErrorJson = ? WHERE uuid = ?',
      toSqlParams([lock.status, blockExtrinsicErrorJson, lock.uuid]),
    );
  }

  public async setLockFailedByUuid(
    uuid: string,
    blockExtrinsicErrorJson: IBitcoinLockBlockExtrinsicError,
  ): Promise<IBitcoinLockRecord | undefined> {
    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks SET
        status = ?,
        blockExtrinsicErrorJson = ?
       WHERE uuid = ? RETURNING *`,
      toSqlParams([BitcoinLockStatus.LockFailed, blockExtrinsicErrorJson, uuid]),
    );
    if (!rawRecords.length) return undefined;
    return this.toLockRecord(rawRecords[0]);
  }

  public async recordReleaseRequest(
    lock: IBitcoinLockRecord,
    facts: Pick<IBitcoinLockRecord, 'releaseRedemptionMicrogons' | 'releaseArgonTxFeeMicrogons'>,
  ): Promise<void> {
    const status = lock.status === BitcoinLockStatus.Released ? lock.status : BitcoinLockStatus.Releasing;
    const records = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks SET
        status = CASE WHEN status = ? THEN status ELSE ? END,
        releaseRedemptionMicrogons = COALESCE(releaseRedemptionMicrogons, ?),
        releaseArgonTxFeeMicrogons = COALESCE(releaseArgonTxFeeMicrogons, ?)
       WHERE uuid = ? RETURNING *`,
      toSqlParams([
        BitcoinLockStatus.Released,
        status,
        facts.releaseRedemptionMicrogons,
        facts.releaseArgonTxFeeMicrogons,
        lock.uuid,
      ]),
    );
    if (!records[0]) return;

    const fundingUtxoRecord = lock.fundingUtxoRecord;
    Object.assign(lock, this.toLockRecord(records[0]), { fundingUtxoRecord });
  }

  public async recordReleaseCompensation(lock: IBitcoinLockRecord, amount: bigint): Promise<void> {
    const records = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks SET
        releaseCompensationMicrogons = COALESCE(releaseCompensationMicrogons, ?)
       WHERE uuid = ? RETURNING *`,
      toSqlParams([amount, lock.uuid]),
    );
    if (!records[0]) return;

    const fundingUtxoRecord = lock.fundingUtxoRecord;
    Object.assign(lock, this.toLockRecord(records[0]), { fundingUtxoRecord });
  }

  public async recordReleaseCosign(
    lock: IBitcoinLockRecord,
    facts: Pick<
      IBitcoinLockRecord,
      | 'removalBlockNumber'
      | 'removalBlockHash'
      | 'removalBlockTime'
      | 'removalExtrinsicIndex'
      | 'btcPriceAtRemovalMicrogons'
    >,
  ): Promise<void> {
    const records = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks SET
        removalBlockNumber = COALESCE(removalBlockNumber, ?),
        removalBlockHash = COALESCE(removalBlockHash, ?),
        removalBlockTime = COALESCE(removalBlockTime, ?),
        removalExtrinsicIndex = COALESCE(removalExtrinsicIndex, ?),
        btcPriceAtRemovalMicrogons = COALESCE(btcPriceAtRemovalMicrogons, ?)
       WHERE uuid = ? RETURNING *`,
      toSqlParams([
        facts.removalBlockNumber,
        facts.removalBlockHash,
        facts.removalBlockTime,
        facts.removalExtrinsicIndex,
        facts.btcPriceAtRemovalMicrogons,
        lock.uuid,
      ]),
    );
    if (!records[0]) return;

    const fundingUtxoRecord = lock.fundingUtxoRecord;
    Object.assign(lock, this.toLockRecord(records[0]), { fundingUtxoRecord });
  }

  public async recordRemoval(
    lock: IBitcoinLockRecord,
    status: BitcoinLockStatus,
    facts: Pick<
      IBitcoinLockRecord,
      | 'removalBlockNumber'
      | 'removalBlockHash'
      | 'removalBlockTime'
      | 'removalExtrinsicIndex'
      | 'removalReason'
      | 'btcPriceAtRemovalMicrogons'
    >,
  ): Promise<void> {
    const records = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks SET
        status = CASE WHEN removalReason IS NULL OR removalReason = ? THEN ? ELSE status END,
        removalBlockNumber = COALESCE(removalBlockNumber, ?),
        removalBlockHash = COALESCE(removalBlockHash, ?),
        removalBlockTime = COALESCE(removalBlockTime, ?),
        removalExtrinsicIndex = COALESCE(removalExtrinsicIndex, ?),
        removalReason = COALESCE(removalReason, ?),
        btcPriceAtRemovalMicrogons = COALESCE(btcPriceAtRemovalMicrogons, ?)
       WHERE uuid = ? RETURNING *`,
      toSqlParams([
        facts.removalReason,
        status,
        facts.removalBlockNumber,
        facts.removalBlockHash,
        facts.removalBlockTime,
        facts.removalExtrinsicIndex,
        facts.removalReason,
        facts.btcPriceAtRemovalMicrogons,
        lock.uuid,
      ]),
    );
    if (!records[0]) return;

    const fundingUtxoRecord = lock.fundingUtxoRecord;
    Object.assign(lock, this.toLockRecord(records[0]), { fundingUtxoRecord });
  }

  public async setReleased(lock: IBitcoinLockRecord): Promise<void> {
    const releaseRemovalReason: IBitcoinLockRecord['removalReason'] = lock.removalBlockNumber ? 'released' : undefined;
    await this.db.execute(
      'UPDATE BitcoinLocks SET status = ?, removalReason = COALESCE(removalReason, ?) WHERE uuid = ?',
      toSqlParams([BitcoinLockStatus.Released, releaseRemovalReason, lock.uuid]),
    );
    lock.status = BitcoinLockStatus.Released;
    if (releaseRemovalReason) lock.removalReason ??= releaseRemovalReason;
  }

  private toLockRecord(rawRecord: IBitcoinLockRecord & { relayMetadataJson?: unknown }): IBitcoinLockRecord {
    const mapped = convertFromSqliteFields<IBitcoinLockRecord & { relayMetadataJson?: unknown }>(
      rawRecord,
      this.fieldTypes,
    );
    const { relayMetadataJson: _relayMetadataJson, ...record } = mapped;
    record.fundingUtxoRecord = undefined;
    return record;
  }

  public async deleteAll(): Promise<void> {
    await this.db.walletHdKeysTable.deleteByKeyRole('bitcoinLock');
    await this.db.execute('DELETE FROM BitcoinLockVaultHdSeq', []);
    await this.db.execute('DELETE FROM BitcoinLocks', []);
  }
}
