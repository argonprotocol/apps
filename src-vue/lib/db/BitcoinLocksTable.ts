import { BaseTable, IFieldTypes } from './BaseTable';
import { IBitcoinLock } from '@argonprotocol/mainchain';
import { JsonExt } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { IMempoolFundingStatus, IMempoolReleaseStatus } from '../BitcoinLocksStore.ts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { nanoid } from 'nanoid';

dayjs.extend(utc);

export interface IRatchet {
  mintAmount: bigint;
  mintPending: bigint;
  peggedPrice: bigint;
  securityFee: bigint;
  txFee: bigint;
  burned: bigint;
  blockHeight: number;
  oracleBitcoinBlockHeight: number;
}

export enum BitcoinLockStatus {
  LockIsProcessingOnArgon = 'LockIsProcessingOnArgon', // Submitted transaction to the Argon chain but not yet confirmed in block
  LockReadyForBitcoin = 'LockReadyForBitcoin', // Submitted to the Argon chain & vault's securitization has been locked
  LockFailedToHappen = 'LockFailedToHappen', // The lock expired before it could be verified in argon
  LockIsProcessingOnBitcoin = 'LockIsProcessingOnBitcoin', // Found on bitcoin mempool but not in blocks or requires more confirmations
  LockReceivedWrongAmount = 'LockReceivedWrongAmount', // Submitted to bitcoin network with wrong amount
  LockedAndIsMinting = 'LockedAndIsMinting', // Is fully locked but has been promised more argon minting
  LockedAndMinted = 'LockedAndMinted', // Is fully locked and fully minted

  ReleaseIsProcessingOnArgon = 'ReleaseIsProcessingOnArgon', // Has submitted transaction to network but not yet confirmed in block
  ReleaseIsWaitingForVault = 'ReleaseIsWaitingForVault', // Is waiting for vault to approve release
  ReleaseSigned = 'ReleaseSigned', // Has retrieved the vault signature
  ReleaseIsProcessingOnBitcoin = 'ReleaseIsProcessingOnBitcoin', // Release was found in mempool and is being processed
  ReleaseComplete = 'ReleaseComplete',
}

export interface IBitcoinLockRecord {
  uuid: string; // uuid so we can track it prior to insert
  utxoId?: number;
  status: BitcoinLockStatus;
  satoshis: bigint;
  liquidityPromised: bigint;
  peggedPrice: bigint;
  ratchets: IRatchet[]; // array of ratchets
  cosignVersion: string;
  lockDetails: IBitcoinLock;
  lockMempool?: IMempoolFundingStatus;
  lockProcessingOnBitcoinAtTime?: Date;
  lockProcessingOnBitcoinAtBitcoinHeight?: number;
  lockProcessingOnBitcoinAtOracleBitcoinHeight?: number;
  lockProcessingLastOracleBlockDate?: Date;
  lockProcessingLastOracleBlockHeight?: number;
  lockedTxid?: string;
  lockedVout?: number;
  requestedReleaseAtTick?: number;
  releaseBitcoinNetworkFee?: bigint;
  releaseToDestinationAddress?: string;
  releaseCosignVaultSignature?: Uint8Array;
  releaseCosignHeight?: number;
  releasedAtBitcoinHeight?: number;
  releaseMempool?: IMempoolReleaseStatus;
  releaseProcessingOnBitcoinAtDate?: Date;
  releaseProcessingOnBitcoinAtBitcoinHeight?: number;
  releaseProcessingOnBitcoinAtOracleBitcoinHeight?: number;
  releaseProcessingLastOracleBlockDate?: Date;
  releaseProcessingLastOracleBlockHeight?: number;
  releasedTxid?: string;
  releaseError?: string;
  network: string;
  hdPath: string;
  vaultId: number;
  createdAt: Date;
  updatedAt: Date;
}

export class BitcoinLocksTable extends BaseTable {
  private fieldTypes: IFieldTypes = {
    bigint: ['satoshis', 'peggedPrice', 'liquidityPromised', 'releaseBitcoinNetworkFee'],
    json: ['lockDetails', 'ratchets'],
    date: ['createdAt', 'updatedAt'],
    uint8array: ['releaseCosignVaultSignature'],
  };

  public static createUuid(): string {
    return nanoid(5);
  }

