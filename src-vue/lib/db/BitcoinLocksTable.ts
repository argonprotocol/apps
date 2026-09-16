import { BaseTable, IFieldTypes } from './BaseTable';

import { type IBitcoinLock } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { nanoid } from 'nanoid';
import {
  type IBitcoinLockBlockExtrinsicError,
  BitcoinLockStatus,
  type IBitcoinLockScriptDetails,
  type IBitcoinLockRecord,
} from '../../interfaces/IBitcoinLockRecord.ts';
export {
  type IBitcoinLockBlockExtrinsicError,
  BitcoinLockStatus,
  type IBitcoinLockRecord,
} from '../../interfaces/IBitcoinLockRecord.ts';

type IBitcoinLockRow = IBitcoinLockRecord & { relayMetadataJson?: unknown };

export function toBitcoinLockScriptDetails(lock: IBitcoinLockScriptDetails): IBitcoinLockScriptDetails {
  const {
    p2wshScriptHashHex,
    vaultPubkey,
    vaultClaimPubkey,
    ownerPubkey,
    vaultXpubSources,
    vaultClaimHeight,
    openClaimHeight,
    createdAtHeight,
  } = lock;
  return {
    p2wshScriptHashHex,
    vaultPubkey,
    vaultClaimPubkey,
    ownerPubkey,
    vaultXpubSources,
    vaultClaimHeight,
    openClaimHeight,
    createdAtHeight,
  };
}

type FinalizePendingArgs = {
  uuid: string;
  lock: IBitcoinLock;
};

export class BitcoinLocksTable extends BaseTable {
  private fieldTypes: IFieldTypes = {
    bigint: [
      'securitizedSatoshis',
      'fundedSatoshis',
      'microgonsAtTargetPerBtc',
      'securitizationCoverageMicrogons',
      'fissionedSatoshis',
      'securityFees',
      'couponFeesPaid',
      'btcPriceAtRemovalMicrogons',
    ],
    boolean: ['isFlexible', 'isHistoryRecoveryPending'],
    json: ['fundingUtxoIds', 'scriptDetails', 'fundHoldExtensionsByBitcoinExpirationHeight', 'blockExtrinsicErrorJson'],
    date: ['removalBlockTime', 'createdAt', 'updatedAt'],
  };

  public static createUuid(): string {
    return nanoid(5);
  }

  public async findPendingByHdPath(hdPath: string): Promise<IBitcoinLockRecord | undefined> {
    const rawRecords = await this.db.select<IBitcoinLockRow[]>(
      'SELECT * FROM BitcoinLocks WHERE hdPath = ? AND lockId IS NULL',
      toSqlParams([hdPath]),
    );
    if (rawRecords.length === 0) return undefined;
    return this.toLockRecord(rawRecords[0]);
  }

  public async getLockIdByUuid(uuid: string): Promise<number | undefined> {
    const rawRecords = await this.db.select<{ lockId: number }[]>(
      'SELECT lockId FROM BitcoinLocks WHERE uuid = ?',
      toSqlParams([uuid]),
    );
    if (rawRecords.length === 0) return undefined;
    return rawRecords[0].lockId;
  }

  public async insertPending(
    lock: Pick<
      IBitcoinLockRecord,
      'uuid' | 'status' | 'securitizedSatoshis' | 'cosignVersion' | 'network' | 'hdPath' | 'vaultId'
    >,
  ): Promise<IBitcoinLockRecord> {
    const rawRecords = await this.db.select<IBitcoinLockRow[]>(
      `INSERT INTO BitcoinLocks (
        uuid, status, securitizedSatoshis, securityFees, couponFeesPaid,
        fundHoldExtensionsByBitcoinExpirationHeight, cosignVersion, network, hdPath, vaultId
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      ) RETURNING *`,
      toSqlParams([
        lock.uuid,
        lock.status,
        lock.securitizedSatoshis,
        0n,
        0n,
        {},
        lock.cosignVersion,
        lock.network,
        lock.hdPath,
        lock.vaultId,
      ]),
    );
    if (!rawRecords.length) {
      throw new Error(`Failed to insert pending Bitcoin lock`);
    }
    return this.toLockRecord(rawRecords[0]);
  }

