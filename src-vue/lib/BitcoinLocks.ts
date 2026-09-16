import { getMainchainClient } from '../stores/mainchain.ts';
import BigNumber from 'bignumber.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import {
  addressBytesHex,
  BitcoinNetwork,
  CosignScript,
  getScureNetwork,
  type ICosignScriptLock,
  p2wshScriptHexToAddress,
} from '@argonprotocol/bitcoin';
import { Address, OutScript } from '@scure/btc-signer';
import { formatArgons, hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import { toRuntimeEvent } from '@argonprotocol/runtime-client';
import { Db } from './Db.ts';
import { BitcoinLocksTable, BitcoinLockStatus, IBitcoinLockBlockExtrinsicError } from './db/BitcoinLocksTable.ts';
import type { IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import { BitcoinReleaseStatus, type IBitcoinReleaseRecord } from '../interfaces/IBitcoinReleaseRecord.ts';
import type { IBitcoinUnlockReleaseState, IBitcoinVaultUnlockStateDetails } from '../interfaces/IBitcoinLocks.ts';
import BitcoinUtxoTracking from './BitcoinUtxoTracking.ts';
import BitcoinReleases from './BitcoinReleases.ts';
import BitcoinMempool from './BitcoinMempool.ts';
import { recordFinalizedSecuritization } from './BitcoinSecuritizationTerms.ts';
import { BlockProgress } from './BlockProgress.ts';
import { BITCOIN_BLOCK_MILLIS, ESPLORA_HOST } from './Env.ts';
import {
  type ArgonQueryClient,
  bigIntMax,
  bigNumberToBigInt,
  BitcoinLock,
  BlockWatch,
  createDeferred,
  createTypedEventEmitter,
  Currency as CurrencyBase,
  getPercent,
  type IBitcoinLock,
  type IBitcoinLockConfig,
  type IBitcoinLockCouponUseRecord,
  IBlockHeaderInfo,
  IDeferred,
  MiningFrames,
  NetworkConfig,
  type RuntimeSystemEventRecord,
  SingleFileQueue,
  type Vault,
} from '@argonprotocol/apps-core';
import { TransactionTracker } from './TransactionTracker.ts';
import { deriveBitcoinLockHdKey, WalletKeys } from './WalletKeys.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { MyVault } from './MyVault.ts';
import type { IBitcoinUtxoRecord } from './db/BitcoinUtxosTable.ts';
import type { IBitcoinLockProcessingDetails, IBitcoinLockSummary } from '../interfaces/IBitcoinLockSummary.ts';
import { BitcoinLockRecovery } from './recovery/BitcoinLocks.ts';
import { calculateBitcoinReturn, valueSatoshisAtRate } from './financials/BitcoinLocks.ts';

export type { IBitcoinUnlockReleaseState, IBitcoinVaultUnlockStateDetails };

dayjs.extend(utc);

export interface IOperatorBitcoinLockCouponRoute {
  vaultId: number;
  offerCode: string;
  accountId?: string;
  remainingFeeCreditMicrogons?: bigint;
  pendingInitialization?: Pick<IBitcoinLockCouponUseRecord, 'requestId' | 'feeCreditMicrogons' | 'feeCoupon'>;
}

export class BitcoinLockWalletFundingError extends Error {
  constructor(public readonly requiredWalletBalanceMicrogons: bigint) {
    super(`Your wallet needs a balance of ${formatArgons(requiredWalletBalanceMicrogons)} to initialize this lock.`);
  }
}

export interface IBitcoinRequestLockMetadata {
  bitcoin: {
    uuid: string;
    vaultId: number;
    satoshis: bigint;
    hdPath: string;
    lockedTargetPrice: bigint;
    liquidityPromised: bigint;
    securityFee: bigint;
    feeCouponNonce?: bigint;
    feeCouponRequestId?: string;
  };
}

export default class BitcoinLocks {
  public readonly events = createTypedEventEmitter<{
    'fissions:changed': (change: {
      block: IBlockHeaderInfo;
      client: ArgonQueryClient;
      events: readonly RuntimeSystemEventRecord[];
    }) => void;
  }>();

  public data: {
    pendingLocks: IBitcoinLockRecord[];
    locksByLockId: { [lockId: number]: IBitcoinLockRecord };
    oracleBitcoinBlockHeight: number;
    bitcoinNetwork: BitcoinNetwork;
    readiness: 'idle' | 'loading' | 'ready' | 'error';
    loadError?: Error;
    financialRevision: number;
    isReconciliationPending: boolean;
    latestArgonBlock?: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>;
  };

  public get bitcoinNetwork() {
    return this.data.bitcoinNetwork;
  }

  private get locksByLockId() {
    return this.data.locksByLockId;
  }

  private get oracleBitcoinBlockHeight() {
    return this.data.oracleBitcoinBlockHeight;
  }

  public get config(): IBitcoinLockConfig {
    return this.#config;
  }

  public myVault?: MyVault;
  public readonly utxoTracking: BitcoinUtxoTracking;
  public readonly releases: BitcoinReleases;
  public readonly recovery: BitcoinLockRecovery;

  #config!: IBitcoinLockConfig;

  #lockTicksPerDay!: number;
  #subscription?: () => void;
  #waitForLoad?: IDeferred;
  #currency: CurrencyBase;
  #transactionTracker: TransactionTracker;
  #blockQueue = new SingleFileQueue();
  #bitcoinKeyAllocationQueue = new SingleFileQueue();
  #txQueueByUuid: { [uuid: string]: SingleFileQueue } = {};
  #pendingArgonBlocks: IBlockHeaderInfo[] = [];
  #historyRecoveryWaitersByUuid: Record<string, IDeferred<void>> = {};
  #mempool: BitcoinMempool;
  #securitizationHoldExpirationEstimateByCreatedHeight = new Map<
    number,
    { oracleBitcoinBlockHeight: number; expirationTime: number }
  >();
  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly walletKeys: WalletKeys,
    private readonly blockWatch: BlockWatch,
    currency: CurrencyBase,
    transactionTracker: TransactionTracker,
    mempool: BitcoinMempool = new BitcoinMempool(ESPLORA_HOST),
  ) {
    this.#currency = currency;
    this.#transactionTracker = transactionTracker;
    this.data = {
      pendingLocks: [],
      locksByLockId: {},
      oracleBitcoinBlockHeight: 0,
      bitcoinNetwork: BitcoinNetwork.Bitcoin,
      readiness: 'idle',
      financialRevision: 0,
      isReconciliationPending: false,
    };
    this.#mempool = mempool;
    this.utxoTracking = new BitcoinUtxoTracking({
      dbPromise,
      getBitcoinNetwork: () => this.bitcoinNetwork,
      getOracleBitcoinBlockHeight: () => this.oracleBitcoinBlockHeight,
      getConfig: () => this.#config,
      getMainchainClient,
      mempool: this.#mempool,
    });
    this.releases = new BitcoinReleases(
      this,
      dbPromise,
      this.utxoTracking,
      this.#mempool,
      walletKeys,
      currency,
      blockWatch,
      transactionTracker,
    );
    this.recovery = new BitcoinLockRecovery({
      walletKeys,
      blockWatch,
      currency,
      getLocksByLockId: () => this.data.locksByLockId,
      getPendingLocks: () => this.data.pendingLocks,
      utxoTracking: this.utxoTracking,
      releases: this.releases,
      waitForLockIdle: async (lock, alreadyOwnsQueue) => {
        this.#historyRecoveryWaitersByUuid[lock.uuid] ??= createDeferred<void>();
        if (alreadyOwnsQueue) return;

        const queue = this.#txQueueByUuid[lock.uuid];
        if (queue) await queue.add(async () => undefined).promise;
      },
      findConfirmedRecoveredRelease: async ({ lock, release, fundingUtxos }) => {
        let txid = release?.bitcoinTxid;
        if (!txid) {
          for (const fundingUtxo of fundingUtxos) {
            const outspend = await this.#mempool.getOutspendStatus(
              fundingUtxo.txid,
              fundingUtxo.vout,
              this.oracleBitcoinBlockHeight,
            );
            if (outspend?.isConfirmed) return outspend;
          }
          if (!walletKeys.canSign || !release || release.status !== BitcoinReleaseStatus.ReadyForBitcoinBroadcast)
            return;
          txid = (await this.releases.buildLockBitcoinTransaction(lock, release)).txid;
        }

        const status = await this.#mempool.getTxStatus(txid, this.oracleBitcoinBlockHeight);
        if (!status?.isConfirmed) return;
        return { ...status, txid };
      },
      onHistoryRecoveryComplete: (locks, didPublish) => this.resumeAfterHistoryRecovery(locks, didPublish),
      onHistoryPublished: () => this.publishFinancialRevision(),
      insertPending: this.insertPending.bind(this),
      dbPromise,
      getTable: () => this.getTable(),
      getDerivedPubkey: (vaultId, index) => this.getDerivedPubkey(vaultId, index),
      getBitcoinNetwork: () => String(this.#config?.bitcoinNetwork ?? BitcoinNetwork[this.bitcoinNetwork]),
      trackDerivedBitcoinLockKey: (vaultId, derivedPubkey) => this.trackDerivedBitcoinLockKey(vaultId, derivedPubkey),
    });
  }

  public getActiveLocks(): IBitcoinLockRecord[] {
    return this.getAllLocks().filter(lock => !this.isTerminalLock(lock));
  }

  public getAllLocks({
    includeHistoryRecoveryPending = false,
  }: { includeHistoryRecoveryPending?: boolean } = {}): IBitcoinLockRecord[] {
    const locks = Object.values(this.data.locksByLockId);
    locks.unshift(...this.data.pendingLocks);
    return locks
      .filter(lock => includeHistoryRecoveryPending || !lock.isHistoryRecoveryPending)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  public getUtxosForLock(lock: Pick<IBitcoinLockRecord, 'lockId'>): IBitcoinUtxoRecord[] {
    return lock.lockId === undefined ? [] : this.utxoTracking.getUtxosForLock(lock.lockId);
  }

  public getFundingUtxos(lock: IBitcoinLockRecord): IBitcoinUtxoRecord[] {
    return this.utxoTracking.getFundingUtxos(lock);
  }

  public async getEligibleFlexibleLocks({
    vaultId,
    operatorAddress,
    client,
  }: {
    vaultId: number;
    operatorAddress: string;
    client?: ArgonQueryClient;
  }): Promise<IBitcoinLock[]> {
    client ??= await getMainchainClient(false);

    const lockIds = await BitcoinLock.idsByOwner(client, operatorAddress);
    const locks = await BitcoinLock.getMany(client, lockIds);
    const eligible: IBitcoinLock[] = [];

    for (const lock of locks) {
      if (!lock) continue;
      if (lock.ownerAccount !== operatorAddress || lock.vaultId !== vaultId || lock.fundedSatoshis === 0n) continue;
      if (await BitcoinLock.getReleaseRequest(client, lock.lockId)) continue;

      eligible.push(lock);
    }

    return eligible;
  }

  public createLockSummary(lock: IBitcoinLockRecord): IBitcoinLockSummary {
    const lockProcessingDetails = this.getLockProcessingDetails(lock);
    const release = this.releases.getLatestForLock(lock);
    const satoshis = lock.fundedSatoshis || lock.securitizedSatoshis;
    const valueOfBtc = this.#currency.convertBtcToMicrogon(this.#currency.convertSatToBtc(satoshis));
    const securityFees = bigIntMax(lock.securityFees - lock.couponFeesPaid, 0n);
    const releaseBitcoinNetworkFeeValue = valueSatoshisAtRate(
      release?.bitcoinNetworkFee,
      lock.btcPriceAtRemovalMicrogons,
    );
    const hasHistoricalTransactionFees =
      release?.argonTxFeeMicrogons !== undefined || releaseBitcoinNetworkFeeValue !== undefined;
    const historicalTransactionFees = hasHistoricalTransactionFees
      ? (release?.argonTxFeeMicrogons ?? 0n) + (releaseBitcoinNetworkFeeValue ?? 0n)
      : undefined;

    return {
      uuid: lock.uuid,
      lockId: lock.lockId,
      status: lock.status,
      statusDetails: this.readLockStatusDetails(lock, lockProcessingDetails),
      lockProcessingDetails,
      lockProcessingError: this.getLockProcessingError(lock),
      satoshis,
      valueOfBtc,
      totalLiquidity: 0n,
      pendingLiquidity: 0n,
      receivedLiquidity: 0n,
      valueBeyondLiquidity: valueOfBtc,
      startingCapital: valueOfBtc,
      endingCapital: valueOfBtc - securityFees,
      ratchetPercent: 0,
      totalReturn: calculateBitcoinReturn(valueOfBtc, valueOfBtc - securityFees),
      securityFees,
      transactionFees: 0n,
      totalFees: securityFees,
      historicalTransactionFees,
      historicalTotalFees:
        historicalTransactionFees === undefined ? undefined : securityFees + historicalTransactionFees,
      unlockAmount: 0n,
      createdAt: lock.createdAt,
      record: lock,
    };
  }

  public refreshLockSummary(summary: IBitcoinLockSummary): void {
    const lock = summary.record;
    const lockProcessingDetails = this.getLockProcessingDetails(lock);

    summary.status = lock.status;
    summary.lockProcessingDetails = lockProcessingDetails;
    summary.lockProcessingError = this.getLockProcessingError(lock);
    Object.assign(summary.statusDetails, this.readLockStatusDetails(lock, lockProcessingDetails));
  }

  public getLockById(lockId: number): IBitcoinLockRecord | undefined {
    const lock = this.data.locksByLockId[lockId];
    return lock && !this.isHistoryRecoveryPendingForLock(lock) ? lock : undefined;
  }

  public getLockByUuid(uuid: string): IBitcoinLockRecord | undefined {
    return (
      this.data.pendingLocks.find(lock => lock.uuid === uuid) ?? this.getAllLocks().find(lock => lock.uuid === uuid)
    );
  }

  public unlockDeadlineTime(lock: IBitcoinLockRecord): number {
    if (!this.#config) {
      throw new Error('Bitcoin lock configuration is not loaded for expiration time.');
    }
    const oracleBitcoinBlockHeight = this.oracleBitcoinBlockHeight;
    const expirationBlock = lock.scriptDetails?.vaultClaimHeight;
    if (expirationBlock === undefined) throw new Error(`Bitcoin lock ${lock.uuid} has no script details.`);
    if (expirationBlock <= oracleBitcoinBlockHeight) {
      return 0; // Already expired
    }
    const lockReleaseCosignDeadlineFrames = this.#config?.lockReleaseCosignDeadlineFrames ?? 0;
    const releaseOffset = this.#config.tickDurationMillis * this.#lockTicksPerDay * lockReleaseCosignDeadlineFrames;
    const expirationDateMillis = (expirationBlock - oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS;
    return Date.now() + expirationDateMillis - releaseOffset;
  }

  public getSecuritizationHoldExpirationTime(
    lock: Pick<IBitcoinLockRecord, 'scriptDetails' | 'securitizationHoldExpirationBitcoinHeight'>,
  ) {
    if (!this.#config) {
      throw new Error('Bitcoin lock configuration is not loaded for verify time.');
    }
    const createdAtHeight = lock.scriptDetails?.createdAtHeight;
    const expirationHeight = lock.securitizationHoldExpirationBitcoinHeight;
    if (createdAtHeight === undefined || expirationHeight === undefined) {
      throw new Error('Bitcoin lock funding terms are unavailable.');
    }
    const oracleBitcoinBlockHeight = this.oracleBitcoinBlockHeight;

    if (expirationHeight <= oracleBitcoinBlockHeight) {
      return Date.now() - 1; // Already expired
    }

    const previousEstimate = this.#securitizationHoldExpirationEstimateByCreatedHeight.get(createdAtHeight);
    if (previousEstimate?.oracleBitcoinBlockHeight === oracleBitcoinBlockHeight) {
      return previousEstimate.expirationTime;
    }

    const expirationTime = Date.now() + (expirationHeight - oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS;
    this.#securitizationHoldExpirationEstimateByCreatedHeight.set(createdAtHeight, {
      oracleBitcoinBlockHeight,
      expirationTime,
    });
    return expirationTime;
  }

  public getSecuritizationHoldProgress(
    lock: Pick<IBitcoinLockRecord, 'scriptDetails' | 'securitizationHoldExpirationBitcoinHeight'>,
  ): number {
    try {
      const expTime = this.getSecuritizationHoldExpirationTime(lock);
      if (expTime <= Date.now()) return 100;

      const created = lock.scriptDetails?.createdAtHeight ?? 0;
      const current = this.data.oracleBitcoinBlockHeight;
      const windowBlocks = this.config?.securitizationHoldBlocks;
      if (!windowBlocks) return 0;

      const elapsed = Math.max(current - created, 0);
      return Math.min((elapsed / windowBlocks) * 100, 100);
    } catch {
      return 0;
    }
  }

  public getLockTermProgress(lock: Pick<IBitcoinLockRecord, 'scriptDetails'>): number {
    const created = lock.scriptDetails?.createdAtHeight ?? 0;
    const expires = lock.scriptDetails?.vaultClaimHeight ?? 0;
    const current = this.data.oracleBitcoinBlockHeight;
    if (expires <= created) return 100;

    const elapsed = Math.max(current - created, 0);
    const total = expires - created;
    return Math.min((elapsed / total) * 100, 100);
  }

  public getCosignDeadlineProgress(dueFrame: number | undefined, miningFrames: MiningFrames): number {
    const deadlineFrames = this.config?.lockReleaseCosignDeadlineFrames ?? 0;
    if (!dueFrame || deadlineFrames <= 0) return 0;

    const startFrame = dueFrame - deadlineFrames;
    const startTick = miningFrames.estimateTickStart(startFrame);
    const endTick = miningFrames.estimateTickStart(dueFrame) + NetworkConfig.rewardTicksPerFrame;
    return getPercent(miningFrames.currentTick - startTick, endTick - startTick);
  }

  public isSecuritizationHoldExpired(lock: IBitcoinLockRecord): boolean {
    try {
      return this.getSecuritizationHoldExpirationTime(lock) <= Date.now();
    } catch {
      return false;
    }
  }

  public confirmAddress(lock: IBitcoinLockRecord) {
    const cosignScript = this.createCosignScript({ lock, fundedSatoshis: lock.fundedSatoshis });
    const pubkey = cosignScript.calculateScriptPubkey();
    if (lock.scriptDetails?.p2wshScriptHashHex !== pubkey) {
      throw new Error(`Lock with ID ${lock.lockId} has an invalid address.`);
    }
  }

  public createCosignScript(args: { lock: IBitcoinLockRecord; fundedSatoshis: bigint }): CosignScript {
    return new CosignScript(this.getCosignScriptLock(args), this.bitcoinNetwork);
  }

  public getCosignScriptLock(args: { lock: IBitcoinLockRecord; fundedSatoshis: bigint }): ICosignScriptLock {
    const { lock, fundedSatoshis } = args;
    if (!lock.scriptDetails) throw new Error(`Bitcoin lock ${lock.uuid} has no script details.`);
    return {
      ...lock.scriptDetails,
      securitizedSatoshis: lock.securitizedSatoshis,
      fundedSatoshis,
    };
  }

  public async load(force = false): Promise<void> {
    if (this.#waitForLoad?.isRunning) return this.#waitForLoad.promise;
    if (!force && this.#waitForLoad?.isResolved) return this.#waitForLoad.promise;

    if (force || this.#waitForLoad?.isRejected) {
      this.#waitForLoad = createDeferred<void>();
    } else {
      this.#waitForLoad ??= createDeferred<void>();
    }
    this.data.readiness = 'loading';
    this.data.loadError = undefined;
    try {
      const archiveClient = await getMainchainClient(true);
      this.#config ??= await BitcoinLock.getConfig(archiveClient);
      this.#lockTicksPerDay = archiveClient.consts.bitcoinLocks.argonTicksPerDay.toNumber();
      const bitcoinNetwork = this.#config.bitcoinNetwork.type;
      if (bitcoinNetwork === 'Bitcoin') this.data.bitcoinNetwork = BitcoinNetwork.Bitcoin;
      else if (bitcoinNetwork === 'Testnet') this.data.bitcoinNetwork = BitcoinNetwork.Testnet;
      else if (bitcoinNetwork === 'Signet') this.data.bitcoinNetwork = BitcoinNetwork.Signet;
      else this.data.bitcoinNetwork = BitcoinNetwork.Regtest;

      const db = await this.dbPromise;
      const table = db.bitcoinLocksTable;
      const [locks, utxoRecords] = await Promise.all([table.fetchAll(), db.bitcoinUtxosTable.fetchAll()]);
      for (const lock of locks) {
        if (lock.lockId) {
          this.locksByLockId[lock.lockId] = lock;
        } else {
          const existingIndex = this.data.pendingLocks.findIndex(x => x.uuid === lock.uuid);
          if (existingIndex >= 0) {
            this.data.pendingLocks.splice(existingIndex, 1, lock);
          } else {
            this.data.pendingLocks.push(lock);
          }
        }
      }
      this.utxoTracking.load(utxoRecords);
      await this.releases.load();

      await this.blockWatch.start();
      const hasDelegatedPendingLocks = await table.hasDelegatedPendingLocks();
      const activeLocks = await this.recovery
        .recoverActiveLocks({ requireComplete: hasDelegatedPendingLocks })
        .catch(error => {
          if (hasDelegatedPendingLocks) throw error;
          console.warn('[BitcoinLocks] Unable to restore active locks from chain during startup', error);
          return undefined;
        });
      // Delegated initialization cannot resume on the current runtime. A complete active scan protects real
      // active locks before the remaining relay-only attempts become terminal; do not restore relay polling.
      if (activeLocks) {
        for (const retiredLock of await table.retireDelegatedPendingLocks()) {
          const index = this.data.pendingLocks.findIndex(lock => lock.uuid === retiredLock.uuid);
          if (index >= 0) this.data.pendingLocks.splice(index, 1, { ...retiredLock, fundedSatoshis: 0n });
        }
      }

      await this.utxoTracking.syncArgonOrphans(Object.values(this.locksByLockId), archiveClient).catch(error => {
        console.warn(`[BitcoinLocks] Unable to restore orphaned Bitcoin`, error);
      });
      for (const lock of Object.values(this.locksByLockId)) {
        if (!this.isTerminalLock(lock)) {
          await this.checkForMissingBitcoinLockState(lock).catch(error => {
            console.warn(`[BitcoinLocks] Unable to reconcile lock ${lock.uuid} during startup`, error);
          });
        }
      }

      await this.migrateLegacyBitcoinLockHdKeys();
      await this.releases.syncOrphanCosignCounterSubscriptions(archiveClient).catch(error => {
        console.warn('[BitcoinLocks] Unable to watch orphan return counters', error);
      });
      this.data.isReconciliationPending = true;
      const initialFinalizedBlock = this.blockWatch.finalizedBlockHeader;
      void this.#blockQueue
        .add(async () => {
          await this.checkIncomingArgonBlocks([initialFinalizedBlock]);
          await this.runPendingLoadReconciliation();
        })
        .promise.catch(error => {
          console.warn(
            '[BitcoinLocks] Initial Argon block sync did not finish during load; continuing in the background',
            {
              blockNumber: initialFinalizedBlock.blockNumber,
              blockHash: initialFinalizedBlock.blockHash,
              error,
            },
          );
        });
      this.#subscription?.();
      this.#subscription = this.blockWatch.events.on('finalized', async headers => {
        void this.#blockQueue.add(async () => {
          await this.checkIncomingArgonBlocks(headers);
          await this.runPendingLoadReconciliation();
        });
      });
      this.data.readiness = 'ready';
      this.data.financialRevision += 1;
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('Error loading BitcoinLocks:', error);
      this.data.readiness = 'error';
      this.data.loadError = error instanceof Error ? error : new Error(String(error));
      this.#waitForLoad.reject(error);
    }
    return this.#waitForLoad.promise;
  }

  public get currentLoadPromise(): Promise<void> {
    if (!this.#waitForLoad) throw new Error('Bitcoin Lock loading has not started.');
    return this.#waitForLoad.promise;
  }

  private async runPendingLoadReconciliation(): Promise<void> {
    if (!this.data.isReconciliationPending) {
      return;
    }

    try {
      for (const lock of Object.values(this.locksByLockId)) {
        if (this.isHistoryRecoveryPendingForLock(lock)) continue;
        if (this.isTerminalLock(lock)) {
          await this.runInQueueForLock(lock, () => this.releases.reconcileOrphanReleases(lock), {
            waitForHistoryRecovery: true,
          });
          continue;
        }

        await this.runInQueueForLock(
          lock,
          async () => {
            await this.releases.reconcileOrphanReleases(lock);
            await this.releases.reconcileLockRelease(lock, false);
          },
          { waitForHistoryRecovery: true },
        );
      }
      await this.releases.syncOrphanBitcoinProcessing(this.oracleBitcoinBlockHeight);
      this.data.isReconciliationPending = false;
    } catch (error) {
      console.warn('[BitcoinLocks] Startup reconciliation did not finish; will retry on the next block', error);
    }
  }

  private async checkForMissingBitcoinLockState(lock: IBitcoinLockRecord): Promise<void> {
    if (this.isHistoryRecoveryPendingForLock(lock) || this.isTerminalLock(lock) || !lock.lockId) {
      return;
    }
    const finalizedApi = await this.blockWatch.getFinalizedApi();
    const bitcoinLock = await BitcoinLock.get(finalizedApi, lock.lockId);
    if (bitcoinLock) {
      if (lock.status === BitcoinLockStatus.LockFunded && bitcoinLock.fundedSatoshis === 0n) {
        await (await this.getTable()).setStatus(lock, BitcoinLockStatus.LockPendingFunding);
      }
      await this.tryUpdateFundingUtxos(lock, finalizedApi, bitcoinLock);
    }
    await this.releases.reconcileLockRelease(lock, false);
  }

  public unsubscribeFromArgonBlocks() {
    this.#subscription?.();
    this.#subscription = undefined;
  }

  public async shutdown() {
    this.unsubscribeFromArgonBlocks();
    this.releases.shutdown();
    await this.#blockQueue.stop(true);
    await this.#bitcoinKeyAllocationQueue.stop(true);
    await Promise.all(Object.values(this.#txQueueByUuid).map(queue => queue.stop(true)));
  }

  public async allocateUtxoPubkey(vault: Vault) {
    return await this.#bitcoinKeyAllocationQueue.add(async () => {
      await this.load();
      const db = await this.dbPromise;
      const scopeKey = vault.vaultId.toString();
      const derivedPubkey = await this.getDerivedPubkey(
        vault.vaultId,
        await db.walletHdKeysTable.getNextHdKeyIndex({
          keyRole: 'bitcoinLock',
          scopeKey,
        }),
      );
      await this.trackDerivedBitcoinLockKey(vault.vaultId, derivedPubkey);
      return derivedPubkey;
    }).promise;
  }

  public async getInitializePreviewPubkey(vault: Vault) {
    return await this.getDerivedPubkey(vault.vaultId, 0);
  }

  public async getDerivedPubkey(vaultId: number, index: number) {
    return await deriveBitcoinLockHdKey({
      walletKeys: this.walletKeys,
      bitcoinNetwork: this.bitcoinNetwork,
      vaultId,
      hdIndex: index,
    });
  }

  public async trackDerivedBitcoinLockKey(
    vaultId: number,
    derivedPubkey: Awaited<ReturnType<BitcoinLocks['getDerivedPubkey']>>,
  ): Promise<void> {
    const db = await this.dbPromise;
    await db.walletHdKeysTable.upsert({
      keyRole: 'bitcoinLock',
      scopeKey: vaultId.toString(),
      hdIndex: derivedPubkey.hdIndex,
      hdPath: derivedPubkey.hdPath,
      address: derivedPubkey.address,
      publicKeyHex: u8aToHex(derivedPubkey.ownerBitcoinPubkey),
    });
  }

  private async migrateLegacyBitcoinLockHdKeys(): Promise<void> {
    const db = await this.dbPromise;
    const legacyRows = await db.select<{ vaultId: number; latestIndex: number }[]>(
      'SELECT vaultId, latestIndex FROM BitcoinLockVaultHdSeq',
      [],
    );
    if (!legacyRows.length) {
      return;
    }

    for (const { vaultId, latestIndex } of legacyRows) {
      const scopeKey = vaultId.toString();
      const nextHdIndex = await db.walletHdKeysTable.getNextHdKeyIndex({
        keyRole: 'bitcoinLock',
        scopeKey,
      });
      if (nextHdIndex > latestIndex) {
        continue;
      }

      await this.trackDerivedBitcoinLockKey(vaultId, await this.getDerivedPubkey(vaultId, latestIndex));
    }

    await db.execute('DELETE FROM BitcoinLockVaultHdSeq', []);
  }

  public async satoshisForArgonLiquidity(microgonLiquidity: bigint, microgonsAtTargetPerBtc?: bigint): Promise<bigint> {
    if (microgonsAtTargetPerBtc === undefined) {
      await this.#currency.load(true);
      return BitcoinLock.satoshisRequiredForRedemptionAmount(this.#currency.priceIndex, microgonLiquidity);
    }

    if (microgonLiquidity <= 0n || microgonsAtTargetPerBtc <= 0n) return 0n;

    let lowerSatoshis = 0n;
    let upperSatoshis = 1n;
    while (this.argonLiquidityForSatoshis(upperSatoshis, microgonsAtTargetPerBtc) < microgonLiquidity) {
      upperSatoshis *= 2n;
    }

    while (lowerSatoshis < upperSatoshis) {
      const satoshis = (lowerSatoshis + upperSatoshis) / 2n;
      if (this.argonLiquidityForSatoshis(satoshis, microgonsAtTargetPerBtc) >= microgonLiquidity) {
        upperSatoshis = satoshis;
      } else {
        lowerSatoshis = satoshis + 1n;
      }
    }
    return lowerSatoshis;
  }

  public argonLiquidityForSatoshis(satoshis: bigint, microgonsAtTargetPerBtc?: bigint): bigint {
    return BitcoinLock.calculateLiquidityPromised({
      priceIndex: this.#currency.priceIndex,
      satoshis,
      microgonsAtTargetPerBtc,
    });
  }

  public async getLockableBitcoinCapacity(args: {
    vault: Vault;
    lockOwner?: string;
    maxSatoshis?: bigint;
    projectedFlexibleSecuritizationLocked?: bigint;
    microgonsAtTargetPerBtc?: bigint;
  }): Promise<{
    availableSatoshis: bigint;
    availableLiquidityMicrogons: bigint;
    vaultCapacitySatoshis: bigint;
    vaultCapacityLiquidityMicrogons: bigint;
  }> {
    const { vault, lockOwner, maxSatoshis, projectedFlexibleSecuritizationLocked, microgonsAtTargetPerBtc } = args;
    let vaultCapacityLiquidityMicrogons: bigint;
    if (projectedFlexibleSecuritizationLocked == null) {
      vaultCapacityLiquidityMicrogons = vault.availableBitcoinSpace(lockOwner) ?? 0n;
    } else {
      const projectedOrdinarySecuritizationLocked = bigIntMax(
        vault.securitizationLocked - projectedFlexibleSecuritizationLocked,
        0n,
      );
      const projectedAvailableSecuritization = bigIntMax(
        vault.securitization - projectedOrdinarySecuritizationLocked - vault.reservedSecuritizationSpace,
        0n,
      );
      vaultCapacityLiquidityMicrogons = bigNumberToBigInt(
        BigNumber(projectedAvailableSecuritization).dividedBy(vault.securitizationRatioBN()),
      );
    }
    if (!this.#currency.isLoaded) {
      await this.#currency.load();
    }
    const vaultCapacitySatoshis =
      microgonsAtTargetPerBtc === undefined
        ? BitcoinLock.satoshisRequiredForRedemptionAmount(this.#currency.priceIndex, vaultCapacityLiquidityMicrogons)
        : await this.satoshisForArgonLiquidity(vaultCapacityLiquidityMicrogons, microgonsAtTargetPerBtc);
    let availableSatoshis = vaultCapacitySatoshis;
    let availableLiquidityMicrogons = vaultCapacityLiquidityMicrogons;
    if (maxSatoshis != null && maxSatoshis < vaultCapacitySatoshis) {
      availableSatoshis = maxSatoshis;
      availableLiquidityMicrogons = this.argonLiquidityForSatoshis(availableSatoshis, microgonsAtTargetPerBtc);
    }

    return {
      availableSatoshis,
      availableLiquidityMicrogons,
      vaultCapacitySatoshis,
      vaultCapacityLiquidityMicrogons,
    };
  }

  public async minimumSatoshiPerLock(): Promise<bigint> {
    const client = await getMainchainClient(false);
    return await client.query.bitcoinLocks.minimumSatoshis();
  }

  public async insertPending(details: {
    uuid: string;
    securitizedSatoshis: bigint;
    vaultId: number;
    hdPath: string;
  }): Promise<IBitcoinLockRecord> {
    const table = await this.getTable();
    return {
      ...(await table.insertPending({
        uuid: details.uuid,
        securitizedSatoshis: details.securitizedSatoshis,
        vaultId: details.vaultId,
        hdPath: details.hdPath,
        status: BitcoinLockStatus.LockIsProcessingOnArgon,
        cosignVersion: 'v1',
        network: String(this.#config.bitcoinNetwork),
      })),
      fundedSatoshis: 0n,
    };
  }

  public async publishPendingLock(metadata: IBitcoinRequestLockMetadata): Promise<IBitcoinLockRecord> {
    const { bitcoin } = metadata;
    const existing = this.getLockByUuid(bitcoin.uuid);
    if (existing) return existing;

    const pendingLock = await this.insertPending({
      uuid: bitcoin.uuid,
      securitizedSatoshis: bitcoin.satoshis,
      vaultId: bitcoin.vaultId,
      hdPath: bitcoin.hdPath,
    });
    this.data.pendingLocks.push(pendingLock);
    this.publishFinancialRevision();
    return pendingLock;
  }

  public async finalizeCreatedLock(
    uuid: string,
    lock: IBitcoinLock,
    txInfo: TransactionInfo,
  ): Promise<IBitcoinLockRecord> {
    const { block, extrinsicIndex } = await this.getFinalizedTransactionLocation(txInfo);
    return await this.runInQueueForLock(
      { uuid },
      async () => {
        const db = await this.dbPromise;
        const record = await db.transaction(async transaction => {
          const finalized = await transaction.bitcoinLocksTable.finalizePending({ uuid, lock });
          await recordFinalizedSecuritization(transaction.bitcoinSecuritizationHistoryTable, {
            block,
            extrinsicIndex,
            lock,
            origin: 'created',
          });
          return finalized;
        });
        const model: IBitcoinLockRecord = { ...record, fundedSatoshis: 0n };
        this.locksByLockId[model.lockId!] = model;
        const pendingIdx = this.data.pendingLocks.findIndex(pending => pending.uuid === uuid);
        if (pendingIdx >= 0) this.data.pendingLocks.splice(pendingIdx, 1);
        this.publishFinancialRevision();
        return model;
      },
      { waitForHistoryRecovery: true },
    );
  }

  public async failPendingLock(uuid: string, error: unknown): Promise<void> {
    await this.runInQueueForLock(
      { uuid },
      async () => {
        const table = await this.getTable();
        const pendingLock = this.data.pendingLocks.find(lock => lock.uuid === uuid);
        const errorJson = BitcoinLocks.toBlockExtrinsicErrorJson(error);
        if (pendingLock) {
          await table.setLockFailed(pendingLock, errorJson);
          return;
        }

        const failedRecord = await table.setLockFailedByUuid(uuid, errorJson);
        if (!failedRecord) return;
        const pendingIndex = this.data.pendingLocks.findIndex(lock => lock.uuid === uuid);
        if (pendingIndex >= 0) {
          this.data.pendingLocks.splice(pendingIndex, 1, { ...failedRecord, fundedSatoshis: 0n });
        }
      },
      { waitForHistoryRecovery: true },
    );
    this.publishFinancialRevision();
  }

  public static toBlockExtrinsicErrorJson(error: unknown): IBitcoinLockBlockExtrinsicError {
    const candidate = error as Partial<IBitcoinLockBlockExtrinsicError> & {
      message?: string;
      toString?: () => string;
    };
    return {
      batchInterruptedIndex: candidate.batchInterruptedIndex,
      errorCode: candidate.errorCode,
      details: candidate.details,
      message: candidate.message ?? candidate.toString?.() ?? 'Unknown Error',
    };
  }

  public async calculateBitcoinNetworkFee(
    lock: IBitcoinLockRecord,
    feeRatePerSatVb: bigint,
    toScriptPubkey: string,
    hasChange = false,
  ): Promise<bigint> {
    const cosignScript = this.createCosignScript({ lock, fundedSatoshis: lock.fundedSatoshis });
    toScriptPubkey = addressBytesHex(toScriptPubkey, this.bitcoinNetwork);
    const inputCount = this.utxoTracking.getFundingUtxos(lock).length;
    if (!inputCount) throw new Error(`Bitcoin lock ${lock.lockId} has no funding UTXOs`);
    console.log('Calculating fee for lock', {
      lockId: lock.lockId,
      feeRatePerSatVb: feeRatePerSatVb.toString(),
      toScriptPubkey,
    });
    return cosignScript.calculateFee(feeRatePerSatVb, inputCount, toScriptPubkey, hasChange);
  }

  public formatP2wshAddress(scriptHex: string): string {
    return BitcoinLocks.formatP2wshAddress(scriptHex, this.bitcoinNetwork);
  }

  public formatAddressBytes(scriptHex: string): string {
    return BitcoinLocks.formatAddressBytes(scriptHex, this.bitcoinNetwork);
  }

  public getLockProcessingDetails(lock: IBitcoinLockRecord): IBitcoinLockProcessingDetails {
    if (lock.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
      const txInfo = this.#transactionTracker.findLatestTxInfo<IBitcoinRequestLockMetadata>(
        candidate =>
          candidate.tx.extrinsicType === ExtrinsicType.BitcoinRequestLock &&
          candidate.tx.metadataJson.bitcoin.uuid === lock.uuid,
      );
      if (txInfo) {
        const progress = txInfo.getStatus();
        return {
          progressPct: progress.progressPct,
          confirmations: progress.confirmations,
          expectedConfirmations: progress.expectedConfirmations,
        };
      }

      return {
        progressPct: 0,
        confirmations: -1,
        expectedConfirmations: 0,
      };
    }
    return this.utxoTracking.getLockProcessingDetails(lock);
  }

  public getLockProcessingError(lock: IBitcoinLockRecord): string {
    if (lock.blockExtrinsicErrorJson?.message) {
      return BitcoinLocks.formatBlockExtrinsicError(lock.blockExtrinsicErrorJson);
    }

    const txInfo = this.#transactionTracker.findLatestTxInfo<IBitcoinRequestLockMetadata>(
      candidate =>
        candidate.tx.extrinsicType === ExtrinsicType.BitcoinRequestLock &&
        candidate.tx.metadataJson.bitcoin.uuid === lock.uuid,
    );
    if (!txInfo) return '';
    if (txInfo.txResult.submissionError) {
      return txInfo.txResult.submissionError.message;
    }
    if (!txInfo.tx.isFinalized) return '';
    return txInfo.txResult.extrinsicError?.message ?? '';
  }

  public static formatBlockExtrinsicError(error: IBitcoinLockBlockExtrinsicError): string {
    const raw = error.details || error.errorCode || error.message;
    return raw.split('.').pop() || raw;
  }

  public hasObservedFundingSignal(lock: IBitcoinLockRecord): boolean {
    return this.utxoTracking.hasObservedFundingSignal(lock);
  }

  public getLockUnlockReleaseState(lock: IBitcoinLockRecord | undefined): IBitcoinUnlockReleaseState {
    const defaultState: IBitcoinUnlockReleaseState = {
      hasActiveLock: false,
      isPendingFunding: false,
      isLockReadyForUnlock: false,
      hasFundingUtxos: false,
      isReleaseStatus: false,
      isArgonSubmitting: false,
      isWaitingForVaultCosign: false,
      isBitcoinReleaseProcessing: false,
      hasRequestDetails: false,
      hasCosign: false,
      hasReleaseTxid: false,
      isReleaseComplete: false,
    };

    if (!lock) return defaultState;

    const fundingUtxos = this.utxoTracking.getFundingUtxos(lock);
    const release =
      lock.status === BitcoinLockStatus.Released
        ? this.releases.getLatestForLock(lock)
        : this.releases.getActiveForLock(lock);
    const hasFundingUtxos = fundingUtxos.length > 0;
    const hasRequestDetails = release?.requestedReleaseAtTick !== undefined;
    const hasCosign = !!release?.vaultSignatures.length;
    const hasReleaseTxid = !!release?.bitcoinTxid;
    const isArgonSubmitting = release?.status === BitcoinReleaseStatus.SubmittingRequestOnArgon;
    const isReleaseComplete =
      release?.status === BitcoinReleaseStatus.Complete || lock.status === BitcoinLockStatus.Released;
    const isBitcoinReleaseProcessing =
      release?.status === BitcoinReleaseStatus.ConfirmingOnBitcoin ||
      release?.status === BitcoinReleaseStatus.WaitingForArgonRecognition;
    const isWaitingForVaultCosign = release?.status === BitcoinReleaseStatus.WaitingForVaultCosign;
    const isReleaseStatus =
      !!release || lock.status === BitcoinLockStatus.Releasing || lock.status === BitcoinLockStatus.Released;

    return {
      hasActiveLock: true,
      lockStatus: lock.status,
      isPendingFunding: lock.status === BitcoinLockStatus.LockPendingFunding,
      isLockReadyForUnlock: this.isLockFunded(lock) && !lock.activeReleaseId,
      hasFundingUtxos,
      fundingStatus: release?.status,
      isReleaseStatus,
      isArgonSubmitting,
      isWaitingForVaultCosign,
      isBitcoinReleaseProcessing,
      hasRequestDetails,
      hasCosign,
      hasReleaseTxid,
      isReleaseComplete,
    };
  }

  public getVaultUnlockStateDetails(vaultId: number): IBitcoinVaultUnlockStateDetails {
    const activeLocks = this.getActiveLocks().filter(lock => lock.vaultId === vaultId);
    return {
      activeLocks: activeLocks.map(lock => ({
        lock,
        fundingUtxos: this.utxoTracking.getFundingUtxos(lock),
      })),
    };
  }

  public getReleaseProcessingDetails(release: IBitcoinReleaseRecord | undefined): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    releaseError?: string;
  } {
    const expectedConfirmations = 6;
    if (!release) return { progressPct: 0, confirmations: -1, expectedConfirmations };
    if (
      release.status === BitcoinReleaseStatus.WaitingForArgonRecognition ||
      release.status === BitcoinReleaseStatus.Complete
    ) {
      return { progressPct: 100, confirmations: 6, expectedConfirmations, releaseError: release.statusError };
    }
    if (release.status !== BitcoinReleaseStatus.ConfirmingOnBitcoin || !release.bitcoinFirstSeenAt) {
      return { progressPct: 0, confirmations: -1, expectedConfirmations, releaseError: release.statusError };
    }

    const recordedOracleHeight = release.bitcoinFirstSeenOracleHeight;
    const recordedTransactionHeight = release.bitcoinFirstSeenHeight;
    const confirmationsExpected =
      recordedOracleHeight !== undefined && recordedTransactionHeight !== undefined
        ? Math.max(0, recordedTransactionHeight - recordedOracleHeight)
        : expectedConfirmations;
    const progress = new BlockProgress({
      blockHeightGoal: recordedTransactionHeight,
      blockHeightCurrent: this.oracleBitcoinBlockHeight,
      minimumConfirmations: confirmationsExpected,
      millisPerBlock: BITCOIN_BLOCK_MILLIS,
      timeOfLastBlock: dayjs.utc(release.bitcoinLastConfirmationCheckAt ?? release.bitcoinFirstSeenAt),
    });

    return {
      progressPct: progress.getProgress().progressPct,
      confirmations: progress.getConfirmations(),
      expectedConfirmations: progress.expectedConfirmations,
      releaseError: release.statusError,
    };
  }

  private async syncPendingFundingSignals(lock: IBitcoinLockRecord, apiClient?: ArgonQueryClient) {
    try {
      await this.utxoTracking.syncPendingFundingSignals(lock, apiClient);
    } catch (error) {
      console.error('Error checking UTXO status:', error);
    }
  }

  public getRequestReleaseByVaultProgress(lock: IBitcoinLockRecord, miningFrames: MiningFrames): number {
    const release = this.releases.getActiveForLock(lock);
    const startTick = release?.requestedReleaseAtTick;
    if (!startTick) return 0;
    if (release.status !== BitcoinReleaseStatus.WaitingForVaultCosign) return 100;

    const startFrame = miningFrames.getForTick(startTick);
    const dueFrame = startFrame + this.config.lockReleaseCosignDeadlineFrames;
    const startTickOfDue = miningFrames.estimateTickStart(dueFrame);
    const totalTicks = startTickOfDue + NetworkConfig.rewardTicksPerFrame - startTick;
    return getPercent(miningFrames.currentTick - startTick, totalTicks);
  }

  public isLockProcessingStatus(lockRecord: IBitcoinLockRecord): boolean {
    return (
      lockRecord.status === BitcoinLockStatus.LockIsProcessingOnArgon ||
      lockRecord.status === BitcoinLockStatus.LockPendingFunding
    );
  }

  public isLockFunded(lockRecord: Pick<IBitcoinLockRecord, 'status'>): boolean {
    return lockRecord.status === BitcoinLockStatus.LockFunded;
  }

  public isFinishedStatus(lock: Pick<IBitcoinLockRecord, 'status'>): boolean {
    return lock.status === BitcoinLockStatus.Released;
  }

  public isInactiveForVaultDisplay(lock: Pick<IBitcoinLockRecord, 'status' | 'removalReason'>): boolean {
    return this.isTerminalLock(lock);
  }

  public isTerminalLock(lock: Pick<IBitcoinLockRecord, 'status' | 'removalReason'>): boolean {
    return (
      !!lock.removalReason || this.isFinishedStatus(lock) || lock.status === BitcoinLockStatus.LockFailedAcknowledged
    );
  }

  public isReleaseStatus(lock: Pick<IBitcoinLockRecord, 'status'>): boolean {
    return lock.status === BitcoinLockStatus.Releasing || lock.status === BitcoinLockStatus.Released;
  }

  public async acknowledgeFailed(lock: IBitcoinLockRecord): Promise<void> {
    this.ensureBitcoinActionsAvailable(lock);

    const lockTable = await this.getTable();
    await lockTable.setLockFailedAcknowledged(lock);
    this.publishFinancialRevision();
  }

  public async getTable(): Promise<BitcoinLocksTable> {
    const db = await this.dbPromise;
    return db.bitcoinLocksTable;
  }

  public async updateCurrentLock(
    lock: IBitcoinLockRecord,
    currentLock: IBitcoinLock,
    txInfo: TransactionInfo,
  ): Promise<void> {
    const { block, extrinsicIndex } = await this.getFinalizedTransactionLocation(txInfo);
    const updated = { ...lock };
    const db = await this.dbPromise;
    await db.transaction(async transaction => {
      await transaction.bitcoinLocksTable.updateFromCurrentLock(updated, currentLock);
      await recordFinalizedSecuritization(transaction.bitcoinSecuritizationHistoryTable, {
        block,
        extrinsicIndex,
        lock: currentLock,
        origin: 'resecuritized',
      });
    });
    Object.assign(lock, updated);
    this.publishFinancialRevision();
  }

  public async runInQueueForLock<T>(
    lockRecord: Pick<IBitcoinLockRecord, 'uuid'> & Partial<Pick<IBitcoinLockRecord, 'status' | 'removalReason'>>,
    task: () => Promise<T>,
    options: { allowOrphanRecovery?: boolean; waitForHistoryRecovery?: boolean; skipActionAvailability?: boolean } = {},
  ): Promise<T> {
    if (options.waitForHistoryRecovery) {
      const historyRecovery = this.waitForHistoryRecovery(lockRecord);
      if (historyRecovery) {
        await historyRecovery;
        return await this.runInQueueForLock(lockRecord, task, options);
      }
    }

    const { uuid } = lockRecord;
    this.#txQueueByUuid[uuid] ??= new SingleFileQueue();
    return this.#txQueueByUuid[uuid].add(async () => {
      if (!options.waitForHistoryRecovery && !options.skipActionAvailability) {
        this.ensureBitcoinActionsAvailable(lockRecord, { allowOrphanRecovery: options.allowOrphanRecovery });
      }
      return await task();
    }).promise;
  }

  private async getFinalizedTransactionLocation(txInfo: TransactionInfo): Promise<{
    block: IBlockHeaderInfo;
    extrinsicIndex: number;
  }> {
    const blockNumber = txInfo.tx.blockHeight ?? txInfo.txResult.blockNumber;
    const blockHash = txInfo.tx.blockHash;
    const extrinsicIndex = txInfo.tx.blockExtrinsicIndex ?? txInfo.txResult.extrinsicIndex;
    if (blockNumber === undefined || !blockHash || extrinsicIndex === undefined) {
      throw new Error(`Finalized transaction #${txInfo.tx.id} is missing its Bitcoin Lock history location`);
    }

    const block = await this.blockWatch.getHeader(blockNumber);
    if (block.blockHash.toLowerCase() !== blockHash.toLowerCase()) {
      throw new Error(`Finalized transaction #${txInfo.tx.id} does not match block ${blockNumber}`);
    }
    return { block, extrinsicIndex };
  }

  private async checkIncomingArgonBlocks(headers: IBlockHeaderInfo[]): Promise<void> {
    const headersByNumber = new Map<number, IBlockHeaderInfo>();
    for (const header of [...this.#pendingArgonBlocks, ...headers]) {
      headersByNumber.set(header.blockNumber, header);
    }
    const pending = [...headersByNumber.values()].sort((left, right) => left.blockNumber - right.blockNumber);
    this.#pendingArgonBlocks = [];

    for (let index = 0; index < pending.length; index += 1) {
      if (await this.checkIncomingArgonBlock(pending[index])) continue;
      this.#pendingArgonBlocks = pending.slice(index);
      return;
    }
  }

  private async checkIncomingArgonBlock(header: IBlockHeaderInfo): Promise<boolean> {
    try {
      await this.releases.recoverPendingOrphanCosignEvents(header.blockNumber);
      if (header.blockNumber <= (this.data.latestArgonBlock?.blockNumber ?? 0)) {
        return true;
      }
      const archivedBitcoinBlockHeight = this.data.oracleBitcoinBlockHeight;

      const { api: clientAt, events } = await this.blockWatch.getEventsWithSpec(header);
      const runtimeEvents = events.flatMap(record => {
        const event = toRuntimeEvent(record.event);
        return event ? [{ event, record }] : [];
      });
      let hasBitcoinStateEvent = false;
      let hasUnscopedBitcoinStateEvent = false;
      const affectedBitcoinLockIds = new Set<number>();
      for (const { event } of runtimeEvents) {
        if (event.section !== 'bitcoinLocks' && event.section !== 'bitcoinUtxos') continue;
        hasBitcoinStateEvent = true;
        const lockId = 'lockId' in event.data ? event.data.lockId : undefined;
        if (lockId === undefined) hasUnscopedBitcoinStateEvent = true;
        else affectedBitcoinLockIds.add(lockId);
      }
      const hasFissionStateEvent = runtimeEvents.some(({ event }) => {
        return (
          event.section === 'bitcoinFissions' &&
          (event.method === 'FissionCreated' ||
            event.method === 'FissionRatcheted' ||
            event.method === 'FissionClosed' ||
            event.method === 'FissionClosedByLock')
        );
      });
      const hasFissionRefreshEvent =
        hasFissionStateEvent ||
        runtimeEvents.some(({ event }) => {
          return (
            event.section === 'bitcoinLocks' &&
            (event.method === 'BitcoinLockBurned' || event.method === 'BitcoinSpentAfterRelease')
          );
        });
      const hasBitcoinLockFlexibilityChange = runtimeEvents.some(({ event }) => {
        return (
          event.section === 'bitcoinLocks' &&
          (event.method === 'BitcoinLockBackfillChanged' || event.method === 'BitcoinLockFlexibleChanged')
        );
      });

      const bitcoinTip = await clientAt.query.bitcoinUtxos.confirmedBitcoinBlockTip();
      this.data.oracleBitcoinBlockHeight = Number(bitcoinTip?.blockHeight ?? 0n);

      const hasNewOracleBitcoinBlockHeight = archivedBitcoinBlockHeight !== this.data.oracleBitcoinBlockHeight;
      if (hasBitcoinStateEvent || hasNewOracleBitcoinBlockHeight) {
        await this.utxoTracking.syncArgonOrphans(Object.values(this.locksByLockId), clientAt).catch(error => {
          console.warn('[BitcoinLocks] Unable to sync orphaned Bitcoin from current chain state', error);
        });
      }

      const promises = Object.values(this.data.locksByLockId)
        .map(lockRecord => {
          if (this.isTerminalLock(lockRecord)) {
            return undefined;
          }
          if (lockRecord.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
            // waiting for a utxo to be found
            return undefined;
          }
          return this.runInQueueForLock(
            lockRecord,
            async () => {
              const releaseCompletionEvent = runtimeEvents.find(({ event }) => {
                if (event.section !== 'bitcoinLocks') return false;
                if (event.method === 'BitcoinSpentAfterRelease') {
                  const release = this.releases.getActiveForLock(lockRecord);
                  return event.data.lockId === lockRecord.lockId && event.data.releaseNumber === release?.releaseNumber;
                }
                if (event.method === 'BitcoinLockBurned') {
                  return event.data.lockId === lockRecord.lockId && event.data.wasUtxoSpent;
                }
                return false;
              });
              if (releaseCompletionEvent) {
                const release = this.releases.getActiveForLock(lockRecord);
                if (release) {
                  await this.releases.completeLockReleaseFromArgon(
                    lockRecord,
                    release,
                    header,
                    clientAt,
                    releaseCompletionEvent.record,
                  );
                  return;
                }
              }

              const isPendingFunding = lockRecord.status === BitcoinLockStatus.LockPendingFunding;
              const shouldSyncLockingState =
                isPendingFunding ||
                affectedBitcoinLockIds.has(lockRecord.lockId!) ||
                hasUnscopedBitcoinStateEvent ||
                (this.isLockFunded(lockRecord) &&
                  (!this.utxoTracking.getFundingUtxos(lockRecord).length ||
                    hasBitcoinLockFlexibilityChange ||
                    hasFissionStateEvent));

              // Phase 1: lock sync.
              if (shouldSyncLockingState) {
                await this.updateLockingStatus(lockRecord, clientAt).catch(err =>
                  console.warn(`[BitcoinLocks] Error updating locking status for utxo ${lockRecord.uuid}`, err),
                );
              }

              // Phase 2: funding sync.
              if (hasNewOracleBitcoinBlockHeight) {
                await this.utxoTracking.updateFundingLastConfirmationCheck(lockRecord).catch(err => {
                  console.warn(
                    `[BitcoinLocks] Error updating funding confirmation check for utxo ${lockRecord.uuid}`,
                    err,
                  );
                });
              }
              await this.syncPendingFundingSignals(lockRecord, clientAt).catch(err => {
                console.warn(`[BitcoinLocks] Error syncing funding signals for utxo ${lockRecord.uuid}`, err);
              });

              await this.releases.reconcileOrphanReleases(lockRecord).catch(err => {
                console.warn(`[BitcoinLocks] Error reconciling orphan return for utxo ${lockRecord.uuid}`, err);
              });

              // Phase 3: accepted funding release sync.
              await this.releases.reconcileLockRelease(lockRecord, hasNewOracleBitcoinBlockHeight).catch(err => {
                console.warn(`[BitcoinLocks] Error reconciling accepted release for utxo ${lockRecord.uuid}`, err);
              });
            },
            { skipActionAvailability: true },
          );
        })
        .filter(x => x !== undefined);
      if (hasNewOracleBitcoinBlockHeight) {
        await this.releases.syncOrphanBitcoinProcessing(this.data.oracleBitcoinBlockHeight).catch(err => {
          console.warn('[BitcoinLocks] Error syncing orphan return processing', err);
        });
      }
      await Promise.all(promises);
      this.data.latestArgonBlock = {
        blockNumber: header.blockNumber,
        blockHash: header.blockHash,
      };
      if (hasBitcoinStateEvent || hasFissionStateEvent || hasNewOracleBitcoinBlockHeight) {
        this.publishFinancialRevision();
      }
      if (hasFissionRefreshEvent) this.events.emit('fissions:changed', { block: header, client: clientAt, events });
      return true;
    } catch (error) {
      console.warn('[BitcoinLocks] Failed to process incoming Argon block, will retry on the next block', {
        blockNumber: header.blockNumber,
        blockHash: header.blockHash,
        error,
      });
      return false;
    }
  }

  private async tryUpdateFundingUtxos(
    lock: IBitcoinLockRecord,
    apiClient: ArgonQueryClient,
    latestBitcoinLock?: IBitcoinLock,
  ): Promise<void> {
    latestBitcoinLock ??= await BitcoinLock.get(apiClient, lock.lockId!);
    if (!latestBitcoinLock) return;

    await this.utxoTracking.syncFundingUtxos(lock, latestBitcoinLock);
  }

  private async updateLockingStatus(lock: IBitcoinLockRecord, finalizedApi: ArgonQueryClient): Promise<void> {
    const bitcoinLock = await BitcoinLock.get(finalizedApi, lock.lockId!);
    if (!bitcoinLock) {
      console.warn(`Lock with ID ${lock.lockId} not found`);
      return;
    }

    if (bitcoinLock.fundedSatoshis === 0n) return;

    await this.tryUpdateFundingUtxos(lock, finalizedApi, bitcoinLock);
  }

  public ensureBitcoinActionsAvailable(
    lock: Pick<IBitcoinLockRecord, 'uuid'> & Partial<Pick<IBitcoinLockRecord, 'status' | 'removalReason'>>,
    options: { allowOrphanRecovery?: boolean } = {},
  ): void {
    if (this.#historyRecoveryWaitersByUuid[lock.uuid] || this.isHistoryRecoveryPendingForLock(lock)) {
      throw new Error('Bitcoin history recovery is still in progress. Please wait for it to finish.');
    }
    const isSettled =
      !!lock.removalReason ||
      (lock.status != null && this.isTerminalLock({ status: lock.status, removalReason: lock.removalReason }));
    if (!options.allowOrphanRecovery && isSettled) {
      throw new Error('This Bitcoin lock is already settled.');
    }
  }

  private isHistoryRecoveryPendingForLock(
    lock: Pick<IBitcoinLockRecord, 'uuid'> & Partial<Pick<IBitcoinLockRecord, 'isHistoryRecoveryPending'>>,
  ): boolean {
    if (lock.isHistoryRecoveryPending) return true;

    const pendingLock = this.data?.pendingLocks?.find(record => record.uuid === lock.uuid);
    if (pendingLock?.isHistoryRecoveryPending) return true;

    return Object.values(this.data?.locksByLockId ?? {}).some(record => {
      return record.uuid === lock.uuid && !!record.isHistoryRecoveryPending;
    });
  }

  private waitForHistoryRecovery(lock: Pick<IBitcoinLockRecord, 'uuid'>): Promise<void> | undefined {
    const activeRecovery = this.#historyRecoveryWaitersByUuid[lock.uuid];
    if (activeRecovery) return activeRecovery.promise;
    if (!this.isHistoryRecoveryPendingForLock(lock)) return;

    this.#historyRecoveryWaitersByUuid[lock.uuid] ??= createDeferred<void>();
    return this.#historyRecoveryWaitersByUuid[lock.uuid].promise;
  }

  private resumeAfterHistoryRecovery(locks: IBitcoinLockRecord[], didPublish = true): void {
    for (const lock of locks) {
      const waiter = this.#historyRecoveryWaitersByUuid[lock.uuid];
      if (!waiter) continue;

      waiter.resolve();
      delete this.#historyRecoveryWaitersByUuid[lock.uuid];
    }
    if (!locks.length) return;

    if (didPublish) this.publishFinancialRevision();
    this.data.isReconciliationPending = true;
    void this.#blockQueue
      .add(async () => {
        try {
          const archiveClient = await getMainchainClient(true);
          await this.releases.syncOrphanCosignCounterSubscriptions(archiveClient);
        } catch (error) {
          console.warn('[BitcoinLocks] Unable to refresh orphan return counters after history recovery', error);
        }
        await this.runPendingLoadReconciliation();
      })
      .promise.catch(error =>
        console.warn('[BitcoinLocks] Unable to resume reconciliation after history recovery', error),
      );
  }

  public publishFinancialRevision(): void {
    if (this.data.readiness === 'ready') this.data.financialRevision += 1;
  }

  private readLockStatusDetails(
    lock: IBitcoinLockRecord,
    lockProcessingDetails: IBitcoinLockProcessingDetails,
  ): IBitcoinLockSummary['statusDetails'] {
    const hasObservedFundingSignal = this.hasObservedFundingSignal(lock);

    return {
      hasObservedFundingSignal,
      showReadyForBitcoin: !hasObservedFundingSignal && lockProcessingDetails.confirmations < 0,
      isFundingSeenInMempoolOnly: hasObservedFundingSignal && lockProcessingDetails.confirmations < 0,
    };
  }

  public static async getFeeRates() {
    const mempool = new BitcoinMempool(ESPLORA_HOST);
    return await mempool.getFeeRates();
  }

  public static formatP2wshAddress(scriptHex: string, network: BitcoinNetwork): string {
    try {
      return p2wshScriptHexToAddress(scriptHex, network);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid address: ${scriptHex}. Ensure it is a valid hex address. ${message}`);
    }
  }

  public static formatAddressBytes(scriptHex: string, network: BitcoinNetwork): string {
    try {
      const decoded = OutScript.decode(hexToU8a(scriptHex));
      return Address(getScureNetwork(network)).encode(decoded);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid address: ${scriptHex}. Ensure it is a valid hex address. ${message}`);
    }
  }
}
