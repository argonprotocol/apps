import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import {
  getPercent,
  MiningFrames,
  NetworkConfig,
  queryCandidateUtxoRefsByUtxoId,
  supportsCandidateUtxoRefsByUtxoId,
} from '@argonprotocol/apps-core';
import { type ApiDecoration, type ArgonClient, type IBitcoinLockConfig } from '@argonprotocol/mainchain';
import {
  BitcoinUtxosTable,
  BitcoinUtxoStatus,
  IBitcoinUtxoRecord,
  IMempoolFundingObservation,
  type IConfirmedReleaseCosign,
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
    this.data.supportsCandidateUtxos = supportsCandidateUtxoRefsByUtxoId(apiClient);
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
    if (lock.fundingUtxoRecord?.lockUtxoId === lock.utxoId) {
      return lock.fundingUtxoRecord;
    }

    if (lock.fundingUtxoRecordId) {
      const record = this.getUtxoRecordById(lock.fundingUtxoRecordId);
      if (record?.lockUtxoId === lock.utxoId) {
        lock.fundingUtxoRecord = record;
        return record;
      }
    }
    if (!lock.utxoId) return undefined;
    const records = this.data.utxosByLockUtxoId[lock.utxoId] ?? [];
    const record = [...records]
      .filter(x => x.status === BitcoinUtxoStatus.FundingUtxo)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    lock.fundingUtxoRecord = record;
    return record;
  }

  public async setAcceptedFundingRecordForLock(lock: IBitcoinLockRecord, record: IBitcoinUtxoRecord): Promise<void> {
    if (!lock.utxoId || record.lockUtxoId !== lock.utxoId) {
      throw new Error('Funding record does not belong to this lock.');
    }
    const table = await this.getTable();
    if (record.status !== BitcoinUtxoStatus.FundingUtxo) {
      await table.setFundingUtxo(record);
    }

    for (const siblingRecord of this.getUtxosForLock(lock)) {
      if (siblingRecord.id === record.id) continue;
      if (siblingRecord.status !== BitcoinUtxoStatus.FundingCandidate) continue;
      await table.setOrphaned(siblingRecord);
    }

    lock.fundingUtxoRecordId = record.id;
    lock.fundingUtxoRecord = record;
  }

  public async refreshFundingCandidates(
    lock: IBitcoinLockRecord,
    preferredClient?: ApiDecoration<'promise'>,
  ): Promise<void> {
    if (!lock.utxoId) return;

    if (preferredClient) {
      const preferredSupportsCandidates = this.updateSupportsCandidateUtxos(preferredClient);
      const preferredCandidates = preferredSupportsCandidates
        ? await this.syncArgonFundingCandidates(lock, preferredClient)
        : [];
      const preferredOrphans = await this.syncArgonOrphanedCandidates(lock, preferredClient);
      if (preferredCandidates.length || preferredOrphans.length) return;
    }

    const client = await this.deps.getMainchainClient(true);
    const archiveSupportsCandidates = this.updateSupportsCandidateUtxos(client);
    const archiveCandidates = archiveSupportsCandidates ? await this.syncArgonFundingCandidates(lock, client) : [];
    const archiveOrphans = await this.syncArgonOrphanedCandidates(lock, client);
    if (archiveCandidates.length || archiveOrphans.length) return;

    // Archive can lag candidate visibility briefly; fall back to latest head for UI responsiveness.
    const latestClient = await this.deps.getMainchainClient(false).catch(() => undefined);
    if (!latestClient) return;
    if (this.updateSupportsCandidateUtxos(latestClient)) {
      await this.syncArgonFundingCandidates(lock, latestClient);
    }
    await this.syncArgonOrphanedCandidates(lock, latestClient);
  }

  public async syncArgonFundingCandidates(
    lock: IBitcoinLockRecord,
    apiClient: ApiDecoration<'promise'>,
  ): Promise<IBitcoinUtxoRecord[]> {
    if (!lock.utxoId) return [];

    const records: IBitcoinUtxoRecord[] = [];
    const queryValue = await queryCandidateUtxoRefsByUtxoId(apiClient, lock.utxoId);
    if (!queryValue) return [];

    for (const [utxoRef, sats] of queryValue.entries()) {
      const txid = utxoRef.txid.toHex();
      const vout = utxoRef.outputIndex.toNumber();
      const satoshis = sats.toBigInt();
      const record = await this.upsertUtxoRecord(
        lock,
        {
          txid,
          vout,
          satoshis,
        },
        { markArgonCandidate: true },
      );
      records.push(record);
    }
    return records;
  }

  public async syncArgonOrphanedCandidates(
    lock: IBitcoinLockRecord,
    apiClient: ApiDecoration<'promise'>,
  ): Promise<IBitcoinUtxoRecord[]> {
    if (!lock.utxoId) return [];

    const entries = await apiClient.query.bitcoinLocks.orphanedUtxosByAccount.entries(lock.lockDetails.ownerAccount);
    if (!entries.length) return [];

    const records: IBitcoinUtxoRecord[] = [];
    for (const [orphanKey, orphanMaybe] of entries) {
      if (orphanMaybe.isNone) continue;
      const orphan = orphanMaybe.unwrap();
      if (orphan.utxoId.toNumber() !== lock.utxoId) continue;

      const utxoRef = orphanKey.args[1];
      const record = await this.upsertUtxoRecord(
        lock,
        {
          txid: utxoRef.txid.toHex(),
          vout: utxoRef.outputIndex.toNumber(),
          satoshis: orphan.satoshis.toBigInt(),
        },
        { markOrphaned: true },
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

    const argonCandidates = this.getFundingCandidateRecords(lock).filter(record => !!record.firstSeenOnArgonAt);
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
        ? mempoolRecords.filter(
            record => record.status !== BitcoinUtxoStatus.FundingUtxo && !this.isReleaseStatus(record.status),
          )
        : this.getFundingCandidateRecords(lock).filter(record => !!record.mempoolObservation);
      chosenRecord = this.getPreferredCandidateFromList(mempoolCandidates, lock.satoshis) ?? mempoolCandidates[0];
    }

    return chosenRecord?.mempoolObservation;
  }

  public async syncPendingFundingSignals(
    lock: IBitcoinLockRecord,
    preferredClient?: ApiDecoration<'promise'>,
  ): Promise<boolean> {
    if (!lock.utxoId || !this.isFundingSignalTrackingStatus(lock.status)) return false;
    await this.refreshFundingCandidates(lock, preferredClient);
    const mempoolObservation = await this.observeMempoolFunding(lock);
    const hasFundingRecord = !!this.getAcceptedFundingRecordForLock(lock);
    const hasFundingCandidates = this.getFundingCandidateRecords(lock).length > 0;
    const hasOrphanedCandidates = this.getUtxosForLock(lock).some(
      record => record.status === BitcoinUtxoStatus.Orphaned,
    );
    return hasFundingRecord || hasFundingCandidates || hasOrphanedCandidates || !!mempoolObservation;
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
    if (!this.isFundingSignalTrackingStatus(lock.status))
      return {
        progressPct: 100,
        confirmations: 6,
        expectedConfirmations,
        receivedSatoshis,
        isInvalidAmount,
      };

    const fallbackObservedRecord = [...this.getUtxosForLock(lock)]
      .filter(r => !this.isReleaseStatus(r.status) && (r.firstSeenBitcoinHeight > 0 || !!r.mempoolObservation))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    const fundingRecord =
      this.getAcceptedFundingRecordForLock(lock) ??
      this.getPreferredFundingCandidateRecord(lock) ??
      fallbackObservedRecord;
    const hasConfirmedBitcoinSignal =
      !!fundingRecord &&
      (fundingRecord.firstSeenBitcoinHeight > 0 || fundingRecord.mempoolObservation?.isConfirmed === true);
    if (!fundingRecord || !hasConfirmedBitcoinSignal) {
      return {
        progressPct: 0,
        confirmations: -1,
        expectedConfirmations,
        receivedSatoshis,
        isInvalidAmount,
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

  public getMismatchOrphanReleases(
    lockUtxoId: number,
    candidateRecord?: Pick<IBitcoinUtxoRecord, 'id' | 'txid' | 'vout'>,
    fundingUtxoRecordId?: number,
  ): IBitcoinUtxoRecord[] {
    const records = (this.data.utxosByLockUtxoId[lockUtxoId] ?? []).filter(record => {
      if (!this.isMismatchOrphanLifecycleRecord(record, fundingUtxoRecordId)) return false;
      if (!candidateRecord) return true;
      return this.isSameCandidate(record, candidateRecord);
    });
    return records.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  public getAllOrphanLifecycleUtxos(): IBitcoinUtxoRecord[] {
    return Object.values(this.data.utxosByLockUtxoId)
      .flat()
      .filter(record => this.isMismatchOrphanLifecycleRecord(record));
  }

  public getRequestReleaseByVaultProgress(
    lock: IBitcoinLockRecord,
    miningFrames: MiningFrames,
    lockReleaseCosignDeadlineFrames: number,
  ): number {
    if (lock.status !== BitcoinLockStatus.Releasing) return 0;
    const fundingRecord = lock.fundingUtxoRecord ?? this.getAcceptedFundingRecordForLock(lock);
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
    const fundingRecord = this.getAcceptedFundingRecordForLock(lock) ?? this.getPreferredFundingCandidateRecord(lock);
    if (!fundingRecord) return;
    fundingRecord.lastConfirmationCheckAt = dayjs.utc().toDate();
    fundingRecord.lastConfirmationCheckOracleHeight = this.deps.getOracleBitcoinBlockHeight();
    const table = await this.getTable();
    await table.updateLastConfirmationCheck(fundingRecord);
  }

  private isFundingSignalTrackingStatus(status: BitcoinLockStatus): boolean {
    return [
      BitcoinLockStatus.LockPendingFunding,
      BitcoinLockStatus.LockExpiredWaitingForFunding,
      BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged,
    ].includes(status);
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
    candidate: { txid: string; vout: number; satoshis: bigint },
    options?: {
      mempoolObservation?: IMempoolFundingObservation;
      markArgonCandidate?: boolean;
      markOrphaned?: boolean;
      markFundingUtxo?: boolean;
    },
  ): Promise<IBitcoinUtxoRecord> {
    if (!lock.utxoId) {
      throw new Error('Lock has no utxoId for UTXO tracking.');
    }
    const table = await this.getTable();
    const satoshis = candidate.satoshis;
    const observedStatus = this.getObservedStatusForUpsert(lock, candidate, options);
    const shouldMarkArgonCandidateSeen = !!(
      options?.markArgonCandidate ||
      options?.markOrphaned ||
      options?.markFundingUtxo
    );
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
        lock.fundingUtxoRecordId = record.id;
        lock.fundingUtxoRecord = record;
      }
      return record;
    }

    let needsCandidateUpdate = false;
    if (
      observedStatus &&
      record.status !== BitcoinUtxoStatus.FundingUtxo &&
      !this.isReleaseStatus(record.status) &&
      record.status !== observedStatus &&
      !(record.status === BitcoinUtxoStatus.Orphaned && observedStatus === BitcoinUtxoStatus.FundingCandidate)
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
      lock.fundingUtxoRecordId = record.id;
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

  private selectFundingCandidates(candidates: IBitcoinUtxoRecord[]): IBitcoinUtxoRecord[] {
    if (!candidates.length) return [];
    const candidatePool = candidates.filter(record => {
      if (this.isReleaseStatus(record.status)) return false;
      if (record.status === BitcoinUtxoStatus.FundingUtxo) return false;
      if (record.status === BitcoinUtxoStatus.Orphaned) return false;
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
      markOrphaned?: boolean;
      markFundingUtxo?: boolean;
    },
  ): BitcoinUtxoStatus | undefined {
    if (options?.markFundingUtxo) {
      return BitcoinUtxoStatus.FundingUtxo;
    }
    if (options?.markOrphaned) {
      return BitcoinUtxoStatus.Orphaned;
    }
    if (options?.markArgonCandidate) {
      return BitcoinUtxoStatus.FundingCandidate;
    }
    if (options?.mempoolObservation) {
      return BitcoinUtxoStatus.SeenOnMempool;
    }
    return undefined;
  }

  public isReleaseStatus(status: BitcoinUtxoStatus | undefined): boolean {
    return this.isReleaseProcessingStatus(status) || this.isReleaseCompleteStatus(status);
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

  private isMismatchOrphanLifecycleRecord(record: IBitcoinUtxoRecord, fundingUtxoRecordId?: number): boolean {
    if (!this.isReleaseStatus(record.status)) return false;
    if (record.status === BitcoinUtxoStatus.FundingUtxo) return false;
    if (record.status === BitcoinUtxoStatus.ReleaseCompleteAcknowledged) return false;
    if (fundingUtxoRecordId != null && record.id === fundingUtxoRecordId) return false;
    return true;
  }

  private isSameCandidate(
    record: Pick<IBitcoinUtxoRecord, 'id' | 'txid' | 'vout'>,
    candidateRecord: Pick<IBitcoinUtxoRecord, 'id' | 'txid' | 'vout'>,
  ): boolean {
    if (candidateRecord.id === record.id) return true;
    return candidateRecord.txid === record.txid && candidateRecord.vout === record.vout;
  }
}