  public async finalizePending(args: FinalizePendingArgs): Promise<IBitcoinLockRecord> {
    const { uuid, lock } = args;
    const status = BitcoinLockStatus.LockPendingFunding;
    const scriptDetails = toBitcoinLockScriptDetails(lock);

    const rawRecords = await this.db.select<IBitcoinLockRow[]>(
      `UPDATE BitcoinLocks SET
        status = ?,
        lockId = ?,
        securitizedSatoshis = ?,
        ownerAccount = ?,
        microgonsAtTargetPerBtc = ?,
        securitizationCoverageMicrogons = ?,
        securitizationTick = ?,
        fissionedSatoshis = ?,
        securitizationRatio = ?,
        securityFees = ?,
        couponFeesPaid = ?,
        scriptDetails = ?,
        securitizationHoldExpirationBitcoinHeight = ?,
        isFlexible = ?,
        fundHoldExtensionsByBitcoinExpirationHeight = ?,
        createdAtArgonBlock = ?
      WHERE uuid = ? AND lockId IS NULL RETURNING *`,
      toSqlParams([
        status,
        lock.lockId,
        lock.securitizedSatoshis,
        lock.ownerAccount,
        lock.microgonsAtTargetPerBtc,
        lock.securitizationCoverageMicrogons,
        lock.securitizationTick,
        lock.fissionedSatoshis,
        lock.securitizationRatio,
        lock.securityFees,
        lock.couponFeesPaid,
        scriptDetails,
        lock.securitizationHoldExpirationBitcoinHeight,
        lock.isFlexible,
        lock.fundHoldExtensionsByBitcoinExpirationHeight,
        lock.createdAtArgonBlock,
        uuid,
      ]),
    );
    if (!rawRecords.length) {
      const existingRecord = await this.db
        .select<IBitcoinLockRow[]>('SELECT * FROM BitcoinLocks WHERE uuid = ?', toSqlParams([uuid]))
        .then(records => records[0]);
      if (existingRecord?.lockId === lock.lockId) {
        return this.toLockRecord(existingRecord);
      }
      throw new Error(`Failed to finalize Bitcoin lock record (uuid = ${uuid}, lockId = ${lock.lockId})`);
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

  public async setActiveRelease(lock: IBitcoinLockRecord, releaseId: string): Promise<void> {
    const records = await this.db.select<IBitcoinLockRow[]>(
      `UPDATE BitcoinLocks SET status = ?, activeReleaseId = ? WHERE uuid = ? RETURNING *`,
      toSqlParams([BitcoinLockStatus.Releasing, releaseId, lock.uuid]),
    );
    if (!records[0]) throw new Error(`Bitcoin lock ${lock.uuid} does not exist`);
    Object.assign(lock, this.toLockRecord(records[0]));
  }

  public async clearActiveRelease(lock: IBitcoinLockRecord, status: BitcoinLockStatus): Promise<void> {
    const records = await this.db.select<IBitcoinLockRow[]>(
      `UPDATE BitcoinLocks SET status = ?, activeReleaseId = NULL WHERE uuid = ? RETURNING *`,
      toSqlParams([status, lock.uuid]),
    );
    if (!records[0]) throw new Error(`Bitcoin lock ${lock.uuid} does not exist`);
    Object.assign(lock, this.toLockRecord(records[0]));
  }

  public async getByLockId(lockId: number): Promise<IBitcoinLockRecord | undefined> {
    const rawRecords = await this.db.select<IBitcoinLockRow[]>(
      'SELECT * FROM BitcoinLocks WHERE lockId = ?',
      toSqlParams([lockId]),
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
    const rawRecords = await this.db.select<IBitcoinLockRow[]>(
      'SELECT * FROM BitcoinLocks ORDER BY createdAt DESC',
      [],
    );
    return rawRecords.map(rawRecord => this.toLockRecord(rawRecord));
  }

  public async saveRecoveredHistory(lock: IBitcoinLockRecord, createdAt?: Date): Promise<void> {
    const [updated] = await this.db.select<IBitcoinLockRow[]>(
      `UPDATE BitcoinLocks SET
        status = ?, lockId = COALESCE(lockId, ?), securitizedSatoshis = ?, fundedSatoshis = ?,
        fundingUtxoIds = ?, activeReleaseId = ?, ownerAccount = ?,
        microgonsAtTargetPerBtc = COALESCE(microgonsAtTargetPerBtc, ?),
        securitizationCoverageMicrogons = COALESCE(securitizationCoverageMicrogons, ?),
        securitizationTick = COALESCE(securitizationTick, ?),
        fissionedSatoshis = COALESCE(fissionedSatoshis, ?), securitizationRatio = ?, securityFees = ?,
        couponFeesPaid = ?, scriptDetails = ?, securitizationHoldExpirationBitcoinHeight = ?, isFlexible = ?,
        fundHoldExtensionsByBitcoinExpirationHeight = ?, createdAtArgonBlock = ?,
        removalBlockNumber = ?, removalBlockHash = ?, removalBlockTime = ?, removalExtrinsicIndex = ?,
        removalReason = ?, btcPriceAtRemovalMicrogons = ?,
        createdAt = COALESCE(?, createdAt), updatedAt = CURRENT_TIMESTAMP
       WHERE uuid = ? RETURNING *`,
      toSqlParams([
        lock.status,
        lock.lockId,
        lock.securitizedSatoshis,
        lock.fundedSatoshis,
        lock.fundingUtxoIds,
        lock.activeReleaseId,
        lock.ownerAccount,
        lock.microgonsAtTargetPerBtc,
        lock.securitizationCoverageMicrogons,
        lock.securitizationTick,
        lock.fissionedSatoshis,
        lock.securitizationRatio,
        lock.securityFees,
        lock.couponFeesPaid,
        lock.scriptDetails,
        lock.securitizationHoldExpirationBitcoinHeight,
        lock.isFlexible,
        lock.fundHoldExtensionsByBitcoinExpirationHeight,
        lock.createdAtArgonBlock,
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
    if (updated) lock.updatedAt = this.toLockRecord(updated).updatedAt;
  }

  public async updateFromCurrentLock(lock: IBitcoinLockRecord, currentLock: IBitcoinLock): Promise<void> {
    let status = lock.status;
    if (status !== BitcoinLockStatus.Releasing && status !== BitcoinLockStatus.Released) {
      status = currentLock.fundedSatoshis > 0n ? BitcoinLockStatus.LockFunded : BitcoinLockStatus.LockPendingFunding;
    }
    const scriptDetails = toBitcoinLockScriptDetails(currentLock);
    const [updated] = await this.db.select<IBitcoinLockRow[]>(
      `UPDATE BitcoinLocks SET
        status = CASE WHEN status IN (?, ?) THEN status ELSE ? END,
        securitizedSatoshis = ?, fundedSatoshis = ?, fundingUtxoIds = ?,
        ownerAccount = ?, microgonsAtTargetPerBtc = ?,
        securitizationCoverageMicrogons = ?, securitizationTick = ?, fissionedSatoshis = ?,
        securitizationRatio = ?, securityFees = ?, couponFeesPaid = ?, scriptDetails = ?,
        securitizationHoldExpirationBitcoinHeight = ?, isFlexible = ?, fundHoldExtensionsByBitcoinExpirationHeight = ?,
        createdAtArgonBlock = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE lockId = ? RETURNING *`,
      toSqlParams([
        BitcoinLockStatus.Releasing,
        BitcoinLockStatus.Released,
        status,
        currentLock.securitizedSatoshis,
        currentLock.fundedSatoshis,
        lock.fundingUtxoIds,
        currentLock.ownerAccount,
        currentLock.microgonsAtTargetPerBtc,
        currentLock.securitizationCoverageMicrogons,
        currentLock.securitizationTick,
        currentLock.fissionedSatoshis,
        currentLock.securitizationRatio,
        currentLock.securityFees,
        currentLock.couponFeesPaid,
        scriptDetails,
        currentLock.securitizationHoldExpirationBitcoinHeight,
        currentLock.isFlexible,
        currentLock.fundHoldExtensionsByBitcoinExpirationHeight,
        currentLock.createdAtArgonBlock,
        currentLock.lockId,
      ]),
    );
    if (!updated) throw new Error(`Bitcoin lock ${currentLock.lockId} does not exist`);
    Object.assign(lock, this.toLockRecord(updated));
  }

  public async retireDelegatedPendingLocks(): Promise<IBitcoinLockRecord[]> {
    const records = await this.db.select<IBitcoinLockRow[]>(
      `UPDATE BitcoinLocks
       SET status = ?, blockExtrinsicErrorJson = ?, relayMetadataJson = NULL
       WHERE lockId IS NULL AND relayMetadataJson IS NOT NULL
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
      'SELECT 1 AS found FROM BitcoinLocks WHERE lockId IS NULL AND relayMetadataJson IS NOT NULL LIMIT 1',
    );
    return !!records[0]?.found;
  }

  public async setLockFailedAcknowledged(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.LockFailedAcknowledged;
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
    const rawRecords = await this.db.select<IBitcoinLockRow[]>(
      `UPDATE BitcoinLocks SET
        status = ?,
        blockExtrinsicErrorJson = ?
       WHERE uuid = ? RETURNING *`,
      toSqlParams([BitcoinLockStatus.LockFailed, blockExtrinsicErrorJson, uuid]),
    );
    if (!rawRecords.length) return undefined;
    return this.toLockRecord(rawRecords[0]);
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
    const records = await this.db.select<IBitcoinLockRow[]>(
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

    Object.assign(lock, this.toLockRecord(records[0]));
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
    const records = await this.db.select<IBitcoinLockRow[]>(
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

    Object.assign(lock, this.toLockRecord(records[0]));
  }

  public async setReleased(lock: IBitcoinLockRecord): Promise<void> {
    const releaseRemovalReason: IBitcoinLockRecord['removalReason'] = lock.removalBlockNumber ? 'released' : undefined;
    await this.db.execute(
      `UPDATE BitcoinLocks
       SET status = ?, activeReleaseId = NULL, removalReason = COALESCE(removalReason, ?)
       WHERE uuid = ?`,
      toSqlParams([BitcoinLockStatus.Released, releaseRemovalReason, lock.uuid]),
    );
    lock.status = BitcoinLockStatus.Released;
    lock.activeReleaseId = undefined;
    if (releaseRemovalReason) lock.removalReason ??= releaseRemovalReason;
  }

  private toLockRecord(rawRecord: IBitcoinLockRow): IBitcoinLockRecord {
    const mapped = convertFromSqliteFields<IBitcoinLockRow>(rawRecord, this.fieldTypes);
    const { relayMetadataJson: _relayMetadataJson, ...persisted } = mapped;
    return {
      ...persisted,
      fundedSatoshis: persisted.fundedSatoshis ?? 0n,
      fundingUtxoIds: persisted.fundingUtxoIds ?? [],
      activeReleaseId: persisted.activeReleaseId ?? undefined,
      securityFees: persisted.securityFees ?? 0n,
      couponFeesPaid: persisted.couponFeesPaid ?? 0n,
      fundHoldExtensionsByBitcoinExpirationHeight: persisted.fundHoldExtensionsByBitcoinExpirationHeight ?? {},
    };
  }

  public async deleteAll(): Promise<void> {
    await this.db.walletHdKeysTable.deleteByKeyRole('bitcoinLock');
    await this.db.execute('DELETE FROM BitcoinLockVaultHdSeq', []);
    await this.db.execute('DELETE FROM BitcoinLocks', []);
  }
}
