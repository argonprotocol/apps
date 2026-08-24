import {
  BitcoinLock,
  PriceIndex,
  u8aEq,
  u8aToHex,
  type ApiDecoration,
  type ArgonPrimitivesBitcoinUtxoRef,
  type Bytes,
  type FrameSystemEventRecord,
  type GenericEvent,
} from '@argonprotocol/mainchain';
import {
  bigIntMax,
  bigIntMin,
  type BlockWatch,
  type Currency,
  type IBlockHeaderInfo,
  JsonExt,
  type MainchainClients,
  readEventField,
  StorageFinder,
  TransactionEvents,
} from '@argonprotocol/apps-core';
import {
  applyCanonicalPreFundingState,
  applyBitcoinLockMintState,
  BitcoinLocksTable,
  BitcoinLockStatus,
  createBitcoinLockCreationRatchets,
  type IBitcoinLockRecord,
} from '../db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus, isBitcoinUtxoReleaseStatus, type IBitcoinUtxoRecord } from '../db/BitcoinUtxosTable.ts';
import BitcoinUtxoTracking from '../BitcoinUtxoTracking.ts';
import type { IMempoolTxStatus } from '../BitcoinMempool.ts';
import type { deriveBitcoinLockHdKey, WalletKeys } from '../WalletKeys.ts';
import type { Db } from '../Db.ts';
import type { IBitcoinRequestLockMetadata } from '../BitcoinLocks.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import { readRequiredEventBigInt, readRequiredEventField } from './index.ts';
import { getHistoricalBitcoinLock } from './BitcoinLockHistory.ts';

type BitcoinRecoveryUtxoTracking = Pick<
  BitcoinUtxoTracking,
  | 'getAcceptedFundingRecordForLock'
  | 'getAllOrphanLifecycleUtxos'
  | 'getObservedStatusForUpsert'
  | 'getUtxoRecord'
  | 'getUtxoRecordById'
  | 'getUtxosForLock'
  | 'isReleaseCompleteStatus'
  | 'isReleaseStatus'
  | 'load'
  | 'setAcceptedFundingRecordForLock'
  | 'setReleaseCosign'
  | 'setReleaseIsProcessingOnArgon'
  | 'setReleaseRequest'
  | 'shouldUpdateObservedCandidateStatus'
  | 'upsertUtxoRecord'
>;

