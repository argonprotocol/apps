import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import {
  type ArgonClient,
  type ArgonQueryClient,
  type IBitcoinLock,
  type IBitcoinLockConfig,
} from '@argonprotocol/apps-core';
import {
  BitcoinUtxosTable,
  BitcoinUtxoSpendStatus,
  BitcoinUtxoStatus,
  IBitcoinUtxoRecord,
  IMempoolFundingObservation,
} from './db/BitcoinUtxosTable.ts';
import { BitcoinLockStatus } from './db/BitcoinLocksTable.ts';
import type { IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import type { IBitcoinLockProcessingDetails } from '../interfaces/IBitcoinLockSummary.ts';
import { BlockProgress } from './BlockProgress.ts';
import { BITCOIN_BLOCK_MILLIS } from './Env.ts';
import BitcoinMempool from './BitcoinMempool.ts';
import { Db } from './Db.ts';
import BitcoinLocks from './BitcoinLocks.ts';

dayjs.extend(utc);

export interface IUtxoTrackingDeps {
  dbPromise: Promise<Db>;
  getBitcoinNetwork: () => BitcoinNetwork;
  getOracleBitcoinBlockHeight: () => number;
  getConfig: () => IBitcoinLockConfig | undefined;
  getMainchainClient: (archived: boolean) => Promise<ArgonClient>;
  mempool: BitcoinMempool;
}

export default class BitcoinUtxoTracking {
  public data: {
    utxosByKey: { [key: string]: IBitcoinUtxoRecord };
    utxosById: { [id: number]: IBitcoinUtxoRecord };
    utxoIdsByLockId: { [lockId: number]: number[] };
  };

  constructor(private readonly deps: IUtxoTrackingDeps) {
    this.data = {
      utxosByKey: {},
      utxosById: {},
      utxoIdsByLockId: {},
    };
  }

  public load(records: IBitcoinUtxoRecord[]): void {
    this.data.utxosByKey = {};
    this.data.utxosById = {};
    this.data.utxoIdsByLockId = {};
    for (const record of records) this.recordUtxo(record);
  }

  public getUtxoRecord(lockId: number, txid: string, vout: number): IBitcoinUtxoRecord | undefined {
    return this.data.utxosByKey[this.getUtxoKey(lockId, txid, vout)];
  }

  public getUtxoRecordById(id: number): IBitcoinUtxoRecord | undefined {
    return this.data.utxosById[id];
  }

  public getUtxosForLock(lockId: number): IBitcoinUtxoRecord[] {
    return (this.data.utxoIdsByLockId[lockId] ?? []).flatMap(id => {
      const record = this.data.utxosById[id];
      return record ? [record] : [];
    });
  }

  public getFundingUtxos(lock: IBitcoinLockRecord): IBitcoinUtxoRecord[] {
    return lock.fundingUtxoIds.flatMap(id => {
      const record = this.data.utxosById[id];
      return record?.lockId === lock.lockId ? [record] : [];
    });
  }

  public getReceivedFundingSatoshis(lock: IBitcoinLockRecord): bigint | undefined {
    if (lock.lockId === undefined) return;
    const fundingUtxoIds = new Set(lock.fundingUtxoIds);
    const receivedUtxos = this.getUtxosForLock(lock.lockId).filter(record => {
      return fundingUtxoIds.has(record.id) || record.status === BitcoinUtxoStatus.SeenOnMempool;
    });
    if (!receivedUtxos.length) return;
    return receivedUtxos.reduce((total, record) => total + record.satoshis, 0n);
  }

  public hasObservedFundingSignal(lock: IBitcoinLockRecord): boolean {
    return this.getReceivedFundingSatoshis(lock) !== undefined;
  }

  public getObservedFundingUtxos(lock: IBitcoinLockRecord): IBitcoinUtxoRecord[] {
    if (lock.lockId === undefined) return [];
    return this.getUtxosForLock(lock.lockId)
      .filter(record => record.status === BitcoinUtxoStatus.SeenOnMempool)
      .sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
  }

  public async syncFundingUtxos(lock: IBitcoinLockRecord, currentLock: IBitcoinLock): Promise<IBitcoinUtxoRecord[]> {
    if (!lock.lockId) throw new Error('Lock has no lockId for UTXO tracking.');

    const db = await this.deps.dbPromise;
    const records = await db.transaction(async transaction => {
      const records: IBitcoinUtxoRecord[] = [];
      for (const fundingUtxo of currentLock.fundingUtxos) {
        records.push(
          await this.persistUtxoRecord(
            transaction.bitcoinUtxosTable,
            lock,
            {
              txid: fundingUtxo.utxoRef.txid,
              vout: fundingUtxo.utxoRef.vout,
              satoshis: fundingUtxo.satoshis,
            },
            BitcoinUtxoStatus.FundingUtxo,
          ),
        );
      }

      const updatedLock = {
        ...lock,
        fundingUtxoIds: records.map(record => record.id),
        fundedSatoshis: currentLock.fundedSatoshis,
      };
      await transaction.bitcoinLocksTable.updateFromCurrentLock(updatedLock, currentLock);
      return records;
    });

    const publishedRecords = records.map(record => this.recordUtxo(record));
    const updatedLock = await db.bitcoinLocksTable.getByLockId(lock.lockId);
    if (!updatedLock) throw new Error(`Bitcoin lock ${lock.lockId} does not exist`);
    Object.assign(lock, updatedLock);
    return publishedRecords;
  }

  public async syncArgonOrphans(
    locks: IBitcoinLockRecord[],
    apiClient: ArgonQueryClient,
  ): Promise<IBitcoinUtxoRecord[]> {
    const locksByOwner = new Map<string, IBitcoinLockRecord[]>();
    const records: IBitcoinUtxoRecord[] = [];

    for (const lock of locks) {
      if (!lock.lockId) continue;
      if (!lock.ownerAccount) continue;
      const ownerLocks = locksByOwner.get(lock.ownerAccount) ?? [];
      ownerLocks.push(lock);
      locksByOwner.set(lock.ownerAccount, ownerLocks);
    }

    for (const [ownerAccount, ownerLocks] of locksByOwner) {
      const locksByLockId = new Map(ownerLocks.map(lock => [lock.lockId, lock]));
      const entries = (await apiClient.query.bitcoinLocks.orphanedUtxosByAccount.entries(ownerAccount)) ?? [];

      for (const [orphanKey, orphanMaybe] of entries) {
        if (!orphanMaybe) continue;
        const orphan = orphanMaybe;
        const lock = locksByLockId.get(orphan.lockId);
        if (!lock) continue;

        const utxoRef = orphanKey.args[1];
        const record = await this.upsertUtxoRecord(
          lock,
          {
            txid: utxoRef.txid,
            vout: utxoRef.outputIndex,
            satoshis: orphan.satoshis,
          },
          { markOrphaned: true },
        );
        records.push(record);
      }
    }
    return records;
  }

  public async observeMempoolFunding(lock: IBitcoinLockRecord): Promise<IMempoolFundingObservation | undefined> {
    if (!lock.lockId) return undefined;
    // Mempool is a best-effort preview. The runtime-confirmed funding or orphan state remains authoritative.
    const payToScriptAddress = lock.scriptDetails?.p2wshScriptHashHex;
    if (!payToScriptAddress) throw new Error(`Bitcoin lock ${lock.lockId} is missing its cosign script details`);
    const txs = await this.deps.mempool.getAddressUtxos(
      BitcoinLocks.formatP2wshAddress(payToScriptAddress, this.deps.getBitcoinNetwork()),
    );
    if (!txs.length) {
      return undefined;
    }

    const tip = await this.deps.mempool.getTipHeight();
    const mempoolRecords: IBitcoinUtxoRecord[] = [];
    for (const tx of txs) {
      const status = tx.status;
      const mempoolObservation: IMempoolFundingObservation = {
        satoshis: BigInt(tx.value),
        isConfirmed: status.confirmed,
        confirmations: status.confirmed ? tip - (status.block_height ?? 0) : 0,
        txid: tx.txid,
        vout: tx.vout,
        transactionBlockHeight: status.block_height ?? 0,
        transactionBlockTime: status.block_time ?? 0,
        argonBitcoinHeight: this.deps.getOracleBitcoinBlockHeight(),
      };
      const record = await this.upsertUtxoRecord(
        lock,
        { txid: tx.txid, vout: tx.vout, satoshis: BigInt(tx.value) },
        { mempoolObservation },
      );
      mempoolRecords.push(record);
    }

    return this.getObservedFundingUtxos(lock).at(-1)?.mempoolObservation;
  }

  public async syncPendingFundingSignals(
    lock: IBitcoinLockRecord,
    preferredClient?: ArgonQueryClient,
  ): Promise<boolean> {
    if (!lock.lockId || !this.shouldTrackFundingSignals(lock)) return false;

    let mempoolObservation: IMempoolFundingObservation | undefined;

    const client = preferredClient ?? (await this.deps.getMainchainClient(true));
    const [orphanResult, mempoolObservationResult] = await Promise.allSettled([
      this.syncArgonOrphans([lock], client),
      this.observeMempoolFunding(lock),
    ]);

    if (orphanResult.status === 'rejected') {
      console.warn(
        `[BitcoinUtxoTracking] Failed to refresh Argon orphans for lock ${lock.uuid} (lockId ${lock.lockId})`,
        orphanResult.reason,
      );
    }
    if (mempoolObservationResult.status === 'fulfilled') {
      mempoolObservation = mempoolObservationResult.value;
    } else {
      console.warn(
        `[BitcoinUtxoTracking] Failed to observe mempool funding for lock ${lock.uuid} (lockId ${lock.lockId})`,
        mempoolObservationResult.reason,
      );
    }

    const hasFundingUtxos = this.getFundingUtxos(lock).length > 0;
    const hasOrphan = this.getUtxosForLock(lock.lockId).some(record => record.status === BitcoinUtxoStatus.Orphaned);
    return hasFundingUtxos || hasOrphan || !!mempoolObservation;
  }

  public getLockProcessingDetails(lock: IBitcoinLockRecord): IBitcoinLockProcessingDetails {
    const receivedSatoshis = this.getReceivedFundingSatoshis(lock);
    const observedFundingUtxo = this.getObservedFundingUtxos(lock).at(-1);
    if (lock.status !== BitcoinLockStatus.LockPendingFunding && !observedFundingUtxo)
      return {
        progressPct: 100,
        confirmations: 6,
        expectedConfirmations: 6,
        receivedSatoshis,
      };

    const fundingUtxos = this.getFundingUtxos(lock);
    const fundingUtxo =
      observedFundingUtxo ??
      fundingUtxos.toSorted((left, right) => right.firstSeenAt.getTime() - left.firstSeenAt.getTime()).at(0);
    if (!fundingUtxo) {
      return {
        progressPct: 0,
        confirmations: -1,
        expectedConfirmations: 6,
        receivedSatoshis,
      };
    }

    return { ...this.getFundingUtxoProcessingDetails(fundingUtxo), receivedSatoshis };
  }

  public getFundingUtxoProcessingDetails(fundingUtxo: IBitcoinUtxoRecord): IBitcoinLockProcessingDetails {
    let expectedConfirmations = 6;
    if (!this.hasConfirmedBitcoinSignal(fundingUtxo)) {
      return { progressPct: 0, confirmations: -1, expectedConfirmations };
    }

    const recordedOracleHeight =
      fundingUtxo.firstSeenOracleHeight ?? fundingUtxo.mempoolObservation?.argonBitcoinHeight;
    const recordedTransactionHeight =
      fundingUtxo.firstSeenBitcoinHeight > 0
        ? fundingUtxo.firstSeenBitcoinHeight
        : (fundingUtxo.mempoolObservation?.transactionBlockHeight ?? this.deps.getOracleBitcoinBlockHeight());
    if (recordedOracleHeight && recordedTransactionHeight) {
      expectedConfirmations = Math.max(0, recordedTransactionHeight - recordedOracleHeight);
    }

    const timeOfLastBlock = fundingUtxo.lastConfirmationCheckAt || fundingUtxo.firstSeenAt;

    const blockProgress = new BlockProgress({
      blockHeightGoal: recordedTransactionHeight ?? undefined,
      blockHeightCurrent: this.deps.getOracleBitcoinBlockHeight(),
      minimumConfirmations: expectedConfirmations,
      millisPerBlock: BITCOIN_BLOCK_MILLIS,
      timeOfLastBlock: dayjs.utc(timeOfLastBlock),
    });

    const { progressPct } = blockProgress.getProgress();
    const confirmations = blockProgress.getConfirmations();
    expectedConfirmations = blockProgress.expectedConfirmations;

    return {
      progressPct,
      confirmations,
      expectedConfirmations,
    };
  }

  public getAllOrphanLifecycleUtxos(): IBitcoinUtxoRecord[] {
    return Object.values(this.data.utxosById).filter(record => record.status === BitcoinUtxoStatus.Orphaned);
  }

  public getUnresolvedOrphanRecords(locks: IBitcoinLockRecord[]): IBitcoinUtxoRecord[] {
    const lockIds = new Set(locks.map(lock => lock.lockId).filter(lockId => lockId !== undefined));

    return this.getAllOrphanLifecycleUtxos()
      .filter(record => lockIds.has(record.lockId) && record.spendStatus !== BitcoinUtxoSpendStatus.Spent)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  public async clearStatusError(record: IBitcoinUtxoRecord): Promise<void> {
    const table = await this.getTable();
    await table.clearStatusError(record);
  }

  public async setStatusError(record: IBitcoinUtxoRecord, error: string): Promise<void> {
    const table = await this.getTable();
    await table.setStatusError(record, error);
  }

  public async updateFundingLastConfirmationCheck(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.lockId || !this.shouldTrackFundingSignals(lock)) return;
    const fundingUtxos = this.getFundingUtxos(lock);
    const records = [...fundingUtxos, ...this.getObservedFundingUtxos(lock)];
    if (!records.length) return;
    const checkedAt = dayjs.utc().toDate();
    const oracleHeight = this.deps.getOracleBitcoinBlockHeight();
    const table = await this.getTable();
    await Promise.all(
      records.map(record => {
        record.lastConfirmationCheckAt = checkedAt;
        record.lastConfirmationCheckOracleHeight = oracleHeight;
        return table.updateLastConfirmationCheck(record);
      }),
    );
  }

  private shouldTrackFundingSignals(lock: IBitcoinLockRecord): boolean {
    return (
      lock.status !== BitcoinLockStatus.Released &&
      lock.status !== BitcoinLockStatus.LockFailed &&
      lock.status !== BitcoinLockStatus.LockFailedAcknowledged
    );
  }

  public async upsertUtxoRecord(
    lock: IBitcoinLockRecord,
    deposit: { txid: string; vout: number; satoshis: bigint },
    options?: {
      mempoolObservation?: IMempoolFundingObservation;
      markOrphaned?: boolean;
    },
  ): Promise<IBitcoinUtxoRecord> {
    if (!lock.lockId) throw new Error('Lock has no lockId for UTXO tracking.');
    const table = await this.getTable();
    const record = await this.persistUtxoRecord(
      table,
      lock,
      deposit,
      this.getObservedStatusForUpsert(options),
      options?.mempoolObservation,
    );
    return this.recordUtxo(record);
  }

  private async persistUtxoRecord(
    table: BitcoinUtxosTable,
    lock: IBitcoinLockRecord,
    deposit: { txid: string; vout: number; satoshis: bigint },
    observedStatus?: BitcoinUtxoStatus,
    mempoolObservation?: IMempoolFundingObservation,
  ): Promise<IBitcoinUtxoRecord> {
    if (!lock.lockId) throw new Error('Lock has no lockId for UTXO tracking.');

    const satoshis = deposit.satoshis;
    const wasSeenOnArgon =
      observedStatus === BitcoinUtxoStatus.FundingUtxo || observedStatus === BitcoinUtxoStatus.Orphaned;
    const seenOnArgonAt = wasSeenOnArgon ? dayjs.utc().toDate() : undefined;
    const existing = this.getUtxoRecord(lock.lockId, deposit.txid, deposit.vout);
    let record = existing ? { ...existing } : undefined;
    if (!record) {
      record = await table.insert({
        lockId: lock.lockId,
        txid: deposit.txid,
        vout: deposit.vout,
        satoshis,
        network: lock.network,
        status: observedStatus ?? BitcoinUtxoStatus.SeenOnMempool,
        spendStatus: BitcoinUtxoSpendStatus.Unspent,
        mempoolObservation,
        firstSeenAt: dayjs.utc().toDate(),
        firstSeenOnArgonAt: seenOnArgonAt,
        firstSeenBitcoinHeight: mempoolObservation?.transactionBlockHeight ?? 0,
      });
      if (mempoolObservation) {
        await table.updateMempoolObservation(record, mempoolObservation, this.deps.getOracleBitcoinBlockHeight());
      }
      return record;
    }

    let needsUpdate = false;
    if (this.shouldUpdateObservedStatus(record, observedStatus)) {
      record.status = observedStatus;
      needsUpdate = true;
    }
    if (record.satoshis !== satoshis) {
      record.satoshis = satoshis;
      needsUpdate = true;
    }
    if (wasSeenOnArgon && !record.firstSeenOnArgonAt) {
      record.firstSeenOnArgonAt = seenOnArgonAt ?? dayjs.utc().toDate();
      needsUpdate = true;
    }
    if (needsUpdate) {
      await table.updateObservedDeposit(record);
    }
    if (mempoolObservation) {
      await table.updateMempoolObservation(record, mempoolObservation, this.deps.getOracleBitcoinBlockHeight());
    }
    return record;
  }

  private recordUtxo(record: IBitcoinUtxoRecord): IBitcoinUtxoRecord {
    const existing = this.data.utxosById[record.id];
    const published = existing ?? record;
    if (existing && existing !== record) Object.assign(existing, record);

    this.data.utxosByKey[this.getUtxoKey(published.lockId, published.txid, published.vout)] = published;
    this.data.utxosById[published.id] = published;
    const lockUtxoIds = (this.data.utxoIdsByLockId[published.lockId] ??= []);
    if (!lockUtxoIds.includes(published.id)) lockUtxoIds.push(published.id);
    return published;
  }

  private getUtxoKey(lockId: number, txid: string, vout: number): string {
    return `${lockId}:${txid}:${vout}`;
  }

  public shouldUpdateObservedStatus(
    record: IBitcoinUtxoRecord,
    observedStatus?: BitcoinUtxoStatus,
  ): observedStatus is BitcoinUtxoStatus {
    if (!observedStatus) return false;
    if (record.status === observedStatus) return false;

    switch (observedStatus) {
      case BitcoinUtxoStatus.FundingUtxo:
        return record.status !== BitcoinUtxoStatus.FundingUtxo;
      case BitcoinUtxoStatus.Orphaned:
        return record.status !== BitcoinUtxoStatus.FundingUtxo;
      case BitcoinUtxoStatus.SeenOnMempool:
        return false;
      default:
        return false;
    }
  }

  public async getTable(): Promise<BitcoinUtxosTable> {
    const db = await this.deps.dbPromise;
    return db.bitcoinUtxosTable;
  }

  public getObservedStatusForUpsert(options?: {
    mempoolObservation?: IMempoolFundingObservation;
    markOrphaned?: boolean;
  }): BitcoinUtxoStatus | undefined {
    if (options?.markOrphaned) {
      return BitcoinUtxoStatus.Orphaned;
    }
    if (options?.mempoolObservation) {
      return BitcoinUtxoStatus.SeenOnMempool;
    }
    return undefined;
  }

  private hasConfirmedBitcoinSignal(record?: IBitcoinUtxoRecord): boolean {
    if (!record) return false;
    return record.firstSeenBitcoinHeight > 0 || record.mempoolObservation?.isConfirmed === true;
  }
}
