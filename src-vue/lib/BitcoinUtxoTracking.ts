import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { getPercent, MiningFrames, NetworkConfig } from '@argonprotocol/apps-core';
import { type ApiDecoration, type ArgonClient, type IBitcoinLockConfig } from '@argonprotocol/mainchain';
import {
  BitcoinUtxosTable,
  BitcoinUtxoStatus,
  IBitcoinUtxoRecord,
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
    supportsCandidateUtxos: boolean;
  };

  constructor(private readonly deps: IUtxoTrackingDeps) {
    this.data = {
      utxosByLockUtxoId: {},
      utxosByKey: {},
      utxosById: {},
      supportsCandidateUtxos: false,
    };
  }

  public get supportsCandidateUtxosEnabled(): boolean {
    return this.data.supportsCandidateUtxos;
  }

  public updateSupportsCandidateUtxos(apiClient: ApiDecoration<'promise'>): boolean {
    const candidateQuery = apiClient.query.bitcoinUtxos.candidateUtxoRefsByUtxoId;
    this.data.supportsCandidateUtxos = typeof candidateQuery === 'function';
    return this.data.supportsCandidateUtxos;
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
    if (lock.fundingUtxoRecord?.satoshis !== undefined) return lock.fundingUtxoRecord.satoshis;
    const fundingRecord = this.getAcceptedFundingRecordForLock(lock);
    if (fundingRecord?.satoshis !== undefined) return fundingRecord.satoshis;
    const candidate = this.getPreferredFundingCandidateRecord(lock);
    return this.getUtxoSatoshis(candidate);
  }

  public getFundingCandidateRecords(lock: IBitcoinLockRecord): IBitcoinUtxoRecord[] {
    return this.selectFundingCandidates(this.getUtxosForLock(lock));
  }

  public getPreferredFundingCandidateRecord(lock: IBitcoinLockRecord): IBitcoinUtxoRecord | undefined {
    const candidates = this.getFundingCandidateRecords(lock);
    if (!candidates.length) return undefined;
    return this.getPreferredCandidateFromList(candidates, lock.satoshis);
  }

  public getAcceptedFundingRecordForLock(lock: IBitcoinLockRecord): IBitcoinUtxoRecord | undefined {
    if (lock.fundingUtxoRecordId) {
      const record = this.getUtxoRecordById(lock.fundingUtxoRecordId);
      if (record) {
        lock.fundingUtxoRecord = record;
        return record;
      }
    }
    if (!lock.utxoId) return undefined;
    const records = this.data.utxosByLockUtxoId[lock.utxoId] ?? [];
    const record = records.find(x => x.status === BitcoinUtxoStatus.FundingUtxo);
    lock.fundingUtxoRecord = record;
    return record;
  }

  public async setAcceptedFundingRecordForLock(lock: IBitcoinLockRecord, record: IBitcoinUtxoRecord): Promise<void> {
    if (!lock.utxoId || record.lockUtxoId !== lock.utxoId) {
      throw new Error('Funding record does not belong to this lock.');
    }
    if (record.status !== BitcoinUtxoStatus.FundingUtxo) {
      const table = await this.getTable();
      await table.setFundingUtxo(record);
    }
    lock.fundingUtxoRecord = record;
  }

  public async refreshFundingCandidates(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.utxoId) return;

    const client = await this.deps.getMainchainClient(true);
    const archiveSupportsCandidates = this.updateSupportsCandidateUtxos(client);
    const archiveCandidates = archiveSupportsCandidates ? await this.syncArgonFundingCandidates(lock, client) : [];
    if (archiveCandidates.length) return;

    // Archive can lag candidate visibility briefly; fall back to latest head for UI responsiveness.
    const latestClient = await this.deps.getMainchainClient(false).catch(() => undefined);
    if (!latestClient) return;
    if (!this.updateSupportsCandidateUtxos(latestClient)) return;
    await this.syncArgonFundingCandidates(lock, latestClient);
  }

  public async syncArgonFundingCandidates(
    lock: IBitcoinLockRecord,
    apiClient: ApiDecoration<'promise'>,
  ): Promise<IBitcoinUtxoRecord[]> {
    if (!lock.utxoId || !this.supportsCandidateUtxosEnabled) return [];
    const records: IBitcoinUtxoRecord[] = [];
    const queryValue = await apiClient.query.bitcoinUtxos.candidateUtxoRefsByUtxoId(lock.utxoId);
    for (const [utxoRef, sats] of queryValue.entries()) {
      const record = await this.upsertUtxoRecord(
        lock,
        {
          txid: utxoRef.txid.toHex(),
          vout: utxoRef.outputIndex.toNumber(),
          satoshis: sats.toBigInt(),
        },
        { markArgonCandidate: true },
      );
      records.push(record);
    }
    return records;
  }

  public async observeMempoolFunding(lock: IBitcoinLockRecord): Promise<IMempoolFundingObservation | undefined> {
    if (!lock.utxoId) return undefined;
    // Mempool is a best-effort signal; Argon candidates remain the source of truth.
    const payToScriptAddress = lock.lockDetails.p2wshScriptHashHex;
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

    const argonCandidates = this.getUtxosForLock(lock).filter(record => !!record.firstSeenOnArgonAt);
    let chosenRecord: IBitcoinUtxoRecord | undefined;
    if (argonCandidates.length) {
      const preferredArgon = this.getPreferredCandidateFromList(argonCandidates, lock.satoshis);
      if (preferredArgon) {
        chosenRecord =
          mempoolRecords.find(record => record.txid === preferredArgon.txid && record.vout === preferredArgon.vout) ??
          preferredArgon;
      }
    }
    if (!chosenRecord) {
      const mempoolCandidates = mempoolRecords.length
        ? mempoolRecords
        : this.getUtxosForLock(lock).filter(record => !!record.mempoolObservation);
      chosenRecord = this.getPreferredCandidateFromList(mempoolCandidates, lock.satoshis) ?? mempoolCandidates[0];
    }

    return chosenRecord?.mempoolObservation;
  }

  public async syncPendingFundingSignals(lock: IBitcoinLockRecord): Promise<boolean> {
    if (!lock.utxoId || lock.status !== BitcoinLockStatus.LockPendingFunding) return false;
    await this.refreshFundingCandidates(lock);
    const mempoolObservation = await this.observeMempoolFunding(lock);
    const hasFundingRecord = !!this.getAcceptedFundingRecordForLock(lock);
    const hasFundingCandidates = this.getFundingCandidateRecords(lock).length > 0;
    return hasFundingRecord || hasFundingCandidates || !!mempoolObservation;
  }

  public getLockProcessingDetails(lock: IBitcoinLockRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    receivedSatoshis?: bigint;
    isInvalidAmount?: boolean;
  } {
    let expectedConfirmations = 6;
    let isInvalidAmount = false;
    const receivedSatoshis = this.getReceivedFundingSatoshis(lock);
    const allowedVariance = this.deps.getConfig()?.lockSatoshiAllowedVariance;
    if (receivedSatoshis !== undefined && allowedVariance !== undefined) {
      const diff =
        lock.satoshis > receivedSatoshis ? lock.satoshis - receivedSatoshis : receivedSatoshis - lock.satoshis;
      isInvalidAmount = diff > allowedVariance;
    }
    if (lock.status !== BitcoinLockStatus.LockPendingFunding)
      return {
        progressPct: 100,
        confirmations: 6,
        expectedConfirmations,
        receivedSatoshis,
        isInvalidAmount,
      };

    const fundingRecord =
      this.getAcceptedFundingRecordForLock(lock) ??
      this.getPreferredFundingCandidateRecord(lock) ??
      this.getUtxosForLock(lock).find(r => r.firstSeenBitcoinHeight > 0 || !!r.mempoolObservation);
    if (!fundingRecord || fundingRecord.firstSeenBitcoinHeight <= 0) {
      return {
        progressPct: 0,
        confirmations: -1,
        expectedConfirmations,
        receivedSatoshis,
        isInvalidAmount,
      };
    }

    const recordedOracleHeight = fundingRecord.firstSeenOracleHeight;
    const recordedTransactionHeight = fundingRecord.firstSeenBitcoinHeight;
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
      isInvalidAmount,
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
    const fundingRecord = lock.fundingUtxoRecord ?? this.getAcceptedFundingRecordForLock(lock);
    if (!fundingRecord && lock.status === BitcoinLockStatus.Released) {
      return { progressPct: 100, confirmations: 6, expectedConfirmations: 6 };
    }
    const details = this.getReleaseLifecycleProgress(fundingRecord);
    return { ...details, releaseError: details.error };
  }

  public getRequestReleaseByVaultProgress(
    lock: IBitcoinLockRecord,
    miningFrames: MiningFrames,
    lockReleaseCosignDeadlineFrames: number,
  ): number {
    if (lock.status !== BitcoinLockStatus.Releasing) return 0;
    const fundingRecord = lock.fundingUtxoRecord ?? this.getAcceptedFundingRecordForLock(lock);
    if (!fundingRecord) return 0;
    if (!this.hasFundingRecordReleaseSignal(fundingRecord)) return 0;
    if (this.isFundingRecordReleaseComplete(fundingRecord)) return 100;

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

  public async setReleaseCosign(
    record: IBitcoinUtxoRecord,
    args: { releaseCosignVaultSignature: Uint8Array; releaseCosignHeight?: number },
  ): Promise<void> {
    const table = await this.getTable();
    await table.setReleaseCosign(record, args);
  }

  public async setReleaseIsProcessingOnArgon(
    record: IBitcoinUtxoRecord,
    args: {
      requestedReleaseAtTick?: number;
      releaseToDestinationAddress: string;
      releaseBitcoinNetworkFee: bigint;
      releaseCosignVaultSignature?: Uint8Array;
      releaseCosignHeight?: number;
    },
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
    if (!lock.utxoId || lock.status !== BitcoinLockStatus.LockPendingFunding) return;
    const fundingRecord = this.getAcceptedFundingRecordForLock(lock) ?? this.getPreferredFundingCandidateRecord(lock);
    if (!fundingRecord) return;
    fundingRecord.lastConfirmationCheckAt = dayjs.utc().toDate();
    fundingRecord.lastConfirmationCheckOracleHeight = this.deps.getOracleBitcoinBlockHeight();
    const table = await this.getTable();
    await table.updateLastConfirmationCheck(fundingRecord);
  }

  public hasFundingRecordReleaseSignal(
    record: Pick<
      IBitcoinUtxoRecord,
      | 'status'
      | 'requestedReleaseAtTick'
      | 'releaseToDestinationAddress'
      | 'releaseBitcoinNetworkFee'
      | 'releaseCosignVaultSignature'
      | 'releaseTxid'
    >,
  ): boolean {
    return this.hasReleaseSignal(record);
  }

  public isFundingRecordReleaseComplete(
    record: Pick<IBitcoinUtxoRecord, 'status' | 'releasedAtBitcoinHeight'>,
  ): boolean {
    return this.isReleaseComplete(record);
  }

  public isFundingRecordReleaseProcessingOnBitcoin(
    record: Pick<IBitcoinUtxoRecord, 'status' | 'releaseTxid'>,
  ): boolean {
    return record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin || !!record.releaseTxid;
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
      | 'requestedReleaseAtTick'
      | 'releaseToDestinationAddress'
      | 'releaseBitcoinNetworkFee'
      | 'releaseCosignVaultSignature'
      | 'releaseTxid'
      | 'releasedAtBitcoinHeight'
    >,
  ): boolean {
    return (
      this.hasReleaseSignal(record) &&
      !this.isReleaseComplete(record) &&
      !this.isFundingRecordReleaseProcessingOnBitcoin(record) &&
      this.hasFundingRecordReleaseRequestDetails(record) &&
      !!record.releaseCosignVaultSignature
    );
  }

  public async upsertUtxoRecord(
    lock: IBitcoinLockRecord,
    candidate: { txid: string; vout: number; satoshis: bigint },
    options?: {
      mempoolObservation?: IMempoolFundingObservation;
      markArgonCandidate?: boolean;
      markFundingUtxo?: boolean;
    },
  ): Promise<IBitcoinUtxoRecord> {
    if (!lock.utxoId) {
      throw new Error('Lock has no utxoId for UTXO tracking.');
    }
    const table = await this.getTable();
    const satoshis = candidate.satoshis;
    const observedStatus = this.getObservedStatusForUpsert(lock, candidate, options);
    const shouldMarkArgonCandidateSeen = !!(options?.markArgonCandidate || options?.markFundingUtxo);
    const candidateSeenAt = shouldMarkArgonCandidateSeen ? dayjs.utc().toDate() : undefined;
    let record = this.getUtxoRecord(lock.utxoId, candidate.txid, candidate.vout);
    if (!record) {
      record = await table.insert({
        lockUtxoId: lock.utxoId,
        txid: candidate.txid,
        vout: candidate.vout,
        satoshis,
        network: lock.network,
        status: observedStatus ?? BitcoinUtxoStatus.FundingCandidate,
        mempoolObservation: options?.mempoolObservation,
        firstSeenAt: dayjs.utc().toDate(),
        firstSeenOnArgonAt: candidateSeenAt,
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
      if (options?.markFundingUtxo) {
        lock.fundingUtxoRecord = record;
      }
      return record;
    }

    let needsCandidateUpdate = false;
    if (
      observedStatus &&
      record.status !== BitcoinUtxoStatus.FundingUtxo &&
      !this.isReleaseLifecycleStatus(record.status) &&
      record.status !== observedStatus
    ) {
      record.status = observedStatus;
      needsCandidateUpdate = true;
    }
    if (record.satoshis !== satoshis) {
      record.satoshis = satoshis;
      needsCandidateUpdate = true;
    }
    if (shouldMarkArgonCandidateSeen && !record.firstSeenOnArgonAt) {
      record.firstSeenOnArgonAt = candidateSeenAt ?? dayjs.utc().toDate();
      needsCandidateUpdate = true;
    }
    if (needsCandidateUpdate) {
      await table.updateCandidate(record);
    }
    if (options?.mempoolObservation) {
      await table.updateMempoolObservation(record, options.mempoolObservation, this.deps.getOracleBitcoinBlockHeight());
    }
    this.recordUtxo(record);
    if (options?.markFundingUtxo) {
      lock.fundingUtxoRecord = record;
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

  public async getTable(): Promise<BitcoinUtxosTable> {
    const db = await this.deps.dbPromise;
    return db.bitcoinUtxosTable;
  }

  private getUtxoSatoshis(record?: IBitcoinUtxoRecord): bigint | undefined {
    if (!record) return undefined;
    return record.satoshis;
  }

  private getReleaseLifecycleProgress(record?: IBitcoinUtxoRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    error?: string;
  } {
    const expectedConfirmations = 6;
    if (!record) {
      return { progressPct: 0, confirmations: -1, expectedConfirmations };
    }
    if (record.status === BitcoinUtxoStatus.ReleaseComplete) {
      return { progressPct: 100, confirmations: 6, expectedConfirmations, error: record.statusError };
    }
    if (record.status !== BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
      return { progressPct: 0, confirmations: -1, expectedConfirmations, error: record.statusError };
    }
    const details = this.getReleaseProcessingDetails(record);
    return { ...details, error: record.statusError };
  }

  private selectFundingCandidates(candidates: IBitcoinUtxoRecord[]): IBitcoinUtxoRecord[] {
    if (!candidates.length) return [];
    const candidatePool = candidates.filter(record => {
      if (this.isReleaseLifecycleStatus(record.status)) return false;
      if (record.status === BitcoinUtxoStatus.FundingUtxo) return false;
      return true;
    });
    const argonCandidates = candidatePool.filter(record => !!record.firstSeenOnArgonAt);
    if (argonCandidates.length) return argonCandidates;
    const mempoolCandidates = candidatePool.filter(record => !!record.mempoolObservation);
    if (mempoolCandidates.length) return mempoolCandidates;
    return [];
  }

  private sortCandidatesByPreference(candidates: IBitcoinUtxoRecord[], targetSatoshis: bigint): IBitcoinUtxoRecord[] {
    return [...candidates].sort((a, b) => {
      const satsA = this.getUtxoSatoshis(a) ?? 0n;
      const satsB = this.getUtxoSatoshis(b) ?? 0n;
      const diffA = satsA >= targetSatoshis ? satsA - targetSatoshis : targetSatoshis - satsA;
      const diffB = satsB >= targetSatoshis ? satsB - targetSatoshis : targetSatoshis - satsB;
      if (diffA === diffB) return satsA > satsB ? -1 : 1;
      return diffA < diffB ? -1 : 1;
    });
  }

  private getPreferredCandidateFromList(
    candidates: IBitcoinUtxoRecord[],
    targetSatoshis: bigint,
  ): IBitcoinUtxoRecord | undefined {
    if (!candidates.length) return undefined;
    return this.sortCandidatesByPreference(candidates, targetSatoshis)[0];
  }

  private getObservedStatusForUpsert(
    _lock: IBitcoinLockRecord,
    _candidate: { txid: string; vout: number },
    options?: {
      mempoolObservation?: IMempoolFundingObservation;
      markArgonCandidate?: boolean;
      markFundingUtxo?: boolean;
    },
  ): BitcoinUtxoStatus | undefined {
    if (options?.markFundingUtxo) {
      return BitcoinUtxoStatus.FundingUtxo;
    }
    if (options?.markArgonCandidate) {
      return BitcoinUtxoStatus.FundingCandidate;
    }
    if (options?.mempoolObservation) {
      return BitcoinUtxoStatus.SeenOnMempool;
    }
    return undefined;
  }

  private isReleaseLifecycleStatus(status: BitcoinUtxoStatus): boolean {
    return [
      BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
      BitcoinUtxoStatus.ReleaseComplete,
    ].includes(status);
  }

  private hasReleaseSignal(
    record: Pick<
      IBitcoinUtxoRecord,
      | 'status'
      | 'requestedReleaseAtTick'
      | 'releaseToDestinationAddress'
      | 'releaseBitcoinNetworkFee'
      | 'releaseCosignVaultSignature'
      | 'releaseTxid'
    >,
  ): boolean {
    return (
      record.requestedReleaseAtTick != null ||
      !!record.releaseToDestinationAddress ||
      record.releaseBitcoinNetworkFee != null ||
      !!record.releaseCosignVaultSignature ||
      !!record.releaseTxid ||
      [
        BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
        BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
        BitcoinUtxoStatus.ReleaseComplete,
      ].includes(record.status)
    );
  }

  private isReleaseComplete(record: Pick<IBitcoinUtxoRecord, 'status' | 'releasedAtBitcoinHeight'>): boolean {
    return record.status === BitcoinUtxoStatus.ReleaseComplete || record.releasedAtBitcoinHeight != null;
  }
}
