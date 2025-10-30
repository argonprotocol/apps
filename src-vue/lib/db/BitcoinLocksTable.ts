import { BaseTable, IFieldTypes } from './BaseTable';
import { IBitcoinLock } from '@argonprotocol/mainchain';
import { JsonExt } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { IMempoolFundingStatus, IMempoolReleaseStatus } from '../BitcoinLocksStore.ts';

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
  LockInitializing = 'LockInitializing', // Initializing the lock
  LockInitialized = 'LockInitialized', // Submitted to the Argon chain & vault's securitization has been locked
  LockVerificationExpired = 'LockVerificationExpired', // The lock expired before it could be verified in argon
  LockProcessingOnBitcoin = 'LockProcessingOnBitcoin', // Found on bitcoin mempool but not in blocks or requires more confirmations
  LockReceivedWrongAmount = 'LockReceivedWrongAmount', // Submitted to bitcoin network with wrong amount
  LockedAndMinting = 'LockedAndMinting', // Is fully locked but has been promised more argon minting
  LockedAndMinted = 'LockedAndMinted', // Is fully locked and fully minted
  ReleaseSubmittingToArgon = 'ReleaseSubmittedToArgon', // Has submitted transaction to network but not yet confirmed in block
  ReleaseWaitingForVault = 'ReleaseWaitingForVault', // Is waiting for vault to approve release
  ReleasedByVault = 'ReleasedByVault', // Has retrieved the vault signature
  ReleaseProcessingOnBitcoin = 'ReleaseProcessingOnBitcoin', // Release was found in mempool and is being processed
  ReleaseComplete = 'ReleaseComplete',
}

export interface IBitcoinLockRecord {
  utxoId: number;
  status: BitcoinLockStatus;
  txid?: string;
  vout?: number;
  satoshis: bigint;
  liquidityPromised: bigint;
  peggedPrice: bigint;
  ratchets: IRatchet[]; // array of ratchets
  cosignVersion: string;
  lockDetails: IBitcoinLock;
  lockMempool?: IMempoolFundingStatus;
  lockProcessingOnBitcoinAtBitcoinHeight?: number;
  lockProcessingOnBitcoinAtBitcoinTime?: number;
  lockProcessingOnBitcoinAtOracleBitcoinHeight?: number;
  requestedReleaseAtTick?: number;
  releaseBitcoinNetworkFee?: bigint;
  releaseToDestinationAddress?: string;
  releaseCosignVaultSignature?: Uint8Array;
  releaseCosignHeight?: number;
  releasedAtBitcoinHeight?: number;
  releaseMempool?: IMempoolReleaseStatus;
  releaseProcessingOnBitcoinAtBitcoinHeight?: number;
  releaseProcessingOnBitcoinAtBitcoinTime?: number;
  releaseProcessingOnBitcoinAtOracleBitcoinHeight?: number;
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

  public async insert(
    lock: Omit<IBitcoinLockRecord, 'createdAt' | 'updatedAt' | 'txid' | 'vout'>,
  ): Promise<IBitcoinLockRecord> {
    const result = await this.db.execute(
      `INSERT INTO BitcoinLocks (
        utxoId, status, satoshis, liquidityPromised, peggedPrice, cosignVersion, lockDetails, network, hdPath, vaultId, ratchets
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )`,
      toSqlParams([
        lock.utxoId,
        lock.status || BitcoinLockStatus.LockInitialized,
        lock.satoshis,
        lock.liquidityPromised,
        lock.peggedPrice,
        lock.cosignVersion,
        lock.lockDetails,
        lock.network,
        lock.hdPath,
        lock.vaultId,
        lock.ratchets,
      ]),
    );
    if (!result || result.rowsAffected === 0) {
      throw new Error(`Failed to insert Bitcoin lock with utxoId ${lock.utxoId}`);
    }
    const record = await this.get(lock.utxoId);
    if (!record) {
      throw new Error(`Failed to insert Bitcoin lock with utxoId ${lock.utxoId}`);
    }
    return record;
  }

  public async getNextVaultHdKeyIndex(vaultId: number): Promise<number> {
    const [{ latestIndex }] = await this.db.select<{ latestIndex: number }[]>(
      `INSERT INTO BitcoinLockVaultHdSeq (vaultId, latestIndex) VALUES ($1, $2)
       ON CONFLICT (vaultId) DO UPDATE SET latestIndex = BitcoinLockVaultHdSeq.latestIndex + 1
       RETURNING latestIndex`,
      toSqlParams([vaultId, 0]),
    );

    return latestIndex;
  }

  public async setReleaseWaitingForVault(lock: IBitcoinLockRecord): Promise<void> {
    lock.status = BitcoinLockStatus.ReleaseWaitingForVault;
    await this.db.execute(
      `UPDATE BitcoinLocks SET status = $2, requestedReleaseAtTick=$3, releaseToDestinationAddress=$4, releaseBitcoinNetworkFee=$5 WHERE utxoId = $1`,
      toSqlParams([
        lock.utxoId,
        lock.status,
        lock.requestedReleaseAtTick,
        lock.releaseToDestinationAddress,
        lock.releaseBitcoinNetworkFee,
      ]),
    );
  }

  public async setReleaseProcessingOnBitcoin(lock: IBitcoinLockRecord, txid: string): Promise<void> {
    lock.status = BitcoinLockStatus.ReleaseProcessingOnBitcoin;
    lock.releasedTxid = txid;
    await this.db.execute(
      `UPDATE BitcoinLocks SET status = $2, releasedTxId = $3  WHERE utxoId = $1`,
      toSqlParams([lock.utxoId, lock.status, lock.releasedTxid]),
    );
  }