export class BitcoinLockRecovery {
  private readonly walletKeys: WalletKeys;
  private readonly blockWatch: BlockWatch;
  private readonly currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>;
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
  private readonly activeLocksByUtxoId = new Map<number, BitcoinLock | undefined>();
  private activeLockRecoveryPromise?: Promise<IBitcoinLockRecord[]>;
  private readonly insertPending: (
    details: Pick<IBitcoinLockRecord, 'uuid' | 'satoshis' | 'vaultId' | 'hdPath'>,
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
    currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>;
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

  public async commitHistoryReplay(isComplete = true): Promise<void> {
    const replay = this.historyReplay;
    if (!replay) return;

    if (!isComplete || replay.hasUnscopedFailure) {
      this.historyReplay = undefined;
      this.activeLocksByUtxoId.clear();
      this.onHistoryRecoveryComplete(Object.values(replay.locksByUtxoId));
      return;
    }

    const lockScope = replay.lockScope;
    const table = await this.getTable();
    const locks = [...replay.dirtyLockUtxoIds]
      .map(utxoId => replay.locksByUtxoId[utxoId])
      .filter((lock): lock is IBitcoinLockRecord => Boolean(lock));
    const utxos = replay.utxos.records;
    const db = await this.dbPromise;
    const persistedLocksByUtxoId = new Map<number, IBitcoinLockRecord>();
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

      const recoveredFundingRecord = recovered.fundingUtxoRecord;
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
        const persistedEconomics = durable ? getBitcoinLockEconomicsFingerprint(durable) : undefined;
        const originalEconomics = original ? getBitcoinLockEconomicsFingerprint(original) : undefined;
        const recoveredEconomics = getBitcoinLockEconomicsFingerprint(recovered);
        if (
          persistedEconomics !== undefined &&
          originalEconomics !== undefined &&
          persistedEconomics !== originalEconomics &&
          persistedEconomics !== recoveredEconomics
        ) {
          throw new Error(`Bitcoin lock ${recovered.utxoId} changed during history recovery; retry the replay`);
        }

        if (!durable) {
          durable = await table.insertPending({
            uuid: recovered.uuid,
            status: BitcoinLockStatus.LockIsProcessingOnArgon,
            satoshis: recovered.satoshis,
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
          const creation = recovered.ratchets[0];
          durable = await table.finalizePending({
            uuid: durable.uuid,
            lock: recovered.lockDetails,
            createdAtArgonBlockHeight: creation?.blockHeight ?? recovered.lockDetails.createdAtArgonBlock,
            finalFee: creation?.txFee ?? 0n,
          });
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

        if (recovered.fundingUtxoRecord) {
          const fundingUtxo = await db.bitcoinUtxosTable.getByLockOutpoint(
            recovered.utxoId,
            recovered.fundingUtxoRecord.txid,
            recovered.fundingUtxoRecord.vout,
          );
          if (fundingUtxo) await table.setFundingUtxoRecordId(resolved, fundingUtxo.id);
        }

        persistedLocksByUtxoId.set(recovered.utxoId, resolved);
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
  }

  public async cancelHistoryReplay(): Promise<void> {
    const replay = this.historyReplay;
    const commitStarted = replay?.commitStarted;
    this.historyReplay = undefined;
    if (!commitStarted) await this.publishCompleteActiveLocks();
    this.activeLocksByUtxoId.clear();
    if (replay) this.onHistoryRecoveryComplete(Object.values(replay.locksByUtxoId));
  }

  public async recoverBlock(
    block: IBlockHeaderInfo,
    eventRecords: readonly BitcoinRecoveryEventRecord[],
    options: { lockQueueOwnerUuid?: string } = {},
  ): Promise<void> {
    if (this.historyReplay) this.historyReplay.currentLockUtxoId = undefined;

    const api = await this.blockWatch.getApi(block);
    const table = await this.getTable();
    const utxoTracking = this.historyReplay?.utxos ?? this.utxoTracking;

    for (let eventIndex = 0; eventIndex < eventRecords.length; eventIndex += 1) {
      if (this.historyReplay) this.historyReplay.currentLockUtxoId = undefined;

      const { event } = eventRecords[eventIndex];
      const isBitcoinMint = event.section === 'mint' && event.method === 'BitcoinMint';
      const isBitcoinUtxoVerified = event.section === 'bitcoinUtxos' && event.method === 'UtxoVerified';
      const isBitcoinUtxoUnwatched = event.section === 'bitcoinUtxos' && event.method === 'UtxoUnwatched';
      if (event.section !== 'bitcoinLocks' && !isBitcoinMint && !isBitcoinUtxoVerified && !isBitcoinUtxoUnwatched) {
        continue;
      }
      const bitcoinLockPolicy =
        event.section === 'bitcoinLocks' ? bitcoinRecoveryEventPolicies[event.method] : undefined;
      const isUnknownBitcoinLockEvent = event.section === 'bitcoinLocks' && !bitcoinLockPolicy;
      if (bitcoinLockPolicy === 'ignore') continue;

      const utxoId = this.readUtxoId(event, block);
      if (isBitcoinMint && utxoId === undefined) {
        if (readRequiredEventField(event, 'accountId', block).toString() !== this.walletKeys.defaultArgonAddress)
          continue;

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
          if (record) await this.reconcilePendingMint(record, api, table, options.lockQueueOwnerUuid);
        }
        continue;
      }
      if (utxoId === undefined) continue;
      if (this.historyReplay) this.historyReplay.currentLockUtxoId = utxoId;
      if (
        (isBitcoinMint ||
          event.method === 'BitcoinLockCreated' ||
          event.method === 'BitcoinLockRatcheted' ||
          event.method === 'SecuritizationIncreased' ||
          event.method === 'UtxoFundedFromCandidate') &&
        readRequiredEventField(event, 'accountId', block).toString() !== this.walletKeys.defaultArgonAddress
      ) {
        continue;
      }
      if (this.historyReplay?.lockScope === 'pending' && !this.historyRecoveryPendingUtxoIds.has(utxoId)) continue;

      const liveRecord = this.locksByUtxoId[utxoId];
      if (liveRecord) await this.prepareHistoryRecoveryLock(liveRecord, options.lockQueueOwnerUuid);

      if (event.method === 'BitcoinLockCreated') {
        const chainLock = await getHistoricalBitcoinLock(api, utxoId);
        if (!chainLock) throw new Error(`Bitcoin lock ${utxoId} is unavailable at its creation block`);
        chainLock.couponFeesPaid = bigIntMax(chainLock.couponFeesPaid, this.readUnchargedSecurityFee(event, block));
        const creationLiquidity = readRequiredEventBigInt(event, ['liquidityPromised'], block);
        const creationTargetPrice = readRequiredEventBigInt(
          event,
          ['lockedTargetPrice', 'lockedMarketRate', 'peggedPrice', 'lockPrice'],
          block,
        );
        const transactionFee = this.readTransactionFee(eventRecords, eventIndex, block) ?? 0n;
        const extrinsicIndex = eventRecords[eventIndex].phase.isApplyExtrinsic
          ? eventRecords[eventIndex].phase.asApplyExtrinsic.toNumber()
          : undefined;
        const creationEventRatchet = {
          mintAmount: creationLiquidity,
          mintPending: creationLiquidity,
          lockedTargetPrice: creationTargetPrice,
          blockHeight: block.blockNumber,
          burned: 0n,
          securityFee: chainLock.securityFees,
          txFee: transactionFee,
          oracleBitcoinBlockHeight: chainLock.createdAtHeight,
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
                extrinsicIndex,
              };
              // The active-lock fallback stores current liquidity here; the creation event restores the real baseline.
              delete recovered.ratchets[creationRatchetIndex].liquidityPromised;
              recovered.lockDetails = chainLock;
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
        recovered.satoshis = chainLock.satoshis;
        recovered.liquidityPromised = chainLock.liquidityPromised;
        recovered.lockedTargetPrice = chainLock.lockedTargetPrice;
        recovered.lockDetails = chainLock;
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
      if (restoresPreFundingState) {
        const chainLock = await getHistoricalBitcoinLock(api, utxoId);
        if (!chainLock) throw new Error(`Bitcoin lock ${utxoId} is unavailable after ${event.method}`);

        const recovered = this.createDetachedRecord(record);
        // These events mutate the original lock rather than creating a new ratchet.
        // Use the archived post-event state because older event shapes omit some resulting economics.
        const currentSatoshis = applyCanonicalPreFundingState(recovered, chainLock);

        let fundingRecord;
        if (isBitcoinUtxoVerified || event.method === 'UtxoFundedFromCandidate') {
          if (recovered.status === BitcoinLockStatus.LockPendingFunding) {
            recovered.status = BitcoinLockStatus.LockedAndIsMinting;
          }
          const utxoRef = await chainLock.getFundingUtxoRef(api);
          if (utxoRef) {
            fundingRecord = await utxoTracking.upsertUtxoRecord(
              recovered,
              { txid: utxoRef.txid, vout: utxoRef.vout, satoshis: currentSatoshis },
              { markFundingUtxo: true },
            );
            await utxoTracking.setAcceptedFundingRecordForLock(recovered, fundingRecord);
          }
        }

        this.assertSafePendingMint(recovered);
        await this.saveRecoveredHistory(table, recovered);
        if (fundingRecord && !this.historyReplay) {
          await table.setFundingUtxoRecordId(recovered, fundingRecord.id);
        }
        this.applyRecoveredRecord(recovered);
      } else if (isBitcoinUtxoUnwatched) {
        if (record.status !== BitcoinLockStatus.LockPendingFunding) continue;

        const chainLock = await getHistoricalBitcoinLock(api, utxoId);
        if (chainLock) continue;

        const recovered = this.createDetachedRecord(record);
        if (this.historyReplay) recovered.status = BitcoinLockStatus.LockExpiredWaitingForFunding;
        else await table.setLockExpiredWaitingForFunding(recovered);
        this.applyRecoveredRecord(recovered);
      } else if (event.method === 'BitcoinLockBackfillChanged' || event.method === 'BitcoinLockFlexibleChanged') {
        const fieldName = event.method === 'BitcoinLockBackfillChanged' ? 'isBackfill' : 'isFlexible';
        const recovered = this.createDetachedRecord(record);
        recovered.lockDetails = new BitcoinLock({
          ...record.lockDetails,
          isFlexible: readRequiredEventField(event, fieldName, block).toHuman() === true,
        });
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
        recovered.satoshis = chainLock.utxoSatoshis ?? chainLock.satoshis;
        recovered.liquidityPromised = chainLock.liquidityPromised;
        recovered.lockedTargetPrice = chainLock.lockedTargetPrice;
        recovered.lockDetails = chainLock;
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } else if (event.method === 'OrphanedUtxoReceived') {
        const utxoRef = readRequiredEventField(event, 'utxoRef', block) as ArgonPrimitivesBitcoinUtxoRef;
        await utxoTracking.upsertUtxoRecord(
          record,
          {
            txid: utxoRef.txid.toHex(),
            vout: utxoRef.outputIndex.toNumber(),
            satoshis: readRequiredEventBigInt(event, ['satoshis'], block),
          },
          { markOrphaned: true },
        );
      } else if (event.method === 'OrphanedUtxoReleaseRequested') {
        const ownerAccount = readRequiredEventField(event, 'accountId', block).toString();
        if (ownerAccount !== record.lockDetails.ownerAccount) continue;
        const utxoRef = readRequiredEventField(event, 'utxoRef', block) as ArgonPrimitivesBitcoinUtxoRef;
        const orphanMaybe = await api.query.bitcoinLocks.orphanedUtxosByAccount(ownerAccount, utxoRef);
        if (orphanMaybe.isNone) continue;
        const orphan = orphanMaybe.unwrap();
        if (orphan.cosignRequest.isNone) continue;
        const request = orphan.cosignRequest.unwrap();
        const orphanRecord = await utxoTracking.upsertUtxoRecord(
          record,
          {
            txid: utxoRef.txid.toHex(),
            vout: utxoRef.outputIndex.toNumber(),
            satoshis: orphan.satoshis.toBigInt(),
          },
          { markOrphaned: true },
        );
        await utxoTracking.setReleaseIsProcessingOnArgon(orphanRecord, {
          requestedReleaseAtTick: await api.query.ticks.currentTick().then(tick => tick.toNumber()),
          releaseToDestinationAddress: u8aToHex(request.toScriptPubkey, undefined, false),
          releaseBitcoinNetworkFee: request.bitcoinNetworkFee.toBigInt(),
        });
      } else if (event.method === 'OrphanedUtxoCosigned') {
        const ownerAccount = readEventField(event, 'accountId')?.toString() ?? record.lockDetails.ownerAccount;
        if (ownerAccount !== record.lockDetails.ownerAccount) continue;
        const utxoRef = readRequiredEventField(event, 'utxoRef', block) as ArgonPrimitivesBitcoinUtxoRef;
        const orphanRecord = utxoTracking.getUtxoRecord(utxoId, utxoRef.txid.toHex(), utxoRef.outputIndex.toNumber());
        if (!orphanRecord) continue;
        const signature = readRequiredEventField(event, 'signature', block) as Bytes;
        await utxoTracking.setReleaseCosign(orphanRecord, {
          releaseCosignVaultSignature: signature.toU8a(true),
          releaseCosignHeight: block.blockNumber,
        });
      } else if (event.method === 'BitcoinLockRatcheted') {
        await this.importRatchet(record, block, eventRecords, eventIndex, api, table);
      } else if (isBitcoinMint) {
        await this.applyScopedMint(record, readRequiredEventBigInt(event, ['amount'], block), api, table);
      } else if (event.method === 'BitcoinUtxoCosignRequested') {
        const releaseRequest = await new BitcoinLock(record.lockDetails).getReleaseRequest(api);
        if (!releaseRequest) {
          throw new Error(`Bitcoin lock ${utxoId} release request is unavailable at block ${block.blockNumber}`);
        }
        const recovered = this.createDetachedRecord(record);
        const releaseArgonTxFeeMicrogons = this.readTransactionFee(eventRecords, eventIndex, block);
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
          const utxoRef = await new BitcoinLock(recovered.lockDetails).getFundingUtxoRef(api);
          if (utxoRef) {
            fundingRecord = await utxoTracking.upsertUtxoRecord(
              recovered,
              { txid: utxoRef.txid, vout: utxoRef.vout, satoshis: recovered.satoshis },
              { markFundingUtxo: true },
            );
            await utxoTracking.setAcceptedFundingRecordForLock(recovered, fundingRecord);
            if (!this.historyReplay) {
              await table.setFundingUtxoRecordId(recovered, fundingRecord.id);
            }
          }
        }
        if (fundingRecord && !this.utxoTracking.isReleaseStatus(fundingRecord.status)) {
          await utxoTracking.setReleaseRequest(fundingRecord, {
            requestedReleaseAtTick: await api.query.ticks.currentTick().then(tick => tick.toNumber()),
            releaseToDestinationAddress: releaseRequest.toScriptPubkey,
            releaseBitcoinNetworkFee: releaseRequest.bitcoinNetworkFee,
          });
        }
        this.applyRecoveredRecord(recovered);
      } else if (event.method === 'BitcoinUtxoCosigned') {
        const fundingRecord = utxoTracking.getAcceptedFundingRecordForLock(record);
        if (fundingRecord) {
          const signature = readRequiredEventField(event, 'signature', block) as Bytes;
          await utxoTracking.setReleaseCosign(fundingRecord, {
            releaseCosignVaultSignature: signature.toU8a(true),
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
              removalExtrinsicIndex: phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : undefined,
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
      } else if (event.method === 'BitcoinCosignPastDue') {
        const recovered = this.createDetachedRecord(record);
        const compensation = readRequiredEventBigInt(event, ['compensationAmount'], block);
        if (this.historyReplay) recovered.releaseCompensationMicrogons ??= compensation;
        else await table.recordReleaseCompensation(recovered, compensation);
        this.applyRecoveredRecord(recovered);
      } else if (event.method === 'BitcoinSpentAfterRelease' || event.method === 'BitcoinLockBurned') {
        let removalReason: NonNullable<IBitcoinLockRecord['removalReason']> = 'released';
        let status = BitcoinLockStatus.Released;
        if (event.method === 'BitcoinLockBurned') {
          const wasUtxoSpent = readRequiredEventField(event, 'wasUtxoSpent', block).toString().toLowerCase() === 'true';
          removalReason = wasUtxoSpent ? 'spent' : 'expired';
          if (!wasUtxoSpent) status = BitcoinLockStatus.Releasing;
        }

        const recovered = this.createDetachedRecord(record);
        const rates = await this.currency.fetchMainchainRatesAtBlock({ api, block });
        const phase = eventRecords[eventIndex].phase;
        const removal = {
          removalBlockNumber: block.blockNumber,
          removalBlockHash: block.blockHash,
          removalBlockTime: new Date(block.blockTime),
          removalExtrinsicIndex: phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : undefined,
          removalReason,
          btcPriceAtRemovalMicrogons: rates.BTC,
        };
        if (this.historyReplay) {
          if (!recovered.removalReason || recovered.removalReason === removal.removalReason) {
            recovered.status = status;
          }
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
    lock: BitcoinLock;
    createdAtArgonBlockHeight: number;
    finalFee: bigint;
    lockQueueOwnerUuid?: string;
  }): Promise<IBitcoinLockRecord> {
    const liveRecord = this.locksByUtxoId[args.lock.utxoId];
    if (this.historyReplay && liveRecord) {
      await this.prepareHistoryRecoveryLock(liveRecord, args.lockQueueOwnerUuid);
    }

    const table = await this.getTable();
    const existing = await table.getByUtxoId(args.lock.utxoId);
    if (existing) {
      await this.prepareHistoryRecoveryLock(existing, args.lockQueueOwnerUuid);
      if (
        !this.historyReplay &&
        !this.hasCompleteRatchetEconomics(existing, args.lock.liquidityPromised, args.lock.lockedTargetPrice)
      ) {
        const recovered = this.createDetachedRecord(existing);
        const knownTransactionFees = bigIntMax(
          args.finalFee,
          recovered.ratchets.reduce((total, ratchet) => total + ratchet.txFee, 0n),
        );
        const knownSecurityFees = recovered.ratchets.reduce((total, ratchet) => total + ratchet.securityFee, 0n);
        recovered.satoshis = args.lock.utxoSatoshis ?? args.lock.satoshis;
        recovered.liquidityPromised = args.lock.liquidityPromised;
        recovered.lockedTargetPrice = args.lock.lockedTargetPrice;
        recovered.lockDetails = args.lock;
        // This chain snapshot restores current actions; event replay can replace it with full ratchet history.
        recovered.ratchets = [
          {
            mintAmount: args.lock.liquidityPromised,
            mintPending: recovered.status === BitcoinLockStatus.LockedAndMinted ? 0n : args.lock.liquidityPromised,
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
        return this.applyRecoveredRecord(recovered);
      }
      return this.applyRecoveredRecord(existing);
    }

    const derivedPubkey = await this.findDerivedPubkeyForOwner(args.lock.vaultId, args.lock.ownerPubkey);
    if (!derivedPubkey) throw new Error(`Unable to recover the HD path for Bitcoin lock ${args.lock.utxoId}`);

    let record = await table.findPendingByHdPath(derivedPubkey.hdPath);
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

    if (this.historyReplay) {
      const now = new Date();
      record = record
        ? this.createDetachedRecord(record)
        : {
            uuid: recoveredUuid,
            status: BitcoinLockStatus.LockIsProcessingOnArgon,
            satoshis: args.lock.satoshis,
            liquidityPromised: 0n,
            lockedTargetPrice: 0n,
            ratchets: [],
            cosignVersion: 'v1',
            lockDetails: args.lock,
            fundingUtxoRecordId: null,
            network: this.getBitcoinNetwork(),
            hdPath: derivedPubkey.hdPath,
            vaultId: args.lock.vaultId,
            createdAt: now,
            updatedAt: now,
          };
      if (record.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
        record.status = BitcoinLockStatus.LockPendingFunding;
        record.utxoId = args.lock.utxoId;
        record.liquidityPromised = args.lock.liquidityPromised;
        record.lockedTargetPrice = args.lock.lockedTargetPrice;
        record.lockDetails = args.lock;
        record.ratchets = createBitcoinLockCreationRatchets(args.lock, args.createdAtArgonBlockHeight, args.finalFee);
      }
    } else {
      if (!record) {
        record = await this.insertPending({
          uuid: recoveredUuid,
          vaultId: args.lock.vaultId,
          satoshis: args.lock.satoshis,
          hdPath: derivedPubkey.hdPath,
        });
      }
      if (record.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
        record = await table.finalizePending({
          uuid: record.uuid,
          lock: args.lock,
          createdAtArgonBlockHeight: args.createdAtArgonBlockHeight,
          finalFee: args.finalFee,
        });
      }
    }
    await this.prepareHistoryRecoveryLock(record, args.lockQueueOwnerUuid);
    return this.applyRecoveredRecord(record);
  }

  public recoverActiveLocks(): Promise<IBitcoinLockRecord[]> {
    this.activeLockRecoveryPromise ??= (async () => {
      this.activeLocksByUtxoId.clear();
      const api = await this.blockWatch.getFinalizedApi();
      const utxoIds = await this.findActiveLockIds(api);
      const activeUtxoIds = new Set(utxoIds);
      const records: IBitcoinLockRecord[] = [];
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

          const record = await this.recoverLock({
            lock,
            createdAtArgonBlockHeight: lock.createdAtArgonBlock,
            finalFee: 0n,
          });
          this.activeLockRecoveryFailedUtxoIds.delete(utxoId);
          this.activeLocksByUtxoId.set(utxoId, lock);
          records.push(record);
        } catch (error) {
          this.activeLockRecoveryFailedUtxoIds.add(utxoId);
          console.warn(`Unable to restore active Bitcoin lock ${utxoId} from chain:`, error);
        }
      }

      await this.publishCompleteActiveLocks();
      return records.sort((left, right) => right.ratchets[0].blockHeight - left.ratchets[0].blockHeight);
    })().finally(() => {
      this.activeLockRecoveryPromise = undefined;
    });
    return this.activeLockRecoveryPromise;
  }

  public async recoverActiveLockCreationDetails(mainchainClients: MainchainClients): Promise<void> {
    const api = await this.blockWatch.getFinalizedApi();
    const utxoIds = await this.findActiveLockIds(api);
    const table = await this.getTable();
    const archiveClient = await mainchainClients.archiveClientPromise.catch(error => {
      console.warn('Unable to recover Bitcoin lock creation details:', error);
      return undefined;
    });
    if (!archiveClient) return;

    for (const utxoId of utxoIds) {
      try {
        const lock = await BitcoinLock.get(api, utxoId);
        const record = await table.getByUtxoId(utxoId);
        if (!lock || !record?.ratchets.length) continue;

        let creationBlockNumber = lock.createdAtArgonBlock;
        let creationBlockHash: Uint8Array | undefined;
        if (creationBlockNumber > 0) {
          creationBlockHash = await archiveClient.rpc.chain.getBlockHash(creationBlockNumber);
        } else {
          // Locks migrated from storage predating createdAtArgonBlock have a zero value.
          const lockStorageKey = archiveClient.query.bitcoinLocks.locksByUtxoId.key(utxoId);
          const lockCreation = await StorageFinder.binarySearchForStorageAddition(mainchainClients, lockStorageKey, 0);
          creationBlockNumber = lockCreation?.blockNumber ?? 0;
          creationBlockHash = lockCreation?.blockHash;
        }
        if (!creationBlockHash) continue;

        const result = await TransactionEvents.findFromFeePaidEvent({
          client: archiveClient,
          blockHash: creationBlockHash,
          accountAddress: lock.ownerAccount,
          isMatchingEvent: event => {
            return (
              archiveClient.events.bitcoinLocks.BitcoinLockCreated.is(event) && event.data.utxoId.toNumber() === utxoId
            );
          },
        });
        const recovered = this.createDetachedRecord(record);
        recovered.ratchets[0].blockHeight = creationBlockNumber;
        if (result) recovered.ratchets[0].txFee = result.fee;
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } catch (error) {
        console.warn(`Unable to recover Bitcoin lock ${utxoId} creation details:`, error);
      }
    }
  }

  public async findActiveLockIds(api: ApiDecoration<'promise'>): Promise<number[]> {
    const ownerKeys = await api.query.bitcoinLocks.utxoIdsByOwnerAccount.keys(this.walletKeys.defaultArgonAddress);
    return ownerKeys.map(key => key.args[1].toNumber());
  }

  public async findMissingActiveLockIds(api: ApiDecoration<'promise'>): Promise<number[]> {
    const utxoIds = await this.findActiveLockIds(api);
    const chainLocks = await api.query.bitcoinLocks.locksByUtxoId.multi(utxoIds);
    const missing: number[] = [];

    for (let index = 0; index < utxoIds.length; index += 1) {
      const lockOption = chainLocks[index];
      if (!lockOption?.isSome) continue;

      const utxoId = utxoIds[index];
      const record = this.getRecoveryLock(utxoId);
      const chainLock = lockOption.unwrap();
      if (
        !record ||
        !this.hasCompleteRatchetEconomics(
          record,
          chainLock.liquidityPromised.toBigInt(),
          chainLock.lockedTargetPrice.toBigInt(),
        )
      ) {
        missing.push(utxoId);
      }
    }

    return missing;
  }

  private async importRatchet(
    record: IBitcoinLockRecord,
    block: IBlockHeaderInfo,
    eventRecords: readonly BitcoinRecoveryEventRecord[],
    eventIndex: number,
    api: ApiDecoration<'promise'>,
    table: BitcoinLocksTable,
  ): Promise<void> {
    const phase = eventRecords[eventIndex].phase;
    if (!phase.isApplyExtrinsic) {
      throw new Error(`Bitcoin ratchet at block ${block.blockNumber.toLocaleString()} has no extrinsic identity`);
    }
    const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
    const event = eventRecords[eventIndex].event;
    const cumulativeLiquidity = readRequiredEventBigInt(event, ['liquidityPromised'], block);
    const oldTargetPrice = readRequiredEventBigInt(
      event,
      [
        'oldTargetPrice',
        'oldLockedMarketRate',
        'originalMarketRate',
        'oldPeggedPrice',
        'originalPeggedPrice',
        'oldLockPrice',
        'originalLockPrice',
      ],
      block,
    );
    const lockedTargetPrice = readRequiredEventBigInt(
      event,
      ['newTargetPrice', 'newLockedMarketRate', 'newPeggedPrice', 'newLockPrice'],
      block,
    );
    const chainLock = await BitcoinLock.get(api, record.utxoId!);
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
        await new PriceIndex().load(api),
        lockedTargetPrice - oldTargetPrice,
      );
    }
    const burned = readRequiredEventBigInt(event, ['amountBurned'], block);
    if (!this.isRetiredHistoryRecord(recovered) && recovered.status !== BitcoinLockStatus.Releasing) {
      recovered.status = BitcoinLockStatus.LockedAndIsMinting;
    }

    const ratchet = {
      mintAmount,
      mintPending: mintAmount,
      liquidityPromised: cumulativeLiquidity,
      lockedTargetPrice,
      securityFee: readRequiredEventBigInt(event, ['securityFee'], block),
      txFee: this.readTransactionFee(eventRecords, eventIndex, block) ?? 0n,
      burned,
      blockHeight: block.blockNumber,
      extrinsicIndex,
      oracleBitcoinBlockHeight: await api.query.bitcoinUtxos
        .confirmedBitcoinBlockTip()
        .then(tip => (tip.isSome ? tip.unwrap().blockHeight.toNumber() : 0)),
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
        (record.lockDetails?.couponFeesPaid ?? 0n) + this.readUnchargedSecurityFee(event, block),
      );
      recovered.lockDetails = chainLock;
    }
    this.assertSafePendingMint(recovered);
    await this.saveRecoveredHistory(table, recovered);
    this.applyRecoveredRecord(recovered);
  }

  private createDetachedRecord(record: IBitcoinLockRecord): IBitcoinLockRecord {
    return {
      ...record,
      ratchets: record.ratchets.map(ratchet => ({ ...ratchet })),
    };
  }

  private async saveRecoveredHistory(
    table: BitcoinLocksTable,
    record: IBitcoinLockRecord,
    createdAt?: Date,
  ): Promise<void> {
    if (this.historyReplay) {
      if (createdAt) record.createdAt = createdAt;
      return;
    }
    if (createdAt) await table.saveRecoveredHistory(record, createdAt);
    else await table.saveRecoveredHistory(record);
  }

  private applyRecoveredRecord(recovered: IBitcoinLockRecord): IBitcoinLockRecord {
    const utxoId = recovered.utxoId!;
    const stagedLocks = this.historyReplay?.locksByUtxoId;
    this.historyReplay?.dirtyLockUtxoIds.add(utxoId);
    const liveRecord = this.locksByUtxoId[utxoId];
    const current =
      stagedLocks?.[utxoId] ?? (stagedLocks && liveRecord ? this.createDetachedRecord(liveRecord) : liveRecord);
    const retiredStatus = current && this.isRetiredHistoryRecord(current) ? current.status : undefined;
    if (retiredStatus !== undefined) {
      recovered.status = retiredStatus;
      delete recovered.isHistoryRecoveryPending;
    }
    if (current) {
      recovered.fundingUtxoRecord ??= current.fundingUtxoRecord;
      Object.assign(current, recovered);
      if (retiredStatus !== undefined) current.status = retiredStatus;
      if (stagedLocks) stagedLocks[utxoId] = current;
      return current;
    }

    if (stagedLocks) stagedLocks[utxoId] = recovered;
    else this.locksByUtxoId[utxoId] = recovered;
    return recovered;
  }

  private getRecoveryLock(utxoId: number): IBitcoinLockRecord | undefined {
    return this.historyReplay?.locksByUtxoId[utxoId] ?? this.locksByUtxoId[utxoId];
  }

  private async prepareHistoryRecoveryLock(lock: IBitcoinLockRecord, lockQueueOwnerUuid?: string): Promise<void> {
    if (!this.historyReplay) return;

    const utxoId = lock.utxoId;
    if (utxoId === undefined || this.historyReplay.locksByUtxoId[utxoId] || this.isRetiredHistoryRecord(lock)) {
      return;
    }

    const activeLock = this.activeLocksByUtxoId.get(utxoId);
    if (
      activeLock &&
      this.hasCompleteRatchetEconomics(lock, activeLock.liquidityPromised, activeLock.lockedTargetPrice)
    ) {
      return;
    }
    const fundingRecord = this.utxoTracking.getAcceptedFundingRecordForLock(lock);
    if (lock.status === BitcoinLockStatus.Releasing && this.utxoTracking.isReleaseStatus(fundingRecord?.status)) return;

    await this.waitForLockIdle(lock, lock.uuid === lockQueueOwnerUuid);
    const snapshot = this.createDetachedRecord(lock);
    this.historyReplay.locksByUtxoId[utxoId] = snapshot;
    this.historyReplay.originalLocksByUtxoId[utxoId] = this.createDetachedRecord(snapshot);
  }

  private async publishCompleteActiveLocks(): Promise<void> {
    if (!this.activeLocksByUtxoId.size) return;

    const completedLocks: IBitcoinLockRecord[] = [];
    const table = await this.getTable();

    for (const [utxoId, chainLock] of this.activeLocksByUtxoId) {
      if (!chainLock) continue;

      const record = this.locksByUtxoId[utxoId];
      if (
        !record?.isHistoryRecoveryPending ||
        !this.hasCompleteRatchetEconomics(record, chainLock.liquidityPromised, chainLock.lockedTargetPrice)
      ) {
        continue;
      }

      await table.setHistoryRecoveryPending(record.uuid, false);
      delete record.isHistoryRecoveryPending;
      this.historyRecoveryPendingUtxoIds.delete(utxoId);
      this.historyRecoveryPendingUuids.delete(record.uuid);

      const pendingIndex = this.pendingLocks.findIndex(pending => pending.uuid === record.uuid);
      if (pendingIndex >= 0) this.pendingLocks.splice(pendingIndex, 1);
      completedLocks.push(record);
    }

    if (completedLocks.length) this.onHistoryRecoveryComplete(completedLocks);
  }

  private isRetiredHistoryRecord(lock: Pick<IBitcoinLockRecord, 'status' | 'removalReason'>): boolean {
    return (
      !!lock.removalReason ||
      [
        BitcoinLockStatus.Released,
        BitcoinLockStatus.LockExpiredWaitingForFunding,
        BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged,
        BitcoinLockStatus.LockFailed,
        BitcoinLockStatus.LockFailedAcknowledged,
      ].includes(lock.status)
    );
  }

  private hasCompleteRatchetEconomics(
    record: IBitcoinLockRecord,
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

  private getRatchetLiquidity(ratchets: readonly IBitcoinLockRecord['ratchets'][number][], index: number): bigint {
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

  private assertSafePendingMint(record: IBitcoinLockRecord): void {
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

  private readUtxoId(
    event: Pick<GenericEvent, 'data' | 'method' | 'section'>,
    block: IBlockHeaderInfo,
  ): number | undefined {
    const value = readRequiredEventField(event, 'utxoId', block);
    if (value.toHuman() === null) return;

    const utxoId = Number(value.toString().replace(/,/g, ''));
    if (Number.isSafeInteger(utxoId)) return utxoId;
    throw new Error(`Historical ${event.section}.${event.method} has an invalid Bitcoin lock id`);
  }

  private readTransactionFee(
    records: readonly BitcoinRecoveryEventRecord[],
    operationEventIndex: number,
    block: IBlockHeaderInfo,
  ): bigint | undefined {
    const phase = records[operationEventIndex].phase;
    if (!phase.isApplyExtrinsic) return;

    const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
    const feeEvent = records.find(record => {
      return (
        record.phase.isApplyExtrinsic &&
        record.phase.asApplyExtrinsic.toNumber() === extrinsicIndex &&
        record.event.section === 'transactionPayment' &&
        record.event.method === 'TransactionFeePaid'
      );
    })?.event;
    if (!feeEvent) return;

    const payer = readRequiredEventField(feeEvent, 'who', block).toString();
    const ownedAccounts = new Set([
      this.walletKeys.defaultArgonAddress,
      this.walletKeys.miningBotAddress,
      this.walletKeys.operationalAddress,
    ]);
    return ownedAccounts.has(payer) ? readRequiredEventBigInt(feeEvent, ['actualFee'], block) : 0n;
  }

  private readUnchargedSecurityFee(event: BitcoinRecoveryEventRecord['event'], block: IBlockHeaderInfo): bigint {
    const lockAccount = readRequiredEventField(event, 'accountId', block).toString();
    if (lockAccount !== this.walletKeys.defaultArgonAddress) return 0n;

    // The app's default account is its vault operator, so it does not charge itself the lock's security fee.
    return readRequiredEventBigInt(event, ['securityFee'], block);
  }

  private async applyScopedMint(
    record: IBitcoinLockRecord,
    amount: bigint,
    api: ApiDecoration<'promise'>,
    table: BitcoinLocksTable,
  ): Promise<void> {
    const recovered = this.createDetachedRecord(record);
    const pendingMint = recovered.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
    const chainPendingMints = await new BitcoinLock(recovered.lockDetails).findPendingMints(api);
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
    await this.saveRecoveredMintState(table, recovered);
    this.applyRecoveredRecord(recovered);
  }

  private async reconcilePendingMint(
    record: IBitcoinLockRecord,
    api: ApiDecoration<'promise'>,
    table: BitcoinLocksTable,
    lockQueueOwnerUuid?: string,
  ): Promise<void> {
    const recovered = this.createDetachedRecord(record);
    const chainPendingMints = await new BitcoinLock(recovered.lockDetails).findPendingMints(api);
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
    await this.saveRecoveredMintState(table, recovered);
    this.applyRecoveredRecord(recovered);
  }

  private async saveRecoveredMintState(table: BitcoinLocksTable, record: IBitcoinLockRecord): Promise<void> {
    if (!this.historyReplay) {
      await table.updateMintState(record);
      return;
    }

    applyBitcoinLockMintState(record);
  }

  private get locksByUtxoId(): Record<number, IBitcoinLockRecord> {
    return this.getLocksByUtxoId();
  }

  private get pendingLocks(): IBitcoinLockRecord[] {
    return this.getPendingLocks();
  }
}

type BitcoinRecoveryEventRecord = {
  event: Pick<GenericEvent, 'data' | 'method' | 'section'>;
  phase: Pick<FrameSystemEventRecord['phase'], 'isApplyExtrinsic'> & {
    asApplyExtrinsic: Pick<FrameSystemEventRecord['phase']['asApplyExtrinsic'], 'toNumber'>;
  };
};

export type BitcoinHistoryReplayLockScope = 'all' | 'encountered' | 'pending';

function resolveRecoveredLock(
  durable: IBitcoinLockRecord,
  recovered: IBitcoinLockRecord,
  useRecoveredStatus: boolean,
): IBitcoinLockRecord {
  const recoveredFinishedRelease =
    durable.status === BitcoinLockStatus.Releasing && recovered.status === BitcoinLockStatus.Released;
  const status = useRecoveredStatus || recoveredFinishedRelease ? recovered.status : durable.status;
  const createdAt = durable.createdAt < recovered.createdAt ? durable.createdAt : recovered.createdAt;

  assignIfUnset(durable, recovered, [
    'utxoId',
    'fundingUtxoRecordId',
    'fundingUtxoRecord',
    'releaseRedemptionMicrogons',
    'releaseArgonTxFeeMicrogons',
    'releaseCompensationMicrogons',
    'removalBlockNumber',
    'removalBlockHash',
    'removalBlockTime',
    'removalExtrinsicIndex',
    'removalReason',
    'btcPriceAtRemovalMicrogons',
  ]);
  Object.assign(durable, {
    satoshis: recovered.satoshis,
    lockedTargetPrice: recovered.lockedTargetPrice,
    liquidityPromised: recovered.liquidityPromised,
    ratchets: recovered.ratchets,
    lockDetails: recovered.lockDetails,
    createdAt,
    status,
  });
  return durable;
}

function resolveRecoveredUtxo(durable: IBitcoinUtxoRecord, recovered: IBitcoinUtxoRecord): IBitcoinUtxoRecord {
  const durableIsRelease = isBitcoinUtxoReleaseStatus(durable.status);
  const recoveredIsRelease = isBitcoinUtxoReleaseStatus(recovered.status);
  const durableReleaseIsComplete =
    durable.status === BitcoinUtxoStatus.ReleaseComplete ||
    durable.status === BitcoinUtxoStatus.ReleaseCompleteAcknowledged;
  const recoveredReleaseIsComplete =
    recovered.status === BitcoinUtxoStatus.ReleaseComplete ||
    recovered.status === BitcoinUtxoStatus.ReleaseCompleteAcknowledged;
  let status = recovered.status;
  if (durableIsRelease || durable.status === BitcoinUtxoStatus.FundingUtxo) status = durable.status;
  if (recoveredReleaseIsComplete && !durableReleaseIsComplete) status = recovered.status;
  let statusError = recovered.statusError ?? durable.statusError;
  if (recoveredReleaseIsComplete && !durableReleaseIsComplete) statusError = recovered.statusError;
  else if (durableIsRelease) statusError = durable.statusError;
  else if (recoveredIsRelease) statusError = recovered.statusError;
  const firstSeenAt = durable.firstSeenAt < recovered.firstSeenAt ? durable.firstSeenAt : recovered.firstSeenAt;

  assignIfUnset(durable, recovered, [
    'mempoolObservation',
    'firstSeenOnArgonAt',
    'firstSeenOracleHeight',
    'lastConfirmationCheckAt',
    'lastConfirmationCheckOracleHeight',
    'requestedReleaseAtTick',
    'releaseBitcoinNetworkFee',
    'releaseToDestinationAddress',
    'releaseCosignVaultSignature',
    'releaseCosignHeight',
    'releaseTxid',
    'releaseFirstSeenAt',
    'releaseFirstSeenBitcoinHeight',
    'releaseFirstSeenOracleHeight',
    'releaseLastConfirmationCheckAt',
    'releaseLastConfirmationCheckOracleHeight',
    'releasedAtBitcoinHeight',
  ]);
  Object.assign(durable, {
    status,
    statusError,
    firstSeenAt,
    firstSeenBitcoinHeight: Math.max(durable.firstSeenBitcoinHeight, recovered.firstSeenBitcoinHeight),
  });
  return durable;
}

function assignIfUnset<T extends object, K extends keyof T>(target: T, source: Pick<T, K>, fields: readonly K[]): void {
  for (const field of fields) target[field] = target[field] ?? source[field];
}

function getBitcoinLockEconomicsFingerprint(
  lock: Pick<IBitcoinLockRecord, 'satoshis' | 'lockedTargetPrice' | 'liquidityPromised' | 'ratchets' | 'lockDetails'>,
): string {
  return JsonExt.stringify([
    lock.satoshis,
    lock.lockedTargetPrice,
    lock.liquidityPromised,
    lock.ratchets,
    lock.lockDetails,
  ]);
}

export const bitcoinRecoveryEventPolicies: Readonly<Record<string, 'replay' | 'ignore'>> = {
  BitcoinCosignPastDue: 'replay',
  BitcoinLockBackfillChanged: 'replay',
  BitcoinLockFlexibleChanged: 'replay',
  BitcoinLockBurned: 'replay',
  BitcoinLockCreated: 'replay',
  BitcoinLockRatcheted: 'replay',
  BitcoinSpentAfterRelease: 'replay',
  BitcoinUtxoCosignRequested: 'replay',
  BitcoinUtxoCosigned: 'replay',
  CosignOverdueError: 'ignore',
  LockExpirationError: 'ignore',
  OrphanedUtxoCosigned: 'replay',
  OrphanedUtxoReceived: 'replay',
  OrphanedUtxoReleaseRequested: 'replay',
  SecuritizationIncreased: 'replay',
  UtxoFundedFromCandidate: 'replay',
};

type BitcoinHistoryReplaySession = {
  commitStarted: boolean;
  currentLockUtxoId?: number;
  locksByUtxoId: Record<number, IBitcoinLockRecord>;
  originalLocksByUtxoId: Record<number, IBitcoinLockRecord>;
  utxos: BitcoinHistoryUtxoProjection;
  lockScope: BitcoinHistoryReplayLockScope;
  hdKeys: Map<string, Parameters<Db['walletHdKeysTable']['upsert']>[0]>;
  dirtyLockUtxoIds: Set<number>;
  failedLockUtxoIds: Set<number>;
  hasUnscopedFailure: boolean;
};

class BitcoinHistoryUtxoProjection {
  private readonly recordsByKey = new Map<string, IBitcoinUtxoRecord>();
  private readonly recordsById = new Map<number, IBitcoinUtxoRecord>();
  private readonly orphanedRecordKeys = new Set<string>();
  private nextId = -1;

  constructor(
    private readonly live: BitcoinRecoveryUtxoTracking,
    private readonly dbPromise: Promise<Db>,
  ) {
    for (const record of live.getAllOrphanLifecycleUtxos()) {
      this.orphanedRecordKeys.add(this.getKey(record.lockUtxoId, record.txid, record.vout));
    }
  }

  public get records(): readonly IBitcoinUtxoRecord[] {
    return [...this.recordsById.values()];
  }

  public getUtxoRecord(lockUtxoId: number, txid: string, vout: number): IBitcoinUtxoRecord | undefined {
    const key = this.getKey(lockUtxoId, txid, vout);
    return this.recordsByKey.get(key) ?? this.live.getUtxoRecord(lockUtxoId, txid, vout);
  }

  public getAcceptedFundingRecordForLock(lock: IBitcoinLockRecord): IBitcoinUtxoRecord | undefined {
    return this.live.getAcceptedFundingRecordForLock(lock, {
      getById: id => this.getUtxoRecordById(id),
      getForLock: () => this.getUtxosForLock(lock),
    });
  }

  public async upsertUtxoRecord(
    ...[lock, candidate, options]: Parameters<BitcoinRecoveryUtxoTracking['upsertUtxoRecord']>
  ): Promise<IBitcoinUtxoRecord> {
    if (!lock.utxoId) throw new Error('Lock has no utxoId for UTXO tracking.');

    const key = this.getKey(lock.utxoId, candidate.txid, candidate.vout);
    const observedStatus = this.live.getObservedStatusForUpsert(lock, candidate, options);
    const shouldMarkArgonCandidateSeen = !!(
      options?.markArgonCandidate ||
      options?.markOrphaned ||
      options?.markFundingUtxo
    );
    const candidateSeenAt = shouldMarkArgonCandidateSeen ? new Date() : undefined;
    let record = this.getUtxoRecord(lock.utxoId, candidate.txid, candidate.vout);
    if (!record) {
      const now = new Date();
      record = {
        id: this.nextId,
        lockUtxoId: lock.utxoId,
        txid: candidate.txid,
        vout: candidate.vout,
        satoshis: candidate.satoshis,
        network: lock.network,
        status: observedStatus ?? BitcoinUtxoStatus.FundingCandidate,
        mempoolObservation: options?.mempoolObservation,
        firstSeenAt: now,
        firstSeenOnArgonAt: candidateSeenAt,
        firstSeenBitcoinHeight: options?.mempoolObservation?.transactionBlockHeight ?? 0,
        createdAt: now,
        updatedAt: now,
      };
      this.nextId -= 1;
      this.recordsByKey.set(key, record);
      this.recordsById.set(record.id, record);
    } else {
      record = this.getWritableRecord(record);
      if (this.live.shouldUpdateObservedCandidateStatus(record, observedStatus)) {
        record.status = observedStatus;
      }
      record.satoshis = candidate.satoshis;
      if (candidateSeenAt && !record.firstSeenOnArgonAt) record.firstSeenOnArgonAt = candidateSeenAt;
      if (options?.mempoolObservation) record.mempoolObservation = options.mempoolObservation;
    }
    if (options?.markOrphaned) this.orphanedRecordKeys.add(key);
    if (options?.markFundingUtxo) {
      lock.fundingUtxoRecordId = record.id;
      lock.fundingUtxoRecord = record;
    }
    return record;
  }

  public async setAcceptedFundingRecordForLock(lock: IBitcoinLockRecord, record: IBitcoinUtxoRecord): Promise<void> {
    record = this.getWritableRecord(record);
    if (!lock.utxoId || record.lockUtxoId !== lock.utxoId) {
      throw new Error('Funding record does not belong to this lock.');
    }

    const observedAt = new Date();
    record.status = BitcoinUtxoStatus.FundingUtxo;
    record.firstSeenOnArgonAt ??= observedAt;
    const siblings = this.getUtxosForLock(lock)
      .filter(sibling => sibling.status === BitcoinUtxoStatus.FundingCandidate)
      .map(sibling => this.getWritableRecord(sibling));
    for (const sibling of siblings) {
      sibling.status = BitcoinUtxoStatus.Orphaned;
      sibling.firstSeenOnArgonAt ??= observedAt;
      this.orphanedRecordKeys.add(this.getKey(sibling.lockUtxoId, sibling.txid, sibling.vout));
    }
    lock.fundingUtxoRecordId = record.id;
    lock.fundingUtxoRecord = record;
  }

  public async setReleaseRequest(
    record: IBitcoinUtxoRecord,
    args: Parameters<BitcoinRecoveryUtxoTracking['setReleaseRequest']>[1],
  ): Promise<void> {
    const table = (await this.dbPromise).bitcoinUtxosTable;
    await table.setReleaseRequest(this.getWritableRecord(record), args, false);
  }

  public async setReleaseIsProcessingOnArgon(
    record: IBitcoinUtxoRecord,
    args: Parameters<BitcoinRecoveryUtxoTracking['setReleaseIsProcessingOnArgon']>[1],
  ): Promise<void> {
    const table = (await this.dbPromise).bitcoinUtxosTable;
    await table.setReleaseIsProcessingOnArgon(this.getWritableRecord(record), args, false);
  }

  public async setReleaseCosign(
    record: IBitcoinUtxoRecord,
    args: Parameters<BitcoinRecoveryUtxoTracking['setReleaseCosign']>[1],
  ): Promise<void> {
    const table = (await this.dbPromise).bitcoinUtxosTable;
    await table.setReleaseCosign(this.getWritableRecord(record), args, false);
  }

  public getAllOrphanLifecycleUtxos(): IBitcoinUtxoRecord[] {
    const recordsByKey = new Map(
      this.live
        .getAllOrphanLifecycleUtxos()
        .map(record => [this.getKey(record.lockUtxoId, record.txid, record.vout), record]),
    );
    for (const [key, record] of this.recordsByKey) recordsByKey.set(key, record);
    return [...recordsByKey].flatMap(([key, record]) => {
      const hasOrphanLifecycleStatus =
        record.status === BitcoinUtxoStatus.Orphaned || this.live.isReleaseStatus(record.status);
      return this.orphanedRecordKeys.has(key) && hasOrphanLifecycleStatus ? [record] : [];
    });
  }

  private getUtxoRecordById(id: number): IBitcoinUtxoRecord | undefined {
    return this.recordsById.get(id) ?? this.live.getUtxoRecordById(id);
  }

  private getUtxosForLock(lock: IBitcoinLockRecord): IBitcoinUtxoRecord[] {
    if (!lock.utxoId) return [];
    const recordsByKey = new Map(
      this.live.getUtxosForLock(lock).map(record => [this.getKey(record.lockUtxoId, record.txid, record.vout), record]),
    );
    for (const [key, record] of this.recordsByKey) {
      if (record.lockUtxoId === lock.utxoId) recordsByKey.set(key, record);
    }
    return [...recordsByKey.values()];
  }

  private getWritableRecord(record: IBitcoinUtxoRecord): IBitcoinUtxoRecord {
    const existing = this.recordsById.get(record.id);
    if (existing) return existing;

    const projected = { ...record };
    this.recordsById.set(projected.id, projected);
    this.recordsByKey.set(this.getKey(projected.lockUtxoId, projected.txid, projected.vout), projected);
    return projected;
  }

  private getKey(lockUtxoId: number, txid: string, vout: number): string {
    return `${lockUtxoId}:${txid}:${vout}`;
  }
}
