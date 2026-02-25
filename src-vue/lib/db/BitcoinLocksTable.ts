import { BaseTable, IFieldTypes } from './BaseTable';
import { IBitcoinLock } from '@argonprotocol/mainchain';
import { JsonExt } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { nanoid } from 'nanoid';
import type { IBitcoinUtxoRecord } from './BitcoinUtxosTable.ts';

export interface IRatchet {
  mintAmount: bigint;
  mintPending: bigint;
  lockedMarketRate: bigint;
  securityFee: bigint;
  txFee: bigint;
  burned: bigint;
  blockHeight: number;
  oracleBitcoinBlockHeight: number;
}

export enum BitcoinLockStatus {
  LockIsProcessingOnArgon = 'LockIsProcessingOnArgon', // Submitted transaction to the Argon chain but not yet confirmed in block.
  LockPendingFunding = 'LockPendingFunding', // Argon lock exists and vault securitization is reserved; waiting for Bitcoin funding confirmation/candidate resolution.
  LockExpiredWaitingForFunding = 'LockExpiredWaitingForFunding', // Lock expired before funding could be verified on Argon.
  LockedAndIsMinting = 'LockedAndIsMinting', // Bitcoin is fully locked but minting is still settling.
  LockedAndMinted = 'LockedAndMinted', // Bitcoin is fully locked and minting is complete.

  Releasing = 'Releasing', // Release lifecycle is in progress (argon request, vault cosign, signing, or bitcoin broadcast).
  Released = 'Released', // Release lifecycle is complete.
}

export interface IBitcoinLockRecord {
  uuid: string;
  utxoId?: number;
  status: BitcoinLockStatus;
  satoshis: bigint;
  liquidityPromised: bigint;
  lockedMarketRate: bigint;
  ratchets: IRatchet[];
  cosignVersion: string;
  lockDetails: IBitcoinLock;
  fundingUtxoRecordId: number | null;
  fundingUtxoRecord?: IBitcoinUtxoRecord;
  network: string;
  hdPath: string;
  vaultId: number;
  createdAt: Date;
  updatedAt: Date;
}

export class BitcoinLocksTable extends BaseTable {
  private fieldTypes: IFieldTypes = {
    bigint: ['satoshis', 'lockedMarketRate', 'liquidityPromised'],
    json: ['lockDetails', 'ratchets'],
    date: ['createdAt', 'updatedAt'],
  };

