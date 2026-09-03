import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import {
  type ArgonClient,
  type ArgonQueryClient,
  getPercent,
  MiningFrames,
  NetworkConfig,
  type IBitcoinLockConfig,
} from '@argonprotocol/apps-core';
import { u8aToHex } from '@argonprotocol/mainchain';
import {
  BitcoinUtxosTable,
  BitcoinUtxoRole,
  BitcoinUtxoStatus,
  IBitcoinUtxoRecord,
  isBitcoinUtxoReleaseStatus,
  type IConfirmedReleaseCosign,
  IMempoolFundingObservation,
} from './db/BitcoinUtxosTable.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
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
    utxosByLockUtxoId: { [utxoId: number]: IBitcoinUtxoRecord[] };
    utxosByKey: { [key: string]: IBitcoinUtxoRecord };
    utxosById: { [id: number]: IBitcoinUtxoRecord };
  };

  constructor(private readonly deps: IUtxoTrackingDeps) {
    this.data = {
      utxosByLockUtxoId: {},
      utxosByKey: {},
      utxosById: {},
    };
  }

  public async load(): Promise<void> {
    const table = await this.getTable();
    const records = await table.fetchAll();
    this.data.utxosByLockUtxoId = {};
    this.data.utxosByKey = {};
    this.data.utxosById = {};
    for (const record of records) {
      this.recordUtxo(record);
    }
  }

  public getUtxoRecord(lockUtxoId: number, txid: string, vout: number): IBitcoinUtxoRecord | undefined {
    return this.data.utxosByKey[this.getUtxoKey(lockUtxoId, txid, vout)];
  }

  public getUtxoRecordById(id: number): IBitcoinUtxoRecord | undefined {
    return this.data.utxosById[id];
  }

  public getUtxosForLock(lock: IBitcoinLockRecord): IBitcoinUtxoRecord[] {
    if (!lock.utxoId) return [];
    return this.data.utxosByLockUtxoId[lock.utxoId] ?? [];
  }

  public getReceivedFundingSatoshis(lock: IBitcoinLockRecord): bigint | undefined {
    if (lock.fundingUtxo?.satoshis !== undefined) return lock.fundingUtxo.satoshis;
    const fundingRecord = this.getAcceptedFundingRecordForLock(lock);
    if (fundingRecord?.satoshis !== undefined) return fundingRecord.satoshis;
    return this.getUtxoSatoshis(this.getObservedFundingRecord(lock));
  }

  public hasObservedFundingSignal(lock: IBitcoinLockRecord): boolean {
    return this.getReceivedFundingSatoshis(lock) !== undefined;
  }

  public getObservedFundingRecord(lock: IBitcoinLockRecord): IBitcoinUtxoRecord | undefined {
    return this.getUtxosForLock(lock)
      .filter(record => record.status === BitcoinUtxoStatus.SeenOnMempool)
      .sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime())[0];
  }

  public getAcceptedFundingRecordForLock(
    lock: IBitcoinLockRecord,
    records?: {
      getForLock: () => IBitcoinUtxoRecord[];
    },
  ): IBitcoinUtxoRecord | undefined {
    if (!lock.utxoId) return undefined;

    const recordsForLock = records ? records.getForLock() : this.getUtxosForLock(lock);
    const fundingRecords = recordsForLock.filter(record => record.role === BitcoinUtxoRole.Funding);
    if (fundingRecords.length > 1) {
      throw new Error(`Bitcoin lock ${lock.utxoId} has more than one funding UTXO in a single-funding runtime`);
    }
    const record = fundingRecords[0];
    lock.utxos = recordsForLock;
    lock.fundingUtxo = record;
    lock.fundedSatoshis = record?.satoshis ?? 0n;
    return record;
  }

  public async setAcceptedFundingRecordForLock(lock: IBitcoinLockRecord, record: IBitcoinUtxoRecord): Promise<void> {
    if (!lock.utxoId || record.lockUtxoId !== lock.utxoId) {
      throw new Error('Funding record does not belong to this lock.');
    }
    const existing = this.getUtxosForLock(lock).find(
      candidate => candidate.role === BitcoinUtxoRole.Funding && candidate.id !== record.id,
    );
    if (existing) {
      throw new Error(`Bitcoin lock ${lock.utxoId} already has funding UTXO ${existing.txid}:${existing.vout}`);
    }
    const table = await this.getTable();
    if (record.role !== BitcoinUtxoRole.Funding) {
      await table.setFundingUtxo(record);
    }

    lock.utxos = this.getUtxosForLock(lock);
    lock.fundingUtxo = record;
    lock.fundedSatoshis = record.satoshis;
  }

  public async syncArgonOrphans(
    locks: IBitcoinLockRecord[],
    apiClient: ArgonQueryClient,
  ): Promise<IBitcoinUtxoRecord[]> {
    const locksByOwner = new Map<string, IBitcoinLockRecord[]>();
    const records: IBitcoinUtxoRecord[] = [];

    for (const lock of locks) {
      if (!lock.utxoId) continue;
      if (!lock.ownerAccount) continue;
      const ownerLocks = locksByOwner.get(lock.ownerAccount) ?? [];
      ownerLocks.push(lock);
      locksByOwner.set(lock.ownerAccount, ownerLocks);
    }

    for (const [ownerAccount, ownerLocks] of locksByOwner) {
      const locksByUtxoId = new Map(ownerLocks.map(lock => [lock.utxoId, lock]));
      const entries = (await apiClient.query.bitcoinLocks.orphanedUtxosByAccount.entries(ownerAccount)) ?? [];

      for (const [orphanKey, orphanMaybe] of entries) {
        if (!orphanMaybe) continue;
        const orphan = orphanMaybe;
        const lock = locksByUtxoId.get(orphan.utxoId);
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

        if (orphan.cosignRequest) {
          const request = orphan.cosignRequest;
          await this.setReleaseIsProcessingOnArgon(record, {
            releaseToDestinationAddress: u8aToHex(request.toScriptPubkey, undefined, false),
            releaseBitcoinNetworkFee: request.bitcoinNetworkFee,
          });
        }
      }
    }
    return records;
  }

  public async observeMempoolFunding(lock: IBitcoinLockRecord): Promise<IMempoolFundingObservation | undefined> {
    if (!lock.utxoId) return undefined;
    // Mempool is a best-effort preview. The runtime-confirmed funding or orphan state remains authoritative.
    const payToScriptAddress = lock.scriptDetails?.p2wshScriptHashHex;
    if (!payToScriptAddress) throw new Error(`Bitcoin lock ${lock.utxoId} is missing its cosign script details`);
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

    return this.getObservedFundingRecord(lock)?.mempoolObservation;
  }

  public async syncPendingFundingSignals(
    lock: IBitcoinLockRecord,
    preferredClient?: ArgonQueryClient,
  ): Promise<boolean> {
    if (!lock.utxoId || !this.isFundingSignalTrackingStatus(lock.status)) return false;

    let mempoolObservation: IMempoolFundingObservation | undefined;

    const client = preferredClient ?? (await this.deps.getMainchainClient(true));
    const [orphanResult, mempoolObservationResult] = await Promise.allSettled([
      this.syncArgonOrphans([lock], client),
      this.observeMempoolFunding(lock),
    ]);

    if (orphanResult.status === 'rejected') {
      console.warn(
        `[BitcoinUtxoTracking] Failed to refresh Argon orphans for lock ${lock.uuid} (utxoId ${lock.utxoId})`,
        orphanResult.reason,
      );
    }
    if (mempoolObservationResult.status === 'fulfilled') {
      mempoolObservation = mempoolObservationResult.value;
    } else {
      console.warn(
        `[BitcoinUtxoTracking] Failed to observe mempool funding for lock ${lock.uuid} (utxoId ${lock.utxoId})`,
        mempoolObservationResult.reason,
      );
    }

    const hasFundingRecord = !!this.getAcceptedFundingRecordForLock(lock);
    const hasOrphan = this.getUtxosForLock(lock).some(record => record.role === BitcoinUtxoRole.Orphan);
    return hasFundingRecord || hasOrphan || !!mempoolObservation;
  }

  public getLockProcessingDetails(lock: IBitcoinLockRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    receivedSatoshis?: bigint;
  } {
    let expectedConfirmations = 6;
    const receivedSatoshis = this.getReceivedFundingSatoshis(lock);
    if (!this.isFundingSignalTrackingStatus(lock.status))
      return {
        progressPct: 100,
        confirmations: 6,
        expectedConfirmations,
        receivedSatoshis,
      };

    const fundingRecord = this.getAcceptedFundingRecordForLock(lock) ?? this.getObservedFundingRecord(lock);
    const hasConfirmedBitcoinSignal = this.hasConfirmedBitcoinSignal(fundingRecord);
    if (!fundingRecord || !hasConfirmedBitcoinSignal) {
      return {
        progressPct: 0,
        confirmations: -1,
        expectedConfirmations,
        receivedSatoshis,
      };
    }

    const recordedOracleHeight =
      fundingRecord.firstSeenOracleHeight ?? fundingRecord.mempoolObservation?.argonBitcoinHeight;
    const recordedTransactionHeight =
      fundingRecord.firstSeenBitcoinHeight > 0
        ? fundingRecord.firstSeenBitcoinHeight
        : (fundingRecord.mempoolObservation?.transactionBlockHeight ?? this.deps.getOracleBitcoinBlockHeight());
    if (recordedOracleHeight && recordedTransactionHeight) {
      expectedConfirmations = Math.max(0, recordedTransactionHeight - recordedOracleHeight);
    }

    const timeOfLastBlock = fundingRecord.lastConfirmationCheckAt || fundingRecord.firstSeenAt;

    const blockProgress = new BlockProgress({
      blockHeightGoal: recordedTransactionHeight ?? undefined,
      blockHeightCurrent: this.deps.getOracleBitcoinBlockHeight(),
      minimumConfirmations: expectedConfirmations,
      millisPerBlock: BITCOIN_BLOCK_MILLIS,
      timeOfLastBlock: dayjs.utc(timeOfLastBlock),
    });

    const progressPct = blockProgress.getProgress();
    const confirmations = blockProgress.getConfirmations();
    expectedConfirmations = blockProgress.expectedConfirmations;

    return {
      progressPct,
      confirmations,
      expectedConfirmations,
      receivedSatoshis,
    };
  }

  public getReleaseProcessingDetails(record?: IBitcoinUtxoRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
  } {
    let expectedConfirmations = 6;
    if (!record || !record.releaseFirstSeenAt) {
      return { progressPct: 0, confirmations: -1, expectedConfirmations };
    }

    const recordedOracleHeight = record.releaseFirstSeenOracleHeight;
    const recordedTransactionHeight = record.releaseFirstSeenBitcoinHeight;
    if (recordedOracleHeight && recordedTransactionHeight) {
      expectedConfirmations = Math.max(0, recordedTransactionHeight - recordedOracleHeight);
    }

    const timeOfLastBlock = record.releaseLastConfirmationCheckAt || record.releaseFirstSeenAt;

    const blockProgress = new BlockProgress({
      blockHeightGoal: recordedTransactionHeight,
      blockHeightCurrent: this.deps.getOracleBitcoinBlockHeight(),
      minimumConfirmations: expectedConfirmations,
      millisPerBlock: BITCOIN_BLOCK_MILLIS,
      timeOfLastBlock: dayjs.utc(timeOfLastBlock),
    });

    const progressPct = blockProgress.getProgress();
    const confirmations = blockProgress.getConfirmations();
    expectedConfirmations = blockProgress.expectedConfirmations;

    return { progressPct, confirmations, expectedConfirmations };
  }

  public getLockReleaseProcessingDetails(lock: IBitcoinLockRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    releaseError?: string;
  } {
    const fundingRecord = lock.fundingUtxo ?? this.getAcceptedFundingRecordForLock(lock);
    if (!fundingRecord && lock.status === BitcoinLockStatus.Released) {
      return { progressPct: 100, confirmations: 6, expectedConfirmations: 6 };
    }
    const details = this.getReleaseLifecycleProgress(fundingRecord);
    return { ...details, releaseError: details.error };
  }

  public getAllOrphanLifecycleUtxos(): IBitcoinUtxoRecord[] {
    return Object.values(this.data.utxosByLockUtxoId)
      .flat()
      .filter(record => record.role === BitcoinUtxoRole.Orphan);
  }

  public getUnresolvedOrphanRecords(locks: IBitcoinLockRecord[]): IBitcoinUtxoRecord[] {
    const fundingRecordIds = new Set(
      locks.map(lock => this.getAcceptedFundingRecordForLock(lock)?.id).filter((id): id is number => id !== undefined),
    );

    return this.getAllOrphanLifecycleUtxos()
      .filter(record => !fundingRecordIds.has(record.id) && !this.isReleaseCompleteStatus(record.status))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  public getRequestReleaseByVaultProgress(
    lock: IBitcoinLockRecord,
    miningFrames: MiningFrames,
    lockReleaseCosignDeadlineFrames: number,
  ): number {
    if (lock.status !== BitcoinLockStatus.Releasing) return 0;
    const fundingRecord = lock.fundingUtxo ?? this.getAcceptedFundingRecordForLock(lock);
    if (!fundingRecord) return 0;
    if (!this.isReleaseStatus(fundingRecord.status)) return 0;
    if (this.isReleaseCompleteStatus(fundingRecord.status)) return 100;

    const startTick = fundingRecord.requestedReleaseAtTick;
    if (!startTick) return 0;
    const startFrame = miningFrames.getForTick(startTick);
    const dueFrame = startFrame + lockReleaseCosignDeadlineFrames;
    const startTickOfDue = miningFrames.estimateTickStart(dueFrame);
    const totalTicks = startTickOfDue + NetworkConfig.rewardTicksPerFrame - startTick;
    return getPercent(miningFrames.currentTick - startTick, totalTicks);
  }

  public async setReleaseRequest(
    record: IBitcoinUtxoRecord,
    args: { requestedReleaseAtTick: number; releaseToDestinationAddress: string; releaseBitcoinNetworkFee: bigint },
  ): Promise<void> {
    const table = await this.getTable();
    await table.setReleaseRequest(record, args);
  }

  public async setReleaseCosign(record: IBitcoinUtxoRecord, args: IConfirmedReleaseCosign): Promise<void> {
    const table = await this.getTable();
    await table.setReleaseCosign(record, args);
  }

  public async setReleaseIsProcessingOnArgon(
    record: IBitcoinUtxoRecord,
    args:
      | {
          requestedReleaseAtTick?: number;
          releaseToDestinationAddress: string;
          releaseBitcoinNetworkFee: bigint;
          releaseCosignVaultSignature?: undefined;
          releaseCosignHeight?: undefined;
        }
      | ({
          requestedReleaseAtTick?: number;
          releaseToDestinationAddress: string;
          releaseBitcoinNetworkFee: bigint;
        } & IConfirmedReleaseCosign),
  ): Promise<void> {
    const table = await this.getTable();
    await table.setReleaseIsProcessingOnArgon(record, args);
  }

  public async setReleaseSeenOnBitcoin(
    record: IBitcoinUtxoRecord,
    releaseTxid: string,
    mempoolBitcoinBlockHeight: number,
  ): Promise<void> {
    const table = await this.getTable();
    await table.setReleaseSeenOnBitcoin(
      record,
      releaseTxid,
      mempoolBitcoinBlockHeight,
      this.deps.getOracleBitcoinBlockHeight(),
    );
  }

  public async setReleaseSeenOnBitcoinAndProcessing(
    record: IBitcoinUtxoRecord,
    releaseTxid: string,
    mempoolBitcoinBlockHeight: number,
  ): Promise<void> {
    const table = await this.getTable();
    await table.setReleaseSeenOnBitcoin(
      record,
      releaseTxid,
      mempoolBitcoinBlockHeight,
      this.deps.getOracleBitcoinBlockHeight(),
    );
    await table.setReleaseIsProcessingOnBitcoin(record);
  }

  public async setReleaseComplete(record: IBitcoinUtxoRecord, releasedAtBitcoinHeight?: number): Promise<void> {
    const table = await this.getTable();
    await table.setReleaseComplete(record, releasedAtBitcoinHeight);
  }

  public async setReleaseCompleteAcknowledged(record: IBitcoinUtxoRecord): Promise<void> {
    const table = await this.getTable();
    await table.setReleaseCompleteAcknowledged(record);
  }

  public async setReleaseError(record: IBitcoinUtxoRecord, error: string): Promise<void> {
    const table = await this.getTable();
    await table.setReleaseError(record, error);
  }

  public async clearStatusError(record: IBitcoinUtxoRecord): Promise<void> {
    const table = await this.getTable();
    await table.clearStatusError(record);
  }

  public async setStatusError(record: IBitcoinUtxoRecord, error: string): Promise<void> {
    const table = await this.getTable();
    await table.setStatusError(record, error);
  }

  public async updateReleaseLastConfirmationCheck(record: IBitcoinUtxoRecord): Promise<void> {
    record.releaseLastConfirmationCheckAt = new Date();
    record.releaseLastConfirmationCheckOracleHeight = this.deps.getOracleBitcoinBlockHeight();
    const table = await this.getTable();
    await table.updateReleaseLastConfirmationCheck(record);
  }

  public async updateFundingLastConfirmationCheck(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.utxoId || !this.isFundingSignalTrackingStatus(lock.status)) return;
    const fundingRecord = this.getAcceptedFundingRecordForLock(lock) ?? this.getObservedFundingRecord(lock);
    if (!fundingRecord) return;
    fundingRecord.lastConfirmationCheckAt = dayjs.utc().toDate();
    fundingRecord.lastConfirmationCheckOracleHeight = this.deps.getOracleBitcoinBlockHeight();
    const table = await this.getTable();
    await table.updateLastConfirmationCheck(fundingRecord);
  }

  private isFundingSignalTrackingStatus(status: BitcoinLockStatus): boolean {
    return status === BitcoinLockStatus.LockPendingFunding;
  }

  public isFundingRecordReleaseProcessingOnBitcoin(record: Pick<IBitcoinUtxoRecord, 'status'>): boolean {
    return record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;
  }

  public hasFundingRecordReleaseRequestDetails(
    record: Pick<IBitcoinUtxoRecord, 'releaseToDestinationAddress' | 'releaseBitcoinNetworkFee'>,
  ): boolean {
    return !!record.releaseToDestinationAddress && record.releaseBitcoinNetworkFee != null;
  }

  public canSubmitFundingRecordReleaseToBitcoin(
    record: Pick<
      IBitcoinUtxoRecord,
      | 'status'
      | 'releaseToDestinationAddress'
      | 'releaseBitcoinNetworkFee'
      | 'releaseCosignVaultSignature'
      | 'releaseCosignHeight'
    >,
  ): boolean {
    return (
      this.isReleaseStatus(record.status) &&
      !this.isReleaseCompleteStatus(record.status) &&
      !this.isFundingRecordReleaseProcessingOnBitcoin(record) &&
      this.hasFundingRecordReleaseRequestDetails(record) &&
      !!record.releaseCosignVaultSignature &&
      record.releaseCosignHeight != null
    );
  }

  public async upsertUtxoRecord(
    lock: IBitcoinLockRecord,
    deposit: { txid: string; vout: number; satoshis: bigint },
    options?: {
      mempoolObservation?: IMempoolFundingObservation;
      markOrphaned?: boolean;
      markFundingUtxo?: boolean;
    },
  ): Promise<IBitcoinUtxoRecord> {
    if (!lock.utxoId) {
      throw new Error('Lock has no utxoId for UTXO tracking.');
    }
    const table = await this.getTable();
    const satoshis = deposit.satoshis;
    const observedStatus = this.getObservedStatusForUpsert(options);
    let observedRole: BitcoinUtxoRole | undefined;
    if (options?.markFundingUtxo) observedRole = BitcoinUtxoRole.Funding;
    else if (options?.markOrphaned) observedRole = BitcoinUtxoRole.Orphan;
    const wasSeenOnArgon = !!(options?.markOrphaned || options?.markFundingUtxo);
    const seenOnArgonAt = wasSeenOnArgon ? dayjs.utc().toDate() : undefined;
    let record = this.getUtxoRecord(lock.utxoId, deposit.txid, deposit.vout);
    if (!record) {
      record = await table.insert({
        lockUtxoId: lock.utxoId,
        txid: deposit.txid,
        vout: deposit.vout,
        satoshis,
        network: lock.network,
        role: observedRole,
        status: observedStatus ?? BitcoinUtxoStatus.SeenOnMempool,
        mempoolObservation: options?.mempoolObservation,
        firstSeenAt: dayjs.utc().toDate(),
        firstSeenOnArgonAt: seenOnArgonAt,
        firstSeenBitcoinHeight: options?.mempoolObservation?.transactionBlockHeight ?? 0,
      });
      if (options?.mempoolObservation) {
        await table.updateMempoolObservation(
          record,
          options.mempoolObservation,
          this.deps.getOracleBitcoinBlockHeight(),
        );
      }
      this.recordUtxo(record);
      lock.utxos = this.getUtxosForLock(lock);
      if (options?.markFundingUtxo) {
        lock.fundingUtxo = record;
        lock.fundedSatoshis = record.satoshis;
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
    if (observedRole && record.role !== observedRole) {
      record.role = observedRole;
      needsUpdate = true;
    }
    if (wasSeenOnArgon && !record.firstSeenOnArgonAt) {
      record.firstSeenOnArgonAt = seenOnArgonAt ?? dayjs.utc().toDate();
      needsUpdate = true;
    }
    if (needsUpdate) {
      await table.updateObservedDeposit(record);
    }
    if (options?.mempoolObservation) {
      await table.updateMempoolObservation(record, options.mempoolObservation, this.deps.getOracleBitcoinBlockHeight());
    }
    this.recordUtxo(record);
    lock.utxos = this.getUtxosForLock(lock);
    if (options?.markFundingUtxo) {
      lock.fundingUtxo = record;
      lock.fundedSatoshis = record.satoshis;
    }
    return record;
  }

  private recordUtxo(record: IBitcoinUtxoRecord) {
    this.data.utxosByKey[this.getUtxoKey(record.lockUtxoId, record.txid, record.vout)] = record;
    this.data.utxosById[record.id] = record;
    const list = this.data.utxosByLockUtxoId[record.lockUtxoId] ?? [];
    const existingIndex = list.findIndex(existing => existing.txid === record.txid && existing.vout === record.vout);
    if (existingIndex >= 0) {
      list[existingIndex] = record;
    } else {
      list.push(record);
    }
    this.data.utxosByLockUtxoId[record.lockUtxoId] = list;
  }

  private getUtxoKey(lockUtxoId: number, txid: string, vout: number): string {
    return `${lockUtxoId}:${txid}:${vout}`;
  }

  public shouldUpdateObservedStatus(
    record: IBitcoinUtxoRecord,
    observedStatus?: BitcoinUtxoStatus,
  ): observedStatus is BitcoinUtxoStatus {
    if (!observedStatus) return false;
    if (record.status === observedStatus) return false;

    switch (observedStatus) {
      case BitcoinUtxoStatus.FundingUtxo:
        return !this.isReleaseStatus(record.status) && record.status !== BitcoinUtxoStatus.FundingUtxo;
      case BitcoinUtxoStatus.Orphaned:
        return !this.isReleaseStatus(record.status) && record.status !== BitcoinUtxoStatus.FundingUtxo;
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

  private getUtxoSatoshis(record?: IBitcoinUtxoRecord): bigint | undefined {
    if (!record) return undefined;
    return record.satoshis;
  }

  public getReleaseLifecycleProgress(record?: IBitcoinUtxoRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    error?: string;
  } {
    const expectedConfirmations = 6;
    if (!record) {
      return { progressPct: 0, confirmations: -1, expectedConfirmations };
    }
    if (
      record.status === BitcoinUtxoStatus.ReleaseComplete ||
      record.status === BitcoinUtxoStatus.ReleaseCompleteAcknowledged
    ) {
      return { progressPct: 100, confirmations: 6, expectedConfirmations, error: record.statusError };
    }
    if (record.status !== BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
      return { progressPct: 0, confirmations: -1, expectedConfirmations, error: record.statusError };
    }
    const details = this.getReleaseProcessingDetails(record);
    return { ...details, error: record.statusError };
  }

  public getObservedStatusForUpsert(options?: {
    mempoolObservation?: IMempoolFundingObservation;
    markOrphaned?: boolean;
    markFundingUtxo?: boolean;
  }): BitcoinUtxoStatus | undefined {
    if (options?.markFundingUtxo) {
      return BitcoinUtxoStatus.FundingUtxo;
    }
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

  public isReleaseStatus(status: BitcoinUtxoStatus | undefined): boolean {
    return isBitcoinUtxoReleaseStatus(status);
  }

  public isReleaseCompleteStatus(status: BitcoinUtxoStatus | undefined): boolean {
    return status === BitcoinUtxoStatus.ReleaseComplete || status === BitcoinUtxoStatus.ReleaseCompleteAcknowledged;
  }

  public isReleaseProcessingStatus(status: BitcoinUtxoStatus | undefined): boolean {
    return (
      status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon ||
      status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin
    );
  }
}