  public async setLockProcessingOnBitcoin(
    lock: IBitcoinLockRecord,
    mempoolStatus: IMempoolFundingStatus,
    oracleBitcoinBlockHeight: number,
  ): Promise<void> {
    lock.status = BitcoinLockStatus.LockProcessingOnBitcoin;
    lock.lockProcessingOnBitcoinAtBitcoinHeight = mempoolStatus.transactionBlockHeight;
    lock.lockProcessingOnBitcoinAtBitcoinTime = mempoolStatus.transactionBlockTime;
    lock.lockProcessingOnBitcoinAtOracleBitcoinHeight =
      lock.lockProcessingOnBitcoinAtOracleBitcoinHeight ?? oracleBitcoinBlockHeight;
    lock.lockMempool = mempoolStatus;
    await this.db.execute(
      `UPDATE BitcoinLocks SET 
                status = $6,
                lockProcessingOnBitcoinAtBitcoinHeight = $2, 
                lockProcessingOnBitcoinAtBitcoinTime = $3, 
                lockProcessingOnBitcoinAtOracleBitcoinHeight = $4,
                lockMempool = $5
             WHERE utxoId = $1`,
      toSqlParams([
        lock.utxoId,
        lock.lockProcessingOnBitcoinAtBitcoinHeight,
        lock.lockProcessingOnBitcoinAtBitcoinTime,
        lock.lockProcessingOnBitcoinAtOracleBitcoinHeight,
        lock.lockMempool,
        lock.status,
      ]),
    );
  }

  public async get(utxoId: number): Promise<IBitcoinLockRecord | undefined> {
    const rawRecords = await this.db.select<IBitcoinLockRecord[]>(
      'SELECT * FROM BitcoinLocks WHERE utxoId = $1',
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
    lock.status = BitcoinLockStatus.LockedAndMinting;
    await this.db.execute(
      `UPDATE BitcoinLocks SET status = $2, peggedPrice = $3, liquidityPromised = $4, lockDetails = $5, ratchets = $6 WHERE utxoId = $1`,
      toSqlParams([
        lock.utxoId,
        lock.status,
        lock.peggedPrice,
        lock.liquidityPromised,
        lock.lockDetails,
        lock.ratchets,
      ]),
    );
  }

  public async updateMintState(lock: IBitcoinLockRecord): Promise<void> {
    const remainingMint = lock.ratchets.reduce((acc, ratchet) => acc + ratchet.mintPending, 0n);

    if (
      remainingMint === 0n &&
      (lock.status === BitcoinLockStatus.LockInitialized ||
        lock.status === BitcoinLockStatus.LockedAndMinting ||
        lock.status === BitcoinLockStatus.ReleaseProcessingOnBitcoin)
    ) {
      lock.status = BitcoinLockStatus.LockedAndMinted;
    } else if (lock.status === BitcoinLockStatus.LockInitialized) {
      lock.status = BitcoinLockStatus.LockedAndMinting;
    }
    const ratchets = JsonExt.stringify(lock.ratchets);
    await this.db.execute(
      `UPDATE BitcoinLocks SET ratchets = $2, status = $3 WHERE utxoId = $1`,
      toSqlParams([lock.utxoId, ratchets, lock.status]),
    );
  }

  public async setReleasedByVault(lock: IBitcoinLockRecord, signature: Uint8Array, atHeight: number): Promise<void> {
    lock.status = BitcoinLockStatus.ReleasedByVault;
    lock.releaseCosignVaultSignature = signature;
    lock.releaseCosignHeight = atHeight;
    await this.db.execute(
      'UPDATE BitcoinLocks SET status = $1, releaseCosignVaultSignature = $2, releaseCosignHeight = $3 WHERE utxoId = $4',
      toSqlParams([lock.status, lock.releaseCosignVaultSignature, lock.releaseCosignHeight, lock.utxoId]),
    );
  }

  public async setLockedAndMinting(lock: IBitcoinLockRecord) {
    if (
      lock.status === BitcoinLockStatus.LockInitialized ||
      lock.status === BitcoinLockStatus.LockProcessingOnBitcoin
    ) {
      lock.status = BitcoinLockStatus.LockedAndMinting;
    }
    await this.db.execute(
      'UPDATE BitcoinLocks SET status = $1, txid = $2, vout = $3 WHERE utxoId = $4',
      toSqlParams([lock.status, lock.txid, lock.vout, lock.utxoId]),
    );
  }

  public async setLockReceivedWrongAmount(lock: IBitcoinLockRecord) {
    lock.status = BitcoinLockStatus.LockReceivedWrongAmount;
    await this.db.execute(
      'UPDATE BitcoinLocks SET status = $1 WHERE utxoId = $2',
      toSqlParams([lock.status, lock.utxoId]),
    );
  }

  public async setLockVerificationExpired(lock: IBitcoinLockRecord) {
    lock.status = BitcoinLockStatus.LockVerificationExpired;
    await this.db.execute(
      'UPDATE BitcoinLocks SET status = $1 WHERE utxoId = $2',
      toSqlParams([lock.status, lock.utxoId]),
    );
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
      'UPDATE BitcoinLocks SET status = $1, releasedAtBitcoinHeight = $2 WHERE utxoId = $3',
      toSqlParams([lock.status, lock.releasedAtBitcoinHeight, lock.utxoId]),
    );
  }

  public async deleteAll(): Promise<void> {
    await this.db.execute('DELETE FROM BitcoinLockVaultHdSeq', []);
    await this.db.execute('DELETE FROM BitcoinLocks', []);
  }
}