  public override async loadState(): Promise<void> {
    const records = await this.fetchAll();

    for (const lock of records) {
      let needsSave = false;
      type LegacyRatchet = IRatchet & { peggedPrice?: bigint };
      for (const ratchet of lock.ratchets as LegacyRatchet[]) {
        if (ratchet.peggedPrice !== undefined) {
          ratchet.lockedMarketRate = ratchet.peggedPrice;
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

  public async findLockByHdPath(hdPath: string): Promise<IBitcoinLockRecord | undefined> {
    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      'SELECT * FROM BitcoinLocks WHERE hdPath = ?',
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
    lock: Pick<IBitcoinLockRecord, 'uuid' | 'status' | 'satoshis' | 'cosignVersion' | 'network' | 'hdPath' | 'vaultId'>,
  ): Promise<IBitcoinLockRecord> {
    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      `INSERT INTO BitcoinLocks (
        uuid, status, satoshis, cosignVersion, network, hdPath, vaultId, fundingUtxoRecordId
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?
      ) RETURNING *`,
      toSqlParams([
        lock.uuid,
        lock.status,
        lock.satoshis,
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

    const ratchets = [
      {
        mintAmount: lock.liquidityPromised,
        mintPending: lock.liquidityPromised,
        lockedMarketRate: lock.lockedMarketRate,
        blockHeight: createdAtArgonBlockHeight,
        burned: 0n,
        securityFee: lock.securityFees,
        txFee: finalFee,
        oracleBitcoinBlockHeight: lock.createdAtHeight,
      },
    ];

    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      `UPDATE BitcoinLocks SET
        status = ?,
        utxoId = ?,
        liquidityPromised = ?,
        lockedMarketRate = ?,
        lockDetails = ?,
        ratchets = ?
      WHERE uuid = ? AND utxoId IS NULL RETURNING *`,
      toSqlParams([status, lock.utxoId, lock.liquidityPromised, lock.lockedMarketRate, lock, ratchets, uuid]),
    );
    if (!rawRecords.length) {
      throw new Error(`Failed to finalize Bitcoin lock record (uuid = ${uuid}, utxoId = ${lock.utxoId})`);
    }
    return this.toLockRecord(rawRecords[0]);
  }

  public async setVaultHdKeyIndex(vaultId: number, index: number): Promise<void> {
    await this.db.execute(
      `INSERT INTO BitcoinLockVaultHdSeq (vaultId, latestIndex) VALUES (?, ?)
       ON CONFLICT (vaultId) DO UPDATE SET latestIndex = ? WHERE ? > BitcoinLockVaultHdSeq.latestIndex`,
      toSqlParams([vaultId, index, index, index]),
    );
  }

  public async getNextVaultHdKeyIndex(vaultId: number): Promise<number> {
    const [{ latestIndex }] = await this.db.select<{ latestIndex: number }[]>(
      `INSERT INTO BitcoinLockVaultHdSeq (vaultId, latestIndex) VALUES (?, ?)
       ON CONFLICT (vaultId) DO UPDATE SET latestIndex = BitcoinLockVaultHdSeq.latestIndex + 1
       RETURNING latestIndex`,
      toSqlParams([vaultId, 0]),
    );

    return latestIndex;
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

  public async fetchAll(): Promise<IBitcoinLockRecord[]> {
    return await this.db
      .select<IBitcoinLockRecord[]>('SELECT * FROM BitcoinLocks ORDER BY createdAt DESC', [])
      .then(x => x.map(rawRecord => this.toLockRecord(rawRecord)));
  }

  public async saveNewRatchet(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.LockedAndIsMinting;
    await this.db.execute(
      `UPDATE BitcoinLocks SET status = ?, lockedMarketRate = ?, liquidityPromised = ?, lockDetails = ?, ratchets = ? WHERE uuid = ?`,
      toSqlParams([
        lock.status,
        lock.lockedMarketRate,
        lock.liquidityPromised,
        lock.lockDetails,
        lock.ratchets,
        lock.uuid,
      ]),
    );
  }

  public async updateMintState(lock: IBitcoinLockRecord): Promise<void> {
    const remainingMint = lock.ratchets.reduce((acc, ratchet) => acc + ratchet.mintPending, 0n);

    if (
      remainingMint === 0n &&
      (lock.status === BitcoinLockStatus.LockPendingFunding || lock.status === BitcoinLockStatus.LockedAndIsMinting)
    ) {
      lock.status = BitcoinLockStatus.LockedAndMinted;
    } else if (lock.status === BitcoinLockStatus.LockPendingFunding) {
      lock.status = BitcoinLockStatus.LockedAndIsMinting;
    }
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
      `UPDATE BitcoinLocks SET status = ?, fundingUtxoRecordId = ?, lockDetails = ?, lockedMarketRate = ?, liquidityPromised = ?, ratchets = ?
       WHERE uuid = ?`,
      toSqlParams([
        lock.status,
        lock.fundingUtxoRecordId,
        lock.lockDetails,
        lock.lockedMarketRate,
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

  public async setLockExpiredWaitingForFunding(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.LockExpiredWaitingForFunding;
    await this.db.execute('UPDATE BitcoinLocks SET status = ? WHERE uuid = ?', toSqlParams([lock.status, lock.uuid]));
  }

  public async setReleased(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.Released;
    await this.db.execute('UPDATE BitcoinLocks SET status = ? WHERE uuid = ?', toSqlParams([lock.status, lock.uuid]));
  }

  private toLockRecord(rawRecord: IBitcoinLockRecord): IBitcoinLockRecord {
    const record = convertFromSqliteFields<IBitcoinLockRecord>(rawRecord, this.fieldTypes);
    record.fundingUtxoRecord = undefined;
    return record;
  }

  public async deleteAll(): Promise<void> {
    await this.db.execute('DELETE FROM BitcoinLockVaultHdSeq', []);
    await this.db.execute('DELETE FROM BitcoinLocks', []);
  }
}
