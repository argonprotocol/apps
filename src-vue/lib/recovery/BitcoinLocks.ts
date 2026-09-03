import { u8aEq, u8aToHex } from '@argonprotocol/mainchain';
import {
  type ArgonApi,
  type ArgonQueryClient,
  bigIntMax,
  bigIntMin,
  type BlockWatch,
  type Currency,
  type IBlockHeaderInfo,
  BitcoinLock,
  type IBitcoinLock,
  type IBitcoinLockDetails,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import {
  BitcoinLocksTable,
  BitcoinLockStatus,
  toBitcoinLockScriptDetails,
  type IBitcoinLockRecord,
} from '../db/BitcoinLocksTable.ts';
import type { HistoricalEvent } from '@argonprotocol/runtime-client/events';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../db/BitcoinUtxosTable.ts';
import type { IMempoolTxStatus } from '../BitcoinMempool.ts';
import type { deriveBitcoinLockHdKey, WalletKeys } from '../WalletKeys.ts';
import type { Db } from '../Db.ts';
import type { IBitcoinRequestLockMetadata } from '../BitcoinLocks.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import {
  assignIfUnset,
  bitcoinRecoveryEventPolicies,
  BitcoinHistoryUtxoProjection,
  createHistoricalBitcoinLockRecord,
  resolveRecoveredLock,
  resolveRecoveredUtxo,
  type BitcoinHistoryReplayLockScope,
  type BitcoinHistoryReplaySession,
  type BitcoinRecoveryUtxoTracking,
  type IHistoricalBitcoinLockRecord,
} from './BitcoinLockReplay.ts';
import {
  getHistoricalBitcoinFundingUtxoRef,
  getHistoricalBitcoinLock,
  getHistoricalBitcoinPendingMints,
  getHistoricalBitcoinReleaseRequest,
  toBitcoinLockDetails,
  type IHistoricalBitcoinLock,
} from './BitcoinLockHistory.ts';
import type { IBitcoinSecuritizationTerm } from '../../interfaces/IBitcoinSecuritizationTerm.ts';

export class BitcoinLockRecovery {
  private readonly walletKeys: WalletKeys;
  private readonly blockWatch: BlockWatch;
  private readonly currency: Pick<Currency, 'fetchMainchainRatesAtBlock' | 'fetchPriceIndex'>;
  private readonly getLocksByUtxoId: () => Record<number, IBitcoinLockRecord>;
  private readonly getPendingLocks: () => IBitcoinLockRecord[];
  private readonly waitForLockIdle: (lock: IBitcoinLockRecord, alreadyOwnsQueue?: boolean) => Promise<void>;
  private readonly findConfirmedRecoveredRelease: (args: {
    lock: IBitcoinLockRecord;
    fundingRecord: IBitcoinUtxoRecord;
  }) => Promise<(IMempoolTxStatus & { txid: string }) | undefined>;
  private readonly onHistoryRecoveryComplete: (locks: IBitcoinLockRecord[]) => void;
  private readonly utxoTracking: BitcoinRecoveryUtxoTracking;
  private readonly dbPromise: Promise<Db>;
  private historyReplay?: BitcoinHistoryReplaySession;
  private readonly historyRecoveryPendingUtxoIds = new Set<number>();
  private readonly historyRecoveryPendingUuids = new Set<string>();
  private readonly activeLockRecoveryFailedUtxoIds = new Set<number>();
  private readonly activeLocksByUtxoId = new Map<number, IBitcoinLock | undefined>();
  private activeLockRecoveryPromise?: Promise<IBitcoinLock[]>;
  private readonly insertPending: (
    details: Pick<IBitcoinLockRecord, 'uuid' | 'securitizedSatoshis' | 'vaultId' | 'hdPath'>,
  ) => Promise<IBitcoinLockRecord>;
  private readonly getTable: () => Promise<BitcoinLocksTable>;
  private readonly getDerivedPubkey: (vaultId: number, index: number) => ReturnType<typeof deriveBitcoinLockHdKey>;
  private readonly getBitcoinNetwork: () => string;
  private readonly trackDerivedBitcoinLockKey: (
    vaultId: number,
    derivedPubkey: Awaited<ReturnType<typeof deriveBitcoinLockHdKey>>,
  ) => Promise<void>;

  constructor(args: {
    walletKeys: WalletKeys;
    blockWatch: BlockWatch;
    currency: Pick<Currency, 'fetchMainchainRatesAtBlock' | 'fetchPriceIndex'>;
    getLocksByUtxoId: BitcoinLockRecovery['getLocksByUtxoId'];
    getPendingLocks: BitcoinLockRecovery['getPendingLocks'];
    waitForLockIdle: BitcoinLockRecovery['waitForLockIdle'];
    findConfirmedRecoveredRelease: BitcoinLockRecovery['findConfirmedRecoveredRelease'];
    onHistoryRecoveryComplete: BitcoinLockRecovery['onHistoryRecoveryComplete'];
    utxoTracking: BitcoinLockRecovery['utxoTracking'];
    dbPromise: Promise<Db>;
    insertPending: BitcoinLockRecovery['insertPending'];
    getTable: () => Promise<BitcoinLocksTable>;
    getDerivedPubkey: BitcoinLockRecovery['getDerivedPubkey'];
    getBitcoinNetwork: BitcoinLockRecovery['getBitcoinNetwork'];
    trackDerivedBitcoinLockKey: BitcoinLockRecovery['trackDerivedBitcoinLockKey'];
  }) {
    this.walletKeys = args.walletKeys;
    this.blockWatch = args.blockWatch;
    this.currency = args.currency;
    this.getLocksByUtxoId = args.getLocksByUtxoId;
    this.getPendingLocks = args.getPendingLocks;
    this.waitForLockIdle = args.waitForLockIdle;
    this.findConfirmedRecoveredRelease = args.findConfirmedRecoveredRelease;
    this.onHistoryRecoveryComplete = args.onHistoryRecoveryComplete;
    this.utxoTracking = args.utxoTracking;
    this.dbPromise = args.dbPromise;
    this.insertPending = args.insertPending;
    this.getTable = args.getTable;
    this.getDerivedPubkey = args.getDerivedPubkey;
    this.getBitcoinNetwork = args.getBitcoinNetwork;
    this.trackDerivedBitcoinLockKey = args.trackDerivedBitcoinLockKey;
  }

  public get hasPendingHistoryRecovery(): boolean {
    return (
      this.historyReplay !== undefined ||
      this.activeLockRecoveryFailedUtxoIds.size > 0 ||
      [...Object.values(this.locksByUtxoId), ...this.pendingLocks].some(lock => lock.isHistoryRecoveryPending)
    );
  }

  public async beginHistoryReplay({
    lockScope = 'encountered',
  }: { lockScope?: BitcoinHistoryReplayLockScope } = {}): Promise<void> {
    if (this.historyReplay) throw new Error('Bitcoin lock history replay is already running');
    const existingSecuritizationTerms =
      lockScope === 'all'
        ? []
        : ((
            await this.dbPromise.then(db =>
              db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot(this.walletKeys.defaultArgonAddress),
            )
          )?.terms ?? []);
    const securitizationTermsByUtxoId = new Map<number, IBitcoinSecuritizationTerm[]>();
    for (const term of existingSecuritizationTerms) {
      const terms = securitizationTermsByUtxoId.get(term.utxoId) ?? [];
      terms.push(term);
      securitizationTermsByUtxoId.set(term.utxoId, terms);
    }

    this.historyReplay = {
      commitStarted: false,
      locksByUtxoId: {},
      originalLocksByUtxoId: {},
      utxos: new BitcoinHistoryUtxoProjection(this.utxoTracking, this.dbPromise),
      lockScope,
      hdKeys: new Map(),
      dirtyLockUtxoIds: new Set(),
      failedLockUtxoIds: new Set(),
      hasUnscopedFailure: false,
      recoveredThroughBlock: 0,
      securitizationTermsByUtxoId,
    };
    if (lockScope !== 'all') this.activeLocksByUtxoId.clear();
    for (const lock of [...Object.values(this.locksByUtxoId), ...this.pendingLocks]) {
      if (!lock.isHistoryRecoveryPending) continue;

      this.historyRecoveryPendingUuids.add(lock.uuid);
      if (lock.utxoId !== undefined) this.historyRecoveryPendingUtxoIds.add(lock.utxoId);
    }

    if (lockScope !== 'all') return;

    for (const lock of Object.values(this.locksByUtxoId)) {
      await this.prepareHistoryRecoveryLock(lock);
    }
  }

  public markHistoryReplayFailure(): void {
    const replay = this.historyReplay;
    if (!replay) return;

    if (replay.currentLockUtxoId === undefined) replay.hasUnscopedFailure = true;
    else replay.failedLockUtxoIds.add(replay.currentLockUtxoId);
    replay.currentLockUtxoId = undefined;
  }