  public async getUtxoUuid(uuid: string): Promise<number | undefined> {
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
        uuid, status, satoshis, cosignVersion, network, hdPath, vaultId
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?
      ) RETURNING *`,
      toSqlParams([lock.uuid, lock.status, lock.satoshis, lock.cosignVersion, lock.network, lock.hdPath, lock.vaultId]),
    );
    if (!rawRecords.length) {
      throw new Error(`Failed to insert pending Bitcoin lock`);
    }
    return convertFromSqliteFields<IBitcoinLockRecord[]>(rawRecords, this.fieldTypes)[0];
  }

  public async finalizePending(args: {
    uuid: string;
    lock: IBitcoinLock;
    createdAtArgonBlockHeight: number;
    finalFee: bigint;
  }): Promise<IBitcoinLockRecord> {
    const { uuid, lock, createdAtArgonBlockHeight, finalFee } = args;
    const status = BitcoinLockStatus.LockReadyForBitcoin;

    const ratchets = [
      {
        mintAmount: lock.liquidityPromised,
        mintPending: lock.liquidityPromised,
        peggedPrice: lock.peggedPrice,
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
        peggedPrice = ?,
        lockDetails = ?, 
        ratchets = ?
      WHERE uuid = ? AND utxoId IS NULL RETURNING *`,
      toSqlParams([status, lock.utxoId, lock.liquidityPromised, lock.peggedPrice, lock, ratchets, uuid]),
    );
    if (!rawRecords.length) {
      throw new Error(`Failed to finalize Bitcoin lock record (uuid = ${uuid}, utxoId = ${lock.utxoId})`);
    }
    return convertFromSqliteFields<IBitcoinLockRecord[]>(rawRecords, this.fieldTypes)[0];
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

  public async setReleaseIsWaitingForVault(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.ReleaseIsWaitingForVault;
    await this.db.execute(
      `UPDATE BitcoinLocks SET status = ?, requestedReleaseAtTick=?, releaseToDestinationAddress=?, releaseBitcoinNetworkFee=? WHERE uuid = ?`,
      toSqlParams([
        lock.status,
        lock.requestedReleaseAtTick,
        lock.releaseToDestinationAddress,
        lock.releaseBitcoinNetworkFee,
        lock.uuid,
      ]),
    );
  }

  public async setReleaseIsProcessingOnArgon(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.ReleaseIsProcessingOnArgon;
    await this.db.execute(`UPDATE BitcoinLocks SET status = ? WHERE uuid = ?`, toSqlParams([lock.status, lock.uuid]));
  }

  public async setReleaseIsProcessingOnBitcoin(lock: IBitcoinLockRecord, releasedTxid: string): Promise<void> {
    lock.status = BitcoinLockStatus.ReleaseIsProcessingOnBitcoin;
    lock.releasedTxid = releasedTxid;
    await this.db.execute(
      `UPDATE BitcoinLocks SET status = ?, releasedTxid = ?  WHERE uuid = ?`,
      toSqlParams([lock.status, lock.releasedTxid, lock.uuid]),
    );
  }

  public async setLockIsProcessingOnBitcoin(
    lock: IBitcoinLockRecord,
    mempoolStatus: IMempoolFundingStatus,
    oracleBitcoinBlockHeight: number,
  ): Promise<void> {
    lock.status = BitcoinLockStatus.LockIsProcessingOnBitcoin;
    lock.lockProcessingOnBitcoinAtTime ??= dayjs.utc().toDate();
    lock.lockProcessingOnBitcoinAtBitcoinHeight = mempoolStatus.transactionBlockHeight;
    lock.lockProcessingOnBitcoinAtOracleBitcoinHeight ??= oracleBitcoinBlockHeight;
    lock.lockMempool = mempoolStatus;
    await this.db.execute(
      `UPDATE BitcoinLocks SET 
                status = ?,
                lockProcessingOnBitcoinAtTime = ?, 
                lockProcessingOnBitcoinAtBitcoinHeight = ?,
                lockProcessingOnBitcoinAtOracleBitcoinHeight = ?,
                lockMempool = ?
             WHERE uuid = ?`,
      toSqlParams([
        lock.status,
        lock.lockProcessingOnBitcoinAtTime,
        lock.lockProcessingOnBitcoinAtBitcoinHeight,
        lock.lockProcessingOnBitcoinAtOracleBitcoinHeight,
        lock.lockMempool,
        lock.uuid,
      ]),
    );
  }

  public async getByUtxoId(utxoId: number): Promise<IBitcoinLockRecord | undefined> {
    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      'SELECT * FROM BitcoinLocks WHERE utxoId = ?',
      toSqlParams([utxoId]),
    );
    if (rawRecords.length === 0) return undefined;
    return convertFromSqliteFields(rawRecords[0], this.fieldTypes);
  }

  public async fetchAll(): Promise<IBitcoinLockRecord[]> {
    return await this.db
      .select<IBitcoinLockRecord[]>('SELECT * FROM BitcoinLocks ORDER BY createdAt DESC', [])
      .then(x => {
        return x.map(rawRecord => convertFromSqliteFields(rawRecord, this.fieldTypes));
      });
  }

  public async saveNewRatchet(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.LockedAndIsMinting;
    await this.db.execute(
      `UPDATE BitcoinLocks SET status = ?, peggedPrice = ?, liquidityPromised = ?, lockDetails = ?, ratchets = ? WHERE uuid = ?`,
      toSqlParams([lock.status, lock.peggedPrice, lock.liquidityPromised, lock.lockDetails, lock.ratchets, lock.uuid]),
    );
  }

  public async updateLockProcessingLastOracleBlock(lock: IBitcoinLockRecord): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinLocks SET lockProcessingLastOracleBlockDate = ?, lockProcessingLastOracleBlockHeight = ? WHERE uuid = ?`,
      toSqlParams([lock.lockProcessingLastOracleBlockDate, lock.lockProcessingLastOracleBlockHeight, lock.uuid]),
    );
  }

  public async updateReleaseProcessingLastOracleBlock(lock: IBitcoinLockRecord): Promise<void> {
    await this.db.execute(
      `UPDATE BitcoinLocks SET releaseProcessingLastOracleBlockDate = ?, releaseProcessingLastOracleBlockHeight = ? WHERE uuid = ?`,
      toSqlParams([lock.releaseProcessingLastOracleBlockDate, lock.releaseProcessingLastOracleBlockHeight, lock.uuid]),
    );
  }

  public async updateMintState(lock: IBitcoinLockRecord): Promise<void> {
    const remainingMint = lock.ratchets.reduce((acc, ratchet) => acc + ratchet.mintPending, 0n);

    if (
      remainingMint === 0n &&
      (lock.status === BitcoinLockStatus.LockReadyForBitcoin ||
        lock.status === BitcoinLockStatus.LockedAndIsMinting ||
        lock.status === BitcoinLockStatus.ReleaseIsProcessingOnBitcoin)
    ) {
      console.log('LOCKED AND MINTED (BitcoinLocksTable.updateMintState)');
      lock.status = BitcoinLockStatus.LockedAndMinted;
    } else if (lock.status === BitcoinLockStatus.LockReadyForBitcoin) {
      lock.status = BitcoinLockStatus.LockedAndIsMinting;
    }
    const ratchets = JsonExt.stringify(lock.ratchets);
    await this.db.execute(
      `UPDATE BitcoinLocks SET ratchets = ?, status = ? WHERE uuid = ?`,
      toSqlParams([ratchets, lock.status, lock.uuid]),
    );
  }

  public async setReleaseSigned(lock: IBitcoinLockRecord, signature: Uint8Array, atHeight: number): Promise<void> {
    lock.status = BitcoinLockStatus.ReleaseSigned;
    lock.releaseCosignVaultSignature = signature;
    lock.releaseCosignHeight = atHeight;
    await this.db.execute(
      'UPDATE BitcoinLocks SET status = ?, releaseCosignVaultSignature = ?, releaseCosignHeight = ? WHERE uuid = ?',
      toSqlParams([lock.status, lock.releaseCosignVaultSignature, lock.releaseCosignHeight, lock.uuid]),
    );
  }

  public async setLockedAndIsMinting(lock: IBitcoinLockRecord) {
    if (
      lock.status === BitcoinLockStatus.LockReadyForBitcoin ||
      lock.status === BitcoinLockStatus.LockIsProcessingOnBitcoin
    ) {
      lock.status = BitcoinLockStatus.LockedAndIsMinting;
    }
    await this.db.execute(
      'UPDATE BitcoinLocks SET status = ?, lockedTxid = ?, lockedVout = ? WHERE uuid = ?',
      toSqlParams([lock.status, lock.lockedTxid, lock.lockedVout, lock.uuid]),
    );
  }

  public async setLockReceivedWrongAmount(lock: IBitcoinLockRecord) {
    lock.status = BitcoinLockStatus.LockReceivedWrongAmount;
    await this.db.execute('UPDATE BitcoinLocks SET status = ? WHERE uuid = ?', toSqlParams([lock.status, lock.uuid]));
  }

  public async setLockFailedToHappen(lock: IBitcoinLockRecord) {
    lock.status = BitcoinLockStatus.LockFailedToHappen;
    await this.db.execute('UPDATE BitcoinLocks SET status = ? WHERE uuid = ?', toSqlParams([lock.status, lock.uuid]));
  }

  public async setReleaseComplete(
    lock: IBitcoinLockRecord,
    data: {
      releasedAtBitcoinHeight: number;
    },
  ): Promise<void> {
    lock.status = BitcoinLockStatus.ReleaseComplete;
    lock.releasedAtBitcoinHeight = data.releasedAtBitcoinHeight;
    await this.db.execute(
      'UPDATE BitcoinLocks SET status = ?, releasedAtBitcoinHeight = ? WHERE uuid = ?',
      toSqlParams([lock.status, lock.releasedAtBitcoinHeight, lock.uuid]),
    );
  }

  public async deleteAll(): Promise<void> {
    await this.db.execute('DELETE FROM BitcoinLockVaultHdSeq', []);
    await this.db.execute('DELETE FROM BitcoinLocks', []);
  }
}
