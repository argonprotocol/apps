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
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import {
  BitcoinLocksTable,
  BitcoinLockStatus,
  toBitcoinLockScriptDetails,
  type IBitcoinLockRecord,
} from '../db/BitcoinLocksTable.ts';
import type { HistoricalEvent } from '@argonprotocol/runtime-client/events';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../db/BitcoinUtxosTable.ts';
import {
  BitcoinReleaseKind,
  BitcoinReleaseStatus,
  type IBitcoinReleaseRecord,
} from '../../interfaces/IBitcoinReleaseRecord.ts';
import type { IMempoolTxStatus } from '../BitcoinMempool.ts';
import type BitcoinReleases from '../BitcoinReleases.ts';
import type BitcoinUtxoTracking from '../BitcoinUtxoTracking.ts';
import type { deriveBitcoinLockHdKey, WalletKeys } from '../WalletKeys.ts';
import type { Db } from '../Db.ts';
import type { IBitcoinRequestLockMetadata } from '../BitcoinLocks.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import {
  assignIfUnset,
  bitcoinRecoveryEventPolicies,
  BitcoinHistoryUtxoState,
  createHistoricalBitcoinLockRecord,
  resolveRecoveredLock,
  resolveRecoveredRelease,
  resolveRecoveredUtxo,
  type BitcoinHistoryReplayLockScope,
  type BitcoinHistoryReplaySession,
  type IHistoricalBitcoinLockRecord,
} from './BitcoinLockReplay.ts';
import {
  getHistoricalBitcoinFundingUtxos,
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
  private readonly getLocksByLockId: () => Record<number, IBitcoinLockRecord>;
  private readonly getPendingLocks: () => IBitcoinLockRecord[];
  private readonly waitForLockIdle: (lock: IBitcoinLockRecord, alreadyOwnsQueue?: boolean) => Promise<void>;
  private readonly findConfirmedRecoveredRelease: (args: {
    lock: IBitcoinLockRecord;
    release: IBitcoinReleaseRecord;
    fundingUtxos: IBitcoinUtxoRecord[];
  }) => Promise<(IMempoolTxStatus & { txid: string }) | undefined>;
  private readonly onHistoryRecoveryComplete: (locks: IBitcoinLockRecord[], didPublish: boolean) => void;
  private readonly onHistoryPublished: () => void;
  private readonly utxoTracking: BitcoinUtxoTracking;
  private readonly releases: BitcoinReleases;
  private readonly dbPromise: Promise<Db>;
  private historyReplay?: BitcoinHistoryReplaySession;
  private readonly historyRecoveryPendingLockIds = new Set<number>();
  private readonly historyRecoveryPendingUuids = new Set<string>();
  private readonly activeLockRecoveryFailedLockIds = new Set<number>();
  private readonly activeLocksByLockId = new Map<number, IBitcoinLock | undefined>();
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
    getLocksByLockId: BitcoinLockRecovery['getLocksByLockId'];
    getPendingLocks: BitcoinLockRecovery['getPendingLocks'];
    waitForLockIdle: BitcoinLockRecovery['waitForLockIdle'];
    findConfirmedRecoveredRelease: BitcoinLockRecovery['findConfirmedRecoveredRelease'];
    onHistoryRecoveryComplete: BitcoinLockRecovery['onHistoryRecoveryComplete'];
    onHistoryPublished: BitcoinLockRecovery['onHistoryPublished'];
    utxoTracking: BitcoinLockRecovery['utxoTracking'];
    releases: BitcoinLockRecovery['releases'];
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
    this.getLocksByLockId = args.getLocksByLockId;
    this.getPendingLocks = args.getPendingLocks;
    this.waitForLockIdle = args.waitForLockIdle;
    this.findConfirmedRecoveredRelease = args.findConfirmedRecoveredRelease;
    this.onHistoryRecoveryComplete = args.onHistoryRecoveryComplete;
    this.onHistoryPublished = args.onHistoryPublished;
    this.utxoTracking = args.utxoTracking;
    this.releases = args.releases;
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
      this.activeLockRecoveryFailedLockIds.size > 0 ||
      [...Object.values(this.locksByLockId), ...this.pendingLocks].some(lock => lock.isHistoryRecoveryPending)
    );
  }

  public async beginHistoryReplay({
    lockScope = 'encountered',
    purpose = 'operational-repair',
  }: {
    lockScope?: BitcoinHistoryReplayLockScope;
    purpose?: BitcoinHistoryReplaySession['purpose'];
  } = {}): Promise<void> {
    if (this.historyReplay) throw new Error('Bitcoin lock history replay is already running');
    const existingSecuritizationTerms =
      lockScope === 'all'
        ? []
        : await this.dbPromise.then(
            async db =>
              (await db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot(this.walletKeys.defaultArgonAddress))
                ?.terms ?? [],
          );
    const securitizationTermsByLockId = new Map<number, IBitcoinSecuritizationTerm[]>();
    for (const term of existingSecuritizationTerms) {
      const terms = securitizationTermsByLockId.get(term.lockId) ?? [];
      terms.push(term);
      securitizationTermsByLockId.set(term.lockId, terms);
    }

    this.historyReplay = {
      purpose,
      lockIdByHistoricalUtxoId: new Map(),
      locksByLockId: {},
      utxos: new BitcoinHistoryUtxoState(),
      releasesById: {},
      historicalLiquidRedemptionByUtxoId: new Map(),
      lockScope,
      hdKeys: new Map(),
      dirtyLockIds: new Set(),
      failedLockIds: new Set(),
      hasUnscopedFailure: false,
      recoveredThroughBlock: 0,
      securitizationTermsByLockId,
    };

    if (lockScope !== 'all') {
      const db = await this.dbPromise;
      const migratedFissions = await db.bitcoinFissionsTable.fetchAll(this.walletKeys.defaultArgonAddress);
      for (const fission of migratedFissions) {
        if (fission.origin !== 'lock-migration' || fission.closedAtArgonBlock !== undefined) continue;
        const lock = this.locksByLockId[fission.lockId];
        if (!lock) continue;

        const recovered = createHistoricalBitcoinLockRecord(lock);
        recovered.utxoId = fission.fissionId;
        recovered.satoshis = fission.satoshis;
        recovered.lockedTargetPrice = fission.microgonsAtTargetPerBtc;
        recovered.liquidityPromised = fission.liquidityPromised;
        recovered.ratchets = fission.ratchets
          .filter(ratchet => ratchet.source === 'lock')
          .map(ratchet => ({
            mintAmount: ratchet.amountMinted,
            mintPending: ratchet.mintPending,
            liquidityPromised: ratchet.liquidityPromised,
            lockedTargetPrice: ratchet.microgonsAtTargetPerBtc,
            securityFee: ratchet.securityFee ?? 0n,
            securityFeeCoupon: ratchet.securityFeeCoupon,
            txFee: ratchet.txFee,
            burned: ratchet.amountBurned,
            blockHeight: ratchet.blockNumber,
            tick: ratchet.tick,
            extrinsicIndex: ratchet.extrinsicIndex,
            oracleBitcoinBlockHeight: 0,
          }));
        this.historyReplay.lockIdByHistoricalUtxoId.set(fission.fissionId, fission.lockId);
        this.historyReplay.locksByLockId[fission.lockId] = recovered;
      }
    }

    if (lockScope !== 'all') this.activeLocksByLockId.clear();
    for (const lock of [...Object.values(this.locksByLockId), ...this.pendingLocks]) {
      if (!lock.isHistoryRecoveryPending) continue;

      this.historyRecoveryPendingUuids.add(lock.uuid);
      if (lock.lockId !== undefined) {
        this.historyRecoveryPendingLockIds.add(lock.lockId);
        const hasHistoricalId = [...this.historyReplay.lockIdByHistoricalUtxoId.values()].includes(lock.lockId);
        if (!hasHistoricalId) this.historyReplay.lockIdByHistoricalUtxoId.set(lock.lockId, lock.lockId);
      }
    }

    if (lockScope !== 'all') return;

    for (const lock of Object.values(this.locksByLockId)) {
      await this.prepareHistoryRecoveryLock(lock);
    }
  }

  public markHistoryReplayFailure(): void {
    const replay = this.historyReplay;
    if (!replay) return;

    const lockId =
      replay.currentHistoricalUtxoId === undefined
        ? undefined
        : replay.lockIdByHistoricalUtxoId.get(replay.currentHistoricalUtxoId);
    if (lockId === undefined) replay.hasUnscopedFailure = true;
    else replay.failedLockIds.add(lockId);
    replay.currentHistoricalUtxoId = undefined;
  }

  public async prepareHistoryReplay(): Promise<{
    records: IHistoricalBitcoinLockRecord[];
    unitLockIds: Set<number>;
    failuresByLockId: Map<number, string>;
    hasUnscopedFailure: boolean;
    lockIdByHistoricalUtxoId: ReadonlyMap<number, number>;
    historicalLiquidRedemptionByUtxoId: ReadonlyMap<number, bigint>;
  }> {
    const replay = this.historyReplay;
    if (!replay) {
      return {
        records: [],
        unitLockIds: new Set(),
        failuresByLockId: new Map(),
        hasUnscopedFailure: false,
        lockIdByHistoricalUtxoId: new Map(),
        historicalLiquidRedemptionByUtxoId: new Map(),
      };
    }

    const locks = [...replay.dirtyLockIds]
      .map(lockId => replay.locksByLockId[lockId])
      .filter((lock): lock is IHistoricalBitcoinLockRecord => Boolean(lock));
    const failuresByLockId = new Map<number, string>(
      [...replay.failedLockIds].map(lockId => [lockId, `Bitcoin lock ${lockId} history recovery failed`] as const),
    );

    for (const [lockId, recovered] of Object.entries(replay.locksByLockId).map(
      ([id, lock]) => [Number(id), lock] as const,
    )) {
      if (replay.failedLockIds.has(lockId)) continue;
      if (recovered.status !== BitcoinLockStatus.Releasing) continue;
      const fundingUtxos = recovered.fundingUtxoIds.flatMap(id => {
        const utxo = replay.utxos.getById(id) ?? this.utxoTracking.getUtxoRecordById(id);
        return utxo ? [utxo] : [];
      });
      const release = recovered.activeReleaseId
        ? (replay.releasesById[recovered.activeReleaseId] ?? this.releases.getById(recovered.activeReleaseId))
        : undefined;
      if (!fundingUtxos.length || !release) continue;

      try {
        const confirmed = await this.findConfirmedRecoveredRelease({
          lock: this.toDurableRecord(recovered, lockId),
          release,
          fundingUtxos,
        });
        if (!confirmed) continue;

        for (const fundingUtxo of fundingUtxos) {
          fundingUtxo.spendStatus = BitcoinUtxoSpendStatus.Spent;
          fundingUtxo.activeReleaseId = undefined;
          fundingUtxo.spentByReleaseId = release.id;
        }
        Object.assign(release, {
          status: BitcoinReleaseStatus.Complete,
          bitcoinTxid: confirmed.txid,
          bitcoinFirstSeenAt: release.bitcoinFirstSeenAt ?? new Date(confirmed.transactionBlockTime * 1_000),
          bitcoinFirstSeenHeight: release.bitcoinFirstSeenHeight ?? confirmed.transactionBlockHeight,
          bitcoinFirstSeenOracleHeight: release.bitcoinFirstSeenOracleHeight ?? confirmed.argonBitcoinHeight,
          bitcoinConfirmedHeight: confirmed.transactionBlockHeight,
          statusError: undefined,
        });
        replay.releasesById[release.id] = release;
        recovered.status = BitcoinLockStatus.Released;
        recovered.activeReleaseId = undefined;
        if (recovered.removalBlockNumber) recovered.removalReason ??= 'released';
      } catch (error) {
        console.warn(`Unable to check recovered Bitcoin release ${recovered.utxoId}; leaving it retryable`, error);
      }
    }

    return {
      records: locks.filter(lock => {
        const lockId = replay.lockIdByHistoricalUtxoId.get(lock.utxoId);
        return lockId !== undefined && !replay.failedLockIds.has(lockId);
      }),
      unitLockIds: new Set([
        ...replay.dirtyLockIds,
        ...replay.utxos.records.map(utxo => utxo.lockId),
        ...Object.values(replay.releasesById).map(release => release.lockId),
      ]),
      failuresByLockId,
      hasUnscopedFailure: replay.hasUnscopedFailure,
      lockIdByHistoricalUtxoId: replay.lockIdByHistoricalUtxoId,
      historicalLiquidRedemptionByUtxoId: replay.historicalLiquidRedemptionByUtxoId,
    };
  }

  public async persistHistoryReplayUnit(
    db: Db,
    lockId: number,
    asOfBlock: number,
  ): Promise<IBitcoinLockRecord | undefined> {
    const replay = this.historyReplay;
    if (!replay) return;

    const recovered = replay.locksByLockId[lockId];
    const transactionTable = db.bitcoinLocksTable;
    let stored = await transactionTable.getByLockId(lockId);
    if (!stored && recovered) stored = await transactionTable.findPendingByHdPath(recovered.hdPath);

    const lockUtxos = replay.utxos.getForLock(lockId);
    const persistedUtxoIdByReplayId = new Map<number, number>();
    for (const recoveredUtxo of lockUtxos) {
      const durableUtxo = await db.bitcoinUtxosTable.getByLockOutpoint(
        recoveredUtxo.lockId,
        recoveredUtxo.txid,
        recoveredUtxo.vout,
      );
      if (durableUtxo) {
        await db.bitcoinUtxosTable.saveRecoveredHistory(resolveRecoveredUtxo(durableUtxo, recoveredUtxo));
        persistedUtxoIdByReplayId.set(recoveredUtxo.id, durableUtxo.id);
      } else {
        const persisted = await db.bitcoinUtxosTable.insert(recoveredUtxo);
        persistedUtxoIdByReplayId.set(recoveredUtxo.id, persisted.id);
      }
    }

    const lockReleases = Object.values(replay.releasesById).filter(release => release.lockId === lockId);
    for (const recoveredRelease of lockReleases) {
      recoveredRelease.inputUtxoIds = recoveredRelease.inputUtxoIds.map(id => persistedUtxoIdByReplayId.get(id) ?? id);
      const durable = await db.bitcoinReleasesTable.getById(recoveredRelease.id);
      if (durable) await db.bitcoinReleasesTable.update(durable, resolveRecoveredRelease(durable, recoveredRelease));
      else await db.bitcoinReleasesTable.insert(recoveredRelease);
    }

    if (!recovered) {
      return;
    }

    recovered.fundingUtxoIds = recovered.fundingUtxoIds.map(id => persistedUtxoIdByReplayId.get(id) ?? id);

    const lockHdKeys = [...replay.hdKeys.values()].filter(hdKey => hdKey.hdPath === recovered.hdPath);
    let useRecoveredStatus = !stored;

    if (!stored) {
      stored = await transactionTable.insertPending({
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

    if (stored.lockId == null) {
      useRecoveredStatus = true;
    }

    const resolved = resolveRecoveredLock(stored, recovered, useRecoveredStatus);
    resolved.lockId = lockId;
    await transactionTable.saveRecoveredHistory(resolved, resolved.createdAt);

    for (const hdKey of lockHdKeys) await db.walletHdKeysTable.upsert(hdKey);

    const publishedTerms = await db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot(
      this.walletKeys.defaultArgonAddress,
    );
    const termsByKey = new Map(
      (publishedTerms?.terms ?? [])
        .filter(term => term.lockId !== lockId)
        .map(term => [`${term.lockId}:${term.termIndex}`, term]),
    );
    for (const term of replay.securitizationTermsByLockId.get(lockId) ?? []) {
      termsByKey.set(`${term.lockId}:${term.termIndex}`, term);
    }
    const snapshot = await db.bitcoinSecuritizationHistoryTable.createSnapshot(
      this.walletKeys.defaultArgonAddress,
      asOfBlock,
      [...termsByKey.values()].sort((left, right) => left.lockId - right.lockId || left.termIndex - right.termIndex),
    );
    await db.bitcoinSecuritizationHistoryTable.publishSnapshot(snapshot);
    return resolved;
  }

  public async publishHistoryReplayUnit(lock?: IBitcoinLockRecord): Promise<void> {
    const db = await this.dbPromise;
    this.utxoTracking.load(await db.bitcoinUtxosTable.fetchAll());
    await this.releases.load();
    if (!lock) {
      this.onHistoryPublished();
      return;
    }
    if (lock.lockId !== undefined) {
      const publishedLock = this.locksByLockId[lock.lockId];
      if (publishedLock) {
        Object.assign(publishedLock, resolveRecoveredLock(publishedLock, this.createDetachedRecord(lock), false));
      }
    }
    if (lock.isHistoryRecoveryPending) {
      this.historyRecoveryPendingUuids.add(lock.uuid);
      if (lock.lockId !== undefined) this.historyRecoveryPendingLockIds.add(lock.lockId);
    }
    this.onHistoryPublished();
  }

  public async finishHistoryReplay(failedLockIds: ReadonlySet<number>): Promise<void> {
    const replay = this.historyReplay;
    if (!replay) return;

    const table = await this.getTable();
    const lockScope = replay.lockScope;
    const failedLockUuids = new Set<string>();
    const errors: string[] = [];
    for (const utxoId of failedLockIds) {
      const failedLock = replay.locksByLockId[utxoId] ?? this.locksByLockId[utxoId];
      if (failedLock) failedLockUuids.add(failedLock.uuid);
    }
    const completedLocks: IBitcoinLockRecord[] = [];

    const orphanLifecycleLockIds = new Set(this.releases.getActiveOrphanReleases().map(release => release.lockId));
    for (const uuid of [...this.historyRecoveryPendingUuids]) {
      if (failedLockUuids.has(uuid)) continue;

      const liveLock =
        Object.values(this.locksByLockId).find(lock => lock.uuid === uuid) ??
        this.pendingLocks.find(lock => lock.uuid === uuid);
      if (!liveLock) continue;

      const lockId = liveLock.lockId;
      const isUnresolvedHistoricalLock =
        lockScope === 'all' &&
        lockId !== undefined &&
        !this.isRetiredHistoryRecord(liveLock) &&
        !this.activeLocksByLockId.has(lockId);
      if (isUnresolvedHistoricalLock) {
        const hasLiveReleaseState = !!this.releases.getActiveForLock(liveLock);
        const hasOrphanRecoveryState = orphanLifecycleLockIds.has(lockId);
        if (!hasLiveReleaseState && !hasOrphanRecoveryState) continue;
      }

      try {
        await table.setHistoryRecoveryPending(uuid, false);
      } catch (error) {
        failedLockUuids.add(uuid);
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Bitcoin lock ${lockId ?? uuid}: ${message}`);
        console.warn(`Unable to finish recovered Bitcoin lock ${lockId ?? uuid}; leaving it retryable`, error);
        continue;
      }
      const pendingIndex = this.pendingLocks.findIndex(pending => pending.uuid === liveLock.uuid);
      if (liveLock.lockId !== undefined && pendingIndex >= 0) this.pendingLocks.splice(pendingIndex, 1);
      delete liveLock.isHistoryRecoveryPending;
      if (liveLock.lockId !== undefined) this.historyRecoveryPendingLockIds.delete(liveLock.lockId);
      this.historyRecoveryPendingUuids.delete(uuid);
      completedLocks.push(liveLock);
    }
    this.historyReplay = undefined;
    this.activeLocksByLockId.clear();
    const reconciliationLocksByUuid = new Map(completedLocks.map(lock => [lock.uuid, lock]));
    for (const lockId of orphanLifecycleLockIds) {
      const lock = this.locksByLockId[lockId];
      if (lock) reconciliationLocksByUuid.set(lock.uuid, lock);
    }
    this.onHistoryRecoveryComplete([...reconciliationLocksByUuid.values()], false);
    if (errors.length) throw new Error(errors.join(' '));
  }

  public async cancelHistoryReplay(): Promise<void> {
    const replay = this.historyReplay;
    this.historyReplay = undefined;
    this.activeLocksByLockId.clear();
    if (replay?.purpose === 'operational-repair') {
      const liveLocks = Object.keys(replay.locksByLockId).flatMap(lockId => {
        const lock = this.locksByLockId[Number(lockId)];
        return lock ? [lock] : [];
      });
      this.onHistoryRecoveryComplete(liveLocks, false);
    }
  }

  public async recoverBlock(
    block: IBlockHeaderInfo,
    rawEventRecords: readonly BitcoinRecoveryEventRecord[],
    options: { lockQueueOwnerUuid?: string } = {},
  ): Promise<void> {
    if (this.historyReplay) {
      this.historyReplay.currentHistoricalUtxoId = undefined;
      this.historyReplay.recoveredThroughBlock = Math.max(this.historyReplay.recoveredThroughBlock, block.blockNumber);
    }

    const eventRecords = rawEventRecords as readonly NamedBitcoinRecoveryEventRecord[];
    const api = await this.blockWatch.getApi(block);
    const table = await this.getTable();
    for (let eventIndex = 0; eventIndex < eventRecords.length; eventIndex += 1) {
      if (this.historyReplay) this.historyReplay.currentHistoricalUtxoId = undefined;

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

        const replay = this.historyReplay;
        const candidateHistoricalUtxoIds = replay
          ? [...replay.lockIdByHistoricalUtxoId]
              .filter(([, lockId]) => replay.lockScope !== 'pending' || this.historyRecoveryPendingLockIds.has(lockId))
              .map(([historicalUtxoId]) => historicalUtxoId)
          : [...this.historyRecoveryPendingLockIds];
        for (const historicalUtxoId of candidateHistoricalUtxoIds) {
          if (replay) replay.currentHistoricalUtxoId = historicalUtxoId;
          const record = this.getRecoveryLock(historicalUtxoId);
          if (record) await this.reconcilePendingMint(record, api, options.lockQueueOwnerUuid);
        }
        continue;
      }
      if (utxoId === undefined) continue;
      if (this.historyReplay) this.historyReplay.currentHistoricalUtxoId = utxoId;
      let lockId = this.getCanonicalLockId(utxoId);
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
      if (
        this.historyReplay?.lockScope === 'pending' &&
        !this.historyRecoveryPendingLockIds.has(lockId) &&
        !(event.section === 'bitcoinLocks' && event.method === 'BitcoinLockCreated')
      ) {
        continue;
      }

      let liveRecord = this.locksByLockId[lockId];
      if (liveRecord) await this.prepareHistoryRecoveryLock(liveRecord, options.lockQueueOwnerUuid);

      if (event.section === 'bitcoinLocks' && event.method === 'BitcoinLockCreated') {
        const chainLock = await getHistoricalBitcoinLock(api, utxoId);
        if (!chainLock) throw new Error(`Bitcoin lock ${utxoId} is unavailable at its creation block`);
        lockId = this.resolveHistoricalLockId(chainLock);
        liveRecord = this.locksByLockId[lockId];
        if (liveRecord) await this.prepareHistoryRecoveryLock(liveRecord, options.lockQueueOwnerUuid);
        if (this.historyReplay?.lockScope === 'pending' && !this.historyRecoveryPendingLockIds.has(lockId)) continue;
        const securityFeeCoupon = await this.getEventTimeSecurityFeeCoupon({
          api,
          records: eventRecords,
          eventIndex,
          vaultId: event.data.vaultId,
          grossFee: chainLock.securityFees,
          recordedCoupon: chainLock.couponFeesPaid,
        });
        const recoveredChainLock = { ...chainLock, couponFeesPaid: securityFeeCoupon };
        this.recordSecuritizationTerm(block, eventRecords[eventIndex], recoveredChainLock, 'created');
        const creationLiquidity = event.data.liquidityPromised ?? 0n;
        const creationTargetPrice =
          event.data.lockedTargetPrice ??
          event.data.lockedMarketRate ??
          event.data.peggedPrice ??
          event.data.lockPrice ??
          0n;
        const transactionFee = this.readTransactionFee(eventRecords, eventIndex);
        const phase = eventRecords[eventIndex].phase;
        const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : undefined;
        const creationEventRatchet = {
          mintAmount: creationLiquidity,
          mintPending: creationLiquidity,
          lockedTargetPrice: creationTargetPrice,
          blockHeight: block.blockNumber,
          burned: 0n,
          securityFee: recoveredChainLock.securityFees,
          securityFeeCoupon,
          txFee: transactionFee,
          oracleBitcoinBlockHeight: chainLock.createdAtHeight,
          tick: block.tick,
          extrinsicIndex,
        };

        // Restart replay from durable state rather than a stale in-memory observation.
        const persistedRecord = await table.getByLockId(lockId);
        if (persistedRecord) {
          await this.prepareHistoryRecoveryLock(persistedRecord, options.lockQueueOwnerUuid);
        }
        let existing = persistedRecord ? this.applyRecoveredRecord(persistedRecord) : this.getRecoveryLock(utxoId);
        if (existing?.utxoId !== undefined && existing.utxoId !== utxoId) {
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
              existing.couponFeesPaid !== securityFeeCoupon
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
              recovered.couponFeesPaid = securityFeeCoupon;
              await this.saveRecoveredHistory(table, recovered, new Date(block.blockTime));
              this.applyRecoveredRecord(recovered);
            }
            continue;
          }
        }

        const record =
          existing ??
          (await this.recoverLock({
            lock: recoveredChainLock,
            createdAtArgonBlockHeight: block.blockNumber,
            finalFee: transactionFee,
            lockQueueOwnerUuid: options.lockQueueOwnerUuid,
          }));
        const recovered = this.createDetachedRecord(record);
        if (!this.isRetiredHistoryRecord(recovered)) recovered.status = BitcoinLockStatus.LockPendingFunding;
        recovered.satoshis = recoveredChainLock.securitizedSatoshis;
        recovered.liquidityPromised = recoveredChainLock.liquidityPromised;
        recovered.lockedTargetPrice = recoveredChainLock.lockedTargetPrice;
        recovered.couponFeesPaid = securityFeeCoupon;
        recovered.ratchets = [creationEventRatchet];
        this.assertSafePendingMint(recovered);
        await this.saveRecoveredHistory(table, recovered, new Date(block.blockTime));
        this.applyRecoveredRecord(recovered);
        continue;
      }

      const persistedRecord = this.getRecoveryLock(utxoId) ? undefined : await table.getByLockId(lockId);
      if (persistedRecord) {
        await this.prepareHistoryRecoveryLock(persistedRecord, options.lockQueueOwnerUuid);
      }
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
        const previousCouponFeesPaid = recovered.couponFeesPaid;
        const previousSecurityFees = recovered.securityFees;
        // These events mutate the original lock rather than creating a new ratchet.
        // Use the archived post-event state because older event shapes omit some resulting economics.
        const creationRatchet = recovered.ratchets[0];
        if (!creationRatchet) throw new Error(`Bitcoin lock ${recovered.utxoId} is missing its creation ratchet`);
        this.applyHistoricalLockSnapshot(recovered, chainLock);
        if (event.method === 'SecuritizationIncreased') {
          const grossFee = bigIntMax(chainLock.securityFees - previousSecurityFees, 0n);
          const recordedCoupon = bigIntMax(chainLock.couponFeesPaid - previousCouponFeesPaid, 0n);
          const securityFeeCoupon = await this.getEventTimeSecurityFeeCoupon({
            api,
            records: eventRecords,
            eventIndex,
            vaultId: event.data.vaultId,
            grossFee,
            recordedCoupon,
          });
          recovered.couponFeesPaid = previousCouponFeesPaid + securityFeeCoupon;
        } else if (chainLock.couponFeesPaid < previousCouponFeesPaid) {
          recovered.couponFeesPaid = previousCouponFeesPaid;
        }
        Object.assign(creationRatchet, {
          mintAmount: chainLock.liquidityPromised,
          mintPending: chainLock.liquidityPromised,
          lockedTargetPrice: chainLock.lockedTargetPrice,
          securityFee: chainLock.securityFees,
          securityFeeCoupon: recovered.couponFeesPaid,
        });
        this.updateCurrentSecuritizationTerm(recovered);

        if (isBitcoinUtxoVerified || event.method === 'UtxoFundedFromCandidate') {
          recovered.fundedSatoshis = chainLock.fundedSatoshis;
          recovered.satoshis = chainLock.fundedSatoshis || chainLock.securitizedSatoshis;
          if (recovered.status === BitcoinLockStatus.LockPendingFunding) {
            recovered.status = BitcoinLockStatus.LockFunded;
          }
          const fundingUtxos = await getHistoricalBitcoinFundingUtxos(api, utxoId, recovered.satoshis);
          if (fundingUtxos.length) {
            await this.syncRecoveredFundingUtxos(recovered, fundingUtxos);
          }
        }

        this.assertSafePendingMint(recovered);
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinLockBackfillChanged') {
        const recovered = this.createDetachedRecord(record);
        recovered.isFlexible = event.data.isBackfill;
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinLockFlexibleChanged') {
        const recovered = this.createDetachedRecord(record);
        recovered.isFlexible = event.data.isFlexible;
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
        this.applyHistoricalLockSnapshot(recovered, chainLock);
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } else if (event.section === 'bitcoinLocks' && event.method === 'OrphanedUtxoReceived') {
        const { satoshis, utxoRef } = event.data;
        await this.upsertRecoveredUtxo(
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
        if (ownerAccount !== record.ownerAccount) continue;
        const orphan = await api.query.bitcoinLocks.orphanedUtxosByAccount(ownerAccount, utxoRef);
        if (!orphan?.cosignRequest) continue;
        const request = orphan.cosignRequest;
        const currentTick = await api.query.ticks.currentTick();
        if (currentTick === null) continue;
        const orphanRecord = await this.upsertRecoveredUtxo(
          record,
          {
            txid: utxoRef.txid,
            vout: utxoRef.outputIndex,
            satoshis: orphan.satoshis,
          },
          { markOrphaned: true },
        );
        const release = await this.createRecoveredRelease(
          BitcoinReleaseKind.Orphan,
          record,
          [orphanRecord],
          {
            toScriptPubkey: u8aToHex(request.toScriptPubkey),
            bitcoinNetworkFee: request.bitcoinNetworkFee,
          },
          block,
          eventIndex,
        );
        await this.recordRecoveredReleaseRequest(release, {
          requestedReleaseAtTick: Number(currentTick),
        });
      } else if (event.section === 'bitcoinLocks' && event.method === 'OrphanedUtxoCosigned') {
        const { utxoRef, signature } = event.data;
        const ownerAccount = event.data.accountId ?? record.ownerAccount;
        if (ownerAccount !== record.ownerAccount) continue;
        const orphanRecord = this.getRecoveredUtxo(record, utxoRef.txid, utxoRef.outputIndex);
        if (!orphanRecord) continue;
        const release = orphanRecord.activeReleaseId
          ? (this.historyReplay?.releasesById[orphanRecord.activeReleaseId] ??
            this.releases.getById(orphanRecord.activeReleaseId))
          : undefined;
        if (!release || release.kind !== BitcoinReleaseKind.Orphan) continue;
        await this.recordRecoveredReleaseCosign(release, [signature], block.blockNumber);
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinLockRatcheted') {
        await this.importRatchet(record, block, eventRecords, eventIndex, event, api, table);
      } else if (event.section === 'mint' && event.method === 'BitcoinMint') {
        await this.applyScopedMint(record, event.data.amount, api, table);
      } else if (
        isBitcoinUtxoUnwatched &&
        record.status === BitcoinLockStatus.LockPendingFunding &&
        record.fundedSatoshis === 0n
      ) {
        const recovered = this.createDetachedRecord(record);
        recovered.status = BitcoinLockStatus.LockFailedAcknowledged;
        await this.saveRecoveredHistory(table, recovered);
        this.applyRecoveredRecord(recovered);
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinUtxoCosignRequested') {
        const releaseRequest = await getHistoricalBitcoinReleaseRequest(api, utxoId);
        if (!releaseRequest) {
          throw new Error(`Bitcoin lock ${utxoId} release request is unavailable at block ${block.blockNumber}`);
        }
        const recovered = this.createDetachedRecord(record);
        const releaseArgonTxFeeMicrogons = this.readTransactionFee(eventRecords, eventIndex);
        if (releaseRequest.liquidRedemptionAmount !== undefined) {
          this.historyReplay?.historicalLiquidRedemptionByUtxoId.set(utxoId, releaseRequest.liquidRedemptionAmount);
        }
        let fundingUtxos = this.getRecoveredFundingUtxos(recovered);
        if (!fundingUtxos.length) {
          const recoveredFundingUtxos = await getHistoricalBitcoinFundingUtxos(api, utxoId, recovered.satoshis);
          if (recoveredFundingUtxos.length) {
            fundingUtxos = await this.syncRecoveredFundingUtxos(recovered, recoveredFundingUtxos);
          }
        }
        if (!fundingUtxos.length) throw new Error(`Bitcoin lock ${utxoId} release has no recovered funding inputs`);
        const currentTick = await api.query.ticks.currentTick();
        if (currentTick === null) continue;
        const release = await this.createRecoveredRelease(
          BitcoinReleaseKind.Lock,
          recovered,
          fundingUtxos,
          {
            toScriptPubkey: releaseRequest.toScriptPubkey,
            bitcoinNetworkFee: releaseRequest.bitcoinNetworkFee,
            argonTxFeeMicrogons: releaseArgonTxFeeMicrogons,
          },
          block,
          eventIndex,
        );
        await this.recordRecoveredReleaseRequest(release, {
          requestedReleaseAtTick: Number(currentTick),
          argonTxFeeMicrogons: releaseArgonTxFeeMicrogons,
        });
        this.applyRecoveredRecord(recovered);
      } else if (event.section === 'bitcoinLocks' && event.method === 'BitcoinUtxoCosigned') {
        const release = this.getRecoveredRelease(record, BitcoinReleaseKind.Lock);
        if (!release) throw new Error(`Bitcoin lock ${utxoId} cosign has no recovered release request`);
        const signatures = event.data.signatures ?? (event.data.signature ? [event.data.signature] : []);
        await this.recordRecoveredReleaseCosign(release, [...signatures], block.blockNumber);
        const releaseIsComplete =
          liveRecord?.status === BitcoinLockStatus.Released || record.status === BitcoinLockStatus.Released;
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
        const compensation = event.data.compensationAmount;
        const release = this.getRecoveredRelease(record, BitcoinReleaseKind.Lock);
        if (!release) continue;
        if (this.historyReplay) release.compensationMicrogons ??= compensation;
        else await this.releases.recordCompensation(release, compensation);
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
          const release = this.getRecoveredRelease(recovered, BitcoinReleaseKind.Lock);
          if (bitcoinWasReleased && release) {
            Object.assign(release, {
              status: BitcoinReleaseStatus.Complete,
              argonCompletionBlockNumber: block.blockNumber,
              argonCompletionBlockHash: block.blockHash,
              argonCompletionBlockTime: new Date(block.blockTime),
              argonCompletionExtrinsicIndex: phase.type === 'ApplyExtrinsic' ? phase.value : undefined,
              statusError: undefined,
            });
            for (const inputId of release.inputUtxoIds) {
              const input = this.historyReplay.utxos.getById(inputId);
              if (!input) continue;
              input.spendStatus = BitcoinUtxoSpendStatus.Spent;
              input.activeReleaseId = undefined;
              input.spentByReleaseId = release.id;
            }
            recovered.activeReleaseId = undefined;
          }
        } else {
          const release = this.getRecoveredRelease(recovered, BitcoinReleaseKind.Lock);
          const liveLock = this.locksByLockId[this.getCanonicalLockId(recovered.utxoId)];
          if (bitcoinWasReleased && release && liveLock) {
            await this.releases.completeLockRelease(
              liveLock,
              release,
              {
                argonCompletionBlockNumber: block.blockNumber,
                argonCompletionBlockHash: block.blockHash,
                argonCompletionBlockTime: new Date(block.blockTime),
                argonCompletionExtrinsicIndex: phase.type === 'ApplyExtrinsic' ? phase.value : undefined,
              },
              removal,
            );
          } else {
            await table.recordRemoval(recovered, status, removal);
          }
        }
        this.applyRecoveredRecord(recovered);
      }
    }

    if (this.historyReplay) this.historyReplay.currentHistoricalUtxoId = undefined;
  }

  public async recoverLock(args: {
    lock: IHistoricalBitcoinLock;
    createdAtArgonBlockHeight: number;
    finalFee?: bigint;
    lockQueueOwnerUuid?: string;
  }): Promise<IHistoricalBitcoinLockRecord> {
    const lockDetails = toBitcoinLockDetails(args.lock);
    const lockId = this.resolveHistoricalLockId(args.lock);
    const liveRecord = this.locksByLockId[lockId];
    if (this.historyReplay && liveRecord) {
      await this.prepareHistoryRecoveryLock(liveRecord, args.lockQueueOwnerUuid);
    }

    const table = await this.getTable();
    const existing = await table.getByLockId(lockId);
    if (existing) {
      const recovered = this.createDetachedRecord(this.getRecoveryLock(args.lock.utxoId) ?? existing);
      if (!this.hasCompleteRatchetEconomics(recovered, args.lock.liquidityPromised, args.lock.lockedTargetPrice)) {
        const recoveredTransactionFees = recovered.ratchets.every(ratchet => ratchet.txFee !== undefined)
          ? recovered.ratchets.reduce((total, ratchet) => total + (ratchet.txFee ?? 0n), 0n)
          : undefined;
        const knownTransactionFees =
          args.finalFee === undefined
            ? recoveredTransactionFees
            : recoveredTransactionFees === undefined
              ? args.finalFee
              : bigIntMax(args.finalFee, recoveredTransactionFees);
        const knownSecurityFees = recovered.ratchets.reduce((total, ratchet) => total + ratchet.securityFee, 0n);
        recovered.satoshis = args.lock.fundedSatoshis || args.lock.securitizedSatoshis;
        recovered.liquidityPromised = args.lock.liquidityPromised;
        recovered.lockedTargetPrice = args.lock.lockedTargetPrice;
        this.applyHistoricalLockSnapshot(recovered, args.lock);
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

    let derivedPubkey: Awaited<ReturnType<typeof deriveBitcoinLockHdKey>> | undefined;
    if (this.walletKeys.canSign) {
      derivedPubkey = await this.findDerivedPubkeyForOwner(args.lock.vaultId, args.lock.ownerPubkey);
      if (!derivedPubkey) throw new Error(`Unable to recover the HD path for Bitcoin lock ${args.lock.utxoId}`);
    }

    let record: IBitcoinLockRecord | IHistoricalBitcoinLockRecord | undefined = derivedPubkey
      ? await table.findPendingByHdPath(derivedPubkey.hdPath)
      : undefined;
    let recoveredUuid = record?.uuid;
    if (!recoveredUuid && derivedPubkey) {
      const db = await this.dbPromise;
      const transaction = (await db.transactionsTable.fetchAll()).find(candidate => {
        if (candidate.extrinsicType !== ExtrinsicType.BitcoinRequestLock) return false;

        const metadata = candidate.metadataJson as Partial<IBitcoinRequestLockMetadata> | undefined;
        return metadata?.bitcoin?.hdPath === derivedPubkey.hdPath && metadata.bitcoin.vaultId === args.lock.vaultId;
      });
      const metadata = transaction?.metadataJson as Partial<IBitcoinRequestLockMetadata> | undefined;
      recoveredUuid = metadata?.bitcoin?.uuid;
    }
    recoveredUuid ??= BitcoinLocksTable.createUuid();

    if (!record && !this.historyReplay) {
      record = await this.insertPending({
        uuid: recoveredUuid,
        vaultId: args.lock.vaultId,
        securitizedSatoshis: args.lock.securitizedSatoshis,
        hdPath: derivedPubkey?.hdPath ?? '',
      });
    }

    const now = new Date();
    const historicalRecord: IHistoricalBitcoinLockRecord =
      record?.lockId !== undefined
        ? this.createDetachedRecord(record)
        : {
            uuid: record?.uuid ?? recoveredUuid,
            utxoId: args.lock.utxoId,
            status: record?.status ?? BitcoinLockStatus.LockIsProcessingOnArgon,
            securitizedSatoshis: args.lock.securitizedSatoshis,
            fundedSatoshis: args.lock.fundedSatoshis,
            fundingUtxoIds: record?.fundingUtxoIds ?? [],
            activeReleaseId: record?.activeReleaseId,
            ownerAccount: args.lock.ownerAccount,
            securitizationRatio: args.lock.securitizationRatio,
            securityFees: args.lock.securityFees,
            couponFeesPaid: args.lock.couponFeesPaid,
            scriptDetails: toBitcoinLockScriptDetails(lockDetails),
            securitizationHoldExpirationBitcoinHeight: args.lock.securitizationHoldExpirationBitcoinHeight,
            isFlexible: args.lock.isFlexible,
            fundHoldExtensionsByBitcoinExpirationHeight: args.lock.fundHoldExtensionsByBitcoinExpirationHeight,
            createdAtArgonBlock: args.lock.createdAtArgonBlock,
            satoshis: args.lock.securitizedSatoshis,
            liquidityPromised: 0n,
            lockedTargetPrice: 0n,
            ratchets: [],
            cosignVersion: record?.cosignVersion ?? 'v1',
            network: record?.network ?? this.getBitcoinNetwork(),
            hdPath: record?.hdPath ?? derivedPubkey?.hdPath ?? '',
            vaultId: args.lock.vaultId,
            createdAt: record?.createdAt ?? now,
            updatedAt: record?.updatedAt ?? now,
          };
    if (historicalRecord.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
      historicalRecord.status = BitcoinLockStatus.LockPendingFunding;
      historicalRecord.utxoId = args.lock.utxoId;
      historicalRecord.liquidityPromised = args.lock.liquidityPromised;
      historicalRecord.lockedTargetPrice = args.lock.lockedTargetPrice;
      this.applyHistoricalLockSnapshot(historicalRecord, args.lock);
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
    const recovered = this.createDetachedRecord(historicalRecord);
    this.applyRecoveredRecord(recovered);
    return recovered;
  }

  private async recoverCurrentLock(lock: IBitcoinLock): Promise<IBitcoinLockRecord> {
    const loaded = this.locksByLockId[lock.lockId];
    if (loaded) {
      await this.utxoTracking.syncFundingUtxos(loaded, lock);
      return loaded;
    }

    const table = await this.getTable();
    let record = await table.getByLockId(lock.lockId);

    let derivedPubkey: Awaited<ReturnType<typeof deriveBitcoinLockHdKey>> | undefined;
    if (!record && this.walletKeys.canSign) {
      derivedPubkey = await this.findDerivedPubkeyForOwner(lock.vaultId, lock.ownerPubkey);
      if (!derivedPubkey) throw new Error(`Unable to recover the HD path for Bitcoin lock ${lock.lockId}`);
    }

    record ??= derivedPubkey ? await table.findPendingByHdPath(derivedPubkey.hdPath) : undefined;
    if (!record) {
      let recoveredUuid: string | undefined;
      if (derivedPubkey) {
        const db = await this.dbPromise;
        const transaction = (await db.transactionsTable.fetchAll()).find(candidate => {
          if (candidate.extrinsicType !== ExtrinsicType.BitcoinRequestLock) return false;

          const metadata = candidate.metadataJson as Partial<IBitcoinRequestLockMetadata> | undefined;
          return metadata?.bitcoin?.hdPath === derivedPubkey.hdPath && metadata.bitcoin.vaultId === lock.vaultId;
        });
        const metadata = transaction?.metadataJson as Partial<IBitcoinRequestLockMetadata> | undefined;
        recoveredUuid = metadata?.bitcoin?.uuid;
      }
      record = await this.insertPending({
        uuid: recoveredUuid ?? BitcoinLocksTable.createUuid(),
        vaultId: lock.vaultId,
        securitizedSatoshis: lock.securitizedSatoshis,
        hdPath: derivedPubkey?.hdPath ?? '',
      });
    }
    if (record.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
      record = await table.finalizePending({ uuid: record.uuid, lock });
    }
    const model: IBitcoinLockRecord = { ...record };
    await this.utxoTracking.syncFundingUtxos(model, lock);
    this.locksByLockId[lock.lockId] = model;
    return model;
  }

  public recoverActiveLocks(options?: { requireComplete?: boolean }): Promise<IBitcoinLock[]> {
    this.activeLockRecoveryPromise ??= (async () => {
      this.activeLocksByLockId.clear();
      const api = await this.blockWatch.getFinalizedApi();
      const utxoIds = await this.findActiveLockIds(api);
      const activeUtxoIds = new Set(utxoIds);
      const locks: IBitcoinLock[] = [];
      for (const utxoId of utxoIds) this.activeLocksByLockId.set(utxoId, undefined);
      for (const utxoId of this.activeLockRecoveryFailedLockIds) {
        if (!activeUtxoIds.has(utxoId)) this.activeLockRecoveryFailedLockIds.delete(utxoId);
      }

      const table = await this.getTable();
      const resumedReleases: IBitcoinLockRecord[] = [];
      for (const record of Object.values(this.locksByLockId)) {
        if (
          record.lockId === undefined ||
          record.status !== BitcoinLockStatus.Releasing ||
          this.activeLocksByLockId.has(record.lockId)
        ) {
          continue;
        }

        const activeRelease = this.releases.getActiveForLock(record);
        if (activeRelease) {
          if (!record.isHistoryRecoveryPending) continue;

          await table.setHistoryRecoveryPending(record.uuid, false);
          delete record.isHistoryRecoveryPending;
          this.historyRecoveryPendingLockIds.delete(record.lockId);
          this.historyRecoveryPendingUuids.delete(record.uuid);
          resumedReleases.push(record);
          continue;
        }
      }
      if (resumedReleases.length) this.onHistoryRecoveryComplete(resumedReleases, true);

      for (const utxoId of utxoIds) {
        try {
          const lock = await BitcoinLock.get(api, utxoId);
          if (!lock) throw new Error(`Active Bitcoin lock ${utxoId} is unavailable from finalized chain state`);

          this.activeLockRecoveryFailedLockIds.delete(utxoId);
          this.activeLocksByLockId.set(utxoId, lock);
          await this.recoverCurrentLock(lock);
          locks.push(lock);
        } catch (error) {
          this.activeLockRecoveryFailedLockIds.add(utxoId);
          console.warn(`Unable to restore active Bitcoin lock ${utxoId} from chain:`, error);
        }
      }

      return locks.sort((left, right) => right.createdAtArgonBlock - left.createdAtArgonBlock);
    })().finally(() => {
      this.activeLockRecoveryPromise = undefined;
    });
    if (!options?.requireComplete) return this.activeLockRecoveryPromise;

    return this.activeLockRecoveryPromise.then(locks => {
      if (this.activeLockRecoveryFailedLockIds.size) {
        throw new Error('Active Bitcoin lock recovery is incomplete.');
      }
      return locks;
    });
  }

  public async findActiveLockIds(api: ArgonQueryClient): Promise<number[]> {
    if (api.runtimeVersion.specVersion.toNumber() >= 159) {
      const ownerKeys = await api.query.bitcoinLocks.lockIdsByOwnerAccount.keys(this.walletKeys.defaultArgonAddress);
      return (ownerKeys ?? []).map(key => key.args[1]);
    }

    const historicalApi = api as ArgonApi;
    const ownerKeys = await historicalApi.query.bitcoinLocks.utxoIdsByOwnerAccount.keys(
      this.walletKeys.defaultArgonAddress,
    );
    return (ownerKeys ?? []).map(key => key.args[1]);
  }

  public async findMissingActiveLockIds(api: ArgonQueryClient): Promise<number[]> {
    const utxoIds = await this.findActiveLockIds(api);
    if (api.runtimeVersion.specVersion.toNumber() >= 159) {
      return utxoIds.filter(utxoId => this.activeLocksByLockId.get(utxoId) === undefined);
    }

    const missing: number[] = [];

    for (const utxoId of utxoIds) {
      const record = this.getRecoveryLock(utxoId);
      const chainLock = await getHistoricalBitcoinLock(api as ArgonApi, utxoId);
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
    const chainLock = await getHistoricalBitcoinLock(api, record.utxoId);
    if (!chainLock) throw new Error(`Bitcoin lock ${record.utxoId} is unavailable after ratchet`);

    const recovered = this.createDetachedRecord(record);
    const previousCouponFeesPaid = recovered.couponFeesPaid;
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
      throw new Error(
        `Bitcoin lock ${record.utxoId} ratchet history has prior target ${previousRatchet.lockedTargetPrice} instead of ${oldTargetPrice}`,
      );
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
    const recordedCoupon = bigIntMax(chainLock.couponFeesPaid - previousCouponFeesPaid, 0n);
    const securityFeeCoupon = await this.getEventTimeSecurityFeeCoupon({
      api,
      records: eventRecords,
      eventIndex,
      vaultId: event.data.vaultId,
      grossFee: securityFee,
      recordedCoupon,
    });
    const ratchet = {
      mintAmount,
      mintPending: mintAmount,
      liquidityPromised: cumulativeLiquidity,
      lockedTargetPrice,
      securityFee,
      securityFeeCoupon,
      txFee: this.readTransactionFee(eventRecords, eventIndex),
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
      this.applyHistoricalLockSnapshot(recovered, chainLock);
      recovered.securityFees = chainLock.securityFees;
      recovered.couponFeesPaid = previousCouponFeesPaid + securityFeeCoupon;
    }
    this.updateCurrentSecuritizationTerm(recovered);
    this.assertSafePendingMint(recovered);
    await this.saveRecoveredHistory(table, recovered);
    this.applyRecoveredRecord(recovered);
  }

  private async upsertRecoveredUtxo(
    lock: IHistoricalBitcoinLockRecord,
    candidate: { txid: string; vout: number; satoshis: bigint },
    options?: { markOrphaned?: boolean },
  ): Promise<IBitcoinUtxoRecord> {
    const lockId = this.getCanonicalLockId(lock.utxoId);
    const replay = this.historyReplay;
    if (replay) {
      return replay.utxos.upsert({ lockId, network: lock.network }, candidate, options?.markOrphaned);
    }

    const liveLock = this.locksByLockId[lockId];
    if (!liveLock) throw new Error(`Bitcoin lock ${lockId} is unavailable for UTXO recovery`);
    return await this.utxoTracking.upsertUtxoRecord(liveLock, candidate, options);
  }

  private async syncRecoveredFundingUtxos(
    lock: IHistoricalBitcoinLockRecord,
    fundingUtxos: IBitcoinLock['fundingUtxos'],
  ): Promise<IBitcoinUtxoRecord[]> {
    const records: IBitcoinUtxoRecord[] = [];
    for (const fundingUtxo of fundingUtxos) {
      const record = await this.upsertRecoveredUtxo(lock, {
        txid: fundingUtxo.utxoRef.txid,
        vout: fundingUtxo.utxoRef.vout,
        satoshis: fundingUtxo.satoshis,
      });
      record.status = BitcoinUtxoStatus.FundingUtxo;
      record.firstSeenOnArgonAt ??= new Date();
      records.push(record);
    }
    lock.fundingUtxoIds = records.map(record => record.id);
    lock.fundedSatoshis = fundingUtxos.reduce((total, fundingUtxo) => total + fundingUtxo.satoshis, 0n);
    if (this.historyReplay) return records;

    const lockId = this.getCanonicalLockId(lock.utxoId);
    const liveLock = this.locksByLockId[lockId];
    if (!liveLock) throw new Error(`Bitcoin lock ${lockId} is unavailable for funding recovery`);
    const db = await this.dbPromise;
    for (const record of records) await db.bitcoinUtxosTable.setFundingUtxo(record);
    liveLock.fundingUtxoIds = records.map(record => record.id);
    liveLock.fundedSatoshis = lock.fundedSatoshis;
    return records;
  }

  private getRecoveredUtxo(
    lock: IHistoricalBitcoinLockRecord,
    txid: string,
    vout: number,
  ): IBitcoinUtxoRecord | undefined {
    const lockId = this.getCanonicalLockId(lock.utxoId);
    return (
      this.historyReplay?.utxos.getByOutpoint(lockId, txid, vout) ?? this.utxoTracking.getUtxoRecord(lockId, txid, vout)
    );
  }

  private getRecoveredFundingUtxos(lock: IHistoricalBitcoinLockRecord): IBitcoinUtxoRecord[] {
    const replay = this.historyReplay;
    if (replay) {
      return lock.fundingUtxoIds.flatMap(id => {
        const record = replay.utxos.getById(id) ?? this.utxoTracking.getUtxoRecordById(id);
        return record ? [record] : [];
      });
    }
    const liveLock = this.locksByLockId[this.getCanonicalLockId(lock.utxoId)];
    return liveLock ? this.utxoTracking.getFundingUtxos(liveLock) : [];
  }

  private async createRecoveredRelease(
    kind: BitcoinReleaseKind,
    lock: IHistoricalBitcoinLockRecord,
    inputUtxos: IBitcoinUtxoRecord[],
    request: Pick<IBitcoinReleaseRecord, 'toScriptPubkey' | 'bitcoinNetworkFee'> &
      Partial<Pick<IBitcoinReleaseRecord, 'insuredMicrogons' | 'argonTxFeeMicrogons'>>,
    block: IBlockHeaderInfo,
    eventIndex: number,
  ): Promise<IBitcoinReleaseRecord> {
    const replay = this.historyReplay;
    const activeReleaseId =
      kind === BitcoinReleaseKind.Lock
        ? lock.activeReleaseId
        : inputUtxos.length === 1
          ? inputUtxos[0].activeReleaseId
          : undefined;
    const activeRelease = activeReleaseId
      ? (replay?.releasesById[activeReleaseId] ?? this.releases.getById(activeReleaseId))
      : undefined;
    if (activeRelease) return activeRelease;

    const phase = block.blockNumber === 0 ? undefined : eventIndex;
    const outpoint = kind === BitcoinReleaseKind.Orphan ? `-${inputUtxos[0]?.txid}-${inputUtxos[0]?.vout}` : '';
    const id = `history-${kind.toLowerCase()}-${lock.uuid}-${block.blockNumber}-${phase ?? 0}${outpoint}`;
    const now = new Date(block.blockTime);
    const release: IBitcoinReleaseRecord = {
      id,
      kind,
      lockId: this.getCanonicalLockId(lock.utxoId),
      status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
      inputUtxoIds: inputUtxos.map(utxo => utxo.id),
      toScriptPubkey: request.toScriptPubkey,
      bitcoinNetworkFee: request.bitcoinNetworkFee,
      insuredMicrogons: request.insuredMicrogons,
      argonTxFeeMicrogons: request.argonTxFeeMicrogons,
      vaultSignatures: [],
      createdAt: now,
      updatedAt: now,
    };

    if (replay) {
      replay.releasesById[id] = release;
      if (kind === BitcoinReleaseKind.Lock) {
        lock.status = BitcoinLockStatus.Releasing;
        lock.activeReleaseId = id;
      }
      for (const utxo of inputUtxos) utxo.activeReleaseId = id;
      return release;
    }

    if (kind === BitcoinReleaseKind.Lock) {
      const liveLock = this.locksByLockId[release.lockId];
      if (!liveLock) throw new Error(`Bitcoin lock ${release.lockId} is unavailable for release recovery`);
      return await this.releases.createLockRelease(liveLock, release);
    }
    if (inputUtxos.length !== 1) throw new Error(`Orphan release ${id} does not have exactly one input`);
    return await this.releases.createOrphanRelease(inputUtxos[0], release);
  }

  private async recordRecoveredReleaseRequest(
    release: IBitcoinReleaseRecord,
    facts: Pick<IBitcoinReleaseRecord, 'requestedReleaseAtTick'> &
      Partial<Pick<IBitcoinReleaseRecord, 'insuredMicrogons' | 'argonTxFeeMicrogons'>>,
  ): Promise<void> {
    if (release.status !== BitcoinReleaseStatus.SubmittingRequestOnArgon) return;
    if (this.historyReplay) {
      Object.assign(release, facts, {
        status: BitcoinReleaseStatus.WaitingForVaultCosign,
        statusError: undefined,
      });
      return;
    }
    await this.releases.recordArgonRequest(release, facts);
  }

  private async recordRecoveredReleaseCosign(
    release: IBitcoinReleaseRecord,
    vaultSignatures: Uint8Array[],
    cosignBlockNumber: number,
  ): Promise<void> {
    if (
      release.status === BitcoinReleaseStatus.Complete ||
      release.status === BitcoinReleaseStatus.Cancelled ||
      release.status === BitcoinReleaseStatus.Failed
    ) {
      return;
    }
    if (this.historyReplay) {
      if (vaultSignatures.length !== release.inputUtxoIds.length) {
        throw new Error(
          `Bitcoin release ${release.id} has ${vaultSignatures.length} signatures for ${release.inputUtxoIds.length} inputs`,
        );
      }
      Object.assign(release, {
        vaultSignatures: [...vaultSignatures],
        cosignBlockNumber,
        status: BitcoinReleaseStatus.ReadyForBitcoinBroadcast,
        statusError: undefined,
      });
      return;
    }
    await this.releases.recordVaultCosign(release, { vaultSignatures, cosignBlockNumber });
  }

  private getRecoveredRelease(
    lock: IHistoricalBitcoinLockRecord,
    kind: BitcoinReleaseKind,
  ): IBitcoinReleaseRecord | undefined {
    const replay = this.historyReplay;
    const releaseId =
      kind === BitcoinReleaseKind.Lock
        ? lock.activeReleaseId
        : replay?.utxos.records.find(
            utxo => utxo.lockId === this.getCanonicalLockId(lock.utxoId) && utxo.activeReleaseId,
          )?.activeReleaseId;
    if (!releaseId) return;
    const release = replay?.releasesById[releaseId] ?? this.releases.getById(releaseId);
    return release?.kind === kind ? release : undefined;
  }

  private createDetachedRecord(
    record: IBitcoinLockRecord | IHistoricalBitcoinLockRecord,
  ): IHistoricalBitcoinLockRecord {
    const historical = record as IHistoricalBitcoinLockRecord;
    return createHistoricalBitcoinLockRecord(
      historical.utxoId === undefined ? (record as IBitcoinLockRecord) : historical,
    );
  }

  private applyHistoricalLockSnapshot(record: IHistoricalBitcoinLockRecord, chainLock: IHistoricalBitcoinLock): void {
    const lockDetails = toBitcoinLockDetails(chainLock);
    Object.assign(record, {
      liquidityPromised: chainLock.liquidityPromised,
      lockedTargetPrice: chainLock.lockedTargetPrice,
      securitizedSatoshis: lockDetails.securitizedSatoshis,
      ownerAccount: lockDetails.ownerAccount,
      securitizationRatio: lockDetails.securitizationRatio,
      securityFees: lockDetails.securityFees,
      couponFeesPaid: lockDetails.couponFeesPaid,
      scriptDetails: toBitcoinLockScriptDetails(lockDetails),
      securitizationHoldExpirationBitcoinHeight: chainLock.securitizationHoldExpirationBitcoinHeight,
      isFlexible: lockDetails.isFlexible,
      fundHoldExtensionsByBitcoinExpirationHeight: lockDetails.fundHoldExtensionsByBitcoinExpirationHeight,
      createdAtArgonBlock: lockDetails.createdAtArgonBlock,
    });
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
    const durable = this.toDurableRecord(record);
    if (createdAt) await table.saveRecoveredHistory(durable, createdAt);
    else await table.saveRecoveredHistory(durable);
    record.updatedAt = durable.updatedAt;
  }

  private applyRecoveredRecord(
    record: IBitcoinLockRecord | IHistoricalBitcoinLockRecord,
  ): IHistoricalBitcoinLockRecord {
    const recovered = this.createDetachedRecord(record);
    const lockId = this.getCanonicalLockId(recovered.utxoId);
    const stagedLocks = this.historyReplay?.locksByLockId;
    this.historyReplay?.dirtyLockIds.add(lockId);
    const liveRecord = this.locksByLockId[lockId];
    const stagedRecord =
      stagedLocks?.[lockId] ?? (stagedLocks && liveRecord ? this.createDetachedRecord(liveRecord) : undefined);
    const current = stagedRecord ?? liveRecord;
    const liveState = this.toDurableRecord(recovered, lockId);
    const retiredStatus = current && this.isRetiredHistoryRecord(current) ? current.status : undefined;
    if (retiredStatus !== undefined) {
      recovered.status = retiredStatus;
      delete recovered.isHistoryRecoveryPending;
    }
    if (stagedRecord) {
      Object.assign(stagedRecord, recovered);
      if (retiredStatus !== undefined) stagedRecord.status = retiredStatus;
      stagedLocks![lockId] = stagedRecord;
      return stagedRecord;
    }
    if (liveRecord) {
      Object.assign(liveRecord, liveState);
      if (retiredStatus !== undefined) liveRecord.status = retiredStatus;
      return recovered;
    }

    if (stagedLocks) {
      stagedLocks[lockId] = recovered;
    } else {
      this.locksByLockId[lockId] = liveState;
    }
    return recovered;
  }

  private getRecoveryLock(utxoId: number): IHistoricalBitcoinLockRecord | undefined {
    const lockId = this.getCanonicalLockId(utxoId);
    const recovered = this.historyReplay?.locksByLockId[lockId];
    if (recovered) return recovered;
    const live = this.locksByLockId[lockId];
    return live ? this.createDetachedRecord(live) : undefined;
  }

  private async prepareHistoryRecoveryLock(lock: IBitcoinLockRecord, lockQueueOwnerUuid?: string): Promise<void> {
    if (!this.historyReplay) return;

    const lockId = lock.lockId;
    if (lockId === undefined || this.historyReplay.locksByLockId[lockId] || this.isRetiredHistoryRecord(lock)) {
      return;
    }

    if (this.historyReplay.purpose === 'operational-repair') {
      await this.waitForLockIdle(lock, lock.uuid === lockQueueOwnerUuid);
    }
    const snapshot = this.createDetachedRecord(lock);
    this.historyReplay.locksByLockId[lockId] = snapshot;
    for (const utxo of this.utxoTracking.getUtxosForLock(lockId)) {
      this.historyReplay.utxos.add(utxo);
    }
    const release = this.releases.getActiveForLock(lock);
    if (release) {
      this.historyReplay.releasesById[release.id] = { ...release, inputUtxoIds: [...release.inputUtxoIds] };
    }
  }

  private toDurableRecord(
    record: IHistoricalBitcoinLockRecord,
    lockId = this.getCanonicalLockId(record.utxoId),
  ): IBitcoinLockRecord {
    const {
      utxoId,
      removalTick: _removalTick,
      satoshis: _satoshis,
      lockedTargetPrice: _lockedTargetPrice,
      liquidityPromised: _liquidityPromised,
      ratchets: _ratchets,
      ...durable
    } = record;
    return {
      ...durable,
      lockId,
    };
  }

  private getCanonicalLockId(utxoId: number): number {
    return this.historyReplay?.lockIdByHistoricalUtxoId.get(utxoId) ?? utxoId;
  }

  private resolveHistoricalLockId(lock: IHistoricalBitcoinLock): number {
    const replay = this.historyReplay;
    if (!replay) return lock.utxoId;
    const mapped = replay.lockIdByHistoricalUtxoId.get(lock.utxoId);
    if (mapped !== undefined) return mapped;

    const matchingLock = Object.values(this.locksByLockId).find(candidate => {
      return (
        candidate.lockId !== undefined &&
        candidate.vaultId === lock.vaultId &&
        candidate.scriptDetails?.p2wshScriptHashHex === lock.p2wshScriptHashHex &&
        candidate.scriptDetails.ownerPubkey === lock.ownerPubkey
      );
    });
    const lockId = matchingLock?.lockId ?? lock.utxoId;
    replay.lockIdByHistoricalUtxoId.set(lock.utxoId, lockId);
    return lockId;
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
    let value: number | null | undefined;
    if (event.section === 'bitcoinLocks') {
      switch (event.method) {
        case 'BitcoinCosignPastDue':
          value = event.data.lockId ?? event.data.utxoId;
          break;
        case 'BitcoinLockBurned':
          value = event.data.lockId ?? event.data.utxoId;
          break;
        case 'BitcoinLockCreated':
          value = event.data.lockId ?? event.data.utxoId;
          break;
        case 'BitcoinLockFlexibleChanged':
          value = event.data.lockId ?? event.data.utxoId;
          break;
        case 'BitcoinLockResecuritized':
          value = event.data.lockId;
          break;
        case 'BitcoinSpentAfterRelease':
          value = event.data.lockId ?? event.data.utxoId;
          break;
        case 'BitcoinUtxoCosigned':
          value = event.data.lockId ?? event.data.utxoId;
          break;
        case 'BitcoinUtxoCosignRequested':
          value = event.data.lockId ?? event.data.utxoId;
          break;
        case 'OrphanedUtxoCosigned':
          value = event.data.lockId ?? event.data.utxoId;
          break;
        case 'OrphanedUtxoReceived':
          value = event.data.lockId ?? event.data.utxoId;
          break;
        case 'OrphanedUtxoReleaseRequested':
          value = event.data.lockId ?? event.data.utxoId;
          break;
        case 'BitcoinLockBackfillChanged':
          value = event.data.utxoId;
          break;
        case 'BitcoinLockRatcheted':
          value = event.data.utxoId;
          break;
        case 'SecuritizationIncreased':
          value = event.data.utxoId;
          break;
        case 'UtxoFundedFromCandidate':
          value = event.data.utxoId;
          break;
      }
    } else if (event.section === 'bitcoinUtxos' && event.method === 'UtxoUnwatched') {
      value = event.data.lockId ?? event.data.utxoId;
    } else if (event.section === 'bitcoinUtxos' && event.method === 'UtxoVerified') {
      value = event.data.utxoId;
    } else if (event.section === 'mint' && event.method === 'BitcoinMint') {
      value = event.data.lockId ?? event.data.utxoId;
    }
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

    const lockId = this.getCanonicalLockId(lock.utxoId);
    const terms = origin === 'created' ? [] : (replay.securitizationTermsByLockId.get(lockId) ?? []);
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
      lockId,
      termIndex: terms.length,
      origin,
      startTick: block.tick,
      startBlockNumber: block.blockNumber,
      startBlockHash: block.blockHash,
      startExtrinsicIndex: extrinsicIndex,
      securitizedSatoshis: lock.securitizedSatoshis,
      securitizationCoverageMicrogons: coverage,
      cumulativeNetSecurityFee,
      addedNetSecurityFee: bigIntMax(cumulativeNetSecurityFee - (previous?.cumulativeNetSecurityFee ?? 0n), 0n),
    });
    replay.securitizationTermsByLockId.set(lockId, terms);
  }

  private updateCurrentSecuritizationTerm(lock: IHistoricalBitcoinLockRecord): void {
    const terms = this.historyReplay?.securitizationTermsByLockId.get(this.getCanonicalLockId(lock.utxoId));
    const current = terms?.at(-1);
    if (!current) return;

    const previousCumulativeFee = terms?.at(-2)?.cumulativeNetSecurityFee ?? 0n;
    current.securitizedSatoshis = lock.securitizedSatoshis;
    current.securitizationCoverageMicrogons = lock.securitizationCoverageMicrogons;
    current.cumulativeNetSecurityFee = bigIntMax(lock.securityFees - lock.couponFeesPaid, 0n);
    current.addedNetSecurityFee = bigIntMax(current.cumulativeNetSecurityFee - previousCumulativeFee, 0n);
  }

  private async getEventTimeSecurityFeeCoupon(args: {
    api: ArgonApi;
    records: readonly NamedBitcoinRecoveryEventRecord[];
    eventIndex: number;
    vaultId: number;
    grossFee: bigint;
    recordedCoupon: bigint;
  }): Promise<bigint> {
    const { api, records, eventIndex, vaultId, grossFee, recordedCoupon } = args;
    const precedingEvent = records[eventIndex - 1]?.event;
    if (
      precedingEvent?.section === 'vaults' &&
      precedingEvent.method === 'FundsLocked' &&
      precedingEvent.data.vaultId === vaultId &&
      precedingEvent.data.didUseFeeCoupon !== undefined
    ) {
      return precedingEvent.data.didUseFeeCoupon ? grossFee : recordedCoupon;
    }

    const feePayer = this.readTransactionPayer(records, eventIndex);
    if (!feePayer || grossFee <= 0n) return recordedCoupon;

    const vault = await api.query.vaults.vaultsById(vaultId);
    if (!vault || vault.operatorAccountId.toString() !== feePayer) return recordedCoupon;
    return grossFee;
  }

  private closeSecuritizationTerm(block: IBlockHeaderInfo, record: NamedBitcoinRecoveryEventRecord): void {
    const replay = this.historyReplay;
    const utxoId = this.readUtxoId(record.event);
    if (!replay || utxoId === undefined) return;

    const term = replay.securitizationTermsByLockId.get(this.getCanonicalLockId(utxoId))?.at(-1);
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
    const feeRecord = this.findTransactionFeeRecord(records, operationEventIndex);
    if (!feeRecord) return;

    const payer = feeRecord.event.data.who;
    const ownedAccounts = new Set([
      this.walletKeys.defaultArgonAddress,
      this.walletKeys.miningBotAddress,
      this.walletKeys.operationalAddress,
    ]);
    return ownedAccounts.has(payer) ? feeRecord.event.data.actualFee : 0n;
  }

  private readTransactionPayer(
    records: readonly NamedBitcoinRecoveryEventRecord[],
    operationEventIndex: number,
  ): string | undefined {
    return this.findTransactionFeeRecord(records, operationEventIndex)?.event.data.who;
  }

  private findTransactionFeeRecord(
    records: readonly NamedBitcoinRecoveryEventRecord[],
    operationEventIndex: number,
  ):
    | (NamedBitcoinRecoveryEventRecord & {
        event: Extract<HistoricalEvent, { section: 'transactionPayment'; method: 'TransactionFeePaid' }>;
      })
    | undefined {
    const phase = records[operationEventIndex].phase;
    if (phase.type !== 'ApplyExtrinsic') return;

    return records.find(
      (
        record,
      ): record is NamedBitcoinRecoveryEventRecord & {
        event: Extract<HistoricalEvent, { section: 'transactionPayment'; method: 'TransactionFeePaid' }>;
      } =>
        record.phase.type === 'ApplyExtrinsic' &&
        record.phase.value === phase.value &&
        record.event.section === 'transactionPayment' &&
        record.event.method === 'TransactionFeePaid',
    );
  }

  private async applyScopedMint(
    record: IHistoricalBitcoinLockRecord,
    amount: bigint,
    api: ArgonApi,
    table: BitcoinLocksTable,
  ): Promise<void> {
    const recovered = this.createDetachedRecord(record);
    const pendingMint = recovered.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
    const chainPendingMints = await getHistoricalBitcoinPendingMints(api, recovered.utxoId);
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
    const chainPendingMints = await getHistoricalBitcoinPendingMints(api, recovered.utxoId);
    const chainPendingMint = chainPendingMints.reduce((sum, amount) => sum + amount, 0n);
    const recoveredPendingMint = recovered.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
    if (chainPendingMint > recoveredPendingMint) {
      const liveLock = this.locksByLockId[this.getCanonicalLockId(record.utxoId)];
      if (liveLock) await this.prepareHistoryRecoveryLock(liveLock, lockQueueOwnerUuid);
      throw new Error(`Bitcoin lock ${record.utxoId} pending mint exceeds recovered history`);
    }
    this.assertSafePendingMint(recovered);
    if (chainPendingMint === recoveredPendingMint) return;

    const liveLock = this.locksByLockId[this.getCanonicalLockId(record.utxoId)];
    if (liveLock) await this.prepareHistoryRecoveryLock(liveLock, lockQueueOwnerUuid);
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

  private get locksByLockId(): Record<number, IBitcoinLockRecord> {
    return this.getLocksByLockId();
  }

  private get pendingLocks(): IBitcoinLockRecord[] {
    return this.getPendingLocks();
  }
}

type BitcoinRecoveryEventRecord = RuntimeSystemEventRecord;
type NamedBitcoinRecoveryEventRecord = RuntimeSystemEventRecord & { event: HistoricalEvent };
