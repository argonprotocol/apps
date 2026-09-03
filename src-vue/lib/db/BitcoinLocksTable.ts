import { BaseTable, IFieldTypes } from './BaseTable';

import { BitcoinLock, bigIntMax, type IBitcoinLock, type IBitcoinLockDetails } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { nanoid } from 'nanoid';
import {
  type IBitcoinLockBlockExtrinsicError,
  BitcoinLockStatus,
  type IBitcoinLockScriptDetails,
  type IBitcoinLockRecord,
} from '../../interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoRole, type IBitcoinUtxoRecord } from '../../interfaces/IBitcoinUtxoRecord.ts';
export {
  type IBitcoinLockBlockExtrinsicError,
  BitcoinLockStatus,
  type IBitcoinLockRecord,
} from '../../interfaces/IBitcoinLockRecord.ts';

export function toBitcoinLockScriptDetails(lock: IBitcoinLockDetails): IBitcoinLockScriptDetails {
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
      'microgonsAtTargetPerBtc',
      'securitizationCoverageMicrogons',
      'fissionedSatoshis',
      'securityFees',
      'couponFeesPaid',
      'releaseRedemptionMicrogons',
      'releaseArgonTxFeeMicrogons',
      'releaseCompensationMicrogons',
      'btcPriceAtRemovalMicrogons',
    ],
    boolean: ['isFlexible', 'isHistoryRecoveryPending'],
    json: ['scriptDetails', 'fundHoldExtensionsByBitcoinExpirationHeight', 'blockExtrinsicErrorJson'],
    date: ['removalBlockTime', 'createdAt', 'updatedAt'],
  };

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
      'uuid' | 'status' | 'securitizedSatoshis' | 'cosignVersion' | 'network' | 'hdPath' | 'vaultId'
    >,
  ): Promise<IBitcoinLockRecord> {
    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
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

    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks SET
        status = ?,
        utxoId = ?,
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
        fundingExpirationHeight = ?,
        isFlexible = ?,
        fundHoldExtensionsByBitcoinExpirationHeight = ?,
        createdAtArgonBlock = ?
      WHERE uuid = ? AND utxoId IS NULL RETURNING *`,
      toSqlParams([
        status,
        lock.utxoId,
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
        lock.fundingExpirationHeight,
        lock.isFlexible,
        lock.fundHoldExtensionsByBitcoinExpirationHeight,
        lock.createdAtArgonBlock,
        uuid,
      ]),
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
    const [rawRecords, utxos] = await Promise.all([
      this.db.select<IBitcoinLockRecord[]>('SELECT * FROM BitcoinLocks ORDER BY createdAt DESC', []),
      this.db.bitcoinUtxosTable.fetchAll(),
    ]);
    const utxosByLockId = new Map<IBitcoinLockRecord['utxoId'], IBitcoinUtxoRecord[]>();
    for (const utxo of utxos) {
      const lockUtxos = utxosByLockId.get(utxo.lockUtxoId) ?? [];
      lockUtxos.push(utxo);
      utxosByLockId.set(utxo.lockUtxoId, lockUtxos);
    }
    return rawRecords.map(rawRecord => this.toLockRecord(rawRecord, utxosByLockId.get(rawRecord.utxoId) ?? []));
  }

  public async saveRecoveredHistory(lock: IBitcoinLockRecord, createdAt?: Date): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinLocks SET
        status = ?, utxoId = COALESCE(utxoId, ?), securitizedSatoshis = ?, ownerAccount = ?,
        microgonsAtTargetPerBtc = COALESCE(microgonsAtTargetPerBtc, ?),
        securitizationCoverageMicrogons = COALESCE(securitizationCoverageMicrogons, ?),
        securitizationTick = COALESCE(securitizationTick, ?),
        fissionedSatoshis = COALESCE(fissionedSatoshis, ?), securitizationRatio = ?, securityFees = ?,
        couponFeesPaid = ?, scriptDetails = ?, fundingExpirationHeight = ?, isFlexible = ?,
        fundHoldExtensionsByBitcoinExpirationHeight = ?, createdAtArgonBlock = ?,
        releaseRedemptionMicrogons = ?, releaseArgonTxFeeMicrogons = ?, releaseCompensationMicrogons = ?,
        removalBlockNumber = ?, removalBlockHash = ?, removalBlockTime = ?, removalExtrinsicIndex = ?,
        removalReason = ?, btcPriceAtRemovalMicrogons = ?,
        createdAt = COALESCE(?, createdAt)
       WHERE uuid = ?`,
      toSqlParams([
        lock.status,
        lock.utxoId,
        lock.securitizedSatoshis,
        lock.ownerAccount,
        lock.microgonsAtTargetPerBtc,
        lock.securitizationCoverageMicrogons,
        lock.securitizationTick,
        lock.fissionedSatoshis,
        lock.securitizationRatio,
        lock.securityFees,
        lock.couponFeesPaid,
        lock.scriptDetails,
        lock.fundingExpirationHeight,
        lock.isFlexible,
        lock.fundHoldExtensionsByBitcoinExpirationHeight,
        lock.createdAtArgonBlock,
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

  public async setCurrentLockFunded(lock: IBitcoinLockRecord, currentLock: IBitcoinLock): Promise<void> {
    currentLock.couponFeesPaid = bigIntMax(currentLock.couponFeesPaid, lock.couponFeesPaid);
    if (lock.status !== BitcoinLockStatus.Releasing && lock.status !== BitcoinLockStatus.Released) {
      lock.status = BitcoinLockStatus.LockFunded;
    }
    Object.assign(lock, currentLock, {
      scriptDetails: toBitcoinLockScriptDetails(currentLock),
    });
    lock.fundedSatoshis = lock.utxos
      .filter(utxo => utxo.role === BitcoinUtxoRole.Funding)
      .reduce((total, utxo) => total + utxo.satoshis, 0n);
    const [updated] = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks SET
        status = ?, securitizedSatoshis = ?, ownerAccount = ?, microgonsAtTargetPerBtc = ?,
        securitizationCoverageMicrogons = ?, securitizationTick = ?, fissionedSatoshis = ?,
        securitizationRatio = ?, securityFees = ?, couponFeesPaid = ?, scriptDetails = ?,
        fundingExpirationHeight = ?, isFlexible = ?, fundHoldExtensionsByBitcoinExpirationHeight = ?,
        createdAtArgonBlock = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE uuid = ? RETURNING *`,
      toSqlParams([
        lock.status,
        currentLock.securitizedSatoshis,
        currentLock.ownerAccount,
        currentLock.microgonsAtTargetPerBtc,
        currentLock.securitizationCoverageMicrogons,
        currentLock.securitizationTick,
        currentLock.fissionedSatoshis,
        currentLock.securitizationRatio,
        currentLock.securityFees,
        currentLock.couponFeesPaid,
        lock.scriptDetails,
        currentLock.fundingExpirationHeight,
        currentLock.isFlexible,
        currentLock.fundHoldExtensionsByBitcoinExpirationHeight,
        currentLock.createdAtArgonBlock,
        lock.uuid,
      ]),
    );
    if (updated) lock.updatedAt = this.toLockRecord(updated).updatedAt;
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

    const { fundedSatoshis, fundingUtxo, utxos } = lock;
    Object.assign(lock, this.toLockRecord(records[0]), { fundedSatoshis, fundingUtxo, utxos });
  }

  public async recordReleaseCompensation(lock: IBitcoinLockRecord, amount: bigint): Promise<void> {
    const records = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks SET
        releaseCompensationMicrogons = COALESCE(releaseCompensationMicrogons, ?)
       WHERE uuid = ? RETURNING *`,
      toSqlParams([amount, lock.uuid]),
    );
    if (!records[0]) return;

    const { fundedSatoshis, fundingUtxo, utxos } = lock;
    Object.assign(lock, this.toLockRecord(records[0]), { fundedSatoshis, fundingUtxo, utxos });
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

    const { fundedSatoshis, fundingUtxo, utxos } = lock;
    Object.assign(lock, this.toLockRecord(records[0]), { fundedSatoshis, fundingUtxo, utxos });
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

    const { fundedSatoshis, fundingUtxo, utxos } = lock;
    Object.assign(lock, this.toLockRecord(records[0]), { fundedSatoshis, fundingUtxo, utxos });
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

  private toLockRecord(
    rawRecord: IBitcoinLockRecord & { relayMetadataJson?: unknown },
    utxos: IBitcoinUtxoRecord[] = [],
  ): IBitcoinLockRecord {
    const mapped = convertFromSqliteFields<IBitcoinLockRecord & { relayMetadataJson?: unknown }>(
      rawRecord,
      this.fieldTypes,
    );
    const { relayMetadataJson: _relayMetadataJson, ...persisted } = mapped;
    const fundingUtxos = utxos.filter(utxo => utxo.role === BitcoinUtxoRole.Funding);
    if (fundingUtxos.length > 1) throw new Error(`Bitcoin lock ${persisted.utxoId} has multiple funding UTXOs`);

    const fundingUtxo = fundingUtxos[0];
    const fundedSatoshis = fundingUtxos.reduce((total, utxo) => total + utxo.satoshis, 0n);
    const record: IBitcoinLockRecord = {
      ...persisted,
      securityFees: persisted.securityFees ?? 0n,
      couponFeesPaid: persisted.couponFeesPaid ?? 0n,
      fundHoldExtensionsByBitcoinExpirationHeight: persisted.fundHoldExtensionsByBitcoinExpirationHeight ?? {},
      utxos,
      fundedSatoshis,
      fundingUtxo,
    };
    if (record.utxoId === undefined || !record.scriptDetails || record.microgonsAtTargetPerBtc == null) {
      return record;
    }

    return Object.assign(
      new BitcoinLock({
        utxoId: record.utxoId,
        vaultId: record.vaultId,
        securitizedSatoshis: record.securitizedSatoshis,
        microgonsAtTargetPerBtc: record.microgonsAtTargetPerBtc,
        securitizationCoverageMicrogons: record.securitizationCoverageMicrogons!,
        securitizationTick: record.securitizationTick!,
        fundedSatoshis,
        fissionedSatoshis: record.fissionedSatoshis!,
        ownerAccount: record.ownerAccount!,
        securitizationRatio: record.securitizationRatio!,
        securityFees: record.securityFees,
        couponFeesPaid: record.couponFeesPaid,
        ...record.scriptDetails,
        fundingExpirationHeight: record.fundingExpirationHeight!,
        isFlexible: record.isFlexible!,
        fundHoldExtensionsByBitcoinExpirationHeight: record.fundHoldExtensionsByBitcoinExpirationHeight,
        createdAtArgonBlock: record.createdAtArgonBlock!,
      }),
      record,
    );
  }

  public async deleteAll(): Promise<void> {
    await this.db.walletHdKeysTable.deleteByKeyRole('bitcoinLock');
    await this.db.execute('DELETE FROM BitcoinLockVaultHdSeq', []);
    await this.db.execute('DELETE FROM BitcoinLocks', []);
  }
}