  public async commitHistoryReplay(isComplete = true, asOfBlock?: number): Promise<IHistoricalBitcoinLockRecord[]> {
    const replay = this.historyReplay;
    if (!replay) return [];

    if (!isComplete || replay.hasUnscopedFailure) {
      this.historyReplay = undefined;
      this.activeLocksByUtxoId.clear();
      this.onHistoryRecoveryComplete(Object.values(replay.locksByUtxoId));
      return [];
    }

    const lockScope = replay.lockScope;
    const table = await this.getTable();
    const locks = [...replay.dirtyLockUtxoIds]
      .map(utxoId => replay.locksByUtxoId[utxoId])
      .filter((lock): lock is IHistoricalBitcoinLockRecord => Boolean(lock));
    const utxos = replay.utxos.records;
    const db = await this.dbPromise;
    const persistedLocksByUtxoId = new Map<number, IBitcoinLockRecord>();
    const recoveredHistoryByUtxoId = new Map<number, IHistoricalBitcoinLockRecord>();
    const failedLockUuids = new Set<string>();
    const handledUtxoIds = new Set(replay.failedLockUtxoIds);
    const handledHdPaths = new Set<string>();
    const persistenceErrors: string[] = [];
    let persistedUtxos = false;

    for (const utxoId of replay.failedLockUtxoIds) {
      const failedLock = replay.locksByUtxoId[utxoId] ?? this.locksByUtxoId[utxoId];
      if (!failedLock) continue;

      failedLockUuids.add(failedLock.uuid);
      handledHdPaths.add(failedLock.hdPath);
    }

    for (const recovered of locks) {
      if (recovered.utxoId === undefined) continue;
      if (replay.failedLockUtxoIds.has(recovered.utxoId)) continue;

      const recoveredFundingRecord = recovered.fundingUtxo;
      if (recovered.status !== BitcoinLockStatus.Releasing || !recoveredFundingRecord) continue;

      const fundingRecord = utxos.find(candidate => {
        return (
          candidate.lockUtxoId === recovered.utxoId &&
          candidate.txid === recoveredFundingRecord.txid &&
          candidate.vout === recoveredFundingRecord.vout
        );
      });
      if (!fundingRecord) continue;

      try {
        const confirmed = await this.findConfirmedRecoveredRelease({ lock: recovered, fundingRecord });
        if (!confirmed) continue;

        Object.assign(fundingRecord, {
          status: BitcoinUtxoStatus.ReleaseComplete,
          statusError: undefined,
          releaseTxid: confirmed.txid,
          releaseFirstSeenAt: fundingRecord.releaseFirstSeenAt ?? new Date(confirmed.transactionBlockTime * 1_000),
          releaseFirstSeenBitcoinHeight:
            fundingRecord.releaseFirstSeenBitcoinHeight ?? confirmed.transactionBlockHeight,
          releaseFirstSeenOracleHeight: fundingRecord.releaseFirstSeenOracleHeight ?? confirmed.argonBitcoinHeight,
          releasedAtBitcoinHeight: confirmed.transactionBlockHeight,
        });
        recovered.status = BitcoinLockStatus.Released;
        if (recovered.removalBlockNumber) recovered.removalReason ??= 'released';
      } catch (error) {
        console.warn(`Unable to check recovered Bitcoin release ${recovered.utxoId}; leaving it retryable`, error);
      }
    }

    replay.commitStarted = true;

    for (const recovered of locks) {
      if (recovered.utxoId === undefined) continue;
      if (replay.failedLockUtxoIds.has(recovered.utxoId)) continue;

      const lockUtxos = utxos.filter(utxo => utxo.lockUtxoId === recovered.utxoId);
      const lockHdKeys = [...replay.hdKeys.values()].filter(hdKey => hdKey.hdPath === recovered.hdPath);
      handledUtxoIds.add(recovered.utxoId);
      for (const hdKey of lockHdKeys) handledHdPaths.add(hdKey.hdPath);

      let failedUuid = recovered.uuid;
      try {
        let durable = await table.getByUtxoId(recovered.utxoId);
        durable ??= await table.findPendingByHdPath(recovered.hdPath);
        let useRecoveredStatus = !durable;
        failedUuid = durable?.uuid ?? failedUuid;

        const original = replay.originalLocksByUtxoId[recovered.utxoId];
        if (durable && original && durable.updatedAt.getTime() !== original.updatedAt.getTime()) {
          throw new Error(`Bitcoin lock ${recovered.utxoId} changed during history recovery; retry the replay`);
        }

        if (!durable) {
          durable = await table.insertPending({
            uuid: recovered.uuid,
            status: BitcoinLockStatus.LockIsProcessingOnArgon,
            securitizedSatoshis: recovered.securitizedSatoshis,
            cosignVersion: recovered.cosignVersion,
            network: recovered.network,
            hdPath: recovered.hdPath,
            vaultId: recovered.vaultId,
          });
          useRecoveredStatus = true;
        }

        if (durable.isHistoryRecoveryPending) {
          this.historyRecoveryPendingUuids.add(durable.uuid);
          this.historyRecoveryPendingUtxoIds.add(recovered.utxoId);
        }

        if (durable.utxoId == null) {
          useRecoveredStatus = true;
        }

        const resolved = resolveRecoveredLock(durable, recovered, useRecoveredStatus);
        await table.saveRecoveredHistory(resolved, resolved.createdAt);

        for (const hdKey of lockHdKeys) await db.walletHdKeysTable.upsert(hdKey);

        for (const recoveredUtxo of lockUtxos) {
          const durableUtxo = await db.bitcoinUtxosTable.getByLockOutpoint(
            recoveredUtxo.lockUtxoId,
            recoveredUtxo.txid,
            recoveredUtxo.vout,
          );
          if (durableUtxo) {
            await db.bitcoinUtxosTable.saveRecoveredHistory(resolveRecoveredUtxo(durableUtxo, recoveredUtxo));
          } else {
            await db.bitcoinUtxosTable.insert(recoveredUtxo);
          }
        }

        if (recovered.fundingUtxo) {
          const fundingUtxo = await db.bitcoinUtxosTable.getByLockOutpoint(
            recovered.utxoId,
            recovered.fundingUtxo.txid,
            recovered.fundingUtxo.vout,
          );
          if (fundingUtxo) {
            resolved.fundingUtxo = fundingUtxo;
            resolved.fundedSatoshis = fundingUtxo.satoshis;
          }
        }

        persistedLocksByUtxoId.set(recovered.utxoId, resolved);
        recoveredHistoryByUtxoId.set(recovered.utxoId, recovered);
        persistedUtxos ||= lockUtxos.length > 0;
      } catch (error) {
        failedLockUuids.add(failedUuid);
        const message = error instanceof Error ? error.message : String(error);
        persistenceErrors.push(`Bitcoin lock ${recovered.utxoId}: ${message}`);
        console.warn(`Unable to persist recovered Bitcoin lock ${recovered.utxoId}; leaving it retryable`, error);
      }
    }

    for (const recovered of utxos) {
      if (handledUtxoIds.has(recovered.lockUtxoId)) continue;

      try {
        const durable = await db.bitcoinUtxosTable.getByLockOutpoint(
          recovered.lockUtxoId,
          recovered.txid,
          recovered.vout,
        );
        if (durable) {
          await db.bitcoinUtxosTable.saveRecoveredHistory(resolveRecoveredUtxo(durable, recovered));
        } else {
          await db.bitcoinUtxosTable.insert(recovered);
        }
        persistedUtxos = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        persistenceErrors.push(`Bitcoin UTXO for lock ${recovered.lockUtxoId}: ${message}`);
        console.warn(
          `Unable to persist recovered Bitcoin UTXO for lock ${recovered.lockUtxoId}; leaving it retryable`,
          error,
        );
      }
    }

    for (const hdKey of replay.hdKeys.values()) {
      if (handledHdPaths.has(hdKey.hdPath)) continue;

      try {
        await db.walletHdKeysTable.upsert(hdKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        persistenceErrors.push(`Bitcoin HD key ${hdKey.hdPath}: ${message}`);
        console.warn(`Unable to persist recovered Bitcoin HD key ${hdKey.hdPath}; leaving it retryable`, error);
      }
    }

    if (persistedUtxos) await this.utxoTracking.load();

    if (!persistenceErrors.length && !replay.failedLockUtxoIds.size) {
      const terms = [...replay.securitizationTermsByUtxoId.values()]
        .flat()
        .sort((left, right) => left.utxoId - right.utxoId || left.termIndex - right.termIndex);
      const historyTable = db.bitcoinSecuritizationHistoryTable;
      const snapshot = await historyTable.createSnapshot(
        this.walletKeys.defaultArgonAddress,
        asOfBlock ?? replay.recoveredThroughBlock,
        terms,
      );
      await historyTable.publishSnapshot(snapshot);
    }

    this.historyReplay = undefined;
    const completedLocks: IBitcoinLockRecord[] = [];
    for (const recovered of persistedLocksByUtxoId.values()) {
      const applied = this.applyRecoveredRecord(recovered);
      const pendingIndex = this.pendingLocks.findIndex(pending => pending.uuid === applied.uuid);
      if (applied.utxoId !== undefined && pendingIndex >= 0) this.pendingLocks.splice(pendingIndex, 1);
      completedLocks.push(applied);
    }

    const orphanLifecycleLockUtxoIds = new Set(
      this.utxoTracking.getAllOrphanLifecycleUtxos().map(record => record.lockUtxoId),
    );
    for (const uuid of [...this.historyRecoveryPendingUuids]) {
      if (failedLockUuids.has(uuid)) continue;

      const liveLock =
        Object.values(this.locksByUtxoId).find(lock => lock.uuid === uuid) ??
        this.pendingLocks.find(lock => lock.uuid === uuid);
      if (!liveLock) continue;

      const lockUtxoId = liveLock.utxoId;
      const isUnresolvedHistoricalLock =
        lockScope === 'all' &&
        lockUtxoId !== undefined &&
        !this.isRetiredHistoryRecord(liveLock) &&
        !this.activeLocksByUtxoId.has(lockUtxoId);
      if (isUnresolvedHistoricalLock) {
        const fundingRecord = this.utxoTracking.getAcceptedFundingRecordForLock(liveLock);
        const hasLiveReleaseState =
          liveLock.status === BitcoinLockStatus.Releasing && this.utxoTracking.isReleaseStatus(fundingRecord?.status);
        const hasOrphanRecoveryState = orphanLifecycleLockUtxoIds.has(lockUtxoId);
        if (!hasLiveReleaseState && !hasOrphanRecoveryState) continue;
      }

      try {
        await table.setHistoryRecoveryPending(uuid, false);
      } catch (error) {
        failedLockUuids.add(uuid);
        const message = error instanceof Error ? error.message : String(error);
        persistenceErrors.push(`Bitcoin lock ${lockUtxoId ?? uuid}: ${message}`);
        console.warn(`Unable to finish recovered Bitcoin lock ${lockUtxoId ?? uuid}; leaving it retryable`, error);
        continue;
      }
      const pendingIndex = this.pendingLocks.findIndex(pending => pending.uuid === liveLock.uuid);
      if (liveLock.utxoId !== undefined && pendingIndex >= 0) this.pendingLocks.splice(pendingIndex, 1);
      delete liveLock.isHistoryRecoveryPending;
      if (liveLock.utxoId !== undefined) this.historyRecoveryPendingUtxoIds.delete(liveLock.utxoId);
      this.historyRecoveryPendingUuids.delete(uuid);
      completedLocks.push(liveLock);
    }
    this.activeLocksByUtxoId.clear();
    const reconciliationLocksByUuid = new Map(completedLocks.map(lock => [lock.uuid, lock]));
    for (const utxoId of orphanLifecycleLockUtxoIds) {
      const lock = this.locksByUtxoId[utxoId];
      if (lock) reconciliationLocksByUuid.set(lock.uuid, lock);
    }
    this.onHistoryRecoveryComplete([...reconciliationLocksByUuid.values()]);
    if (persistenceErrors.length) throw new Error(persistenceErrors.join(' '));
    return [...recoveredHistoryByUtxoId.values()];
  }

  public async cancelHistoryReplay(): Promise<void> {
    const replay = this.historyReplay;
    this.historyReplay = undefined;
    this.activeLocksByUtxoId.clear();
    if (replay) this.onHistoryRecoveryComplete(Object.values(replay.locksByUtxoId));
  }

  public async recoverBlock(
    block: IBlockHeaderInfo,
    rawEventRecords: readonly BitcoinRecoveryEventRecord[],
    options: { lockQueueOwnerUuid?: string } = {},
  ): Promise<void> {
    if (this.historyReplay) {
      this.historyReplay.currentLockUtxoId = undefined;
      this.historyReplay.recoveredThroughBlock = Math.max(this.historyReplay.recoveredThroughBlock, block.blockNumber);
    }

    const eventRecords = rawEventRecords as readonly NamedBitcoinRecoveryEventRecord[];
    const api = await this.blockWatch.getApi(block);
    const table = await this.getTable();
    const utxoTracking = this.historyReplay?.utxos ?? this.utxoTracking;

    for (let eventIndex = 0; eventIndex < eventRecords.length; eventIndex += 1) {
      if (this.historyReplay) this.historyReplay.currentLockUtxoId = undefined;

      const { event } = eventRecords[eventIndex];
      const isBitcoinMint = event.section === 'mint' && event.method === 'BitcoinMint';
      if (isBitcoinMint && event.data.fissionId !== undefined) continue;

      const isBitcoinUtxoVerified = event.section === 'bitcoinUtxos' && event.method === 'UtxoVerified';
      const isBitcoinUtxoUnwatched = event.section === 'bitcoinUtxos' && event.method === 'UtxoUnwatched';
      if (event.section !== 'bitcoinLocks' && !isBitcoinMint && !isBitcoinUtxoVerified && !isBitcoinUtxoUnwatched) {
        continue;
      }
      const bitcoinLockPolicy =
        event.section === 'bitcoinLocks' ? bitcoinRecoveryEventPolicies[event.method] : undefined;
      const isUnknownBitcoinLockEvent = event.section === 'bitcoinLocks' && !bitcoinLockPolicy;
      if (bitcoinLockPolicy === 'ignore' || bitcoinLockPolicy === 'preserve') continue;

      const utxoId = this.readUtxoId(event);
      if (isBitcoinMint && utxoId === undefined) {
        if (event.section !== 'mint' || event.method !== 'BitcoinMint') continue;
        if (event.data.accountId !== this.walletKeys.defaultArgonAddress) continue;

        let candidateIds = this.historyRecoveryPendingUtxoIds;
        if (this.historyReplay?.lockScope !== 'pending') {
          candidateIds = new Set([
            ...Object.keys(this.locksByUtxoId).map(Number),
            ...Object.keys(this.historyReplay?.locksByUtxoId ?? {}).map(Number),
          ]);
        }
        for (const recoveryId of candidateIds) {
          if (this.historyReplay) this.historyReplay.currentLockUtxoId = recoveryId;
          const record = this.getRecoveryLock(recoveryId);
          if (record) await this.reconcilePendingMint(record, api, options.lockQueueOwnerUuid);
        }
        continue;
      }
      if (utxoId === undefined) continue;
      if (this.historyReplay) this.historyReplay.currentLockUtxoId = utxoId;
      let eventAccountId: string | undefined;
      if (event.section === 'mint' && event.method === 'BitcoinMint') {
        eventAccountId = event.data.accountId;
      } else if (
        event.section === 'bitcoinLocks' &&
        (event.method === 'BitcoinLockCreated' ||
          event.method === 'BitcoinLockResecuritized' ||
          event.method === 'BitcoinLockRatcheted' ||
          event.method === 'SecuritizationIncreased' ||
          event.method === 'UtxoFundedFromCandidate')
      ) {
        eventAccountId = event.data.accountId;
      }
      if (eventAccountId !== undefined && eventAccountId !== this.walletKeys.defaultArgonAddress) continue;
      if (this.historyReplay?.lockScope === 'pending' && !this.historyRecoveryPendingUtxoIds.has(utxoId)) continue;

      const liveRecord = this.locksByUtxoId[utxoId];
      if (liveRecord) await this.prepareHistoryRecoveryLock(liveRecord, options.lockQueueOwnerUuid);

      if (event.section === 'bitcoinLocks' && event.method === 'BitcoinLockCreated') {
        const chainLock = await getHistoricalBitcoinLock(api, utxoId);
        if (!chainLock) throw new Error(`Bitcoin lock ${utxoId} is unavailable at its creation block`);
        this.recordSecuritizationTerm(block, eventRecords[eventIndex], chainLock, 'created');
        const securityFee = event.data.securityFee ?? 0n;
        if (event.data.accountId === this.walletKeys.defaultArgonAddress) {
          chainLock.couponFeesPaid = bigIntMax(chainLock.couponFeesPaid, securityFee);
        }
        const creationLiquidity = event.data.liquidityPromised ?? 0n;
        const creationTargetPrice =
          event.data.lockedTargetPrice ??
          event.data.lockedMarketRate ??
          event.data.peggedPrice ??
          event.data.lockPrice ??
          0n;
        const transactionFee = this.readTransactionFee(eventRecords, eventIndex) ?? 0n;
        const phase = eventRecords[eventIndex].phase;
        const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : undefined;
        const creationEventRatchet = {
          mintAmount: creationLiquidity,
          mintPending: creationLiquidity,
          lockedTargetPrice: creationTargetPrice,
          blockHeight: block.blockNumber,
          burned: 0n,
          securityFee: chainLock.securityFees,
          txFee: transactionFee,
          oracleBitcoinBlockHeight: chainLock.createdAtHeight,
          tick: block.tick,
          extrinsicIndex,
        };

        // Restart replay from durable state rather than a stale in-memory observation.
        const persistedRecord = await table.getByUtxoId(utxoId);
        if (persistedRecord) await this.prepareHistoryRecoveryLock(persistedRecord, options.lockQueueOwnerUuid);
        let existing = persistedRecord ? this.applyRecoveredRecord(persistedRecord) : this.getRecoveryLock(utxoId);
        if (existing?.lockDetails.utxoId !== undefined && existing.lockDetails.utxoId !== utxoId) {
          existing = this.createDetachedRecord(existing);
          existing.ratchets = [];
        }
        if (existing) {
          if (existing.ratchets.length) {
            const creationRatchetIndex = existing.ratchets.findIndex(
              ratchet => ratchet.blockHeight === block.blockNumber,
            );
            const creationRatchet = existing.ratchets[creationRatchetIndex];
            if (!creationRatchet) {
              console.warn(`[BitcoinLocks] Rebuilding missing creation history for lock ${utxoId}`);
              const recovered = this.createDetachedRecord(existing);
              const laterRatchets =
                existing.ratchets.length === 1
                  ? []
                  : existing.ratchets.filter(ratchet => ratchet.blockHeight > block.blockNumber);
              recovered.ratchets = [creationEventRatchet, ...laterRatchets];
              this.assertSafePendingMint(recovered);
              await this.saveRecoveredHistory(table, recovered, new Date(block.blockTime));
              this.applyRecoveredRecord(recovered);
              continue;
            }

            if (
              creationRatchet.mintAmount !== creationLiquidity ||
              creationRatchet.lockedTargetPrice !== creationTargetPrice ||
              creationRatchet.mintPending !== creationRatchet.mintAmount ||
              creationRatchet.extrinsicIndex !== extrinsicIndex ||
              existing.createdAt.getTime() !== block.blockTime ||
              (existing.lockDetails?.couponFeesPaid ?? 0n) !== chainLock.couponFeesPaid
            ) {
              const recovered = this.createDetachedRecord(existing);
              recovered.ratchets[creationRatchetIndex] = {
                ...creationRatchet,
                mintAmount: creationLiquidity,
                mintPending: creationLiquidity,
                lockedTargetPrice: creationTargetPrice,
                tick: block.tick,
                extrinsicIndex,
              };
              // The active-lock fallback stores current liquidity here; the creation event restores the real baseline.
              delete recovered.ratchets[creationRatchetIndex].liquidityPromised;
              recovered.lockDetails = toBitcoinLockDetails(chainLock);
              await this.saveRecoveredHistory(table, recovered, new Date(block.blockTime));
              this.applyRecoveredRecord(recovered);
            }
            continue;
          }
        }

        const record =
          existing ??
          (await this.recoverLock({
            lock: chainLock,
            createdAtArgonBlockHeight: block.blockNumber,
            finalFee: transactionFee,
            lockQueueOwnerUuid: options.lockQueueOwnerUuid,
          }));
        const recovered = this.createDetachedRecord(record);
        if (!this.isRetiredHistoryRecord(recovered)) recovered.status = BitcoinLockStatus.LockPendingFunding;
        recovered.satoshis = chainLock.securitizedSatoshis;
        recovered.liquidityPromised = chainLock.liquidityPromised;
        recovered.lockedTargetPrice = chainLock.lockedTargetPrice;
        recovered.lockDetails = toBitcoinLockDetails(chainLock);
        recovered.ratchets = [creationEventRatchet];
        this.assertSafePendingMint(recovered);
        await this.saveRecoveredHistory(table, recovered, new Date(block.blockTime));
        this.applyRecoveredRecord(recovered);
        continue;
      }

      const persistedRecord = this.getRecoveryLock(utxoId) ? undefined : await table.getByUtxoId(utxoId);
      if (persistedRecord) await this.prepareHistoryRecoveryLock(persistedRecord, options.lockQueueOwnerUuid);
      const record = persistedRecord ? this.applyRecoveredRecord(persistedRecord) : this.getRecoveryLock(utxoId);
      if (!record) {
        // Release events only identify a UTXO, and the indexer returns the full block selected for this account.
        // An unrelated account's release can therefore appear beside owned activity without an ownership field.
        if (!isBitcoinMint && event.method !== 'BitcoinLockRatcheted') continue;
        throw new Error(`Bitcoin lock ${utxoId} history is missing its creation record`);
      }
      const restoresPreFundingState =
        isBitcoinUtxoVerified ||
        event.method === 'SecuritizationIncreased' ||
        event.method === 'UtxoFundedFromCandidate' ||
        (isUnknownBitcoinLockEvent && record.status === BitcoinLockStatus.LockPendingFunding);
      if (event.section === 'bitcoinLocks' && event.method === 'BitcoinLockResecuritized') {
        const chainLock = await getHistoricalBitcoinLock(api, utxoId);
        if (!chainLock) throw new Error(`Bitcoin lock ${utxoId} is unavailable after resecuritization`);
        this.recordSecuritizationTerm(block, eventRecords[eventIndex], chainLock, 'resecuritized');

        const recovered = this.createDetachedRecord(record);
        this.applyHistoricalLockSnapshot(recovered, chainLock);
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } else if (restoresPreFundingState) {
        const chainLock = await getHistoricalBitcoinLock(api, utxoId);
        if (!chainLock) throw new Error(`Bitcoin lock ${utxoId} is unavailable after ${event.method}`);

        const recovered = this.createDetachedRecord(record);
        // These events mutate the original lock rather than creating a new ratchet.
        // Use the archived post-event state because older event shapes omit some resulting economics.
        const creationRatchet = recovered.ratchets[0];
        if (!creationRatchet) throw new Error(`Bitcoin lock ${recovered.utxoId} is missing its creation ratchet`);
        const lockDetails = this.applyHistoricalLockSnapshot(recovered, chainLock);
        Object.assign(creationRatchet, {
          mintAmount: chainLock.liquidityPromised,
          mintPending: chainLock.liquidityPromised,
          lockedTargetPrice: chainLock.lockedTargetPrice,
          securityFee: lockDetails.securityFees,
        });

        let fundingRecord;
        if (isBitcoinUtxoVerified || event.method === 'UtxoFundedFromCandidate') {
          if (recovered.status === BitcoinLockStatus.LockPendingFunding) {
            recovered.status = BitcoinLockStatus.LockFunded;
          }
          const utxoRef = await getHistoricalBitcoinFundingUtxoRef(api, utxoId);
          if (utxoRef) {
            fundingRecord = await utxoTracking.upsertUtxoRecord(
              recovered,
              { txid: utxoRef.txid, vout: utxoRef.vout, satoshis: recovered.satoshis },
              { markFundingUtxo: true },
            );
            await utxoTracking.setAcceptedFundingRecordForLock(recovered, fundingRecord);
          }
        }

        this.assertSafePendingMint(recovered);
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinLockBackfillChanged') {
        const recovered = this.createDetachedRecord(record);
        recovered.isFlexible = event.data.isBackfill;
        recovered.lockDetails = {
          ...record.lockDetails,
          isFlexible: recovered.isFlexible,
        };
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinLockFlexibleChanged') {
        const recovered = this.createDetachedRecord(record);
        recovered.isFlexible = event.data.isFlexible;
        recovered.lockDetails = {
          ...record.lockDetails,
          isFlexible: recovered.isFlexible,
        };
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } else if (isUnknownBitcoinLockEvent) {
        const chainLock = await getHistoricalBitcoinLock(api, utxoId);
        if (!chainLock) {
          throw new Error(
            `bitcoinLocks.${event.method} requires an explicit recovery handler because it removed the lock`,
          );
        }
        if (!this.hasCompleteRatchetEconomics(record, chainLock.liquidityPromised, chainLock.lockedTargetPrice)) {
          throw new Error(
            `bitcoinLocks.${event.method} requires an explicit recovery handler because it changed lock economics`,
          );
        }

        const recovered = this.createDetachedRecord(record);
        chainLock.couponFeesPaid = bigIntMax(chainLock.couponFeesPaid, recovered.lockDetails?.couponFeesPaid ?? 0n);
        this.applyHistoricalLockSnapshot(recovered, chainLock);
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } else if (event.section === 'bitcoinLocks' && event.method === 'OrphanedUtxoReceived') {
        const { satoshis, utxoRef } = event.data;
        await utxoTracking.upsertUtxoRecord(
          record,
          {
            txid: utxoRef.txid,
            vout: utxoRef.outputIndex,
            satoshis,
          },
          { markOrphaned: true },
        );
      } else if (event.section === 'bitcoinLocks' && event.method === 'OrphanedUtxoReleaseRequested') {
        const { accountId, utxoRef } = event.data;
        const ownerAccount = accountId;
        if (ownerAccount !== record.lockDetails.ownerAccount) continue;
        const orphan = await api.query.bitcoinLocks.orphanedUtxosByAccount(ownerAccount, utxoRef);
        if (!orphan?.cosignRequest) continue;
        const request = orphan.cosignRequest;
        const currentTick = await api.query.ticks.currentTick();
        if (currentTick === null) continue;
        const orphanRecord = await utxoTracking.upsertUtxoRecord(
          record,
          {
            txid: utxoRef.txid,
            vout: utxoRef.outputIndex,
            satoshis: orphan.satoshis,
          },
          { markOrphaned: true },
        );
        await utxoTracking.setReleaseIsProcessingOnArgon(orphanRecord, {
          requestedReleaseAtTick: Number(currentTick),
          releaseToDestinationAddress: u8aToHex(request.toScriptPubkey, undefined, false),
          releaseBitcoinNetworkFee: request.bitcoinNetworkFee,
        });
      } else if (event.section === 'bitcoinLocks' && event.method === 'OrphanedUtxoCosigned') {
        const { utxoRef, signature } = event.data;
        const ownerAccount = event.data.accountId ?? record.lockDetails.ownerAccount;
        if (ownerAccount !== record.lockDetails.ownerAccount) continue;
        const orphanRecord = utxoTracking.getUtxoRecord(utxoId, utxoRef.txid, utxoRef.outputIndex);
        if (!orphanRecord) continue;
        await utxoTracking.setReleaseCosign(orphanRecord, {
          releaseCosignVaultSignature: signature,
          releaseCosignHeight: block.blockNumber,
        });
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinLockRatcheted') {
        await this.importRatchet(record, block, eventRecords, eventIndex, event, api, table);
      } else if (event.section === 'mint' && event.method === 'BitcoinMint') {
        await this.applyScopedMint(record, event.data.amount, api, table);
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinUtxoCosignRequested') {
        const releaseRequest = await getHistoricalBitcoinReleaseRequest(api, utxoId);
        if (!releaseRequest) {
          throw new Error(`Bitcoin lock ${utxoId} release request is unavailable at block ${block.blockNumber}`);
        }
        const recovered = this.createDetachedRecord(record);
        const releaseArgonTxFeeMicrogons = this.readTransactionFee(eventRecords, eventIndex);
        if (this.historyReplay) {
          if (recovered.status !== BitcoinLockStatus.Released) recovered.status = BitcoinLockStatus.Releasing;
          recovered.releaseRedemptionMicrogons ??= releaseRequest.redemptionAmount;
          recovered.releaseArgonTxFeeMicrogons ??= releaseArgonTxFeeMicrogons;
        } else {
          await table.recordReleaseRequest(recovered, {
            releaseRedemptionMicrogons: releaseRequest.redemptionAmount,
            releaseArgonTxFeeMicrogons,
          });
        }
        let fundingRecord = utxoTracking.getAcceptedFundingRecordForLock(recovered);
        if (!fundingRecord) {
          const utxoRef = await getHistoricalBitcoinFundingUtxoRef(api, utxoId);
          if (utxoRef) {
            fundingRecord = await utxoTracking.upsertUtxoRecord(
              recovered,
              { txid: utxoRef.txid, vout: utxoRef.vout, satoshis: recovered.satoshis },
              { markFundingUtxo: true },
            );
            await utxoTracking.setAcceptedFundingRecordForLock(recovered, fundingRecord);
          }
        }
        if (fundingRecord && !this.utxoTracking.isReleaseStatus(fundingRecord.status)) {
          const currentTick = await api.query.ticks.currentTick();
          if (currentTick === null) continue;
          await utxoTracking.setReleaseRequest(fundingRecord, {
            requestedReleaseAtTick: Number(currentTick),
            releaseToDestinationAddress: releaseRequest.toScriptPubkey,
            releaseBitcoinNetworkFee: releaseRequest.bitcoinNetworkFee,
          });
        }
        this.applyRecoveredRecord(recovered);
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinUtxoCosigned') {
        const fundingRecord = utxoTracking.getAcceptedFundingRecordForLock(record);
        if (fundingRecord) {
          await utxoTracking.setReleaseCosign(fundingRecord, {
            releaseCosignVaultSignature: event.data.signature,
            releaseCosignHeight: block.blockNumber,
          });
        }
        const releaseIsComplete =
          liveRecord?.status === BitcoinLockStatus.Released ||
          record.status === BitcoinLockStatus.Released ||
          this.utxoTracking.isReleaseCompleteStatus(fundingRecord?.status);
        if (!record.removalReason) {
          const recovered = this.createDetachedRecord(record);
          if (!record.removalBlockNumber) {
            const rates = await this.currency.fetchMainchainRatesAtBlock({ api, block });
            const phase = eventRecords[eventIndex].phase;
            const removal = {
              removalBlockNumber: block.blockNumber,
              removalBlockHash: block.blockHash,
              removalBlockTime: new Date(block.blockTime),
              removalExtrinsicIndex: phase.type === 'ApplyExtrinsic' ? phase.value : undefined,
              btcPriceAtRemovalMicrogons: rates.BTC,
            };
            if (this.historyReplay) {
              assignIfUnset(recovered, removal, [
                'removalBlockNumber',
                'removalBlockHash',
                'removalBlockTime',
                'removalExtrinsicIndex',
                'btcPriceAtRemovalMicrogons',
              ]);
            } else {
              await table.recordReleaseCosign(recovered, removal);
            }
          }
          if (releaseIsComplete) {
            if (this.historyReplay) {
              recovered.status = BitcoinLockStatus.Released;
              if (recovered.removalBlockNumber) recovered.removalReason ??= 'released';
            } else await table.setReleased(recovered);
          }
          this.applyRecoveredRecord(recovered);
        }
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinCosignPastDue') {
        const recovered = this.createDetachedRecord(record);
        const compensation = event.data.compensationAmount;
        if (this.historyReplay) recovered.releaseCompensationMicrogons ??= compensation;
        else await table.recordReleaseCompensation(recovered, compensation);
        this.applyRecoveredRecord(recovered);
      } else if (
        event.section === 'bitcoinLocks' &&
        (event.method === 'BitcoinSpentAfterRelease' || event.method === 'BitcoinLockBurned')
      ) {
        let removalReason: NonNullable<IBitcoinLockRecord['removalReason']> = 'released';
        let status = BitcoinLockStatus.Released;
        if (event.method === 'BitcoinLockBurned') {
          const wasUtxoSpent = event.data.wasUtxoSpent;
          removalReason = wasUtxoSpent ? 'spent' : 'expired';
          if (!wasUtxoSpent) status = BitcoinLockStatus.Releasing;
        }
        const bitcoinWasReleased =
          event.method === 'BitcoinSpentAfterRelease' ||
          (event.method === 'BitcoinLockBurned' && event.data.wasUtxoSpent);
        if (bitcoinWasReleased) this.closeSecuritizationTerm(block, eventRecords[eventIndex]);

        const recovered = this.createDetachedRecord(record);
        const rates = await this.currency.fetchMainchainRatesAtBlock({ api, block });
        const phase = eventRecords[eventIndex].phase;
        const removal = {
          removalBlockNumber: block.blockNumber,
          removalBlockHash: block.blockHash,
          removalBlockTime: new Date(block.blockTime),
          removalExtrinsicIndex: phase.type === 'ApplyExtrinsic' ? phase.value : undefined,
          removalReason,
          btcPriceAtRemovalMicrogons: rates.BTC,
        };
        if (this.historyReplay) {
          if (!recovered.removalReason || recovered.removalReason === removal.removalReason) {
            recovered.status = status;
          }
          recovered.removalTick ??= block.tick;
          assignIfUnset(recovered, removal, [
            'removalBlockNumber',
            'removalBlockHash',
            'removalBlockTime',
            'removalExtrinsicIndex',
            'removalReason',
            'btcPriceAtRemovalMicrogons',
          ]);
        } else {
          await table.recordRemoval(recovered, status, removal);
        }
        this.applyRecoveredRecord(recovered);
      }
    }

    if (this.historyReplay) this.historyReplay.currentLockUtxoId = undefined;
  }

  public async recoverLock(args: {
    lock: IHistoricalBitcoinLock;
    createdAtArgonBlockHeight: number;
    finalFee: bigint;
    lockQueueOwnerUuid?: string;
  }): Promise<IHistoricalBitcoinLockRecord> {
    const lockDetails = toBitcoinLockDetails(args.lock);
    const liveRecord = this.locksByUtxoId[args.lock.utxoId];
    if (this.historyReplay && liveRecord) {
      await this.prepareHistoryRecoveryLock(liveRecord, args.lockQueueOwnerUuid);
    }

    const table = await this.getTable();
    const existing = await table.getByUtxoId(args.lock.utxoId);
    if (existing) {
      await this.prepareHistoryRecoveryLock(existing, args.lockQueueOwnerUuid);
      const recovered = this.createDetachedRecord(this.getRecoveryLock(args.lock.utxoId) ?? existing);
      if (!this.hasCompleteRatchetEconomics(recovered, args.lock.liquidityPromised, args.lock.lockedTargetPrice)) {
        const knownTransactionFees = bigIntMax(
          args.finalFee,
          recovered.ratchets.reduce((total, ratchet) => total + ratchet.txFee, 0n),
        );
        const knownSecurityFees = recovered.ratchets.reduce((total, ratchet) => total + ratchet.securityFee, 0n);
        recovered.satoshis = args.lock.fundedSatoshis || args.lock.securitizedSatoshis;
        recovered.liquidityPromised = args.lock.liquidityPromised;
        recovered.lockedTargetPrice = args.lock.lockedTargetPrice;
        recovered.lockDetails = lockDetails;
        // This chain snapshot restores current actions; event replay can replace it with full ratchet history.
        recovered.ratchets = [
          {
            mintAmount: args.lock.liquidityPromised,
            mintPending: args.lock.liquidityPromised,
            liquidityPromised: args.lock.liquidityPromised,
            lockedTargetPrice: args.lock.lockedTargetPrice,
            securityFee: bigIntMax(args.lock.securityFees, knownSecurityFees),
            txFee: knownTransactionFees,
            burned: 0n,
            blockHeight: args.lock.createdAtArgonBlock || args.createdAtArgonBlockHeight,
            oracleBitcoinBlockHeight: args.lock.createdAtHeight,
          },
        ];
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      }
      return recovered;
    }

    const derivedPubkey = await this.findDerivedPubkeyForOwner(args.lock.vaultId, args.lock.ownerPubkey);
    if (!derivedPubkey) throw new Error(`Unable to recover the HD path for Bitcoin lock ${args.lock.utxoId}`);

    let record: IBitcoinLockRecord | IHistoricalBitcoinLockRecord | undefined = await table.findPendingByHdPath(
      derivedPubkey.hdPath,
    );
    let recoveredUuid = record?.uuid;
    if (!recoveredUuid) {
      const db = await this.dbPromise;
      const transaction = (await db.transactionsTable.fetchAll()).find(candidate => {
        if (candidate.extrinsicType !== ExtrinsicType.BitcoinRequestLock) return false;

        const metadata = candidate.metadataJson as Partial<IBitcoinRequestLockMetadata> | undefined;
        return metadata?.bitcoin?.hdPath === derivedPubkey.hdPath && metadata.bitcoin.vaultId === args.lock.vaultId;
      });
      const metadata = transaction?.metadataJson as Partial<IBitcoinRequestLockMetadata> | undefined;
      recoveredUuid = metadata?.bitcoin?.uuid ?? BitcoinLocksTable.createUuid();
    }

    if (!record && !this.historyReplay) {
      record = await this.insertPending({
        uuid: recoveredUuid,
        vaultId: args.lock.vaultId,
        securitizedSatoshis: args.lock.securitizedSatoshis,
        hdPath: derivedPubkey.hdPath,
      });
    }

    const now = new Date();
    const historicalRecord: IHistoricalBitcoinLockRecord =
      record?.utxoId !== undefined
        ? this.createDetachedRecord(record)
        : {
            ...record,
            uuid: record?.uuid ?? recoveredUuid,
            status: record?.status ?? BitcoinLockStatus.LockIsProcessingOnArgon,
            securitizedSatoshis: args.lock.securitizedSatoshis,
            ownerAccount: args.lock.ownerAccount,
            securitizationRatio: args.lock.securitizationRatio,
            securityFees: args.lock.securityFees,
            couponFeesPaid: args.lock.couponFeesPaid,
            scriptDetails: toBitcoinLockScriptDetails(lockDetails),
            fundingExpirationHeight: args.lock.fundingExpirationHeight,
            isFlexible: args.lock.isFlexible,
            fundHoldExtensionsByBitcoinExpirationHeight: args.lock.fundHoldExtensionsByBitcoinExpirationHeight,
            createdAtArgonBlock: args.lock.createdAtArgonBlock,
            utxos: [],
            fundedSatoshis: 0n,
            satoshis: args.lock.securitizedSatoshis,
            liquidityPromised: 0n,
            lockedTargetPrice: 0n,
            ratchets: [],
            cosignVersion: record?.cosignVersion ?? 'v1',
            lockDetails,
            network: record?.network ?? this.getBitcoinNetwork(),
            hdPath: record?.hdPath ?? derivedPubkey.hdPath,
            vaultId: args.lock.vaultId,
            createdAt: record?.createdAt ?? now,
            updatedAt: record?.updatedAt ?? now,
          };
    if (historicalRecord.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
      historicalRecord.status = BitcoinLockStatus.LockPendingFunding;
      historicalRecord.utxoId = args.lock.utxoId;
      historicalRecord.liquidityPromised = args.lock.liquidityPromised;
      historicalRecord.lockedTargetPrice = args.lock.lockedTargetPrice;
      historicalRecord.lockDetails = lockDetails;
      historicalRecord.ratchets = [
        {
          mintAmount: args.lock.liquidityPromised,
          mintPending: args.lock.liquidityPromised,
          lockedTargetPrice: args.lock.lockedTargetPrice,
          blockHeight: args.createdAtArgonBlockHeight,
          burned: 0n,
          securityFee: lockDetails.securityFees,
          txFee: args.finalFee,
          oracleBitcoinBlockHeight: lockDetails.createdAtHeight,
        },
      ];
    }
    await this.saveRecoveredHistory(table, historicalRecord);
    await this.prepareHistoryRecoveryLock(historicalRecord, args.lockQueueOwnerUuid);
    const recovered = this.createDetachedRecord(historicalRecord);
    this.applyRecoveredRecord(recovered);
    return recovered;
  }

  private async recoverCurrentLock(lock: IBitcoinLock): Promise<IBitcoinLockRecord> {
    const loaded = this.locksByUtxoId[lock.utxoId];
    if (loaded) return loaded;

    const table = await this.getTable();
    const existing = await table.getByUtxoId(lock.utxoId);
    if (existing) return this.applyRecoveredRecord(existing);

    const derivedPubkey = await this.findDerivedPubkeyForOwner(lock.vaultId, lock.ownerPubkey);
    if (!derivedPubkey) throw new Error(`Unable to recover the HD path for Bitcoin lock ${lock.utxoId}`);

    let record = await table.findPendingByHdPath(derivedPubkey.hdPath);
    if (!record) {
      const db = await this.dbPromise;
      const transaction = (await db.transactionsTable.fetchAll()).find(candidate => {
        if (candidate.extrinsicType !== ExtrinsicType.BitcoinRequestLock) return false;

        const metadata = candidate.metadataJson as Partial<IBitcoinRequestLockMetadata> | undefined;
        return metadata?.bitcoin?.hdPath === derivedPubkey.hdPath && metadata.bitcoin.vaultId === lock.vaultId;
      });
      const metadata = transaction?.metadataJson as Partial<IBitcoinRequestLockMetadata> | undefined;
      record = await this.insertPending({
        uuid: metadata?.bitcoin?.uuid ?? BitcoinLocksTable.createUuid(),
        vaultId: lock.vaultId,
        securitizedSatoshis: lock.securitizedSatoshis,
        hdPath: derivedPubkey.hdPath,
      });
    }
    if (record.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
      record = await table.finalizePending({ uuid: record.uuid, lock });
    }
    return this.applyRecoveredRecord(record);
  }

  public recoverActiveLocks(options?: { requireComplete?: boolean }): Promise<IBitcoinLock[]> {
    this.activeLockRecoveryPromise ??= (async () => {
      this.activeLocksByUtxoId.clear();
      const api = await this.blockWatch.getFinalizedApi();
      const utxoIds = await this.findActiveLockIds(api);
      const activeUtxoIds = new Set(utxoIds);
      const locks: IBitcoinLock[] = [];
      for (const utxoId of utxoIds) this.activeLocksByUtxoId.set(utxoId, undefined);
      for (const utxoId of this.activeLockRecoveryFailedUtxoIds) {
        if (!activeUtxoIds.has(utxoId)) this.activeLockRecoveryFailedUtxoIds.delete(utxoId);
      }

      const table = await this.getTable();
      const resumedReleases: IBitcoinLockRecord[] = [];
      for (const record of Object.values(this.locksByUtxoId)) {
        if (
          record.utxoId === undefined ||
          record.status !== BitcoinLockStatus.Releasing ||
          this.activeLocksByUtxoId.has(record.utxoId)
        ) {
          continue;
        }

        const fundingRecord = this.utxoTracking.getAcceptedFundingRecordForLock(record);
        if (this.utxoTracking.isReleaseStatus(fundingRecord?.status)) {
          if (!record.isHistoryRecoveryPending) continue;

          await table.setHistoryRecoveryPending(record.uuid, false);
          delete record.isHistoryRecoveryPending;
          this.historyRecoveryPendingUtxoIds.delete(record.utxoId);
          this.historyRecoveryPendingUuids.delete(record.uuid);
          resumedReleases.push(record);
          continue;
        }
      }
      if (resumedReleases.length) this.onHistoryRecoveryComplete(resumedReleases);

      for (const utxoId of utxoIds) {
        try {
          const lock = await BitcoinLock.get(api, utxoId);
          if (!lock) throw new Error(`Active Bitcoin lock ${utxoId} is unavailable from finalized chain state`);

          this.activeLockRecoveryFailedUtxoIds.delete(utxoId);
          this.activeLocksByUtxoId.set(utxoId, lock);
          await this.recoverCurrentLock(lock);
          locks.push(lock);
        } catch (error) {
          this.activeLockRecoveryFailedUtxoIds.add(utxoId);
          console.warn(`Unable to restore active Bitcoin lock ${utxoId} from chain:`, error);
        }
      }

      return locks.sort((left, right) => right.createdAtArgonBlock - left.createdAtArgonBlock);
    })().finally(() => {
      this.activeLockRecoveryPromise = undefined;
    });
    if (!options?.requireComplete) return this.activeLockRecoveryPromise;

    return this.activeLockRecoveryPromise.then(locks => {
      if (this.activeLockRecoveryFailedUtxoIds.size) {
        throw new Error('Active Bitcoin lock recovery is incomplete.');
      }
      return locks;
    });
  }

  public async findActiveLockIds(api: ArgonQueryClient): Promise<number[]> {
    const ownerKeys = await api.query.bitcoinLocks.utxoIdsByOwnerAccount.keys(this.walletKeys.defaultArgonAddress);
    return (ownerKeys ?? []).map(key => key.args[1]);
  }

  public async findMissingActiveLockIds(api: ArgonQueryClient): Promise<number[]> {
    const utxoIds = await this.findActiveLockIds(api);
    if (api.runtimeVersion.specVersion.toNumber() >= 159) {
      return utxoIds.filter(utxoId => this.activeLocksByUtxoId.get(utxoId) === undefined);
    }

    const missing: number[] = [];

    for (const utxoId of utxoIds) {
      const record = this.getRecoveryLock(utxoId);
      const chainLock = await getHistoricalBitcoinLock(api, utxoId);
      if (
        !chainLock ||
        !record ||
        !this.hasCompleteRatchetEconomics(record, chainLock.liquidityPromised, chainLock.lockedTargetPrice)
      ) {
        missing.push(utxoId);
      }
    }

    return missing;
  }

  private async importRatchet(
    record: IHistoricalBitcoinLockRecord,
    block: IBlockHeaderInfo,
    eventRecords: readonly NamedBitcoinRecoveryEventRecord[],
    eventIndex: number,
    event: Extract<HistoricalEvent, { section: 'bitcoinLocks'; method: 'BitcoinLockRatcheted' }>,
    api: ArgonApi,
    table: BitcoinLocksTable,
  ): Promise<void> {
    const phase = eventRecords[eventIndex].phase;
    if (phase.type !== 'ApplyExtrinsic') {
      throw new Error(`Bitcoin ratchet at block ${block.blockNumber.toLocaleString()} has no extrinsic identity`);
    }
    const extrinsicIndex = phase.value;
    const cumulativeLiquidity = event.data.liquidityPromised ?? 0n;
    const securityFee = event.data.securityFee ?? 0n;
    const oldTargetPrice =
      event.data.oldTargetPrice ??
      event.data.originalMarketRate ??
      event.data.originalPeggedPrice ??
      event.data.originalLockPrice ??
      0n;
    const lockedTargetPrice =
      event.data.newTargetPrice ??
      event.data.newLockedMarketRate ??
      event.data.newPeggedPrice ??
      event.data.newLockPrice ??
      0n;
    const chainLock = await getHistoricalBitcoinLock(api, record.utxoId!);
    if (!chainLock) throw new Error(`Bitcoin lock ${record.utxoId} is unavailable after ratchet`);

    const recovered = this.createDetachedRecord(record);
    let ratchetIndex = recovered.ratchets.findIndex(ratchet => {
      return ratchet.blockHeight === block.blockNumber && ratchet.extrinsicIndex === extrinsicIndex;
    });
    if (ratchetIndex === -1) {
      ratchetIndex = recovered.ratchets.findIndex(ratchet => {
        return (
          ratchet.blockHeight === block.blockNumber &&
          ratchet.extrinsicIndex === undefined &&
          ratchet.lockedTargetPrice === lockedTargetPrice
        );
      });
    }
    const isExistingRatchet = ratchetIndex !== -1;
    if (!isExistingRatchet) {
      ratchetIndex = recovered.ratchets.findIndex(ratchet => {
        if (ratchet.blockHeight !== block.blockNumber) return ratchet.blockHeight > block.blockNumber;
        return (ratchet.extrinsicIndex ?? -1) > extrinsicIndex;
      });
      if (ratchetIndex === -1) ratchetIndex = recovered.ratchets.length;
    }

    const previousRatchet = recovered.ratchets[ratchetIndex - 1];
    if (!previousRatchet) throw new Error(`Bitcoin lock ${record.utxoId} ratchet history is missing its prior state`);

    const previousLiquidity = this.getRatchetLiquidity(recovered.ratchets, ratchetIndex - 1);
    if (previousRatchet.lockedTargetPrice !== oldTargetPrice) {
      throw new Error(`Bitcoin lock ${record.utxoId} ratchet history has the wrong prior target price`);
    }

    const isUpRatchet = lockedTargetPrice > oldTargetPrice;
    let mintAmount = isUpRatchet ? cumulativeLiquidity - previousLiquidity : cumulativeLiquidity;
    // Before runtime spec 158 (v1.4.12, 2026-08-13), upward ratchets recorded a fresh total while minting only the increment.
    if (mintAmount < 0n) {
      if (api.runtimeVersion.specVersion.toNumber() >= 158) {
        throw new Error(`Bitcoin lock ${record.utxoId} up-ratchet reduced its promised liquidity`);
      }
      mintAmount = BitcoinLock.calculateRedemptionAmount(
        await this.currency.fetchPriceIndex(api),
        lockedTargetPrice - oldTargetPrice,
      );
    }
    const burned = event.data.amountBurned;
    const tip = await api.query.bitcoinUtxos.confirmedBitcoinBlockTip();
    const ratchet = {
      mintAmount,
      mintPending: mintAmount,
      liquidityPromised: cumulativeLiquidity,
      lockedTargetPrice,
      securityFee,
      txFee: this.readTransactionFee(eventRecords, eventIndex) ?? 0n,
      burned,
      blockHeight: block.blockNumber,
      tick: block.tick,
      extrinsicIndex,
      oracleBitcoinBlockHeight: Number(tip?.blockHeight ?? 0n),
    };
    if (isExistingRatchet) {
      recovered.ratchets.splice(ratchetIndex, 1, ratchet);
    } else {
      recovered.ratchets.splice(ratchetIndex, 0, ratchet);
    }

    const followsCurrentState =
      record.liquidityPromised === previousLiquidity && record.lockedTargetPrice === oldTargetPrice;
    const matchesCurrentState =
      record.liquidityPromised === cumulativeLiquidity && record.lockedTargetPrice === lockedTargetPrice;
    if (followsCurrentState || matchesCurrentState) {
      recovered.lockedTargetPrice = lockedTargetPrice;
      recovered.liquidityPromised = cumulativeLiquidity;
      chainLock.couponFeesPaid = bigIntMax(
        chainLock.couponFeesPaid,
        (record.lockDetails?.couponFeesPaid ?? 0n) +
          (event.data.accountId.toString() === this.walletKeys.defaultArgonAddress ? securityFee : 0n),
      );
      recovered.lockDetails = toBitcoinLockDetails(chainLock);
    }
    this.assertSafePendingMint(recovered);
    await this.saveRecoveredHistory(table, recovered);
    this.applyRecoveredRecord(recovered);
  }

  private createDetachedRecord(
    record: IBitcoinLockRecord | IHistoricalBitcoinLockRecord,
  ): IHistoricalBitcoinLockRecord {
    return createHistoricalBitcoinLockRecord(record);
  }

  private applyHistoricalLockSnapshot(
    record: IHistoricalBitcoinLockRecord,
    chainLock: IHistoricalBitcoinLock,
  ): IBitcoinLockDetails {
    const lockDetails = toBitcoinLockDetails(chainLock);
    lockDetails.couponFeesPaid = bigIntMax(lockDetails.couponFeesPaid, record.couponFeesPaid);
    Object.assign(record, {
      satoshis: lockDetails.fundedSatoshis || lockDetails.securitizedSatoshis,
      liquidityPromised: chainLock.liquidityPromised,
      lockedTargetPrice: chainLock.lockedTargetPrice,
      lockDetails,
      securitizedSatoshis: lockDetails.securitizedSatoshis,
      ownerAccount: lockDetails.ownerAccount,
      securitizationRatio: lockDetails.securitizationRatio,
      securityFees: lockDetails.securityFees,
      couponFeesPaid: lockDetails.couponFeesPaid,
      scriptDetails: toBitcoinLockScriptDetails(lockDetails),
      fundingExpirationHeight: lockDetails.fundingExpirationHeight,
      isFlexible: lockDetails.isFlexible,
      fundHoldExtensionsByBitcoinExpirationHeight: lockDetails.fundHoldExtensionsByBitcoinExpirationHeight,
      createdAtArgonBlock: lockDetails.createdAtArgonBlock,
    });
    return lockDetails;
  }

  private async saveRecoveredHistory(
    table: BitcoinLocksTable,
    record: IHistoricalBitcoinLockRecord,
    createdAt?: Date,
  ): Promise<void> {
    if (this.historyReplay) {
      if (createdAt) record.createdAt = createdAt;
      return;
    }
    if (createdAt) await table.saveRecoveredHistory(record, createdAt);
    else await table.saveRecoveredHistory(record);
  }

  private applyRecoveredRecord(
    record: IBitcoinLockRecord | IHistoricalBitcoinLockRecord,
  ): IHistoricalBitcoinLockRecord {
    const recovered = this.createDetachedRecord(record);
    const utxoId = recovered.utxoId!;
    const stagedLocks = this.historyReplay?.locksByUtxoId;
    this.historyReplay?.dirtyLockUtxoIds.add(utxoId);
    const liveRecord = this.locksByUtxoId[utxoId];
    const stagedRecord =
      stagedLocks?.[utxoId] ?? (stagedLocks && liveRecord ? this.createDetachedRecord(liveRecord) : undefined);
    const current = stagedRecord ?? liveRecord;
    const {
      satoshis: _satoshis,
      lockedTargetPrice: _lockedTargetPrice,
      liquidityPromised: _liquidityPromised,
      ratchets: _ratchets,
      lockDetails: _lockDetails,
      ...currentRecord
    } = recovered;
    const retiredStatus = current && this.isRetiredHistoryRecord(current) ? current.status : undefined;
    if (retiredStatus !== undefined) {
      recovered.status = retiredStatus;
      delete recovered.isHistoryRecoveryPending;
    }
    if (stagedRecord) {
      recovered.fundingUtxo ??= stagedRecord.fundingUtxo;
      Object.assign(stagedRecord, recovered);
      if (retiredStatus !== undefined) stagedRecord.status = retiredStatus;
      stagedLocks![utxoId] = stagedRecord;
      return stagedRecord;
    }
    if (liveRecord) {
      recovered.fundingUtxo ??= liveRecord.fundingUtxo;
      Object.assign(liveRecord, currentRecord);
      if (retiredStatus !== undefined) liveRecord.status = retiredStatus;
      return recovered;
    }

    if (stagedLocks) {
      stagedLocks[utxoId] = recovered;
    } else {
      this.locksByUtxoId[utxoId] = currentRecord;
    }
    return recovered;
  }

  private getRecoveryLock(utxoId: number): IHistoricalBitcoinLockRecord | undefined {
    const recovered = this.historyReplay?.locksByUtxoId[utxoId];
    if (recovered) return recovered;
    const live = this.locksByUtxoId[utxoId];
    return live ? this.createDetachedRecord(live) : undefined;
  }

  private async prepareHistoryRecoveryLock(lock: IBitcoinLockRecord, lockQueueOwnerUuid?: string): Promise<void> {
    if (!this.historyReplay) return;

    const utxoId = lock.utxoId;
    if (utxoId === undefined || this.historyReplay.locksByUtxoId[utxoId] || this.isRetiredHistoryRecord(lock)) {
      return;
    }

    const fundingRecord = this.utxoTracking.getAcceptedFundingRecordForLock(lock);
    if (lock.status === BitcoinLockStatus.Releasing && this.utxoTracking.isReleaseStatus(fundingRecord?.status)) return;

    await this.waitForLockIdle(lock, lock.uuid === lockQueueOwnerUuid);
    const snapshot = this.createDetachedRecord(lock);
    this.historyReplay.locksByUtxoId[utxoId] = snapshot;
    this.historyReplay.originalLocksByUtxoId[utxoId] = this.createDetachedRecord(snapshot);
  }

  private isRetiredHistoryRecord(lock: Pick<IBitcoinLockRecord, 'status' | 'removalReason'>): boolean {
    return (
      !!lock.removalReason ||
      [BitcoinLockStatus.Released, BitcoinLockStatus.LockFailed, BitcoinLockStatus.LockFailedAcknowledged].includes(
        lock.status,
      )
    );
  }

  private hasCompleteRatchetEconomics(
    record: IHistoricalBitcoinLockRecord,
    chainLiquidityPromised: bigint,
    chainLockedTargetPrice: bigint,
  ): boolean {
    if (!record.ratchets.length) return false;

    let recoveredLiquidity = 0n;
    let previousTargetPrice: bigint | undefined;
    for (let index = 0; index < record.ratchets.length; index += 1) {
      const ratchet = record.ratchets[index];
      recoveredLiquidity = this.getRatchetLiquidity(record.ratchets, index);
      const previousLiquidity = this.getRatchetLiquidity(record.ratchets, index - 1);
      let expectedMint = recoveredLiquidity;
      if (previousTargetPrice !== undefined) {
        if (ratchet.lockedTargetPrice >= previousTargetPrice) {
          expectedMint -= previousLiquidity;
        }
      }
      if (expectedMint < 0n) {
        if (ratchet.mintAmount <= 0n) return false;
      } else if (ratchet.mintAmount !== expectedMint) {
        return false;
      }
      if (ratchet.mintPending < 0n || ratchet.mintPending > ratchet.mintAmount) return false;
      previousTargetPrice = ratchet.lockedTargetPrice;
    }

    const latestTargetPrice = record.ratchets.at(-1)!.lockedTargetPrice;
    return (
      record.liquidityPromised === chainLiquidityPromised &&
      recoveredLiquidity === chainLiquidityPromised &&
      latestTargetPrice === record.lockedTargetPrice &&
      record.lockedTargetPrice === chainLockedTargetPrice
    );
  }

  private getRatchetLiquidity(
    ratchets: readonly IHistoricalBitcoinLockRecord['ratchets'][number][],
    index: number,
  ): bigint {
    if (index < 0) return 0n;

    let liquidity = 0n;
    for (let currentIndex = 0; currentIndex <= index; currentIndex += 1) {
      const ratchet = ratchets[currentIndex];
      if (ratchet.liquidityPromised !== undefined) {
        liquidity = ratchet.liquidityPromised;
      } else if (currentIndex === 0) {
        liquidity = ratchet.mintAmount;
      } else if (ratchet.mintAmount === 0n && ratchet.burned > 0n) {
        liquidity = ratchet.burned;
      } else {
        liquidity += ratchet.mintAmount;
      }
    }
    return liquidity;
  }

  private assertSafePendingMint(record: IHistoricalBitcoinLockRecord): void {
    const totalLiquidity = record.ratchets.reduce((sum, ratchet) => sum + ratchet.mintAmount, 0n);
    const pendingMint = record.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
    if (record.ratchets.some(ratchet => ratchet.mintPending < 0n)) {
      throw new Error(`Bitcoin lock ${record.utxoId} has a negative recovered pending mint`);
    }
    if (record.ratchets.some(ratchet => ratchet.mintPending > ratchet.mintAmount)) {
      throw new Error(`Bitcoin lock ${record.utxoId} pending mint exceeds recovered liquidity`);
    }
    if (pendingMint > totalLiquidity) {
      throw new Error(`Bitcoin lock ${record.utxoId} pending mint exceeds recovered liquidity`);
    }
  }

  private async findDerivedPubkeyForOwner(vaultId: number, ownerPubkey: Parameters<typeof u8aEq>[0], maxTries = 100) {
    for (let index = 0; index < maxTries; index += 1) {
      const derivedPubkey = await this.getDerivedPubkey(vaultId, index);
      if (!u8aEq(ownerPubkey, derivedPubkey.ownerBitcoinPubkey)) continue;

      if (this.historyReplay) {
        const scopeKey = vaultId.toString();
        this.historyReplay.hdKeys.set(`${scopeKey}:${derivedPubkey.hdIndex}`, {
          keyRole: 'bitcoinLock',
          scopeKey,
          hdIndex: derivedPubkey.hdIndex,
          hdPath: derivedPubkey.hdPath,
          address: derivedPubkey.address,
          publicKeyHex: u8aToHex(derivedPubkey.ownerBitcoinPubkey),
        });
      } else {
        await this.trackDerivedBitcoinLockKey(vaultId, derivedPubkey);
      }
      return derivedPubkey;
    }
  }

  private readUtxoId(event: HistoricalEvent): number | undefined {
    const value = 'utxoId' in event.data ? event.data.utxoId : undefined;
    if (value == null) return;
    const utxoId = Number(value);
    if (Number.isSafeInteger(utxoId)) return utxoId;
    throw new Error(`Historical ${event.section}.${event.method} has an invalid Bitcoin lock id`);
  }

  private recordSecuritizationTerm(
    block: IBlockHeaderInfo,
    record: NamedBitcoinRecoveryEventRecord,
    lock: IHistoricalBitcoinLock,
    origin: IBitcoinSecuritizationTerm['origin'],
  ): void {
    const replay = this.historyReplay;
    const coverage = lock.securitizationCoverageMicrogons;
    if (!replay) return;

    const terms = origin === 'created' ? [] : (replay.securitizationTermsByUtxoId.get(lock.utxoId) ?? []);
    const previous = terms.at(-1);
    const cumulativeNetSecurityFee = bigIntMax(lock.securityFees - lock.couponFeesPaid, 0n);
    const phase = record.phase;
    const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : undefined;
    if (previous) {
      Object.assign(previous, {
        endTick: block.tick,
        endBlockNumber: block.blockNumber,
        endBlockHash: block.blockHash,
        endExtrinsicIndex: extrinsicIndex,
        endReason: 'resecuritized' as const,
      });
    }
    terms.push({
      utxoId: lock.utxoId,
      termIndex: terms.length,
      origin,
      startTick: block.tick,
      startBlockNumber: block.blockNumber,
      startBlockHash: block.blockHash,
      startExtrinsicIndex: extrinsicIndex,
      securitizedSatoshis: lock.securitizedSatoshis,
      securitizationCoverageMicrogons: coverage ?? null,
      cumulativeNetSecurityFee,
      addedNetSecurityFee: bigIntMax(cumulativeNetSecurityFee - (previous?.cumulativeNetSecurityFee ?? 0n), 0n),
    });
    replay.securitizationTermsByUtxoId.set(lock.utxoId, terms);
  }

  private closeSecuritizationTerm(block: IBlockHeaderInfo, record: NamedBitcoinRecoveryEventRecord): void {
    const replay = this.historyReplay;
    const utxoId = this.readUtxoId(record.event);
    if (!replay || utxoId === undefined) return;

    const term = replay.securitizationTermsByUtxoId.get(utxoId)?.at(-1);
    if (!term) return;
    const phase = record.phase;
    Object.assign(term, {
      endTick: block.tick,
      endBlockNumber: block.blockNumber,
      endBlockHash: block.blockHash,
      endExtrinsicIndex: phase.type === 'ApplyExtrinsic' ? phase.value : undefined,
      endReason: 'released' as const,
    });
  }

  private readTransactionFee(
    records: readonly NamedBitcoinRecoveryEventRecord[],
    operationEventIndex: number,
  ): bigint | undefined {
    const phase = records[operationEventIndex].phase;
    if (phase.type !== 'ApplyExtrinsic') return;

    const extrinsicIndex = phase.value;
    const feeRecord = records.find(
      (
        record,
      ): record is NamedBitcoinRecoveryEventRecord & {
        event: Extract<HistoricalEvent, { section: 'transactionPayment'; method: 'TransactionFeePaid' }>;
      } => {
        return (
          record.phase.type === 'ApplyExtrinsic' &&
          record.phase.value === extrinsicIndex &&
          record.event.section === 'transactionPayment' &&
          record.event.method === 'TransactionFeePaid'
        );
      },
    );
    if (!feeRecord) return;

    const payer = feeRecord.event.data.who;
    const ownedAccounts = new Set([
      this.walletKeys.defaultArgonAddress,
      this.walletKeys.miningBotAddress,
      this.walletKeys.operationalAddress,
    ]);
    return ownedAccounts.has(payer) ? feeRecord.event.data.actualFee : 0n;
  }

  private async applyScopedMint(
    record: IHistoricalBitcoinLockRecord,
    amount: bigint,
    api: ArgonApi,
    table: BitcoinLocksTable,
  ): Promise<void> {
    const recovered = this.createDetachedRecord(record);
    const pendingMint = recovered.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
    const chainPendingMints = await getHistoricalBitcoinPendingMints(api, recovered.lockDetails.utxoId);
    const chainPendingMint = chainPendingMints.reduce((sum, pending) => sum + pending, 0n);
    if (chainPendingMint > pendingMint) {
      throw new Error(`Bitcoin lock ${record.utxoId} pending mint exceeds recovered history`);
    }
    this.assertSafePendingMint(recovered);
    if (chainPendingMint === pendingMint) return;

    if (amount > pendingMint) {
      throw new Error(`Bitcoin lock ${record.utxoId} mint exceeds recovered pending liquidity`);
    }
    if (pendingMint - amount < chainPendingMint) {
      throw new Error(`Bitcoin lock ${record.utxoId} scoped mint falls below canonical pending liquidity`);
    }

    let remaining = amount;
    for (const ratchet of recovered.ratchets) {
      if (remaining === 0n) break;

      const fulfilled = bigIntMin(ratchet.mintPending, remaining);
      ratchet.mintPending -= fulfilled;
      remaining -= fulfilled;
    }

    this.assertSafePendingMint(recovered);
    this.applyRecoveredRecord(recovered);
  }

  private async reconcilePendingMint(
    record: IHistoricalBitcoinLockRecord,
    api: ArgonApi,
    lockQueueOwnerUuid?: string,
  ): Promise<void> {
    const recovered = this.createDetachedRecord(record);
    const chainPendingMints = await getHistoricalBitcoinPendingMints(api, recovered.lockDetails.utxoId);
    const chainPendingMint = chainPendingMints.reduce((sum, amount) => sum + amount, 0n);
    const recoveredPendingMint = recovered.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
    if (chainPendingMint > recoveredPendingMint) {
      await this.prepareHistoryRecoveryLock(record, lockQueueOwnerUuid);
      throw new Error(`Bitcoin lock ${record.utxoId} pending mint exceeds recovered history`);
    }
    this.assertSafePendingMint(recovered);
    if (chainPendingMint === recoveredPendingMint) return;

    await this.prepareHistoryRecoveryLock(record, lockQueueOwnerUuid);
    let fulfilled = recoveredPendingMint - chainPendingMint;
    for (const ratchet of recovered.ratchets) {
      if (fulfilled <= 0n) break;
      const fulfilledFromRatchet = bigIntMin(ratchet.mintPending, fulfilled);
      ratchet.mintPending -= fulfilledFromRatchet;
      fulfilled -= fulfilledFromRatchet;
    }
    this.assertSafePendingMint(recovered);
    this.applyRecoveredRecord(recovered);
  }

  private get locksByUtxoId(): Record<number, IBitcoinLockRecord> {
    return this.getLocksByUtxoId();
  }

  private get pendingLocks(): IBitcoinLockRecord[] {
    return this.getPendingLocks();
  }
}

type BitcoinRecoveryEventRecord = RuntimeSystemEventRecord;
type NamedBitcoinRecoveryEventRecord = RuntimeSystemEventRecord & { event: HistoricalEvent };
