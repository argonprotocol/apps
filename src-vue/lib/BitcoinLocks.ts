import { getMainchainClient } from '../stores/mainchain.ts';
import BigNumber from 'bignumber.js';
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
import { Db } from './Db.ts';
import {
  BitcoinLocksTable,
  BitcoinLockStatus,
  IBitcoinLockBlockExtrinsicError,
  IBitcoinLockRecord,
} from './db/BitcoinLocksTable.ts';
import type { IBitcoinUnlockReleaseState, IBitcoinVaultUnlockStateDetails } from '../interfaces/IBitcoinLocks.ts';
import BitcoinUtxoTracking from './BitcoinUtxoTracking.ts';
import BitcoinOrphanReleases from './BitcoinOrphanReleases.ts';
import BitcoinMempool from './BitcoinMempool.ts';
import { BITCOIN_BLOCK_MILLIS, ESPLORA_HOST } from './Env.ts';
import {
  type ArgonClient,
  type ArgonQueryClient,
  bigIntMax,
  bigNumberToBigInt,
  BitcoinLock,
  BlockWatch,
  createDeferred,
  Currency as CurrencyBase,
  getPercent,
  type IBitcoinLock,
  type IBitcoinLockConfig,
  type IBitcoinLockCouponUseRecord,
  IBlockHeaderInfo,
  IDeferred,
  MiningFrames,
  NetworkConfig,
  SingleFileQueue,
  type Vault,
} from '@argonprotocol/apps-core';
import { TransactionTracker } from './TransactionTracker.ts';
import { deriveBitcoinLockHdKey, WalletKeys } from './WalletKeys.ts';
import { getTransactionFailureMessage, TransactionInfo } from './TransactionInfo.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { MyVault } from './MyVault.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from './db/BitcoinUtxosTable.ts';
import type { IBitcoinLockProcessingDetails, IBitcoinLockSummary } from '../interfaces/IBitcoinLockSummary.ts';
import { BitcoinLockRecovery } from './recovery/BitcoinLocks.ts';
import { calculateBitcoinReturn, valueSatoshisAtRate } from './financials/BitcoinLocks.ts';

export type { IBitcoinUnlockReleaseState, IBitcoinVaultUnlockStateDetails };

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
  public data: {
    pendingLocks: IBitcoinLockRecord[];
    locksByUtxoId: { [utxoId: number]: IBitcoinLockRecord };
    oracleBitcoinBlockHeight: number;
    bitcoinNetwork: BitcoinNetwork;
    isLoaded: boolean;
    financialRevision: number;
    isReconciliationPending: boolean;
    latestArgonBlock?: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>;
  };

  public get bitcoinNetwork() {
    return this.data.bitcoinNetwork;
  }

  private get locksByUtxoId() {
    return this.data.locksByUtxoId;
  }

  private get oracleBitcoinBlockHeight() {
    return this.data.oracleBitcoinBlockHeight;
  }

  public get config(): IBitcoinLockConfig {
    return this.#config;
  }

  public myVault?: MyVault;
  public readonly utxoTracking: BitcoinUtxoTracking;
  public readonly recovery: BitcoinLockRecovery;
  public readonly orphanReleases: BitcoinOrphanReleases;

  #config!: IBitcoinLockConfig;

  #lockTicksPerDay!: number;
  #subscription?: () => void;
  #waitForLoad?: IDeferred;
  #currency: CurrencyBase;
  #transactionTracker: TransactionTracker;
  #blockQueue = new SingleFileQueue();
  #bitcoinKeyAllocationQueue = new SingleFileQueue();
  #txQueueByUuid: { [uuid: string]: SingleFileQueue } = {};
  #historyRecoveryWaitersByUuid: Record<string, IDeferred<void>> = {};
  #mempool: BitcoinMempool;
  #reportedMissingFundingForReleaseLocks = new Set<string>();
  #fundingExpirationEstimateByCreatedHeight = new Map<
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
      locksByUtxoId: {},
      oracleBitcoinBlockHeight: 0,
      bitcoinNetwork: BitcoinNetwork.Bitcoin,
      isLoaded: false,
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
    this.recovery = new BitcoinLockRecovery({
      walletKeys,
      blockWatch,
      currency,
      getLocksByUtxoId: () => this.data.locksByUtxoId,
      getPendingLocks: () => this.data.pendingLocks,
      utxoTracking: this.utxoTracking,
      waitForLockIdle: async (lock, alreadyOwnsQueue) => {
        this.#historyRecoveryWaitersByUuid[lock.uuid] ??= createDeferred<void>();
        if (alreadyOwnsQueue) return;

        const queue = this.#txQueueByUuid[lock.uuid];
        if (queue) await queue.add(async () => undefined).promise;
      },
      findConfirmedRecoveredRelease: async ({ lock, fundingRecord }) => {
        let txid = fundingRecord.releaseTxid;
        if (!txid) {
          if (!this.utxoTracking.canSubmitFundingRecordReleaseToBitcoin(fundingRecord)) return;
          txid = (await this.ownerCosignAndGenerateTxBytes(lock, fundingRecord)).txid;
        }

        const status = await this.#mempool.getTxStatus(txid, this.oracleBitcoinBlockHeight);
        if (!status?.isConfirmed) return;
        return { ...status, txid };
      },
      onHistoryRecoveryComplete: locks => this.resumeAfterHistoryRecovery(locks),
      insertPending: this.insertPending.bind(this),
      dbPromise,
      getTable: () => this.getTable(),
      getDerivedPubkey: (vaultId, index) => this.getDerivedPubkey(vaultId, index),
      getBitcoinNetwork: () => String(this.#config?.bitcoinNetwork ?? BitcoinNetwork[this.bitcoinNetwork]),
      trackDerivedBitcoinLockKey: (vaultId, derivedPubkey) => this.trackDerivedBitcoinLockKey(vaultId, derivedPubkey),
    });
    this.orphanReleases = new BitcoinOrphanReleases(this, blockWatch, this.#mempool, transactionTracker, walletKeys);
  }

  public getActiveLocks(): IBitcoinLockRecord[] {
    return this.getAllLocks().filter(lock => !this.isTerminalLock(lock));
  }

  public getAllLocks({
    includeHistoryRecoveryPending = false,
  }: { includeHistoryRecoveryPending?: boolean } = {}): IBitcoinLockRecord[] {
    const locks = Object.values(this.data.locksByUtxoId);
    locks.unshift(...this.data.pendingLocks);
    return locks
      .filter(lock => includeHistoryRecoveryPending || !lock.isHistoryRecoveryPending)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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

    const utxoIds = await BitcoinLock.idsByOwner(client, operatorAddress);
    const locks = await BitcoinLock.getMany(client, utxoIds);
    const eligible: IBitcoinLock[] = [];

    for (const lock of locks) {
      if (!lock) continue;
      if (lock.ownerAccount !== operatorAddress || lock.vaultId !== vaultId || lock.fundedSatoshis === 0n) continue;
      if (await BitcoinLock.getReleaseRequest(client, lock.utxoId)) continue;

      eligible.push(lock);
    }

    return eligible;
  }

  public createLockSummary(lock: IBitcoinLockRecord): IBitcoinLockSummary {
    const lockProcessingDetails = this.getLockProcessingDetails(lock);
    const satoshis = lock.fundedSatoshis || lock.securitizedSatoshis;
    const valueOfBtc = this.#currency.convertBtcToMicrogon(this.#currency.convertSatToBtc(satoshis));
    const unlockAmount = lock.releaseRedemptionMicrogons ?? lock.securitizationCoverageMicrogons ?? 0n;
    const securityFees = bigIntMax(lock.securityFees - lock.couponFeesPaid, 0n);
    const releaseBitcoinNetworkFeeValue = valueSatoshisAtRate(
      lock.fundingUtxo?.releaseBitcoinNetworkFee,
      lock.btcPriceAtRemovalMicrogons,
    );
    const hasHistoricalTransactionFees =
      lock.releaseArgonTxFeeMicrogons !== undefined || releaseBitcoinNetworkFeeValue !== undefined;
    const historicalTransactionFees = hasHistoricalTransactionFees
      ? (lock.releaseArgonTxFeeMicrogons ?? 0n) + (releaseBitcoinNetworkFeeValue ?? 0n)
      : undefined;

    return {
      uuid: lock.uuid,
      utxoId: lock.utxoId,
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
      endingCapital: valueOfBtc - unlockAmount - securityFees,
      ratchetPercent: 0,
      totalReturn: calculateBitcoinReturn(valueOfBtc, valueOfBtc - unlockAmount - securityFees),
      securityFees,
      transactionFees: 0n,
      totalFees: securityFees,
      historicalTransactionFees,
      historicalTotalFees:
        historicalTransactionFees === undefined ? undefined : securityFees + historicalTransactionFees,
      unlockAmount,
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

  public getLockByUtxoId(utxoId: number): IBitcoinLockRecord | undefined {
    const lock = this.data.locksByUtxoId[utxoId];
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

  public verifyExpirationTime(lock: Pick<IBitcoinLockRecord, 'scriptDetails' | 'fundingExpirationHeight'>) {
    if (!this.#config) {
      throw new Error('Bitcoin lock configuration is not loaded for verify time.');
    }
    const createdAtHeight = lock.scriptDetails?.createdAtHeight;
    const expirationHeight = lock.fundingExpirationHeight;
    if (createdAtHeight === undefined || expirationHeight === undefined) {
      throw new Error('Bitcoin lock funding terms are unavailable.');
    }
    const oracleBitcoinBlockHeight = this.oracleBitcoinBlockHeight;

    if (expirationHeight <= oracleBitcoinBlockHeight) {
      return Date.now() - 1; // Already expired
    }

    const previousEstimate = this.#fundingExpirationEstimateByCreatedHeight.get(createdAtHeight);
    if (previousEstimate?.oracleBitcoinBlockHeight === oracleBitcoinBlockHeight) {
      return previousEstimate.expirationTime;
    }

    const expirationTime = Date.now() + (expirationHeight - oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS;
    this.#fundingExpirationEstimateByCreatedHeight.set(createdAtHeight, {
      oracleBitcoinBlockHeight,
      expirationTime,
    });
    return expirationTime;
  }

  public getFundingWindowProgress(lock: Pick<IBitcoinLockRecord, 'scriptDetails' | 'fundingExpirationHeight'>): number {
    try {
      const expTime = this.verifyExpirationTime(lock);
      if (expTime <= Date.now()) return 100;

      const created = lock.scriptDetails?.createdAtHeight ?? 0;
      const current = this.data.oracleBitcoinBlockHeight;
      const windowBlocks = this.config?.pendingConfirmationExpirationBlocks;
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

  public isFundingWindowExpired(lock: IBitcoinLockRecord): boolean {
    try {
      return this.verifyExpirationTime(lock) <= Date.now();
    } catch {
      return false;
    }
  }

  public confirmAddress(lock: IBitcoinLockRecord) {
    const cosignScript = this.createCosignScript({ lock, fundedSatoshis: lock.fundedSatoshis });
    const pubkey = cosignScript.calculateScriptPubkey();
    if (lock.scriptDetails?.p2wshScriptHashHex !== pubkey) {
      throw new Error(`Lock with ID ${lock.utxoId} has an invalid address.`);
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
    try {
      const archiveClient = await getMainchainClient(true);
      this.#config ??= await BitcoinLock.getConfig(archiveClient);
      this.#lockTicksPerDay = archiveClient.consts.bitcoinLocks.argonTicksPerDay.toNumber();
      const bitcoinNetwork = this.#config.bitcoinNetwork.type;
      if (bitcoinNetwork === 'Bitcoin') this.data.bitcoinNetwork = BitcoinNetwork.Bitcoin;
      else if (bitcoinNetwork === 'Testnet') this.data.bitcoinNetwork = BitcoinNetwork.Testnet;
      else if (bitcoinNetwork === 'Signet') this.data.bitcoinNetwork = BitcoinNetwork.Signet;
      else this.data.bitcoinNetwork = BitcoinNetwork.Regtest;

      const table = await this.getTable();
      const locks = await table.fetchAll();
      for (const lock of locks) {
        if (lock.utxoId) {
          this.locksByUtxoId[lock.utxoId] = lock;
        } else {
          const existingIndex = this.data.pendingLocks.findIndex(x => x.uuid === lock.uuid);
          if (existingIndex >= 0) {
            this.data.pendingLocks.splice(existingIndex, 1, lock);
          } else {
            this.data.pendingLocks.push(lock);
          }
        }
      }
      await this.utxoTracking.load();
      for (const lock of Object.values(this.locksByUtxoId)) {
        this.utxoTracking.getAcceptedFundingRecordForLock(lock);
      }

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
          if (index >= 0) this.data.pendingLocks.splice(index, 1, retiredLock);
        }
      }

      await this.utxoTracking.syncArgonOrphans(Object.values(this.locksByUtxoId), archiveClient).catch(error => {
        console.warn(`[BitcoinLocks] Unable to restore orphaned Bitcoin`, error);
      });
      for (const lock of Object.values(this.locksByUtxoId)) {
        if (!this.isTerminalLock(lock)) {
          await this.checkForMissingBitcoinLockState(lock).catch(error => {
            console.warn(`[BitcoinLocks] Unable to reconcile lock ${lock.uuid} during startup`, error);
          });
        }
      }

      await this.migrateLegacyBitcoinLockHdKeys();
      await this.orphanReleases.syncCosignCounterSubscriptions(archiveClient).catch(error => {
        console.warn('[BitcoinLocks] Unable to watch orphan return counters', error);
      });
      this.data.isReconciliationPending = true;
      const initialBestBlock = this.blockWatch.bestBlockHeader;
      void this.#blockQueue
        .add(async () => {
          await this.checkIncomingArgonBlock(initialBestBlock);
          await this.runPendingLoadReconciliation();
        })
        .promise.catch(error => {
          console.warn(
            '[BitcoinLocks] Initial Argon block sync did not finish during load; continuing in the background',
            {
              blockNumber: initialBestBlock.blockNumber,
              blockHash: initialBestBlock.blockHash,
              error,
            },
          );
        });
      this.#subscription?.();
      this.#subscription = this.blockWatch.events.on('best-blocks', async headers => {
        void this.#blockQueue.add(async () => {
          await this.checkIncomingArgonBlock(headers.at(-1)!);
          await this.runPendingLoadReconciliation();
        });
      });
      this.data.isLoaded = true;
      this.data.financialRevision += 1;
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('Error loading BitcoinLocks:', error);
      this.#waitForLoad.reject(error);
    }
    return this.#waitForLoad.promise;
  }

  private async runPendingLoadReconciliation(): Promise<void> {
    if (!this.data.isReconciliationPending) {
      return;
    }

    try {
      for (const lock of Object.values(this.locksByUtxoId)) {
        if (this.isHistoryRecoveryPendingForLock(lock)) continue;
        if (this.isTerminalLock(lock)) {
          await this.runInQueueForUtxo(lock, () => this.orphanReleases.reconcileOrphanReturns(lock), {
            waitForHistoryRecovery: true,
          });
          continue;
        }

        await this.runInQueueForUtxo(
          lock,
          async () => {
            await this.orphanReleases.reconcileOrphanReturns(lock);
            await this.reconcileAcceptedFundingReleaseOnBlock(lock, false);
          },
          { waitForHistoryRecovery: true },
        );
      }
      await this.syncLockReleaseBitcoinProcessing(this.locksByUtxoId);
      await this.orphanReleases.syncBitcoinProcessing(this.oracleBitcoinBlockHeight);
      this.data.isReconciliationPending = false;
    } catch (error) {
      console.warn('[BitcoinLocks] Startup reconciliation did not finish; will retry on the next block', error);
    }
  }

  private async checkForMissingBitcoinLockState(lock: IBitcoinLockRecord): Promise<void> {
    if (this.isHistoryRecoveryPendingForLock(lock) || this.isTerminalLock(lock) || !lock.utxoId) {
      return;
    }
    if (!lock.fundingUtxo) {
      this.utxoTracking.getAcceptedFundingRecordForLock(lock);
    }
    const archiveClient = await getMainchainClient(true);
    const bitcoinLock = await BitcoinLock.get(archiveClient, lock.utxoId);
    if (bitcoinLock) {
      await this.tryUpdateFundingUtxo(lock, archiveClient, bitcoinLock);
      await this.syncLockReleaseArgonRequest(lock, archiveClient);
    } else {
      await this.syncLockReleaseArgonCosign(lock, archiveClient);
      const fundingRecord = this.getAcceptedFundingRecord(lock);
      if (fundingRecord) {
        await this.syncLockReleaseStatusFromFundingRecord(lock, fundingRecord);
      }
    }
  }

  public unsubscribeFromArgonBlocks() {
    this.#subscription?.();
    this.#subscription = undefined;
  }

  public async shutdown() {
    this.unsubscribeFromArgonBlocks();
    this.orphanReleases.shutdown();
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
    return await table.insertPending({
      uuid: details.uuid,
      securitizedSatoshis: details.securitizedSatoshis,
      vaultId: details.vaultId,
      hdPath: details.hdPath,
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      cosignVersion: 'v1',
      network: String(this.#config.bitcoinNetwork),
    });
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

  public async finalizeCreatedLock(uuid: string, lock: IBitcoinLock): Promise<IBitcoinLockRecord> {
    if (lock.ownerAccount === this.walletKeys.defaultArgonAddress) {
      lock.couponFeesPaid = bigIntMax(lock.couponFeesPaid, lock.securityFees);
    }
    return await this.finalizePendingRecord({ uuid }, lock);
  }

  public async failPendingLock(uuid: string, error: unknown): Promise<void> {
    await this.runInQueueForUtxo(
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
        if (pendingIndex >= 0) this.data.pendingLocks.splice(pendingIndex, 1, failedRecord);
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
  ): Promise<bigint> {
    const cosignScript = this.createCosignScript({ lock, fundedSatoshis: lock.fundedSatoshis });
    toScriptPubkey = addressBytesHex(toScriptPubkey, this.bitcoinNetwork);
    console.log('Calculating fee for lock', {
      utxoId: lock.utxoId,
      feeRatePerSatVb: feeRatePerSatVb.toString(),
      toScriptPubkey,
    });
    return cosignScript.calculateFee(feeRatePerSatVb, toScriptPubkey);
  }

  private async ownerCosignAndSendToBitcoin(lock: IBitcoinLockRecord): Promise<void> {
    if (this.isHistoryRecoveryPendingForLock(lock) || this.isTerminalLock(lock)) return;

    const fundingRecord = await this.getFundingRecordOrThrow(lock);
    if (!this.utxoTracking.canSubmitFundingRecordReleaseToBitcoin(fundingRecord)) return;

    try {
      await this.utxoTracking.clearStatusError(fundingRecord);
      const { bytes, txid } = await this.ownerCosignAndGenerateTxBytes(lock, fundingRecord);
      const existingTxStatus = await this.#mempool.getTxStatus(txid, this.oracleBitcoinBlockHeight);
      if (existingTxStatus?.isConfirmed) {
        await this.utxoTracking.setReleaseSeenOnBitcoin(fundingRecord, txid, existingTxStatus.transactionBlockHeight);
        return;
      }

      const releasedTxid = await this.#mempool.broadcastTx(u8aToHex(bytes, undefined, false));
      const tip = await this.#mempool.getTipHeight();
      await this.utxoTracking.setReleaseSeenOnBitcoin(fundingRecord, releasedTxid, tip);
    } catch (error) {
      await this.utxoTracking.setStatusError(fundingRecord, String(error));
      throw error;
    }
  }

  private async ownerCosignAndGenerateTxBytes(
    lock: IBitcoinLockRecord,
    fundingRecord: IBitcoinUtxoRecord,
    addTx?: string,
  ): Promise<{ txid: string; bytes: Uint8Array }> {
    if (lock.cosignVersion !== 'v1') {
      throw new Error(`Unsupported cosign version: ${lock.cosignVersion}`);
    }

    if (!fundingRecord.releaseCosignVaultSignature) {
      throw new Error(`Lock with ID ${lock.utxoId} has not been cosigned yet.`);
    }
    if (fundingRecord.releaseCosignHeight == null) {
      throw new Error(`Lock with ID ${lock.utxoId} does not have an Argon cosign block height yet.`);
    }
    if (!fundingRecord.releaseToDestinationAddress || fundingRecord.releaseBitcoinNetworkFee == null) {
      throw new Error(`Lock with ID ${lock.utxoId} has no release request details yet.`);
    }

    const cosign = this.createCosignScript({ lock, fundedSatoshis: fundingRecord.satoshis });
    const tx = cosign.cosignAndGenerateTx({
      releaseRequest: {
        toScriptPubkey: fundingRecord.releaseToDestinationAddress,
        bitcoinNetworkFee: fundingRecord.releaseBitcoinNetworkFee,
      },
      vaultCosignature: fundingRecord.releaseCosignVaultSignature,
      utxoRef: { txid: fundingRecord.txid, vout: fundingRecord.vout },
      utxoSatoshis: fundingRecord.satoshis,
      ownerXpriv: await this.walletKeys.getBitcoinChildXpriv(lock.hdPath, this.bitcoinNetwork),
      addTx,
    });
    if (!tx || !tx.isFinal) {
      throw new Error(`Failed to build finalized release transaction for lock ${lock.utxoId}`);
    }
    return { bytes: tx.toBytes(true, true), txid: tx.id };
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
      hasFundingRecord: false,
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

    const fundingRecord = this.getAcceptedFundingRecord(lock) ?? lock.fundingUtxo;
    const fundingStatus = fundingRecord?.status;
    const hasFundingRecord = !!(fundingRecord && fundingRecord.txid);
    const hasRequestDetails =
      !!fundingRecord?.releaseToDestinationAddress && fundingRecord.releaseBitcoinNetworkFee != null;
    const hasCosign = !!fundingRecord?.releaseCosignVaultSignature;
    const hasReleaseTxid = !!fundingRecord?.releaseTxid;
    const isArgonSubmitting = fundingStatus === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon;
    const isReleaseComplete =
      fundingStatus === BitcoinUtxoStatus.ReleaseComplete || lock.status === BitcoinLockStatus.Released;
    const isBitcoinReleaseProcessing = fundingStatus === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;
    const isWaitingForVaultCosign =
      hasRequestDetails && !hasCosign && !isBitcoinReleaseProcessing && !isReleaseComplete;
    const isReleaseStatus =
      lock.status === BitcoinLockStatus.Releasing ||
      lock.status === BitcoinLockStatus.Released ||
      (fundingStatus != null &&
        [
          BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
          BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
          BitcoinUtxoStatus.ReleaseComplete,
        ].includes(fundingStatus));

    return {
      hasActiveLock: true,
      lockStatus: lock.status,
      isPendingFunding: lock.status === BitcoinLockStatus.LockPendingFunding,
      isLockReadyForUnlock: this.isLockFunded(lock),
      hasFundingRecord,
      fundingStatus,
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
      activeLocks: activeLocks.map(lock => {
        const fundingRecord = this.getAcceptedFundingRecord(lock) ?? lock.fundingUtxo;

        return {
          lock,
          fundingRecord,
        };
      }),
    };
  }

  public getAcceptedFundingRecord(lock: IBitcoinLockRecord): IBitcoinUtxoRecord | undefined {
    return this.utxoTracking.getAcceptedFundingRecordForLock(lock);
  }

  public getReleaseProcessingDetails(lock: IBitcoinLockRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    releaseError?: string;
  } {
    return this.utxoTracking.getLockReleaseProcessingDetails(lock);
  }

  private async syncPendingFundingSignals(lock: IBitcoinLockRecord, apiClient?: ArgonQueryClient) {
    try {
      await this.utxoTracking.syncPendingFundingSignals(lock, apiClient);
    } catch (error) {
      console.error('Error checking UTXO status:', error);
    }
  }

  public getRequestReleaseByVaultProgress(lock: IBitcoinLockRecord, miningFrames: MiningFrames): number {
    return this.utxoTracking.getRequestReleaseByVaultProgress(
      lock,
      miningFrames,
      this.config.lockReleaseCosignDeadlineFrames,
    );
  }

  public isLockProcessingStatus(lockRecord: IBitcoinLockRecord): boolean {
    return (
      lockRecord.status === BitcoinLockStatus.LockIsProcessingOnArgon ||
      this.isFundingSignalTrackingStatus(lockRecord.status)
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

  public async publishReleaseSubmission(lock: IBitcoinLockRecord): Promise<void> {
    await this.runInQueueForUtxo(lock, () => this.ensureLockReleaseProcessing(lock), {
      waitForHistoryRecovery: true,
    });
    this.publishFinancialRevision();
  }

  public async failReleaseSubmission(lock: IBitcoinLockRecord): Promise<void> {
    await this.runInQueueForUtxo(
      lock,
      async () => {
        if (this.isTerminalLock(lock) || lock.status !== BitcoinLockStatus.Releasing) return;

        const fundingRecord = this.getAcceptedFundingRecord(lock);
        if (fundingRecord && this.utxoTracking.isReleaseStatus(fundingRecord.status)) return;

        const lockTable = await this.getTable();
        await lockTable.setStatus(lock, BitcoinLockStatus.LockFunded);
      },
      { waitForHistoryRecovery: true },
    );
    this.publishFinancialRevision();
  }

  public async finalizeReleaseRequest(
    lock: IBitcoinLockRecord,
    blockHash: Uint8Array,
    releaseArgonTxFeeMicrogons: bigint,
  ): Promise<void> {
    await this.runInQueueForUtxo(
      lock,
      async () => {
        if (this.isTerminalLock(lock)) return;

        const client = await getMainchainClient(true);
        const api = await client.at(blockHash);
        const releaseRequest = await BitcoinLock.getReleaseRequest(api, lock.utxoId!);
        if (!releaseRequest) {
          console.warn(`[BitcoinLocks] Missing canonical release request for ${lock.uuid} after finalization`);
          return;
        }
        const currentTick = await api.query.ticks.currentTick();
        if (currentTick === null) return;
        const fundingRecord = await this.getFundingRecordOrThrow(lock);
        const table = await this.getTable();
        await table.recordReleaseRequest(lock, {
          releaseRedemptionMicrogons: releaseRequest.redemptionAmount,
          releaseArgonTxFeeMicrogons,
        });
        await this.utxoTracking.setReleaseRequest(fundingRecord, {
          requestedReleaseAtTick: Number(currentTick),
          releaseToDestinationAddress: releaseRequest.toScriptPubkey,
          releaseBitcoinNetworkFee: releaseRequest.bitcoinNetworkFee,
        });
        await this.ensureLockReleaseProcessing(lock);
      },
      { waitForHistoryRecovery: true },
    );
    this.publishFinancialRevision();
  }

  private async syncLockReleaseArgonRequest(lock: IBitcoinLockRecord, apiClient: ArgonQueryClient): Promise<void> {
    const fundingRecord = this.getAcceptedFundingRecord(lock);
    if (!fundingRecord) return;

    const releaseRequest = await BitcoinLock.getReleaseRequest(apiClient, lock.utxoId!);
    if (!releaseRequest) {
      await this.syncLockReleaseStatusFromFundingRecord(lock, fundingRecord);
      return;
    }

    const currentTick = await apiClient.query.ticks.currentTick();
    if (currentTick === null) return;
    const requestedReleaseAtTick = Number(currentTick);
    const releaseToDestinationAddress = releaseRequest.toScriptPubkey;
    const releaseBitcoinNetworkFee = releaseRequest.bitcoinNetworkFee;
    const needsRepair =
      fundingRecord.requestedReleaseAtTick !== requestedReleaseAtTick ||
      fundingRecord.releaseToDestinationAddress !== releaseToDestinationAddress ||
      fundingRecord.releaseBitcoinNetworkFee !== releaseBitcoinNetworkFee;
    if (needsRepair) {
      await this.utxoTracking.setReleaseRequest(fundingRecord, {
        requestedReleaseAtTick,
        releaseToDestinationAddress,
        releaseBitcoinNetworkFee,
      });
    }

    await this.ensureLockReleaseProcessing(lock);
  }

  private async syncLockReleaseArgonCosign(lock: IBitcoinLockRecord, archiveClient: ArgonClient): Promise<void> {
    const fundingRecord = this.getAcceptedFundingRecord(lock);
    if (!fundingRecord) return;

    if (!fundingRecord.releaseToDestinationAddress || fundingRecord.releaseBitcoinNetworkFee == null) {
      await this.syncLockReleaseArgonRequest(lock, archiveClient);
    }

    const latestFundingRecord = this.getAcceptedFundingRecord(lock);
    if (!latestFundingRecord) return;

    const releaseCosignOnChain = await this.getReleaseCosignOnChain(lock, archiveClient);
    if (releaseCosignOnChain) {
      await this.utxoTracking.setReleaseCosign(latestFundingRecord, {
        releaseCosignVaultSignature: releaseCosignOnChain.signature,
        releaseCosignHeight: releaseCosignOnChain.blockHeight,
      });
      await this.ensureLockReleaseProcessing(lock);
      return;
    }

    const vault = this.myVault;
    if (lock.vaultId !== vault?.vaultId) return;
    if (!latestFundingRecord.releaseToDestinationAddress || latestFundingRecord.releaseBitcoinNetworkFee == null)
      return;

    const result = await vault.cosignMyLock(lock);
    if (!result?.txInfo) return;
    const txFailure = getTransactionFailureMessage(result.txInfo);
    if (txFailure) {
      throw new Error(txFailure);
    }

    if (result.txInfo.txResult.blockNumber == null) {
      void this.continueLockReleaseAfterArgonInclusion(lock, result.vaultSignature, result.txInfo);
      return;
    }

    await this.utxoTracking.setReleaseCosign(latestFundingRecord, {
      releaseCosignVaultSignature: result.vaultSignature,
      releaseCosignHeight: result.txInfo.txResult.blockNumber,
    });
    await this.ensureLockReleaseProcessing(lock);
  }

  private async continueLockReleaseAfterArgonInclusion(
    lock: IBitcoinLockRecord,
    vaultSignature: Uint8Array,
    txInfo: TransactionInfo,
  ): Promise<void> {
    try {
      await txInfo.txResult.waitForInFirstBlock;
      await this.waitForHistoryRecovery(lock);
      if (this.isTerminalLock(lock)) return;

      const txFailure = getTransactionFailureMessage(txInfo);
      if (txFailure || txInfo.txResult.blockNumber == null) return;

      const fundingRecord = this.getAcceptedFundingRecord(lock);
      if (!fundingRecord) return;

      await this.utxoTracking.setReleaseCosign(fundingRecord, {
        releaseCosignVaultSignature: vaultSignature,
        releaseCosignHeight: txInfo.txResult.blockNumber,
      });
      await this.ensureLockReleaseProcessing(lock);
    } catch (error) {
      console.warn(`[BitcoinLocks] Error continuing release after Argon inclusion for ${lock.uuid}`, error);
    }
  }

  private async syncLockReleaseBitcoinProcessing(locksByUtxoId: {
    [utxoId: number]: IBitcoinLockRecord;
  }): Promise<void> {
    const lockTable = await this.getTable();
    for (const lock of Object.values(locksByUtxoId)) {
      if (!lock.utxoId) continue;
      if (this.isHistoryRecoveryPendingForLock(lock) || this.isTerminalLock(lock)) continue;
      const fundingRecord = this.getAcceptedFundingRecord(lock);
      if (!fundingRecord) {
        this.reportMissingFundingRecordForReleasingLock(lock);
        continue;
      }
      if (!this.utxoTracking.isReleaseStatus(fundingRecord.status)) continue;
      if (this.utxoTracking.isReleaseCompleteStatus(fundingRecord.status)) {
        await lockTable.setReleased(lock);
        continue;
      }
      await lockTable.setStatus(lock, BitcoinLockStatus.Releasing);
    }
  }

  private async syncLockReleaseBitcoinComplete(lock: IBitcoinLockRecord): Promise<boolean> {
    const fundingRecord = this.getAcceptedFundingRecord(lock);
    if (!fundingRecord?.releaseTxid) return false;

    const mempoolStatus = await this.#mempool.getTxStatus(fundingRecord.releaseTxid, this.oracleBitcoinBlockHeight);
    if (!mempoolStatus?.isConfirmed) return false;

    await this.utxoTracking.setReleaseComplete(fundingRecord, mempoolStatus.transactionBlockHeight);
    const lockTable = await this.getTable();
    await lockTable.setReleased(lock);
    return true;
  }

  private async reconcileAcceptedFundingReleaseOnBlock(
    lock: IBitcoinLockRecord,
    hasNewOracleBitcoinBlockHeight: boolean,
  ): Promise<void> {
    if (this.isHistoryRecoveryPendingForLock(lock) || this.isTerminalLock(lock)) return;

    let fundingRecord = this.getAcceptedFundingRecord(lock);
    if (!fundingRecord) {
      this.reportMissingFundingRecordForReleasingLock(lock);
      return;
    }

    const getReleaseState = (record: IBitcoinUtxoRecord) => ({
      isReleaseStatus: this.utxoTracking.isReleaseStatus(record.status),
      isComplete: this.utxoTracking.isReleaseCompleteStatus(record.status),
      isProcessingOnBitcoin: this.utxoTracking.isFundingRecordReleaseProcessingOnBitcoin(record),
      hasRequestDetails: this.utxoTracking.hasFundingRecordReleaseRequestDetails(record),
      hasCosign: !!record.releaseCosignVaultSignature && record.releaseCosignHeight != null,
      hasTxid: !!record.releaseTxid,
    });
    const refreshFundingRecord = () => {
      const latestFundingRecord = this.getAcceptedFundingRecord(lock);
      if (!latestFundingRecord) return undefined;
      fundingRecord = latestFundingRecord;
      return getReleaseState(latestFundingRecord);
    };

    await this.syncLockReleaseStatusFromFundingRecord(lock, fundingRecord);
    let releaseState = getReleaseState(fundingRecord);
    if (!releaseState.isReleaseStatus || releaseState.isComplete) return;

    let archiveClient: ArgonClient | undefined;
    const getArchiveClient = async (): Promise<ArgonClient> => {
      archiveClient ??= await getMainchainClient(true);
      return archiveClient;
    };

    if (
      releaseState.isReleaseStatus &&
      !releaseState.isComplete &&
      !releaseState.isProcessingOnBitcoin &&
      !releaseState.hasRequestDetails
    ) {
      await this.syncLockReleaseArgonRequest(lock, await getArchiveClient()).catch(err => {
        console.warn(`[BitcoinLocks] Error syncing release request for ${lock.uuid}`, err);
      });
      releaseState = refreshFundingRecord() ?? releaseState;
    }

    if (
      releaseState.isReleaseStatus &&
      !releaseState.isComplete &&
      !releaseState.isProcessingOnBitcoin &&
      releaseState.hasRequestDetails &&
      !releaseState.hasCosign
    ) {
      await this.syncLockReleaseArgonCosign(lock, await getArchiveClient()).catch(err => {
        console.warn(`[BitcoinLocks] Error syncing release cosign for ${lock.uuid}`, err);
      });
      releaseState = refreshFundingRecord() ?? releaseState;
    }

    if (
      releaseState.isReleaseStatus &&
      !releaseState.isComplete &&
      !!fundingRecord &&
      this.utxoTracking.canSubmitFundingRecordReleaseToBitcoin(fundingRecord)
    ) {
      await this.ownerCosignAndSendToBitcoin(lock).catch(err => {
        console.warn(`[BitcoinLocks] Error submitting release to bitcoin for ${lock.uuid}`, err);
      });
      releaseState = refreshFundingRecord() ?? releaseState;
    }

    if (
      releaseState.isReleaseStatus &&
      !releaseState.isComplete &&
      releaseState.isProcessingOnBitcoin &&
      releaseState.hasTxid
    ) {
      if (hasNewOracleBitcoinBlockHeight) {
        await this.utxoTracking.updateReleaseLastConfirmationCheck(fundingRecord).catch(err => {
          console.warn(`[BitcoinLocks] Error updating release confirmation check for ${lock.uuid}`, err);
        });
      }

      try {
        const wasCompleted = await this.syncLockReleaseBitcoinComplete(lock);
        if (wasCompleted) {
          const latestFundingRecord = this.getAcceptedFundingRecord(lock);
          if (latestFundingRecord) {
            await this.utxoTracking.clearStatusError(latestFundingRecord);
          }
        }
      } catch (error) {
        const latestFundingRecord = this.getAcceptedFundingRecord(lock);
        if (latestFundingRecord) {
          await this.utxoTracking.setStatusError(latestFundingRecord, String(error));
        }
        console.warn(`[BitcoinLocks] Error syncing release completion for ${lock.uuid}`, error);
      }
    }

    const latestFundingRecord = this.getAcceptedFundingRecord(lock);
    if (latestFundingRecord) {
      await this.syncLockReleaseStatusFromFundingRecord(lock, latestFundingRecord);
    }
  }

  private reportMissingFundingRecordForReleasingLock(lock: IBitcoinLockRecord): void {
    if (lock.status !== BitcoinLockStatus.Releasing) return;
    if (this.#reportedMissingFundingForReleaseLocks.has(lock.uuid)) return;
    this.#reportedMissingFundingForReleaseLocks.add(lock.uuid);
    console.error(
      `[BitcoinLocks] Lock ${lock.uuid} is marked Releasing but has no funding UTXO record. This lock cannot progress until a funding record is recovered.`,
      { utxoId: lock.utxoId },
    );
  }

  public async syncLockReleaseStatusFromFundingRecord(
    lock: IBitcoinLockRecord,
    fundingRecord?: IBitcoinUtxoRecord,
  ): Promise<void> {
    if (this.isHistoryRecoveryPendingForLock(lock) || this.isTerminalLock(lock)) return;

    const record = fundingRecord ?? this.getAcceptedFundingRecord(lock);
    if (!record) return;

    let nextStatus: BitcoinLockStatus | undefined;
    if (this.utxoTracking.isReleaseCompleteStatus(record.status)) {
      nextStatus = BitcoinLockStatus.Released;
    } else if (this.utxoTracking.isReleaseStatus(record.status)) {
      nextStatus = BitcoinLockStatus.Releasing;
    }
    if (!nextStatus) return;

    if (lock.status === nextStatus) return;
    const lockTable = await this.getTable();
    await lockTable.setStatus(lock, nextStatus);
  }

  public async runInQueueForUtxo<T>(
    lockRecord: Pick<IBitcoinLockRecord, 'uuid'> & Partial<Pick<IBitcoinLockRecord, 'status' | 'removalReason'>>,
    task: () => Promise<T>,
    options: { allowOrphanRecovery?: boolean; waitForHistoryRecovery?: boolean } = {},
  ): Promise<T> {
    if (options.waitForHistoryRecovery) {
      const historyRecovery = this.waitForHistoryRecovery(lockRecord);
      if (historyRecovery) {
        await historyRecovery;
        return await this.runInQueueForUtxo(lockRecord, task, options);
      }
    }

    const { uuid } = lockRecord;
    this.#txQueueByUuid[uuid] ??= new SingleFileQueue();
    return this.#txQueueByUuid[uuid].add(async () => {
      if (!options.waitForHistoryRecovery) {
        this.ensureBitcoinActionsAvailable(lockRecord, { allowOrphanRecovery: options.allowOrphanRecovery });
      }
      return await task();
    }).promise;
  }

  private async finalizePendingRecord(
    pendingLock: Pick<IBitcoinLockRecord, 'uuid'>,
    lock: IBitcoinLock,
  ): Promise<IBitcoinLockRecord> {
    return await this.runInQueueForUtxo(
      pendingLock,
      async () => {
        const table = await this.getTable();
        const record = await table.finalizePending({ uuid: pendingLock.uuid, lock });
        this.locksByUtxoId[record.utxoId!] = record;
        const pendingIdx = this.data.pendingLocks.findIndex(lock => lock.uuid === pendingLock.uuid);
        if (pendingIdx >= 0) {
          this.data.pendingLocks.splice(pendingIdx, 1);
        }
        this.publishFinancialRevision();
        return record;
      },
      { waitForHistoryRecovery: true },
    );
  }

  private async checkIncomingArgonBlock(
    newestHeader: Pick<IBlockHeaderInfo, 'blockHash' | 'blockNumber'>,
  ): Promise<void> {
    if (newestHeader.blockNumber === 0) {
      return;
    }

    try {
      // Keep the original one-block settling lag, but resolve the header by block number so we do not
      // get stuck retrying a transient best-head hash that the pruned node has already discarded.
      const header = await this.blockWatch.getHeaderByBlockNumber(newestHeader.blockNumber - 1);

      await this.orphanReleases.recoverPendingCosignEvents(header.blockNumber);
      if (header.blockNumber <= (this.data.latestArgonBlock?.blockNumber ?? 0)) {
        return;
      }
      const archivedBitcoinBlockHeight = this.data.oracleBitcoinBlockHeight;

      const { api: clientAt, events } = await this.blockWatch.getEventsWithSpec(header);
      const hasBitcoinStateEvent = events.some(({ event }) => {
        return event.section === 'bitcoinLocks' || event.section === 'bitcoinUtxos';
      });
      const hasBitcoinLockFlexibilityChange = events.some(({ event }) => {
        return (
          event.section === 'bitcoinLocks' &&
          (event.method === 'BitcoinLockBackfillChanged' || event.method === 'BitcoinLockFlexibleChanged')
        );
      });

      const bitcoinTip = await clientAt.query.bitcoinUtxos.confirmedBitcoinBlockTip();
      this.data.oracleBitcoinBlockHeight = Number(bitcoinTip?.blockHeight ?? 0n);

      const hasNewOracleBitcoinBlockHeight = archivedBitcoinBlockHeight !== this.data.oracleBitcoinBlockHeight;
      if (hasNewOracleBitcoinBlockHeight) {
        await this.utxoTracking.syncArgonOrphans(Object.values(this.locksByUtxoId), clientAt).catch(error => {
          console.warn('[BitcoinLocks] Unable to sync orphaned Bitcoin from current chain state', error);
        });
      }

      const queueOptions = { waitForHistoryRecovery: true };
      const promises = Object.values(this.data.locksByUtxoId)
        .map(lockRecord => {
          if (this.isHistoryRecoveryPendingForLock(lockRecord)) {
            return undefined;
          }
          if (this.isTerminalLock(lockRecord)) {
            return undefined;
          }
          if (lockRecord.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
            // waiting for a utxo to be found
            return undefined;
          }
          return this.runInQueueForUtxo(
            lockRecord,
            async () => {
              const isPendingFunding = lockRecord.status === BitcoinLockStatus.LockPendingFunding;
              const shouldTrackFundingSignals = this.isFundingSignalTrackingStatus(lockRecord.status);
              const shouldSyncLockingState =
                isPendingFunding ||
                (this.isLockFunded(lockRecord) && (!lockRecord.fundingUtxo || hasBitcoinLockFlexibilityChange));

              // Phase 1: lock sync.
              if (shouldSyncLockingState) {
                await this.updateLockingStatus(lockRecord, clientAt).catch(err =>
                  console.warn(`[BitcoinLocks] Error updating locking status for utxo ${lockRecord.uuid}`, err),
                );
              }

              // Phase 2: funding sync.
              if (!lockRecord.fundingUtxo) {
                await this.ensureFundingUtxo(lockRecord).catch(err =>
                  console.warn(`[BitcoinLocks] Error linking funding UTXO record for utxo ${lockRecord.uuid}`, err),
                );
              }
              if (shouldTrackFundingSignals && hasNewOracleBitcoinBlockHeight) {
                await this.utxoTracking.updateFundingLastConfirmationCheck(lockRecord).catch(err => {
                  console.warn(
                    `[BitcoinLocks] Error updating funding confirmation check for utxo ${lockRecord.uuid}`,
                    err,
                  );
                });
              }
              if (shouldTrackFundingSignals) {
                await this.syncPendingFundingSignals(lockRecord, clientAt).catch(err => {
                  console.warn(`[BitcoinLocks] Error syncing funding signals for utxo ${lockRecord.uuid}`, err);
                });
              }

              await this.orphanReleases.reconcileOrphanReturns(lockRecord).catch(err => {
                console.warn(`[BitcoinLocks] Error reconciling orphan return for utxo ${lockRecord.uuid}`, err);
              });

              // Phase 3: accepted funding release sync.
              await this.reconcileAcceptedFundingReleaseOnBlock(lockRecord, hasNewOracleBitcoinBlockHeight).catch(
                err => {
                  console.warn(`[BitcoinLocks] Error reconciling accepted release for utxo ${lockRecord.uuid}`, err);
                },
              );
            },
            queueOptions,
          ).catch(err => {
            console.warn(`[BitcoinLocks] Error processing lock for utxo ${lockRecord.uuid}`, err);
          });
        })
        .filter(x => x !== undefined);
      if (hasNewOracleBitcoinBlockHeight) {
        await this.orphanReleases.syncBitcoinProcessing(this.data.oracleBitcoinBlockHeight).catch(err => {
          console.warn('[BitcoinLocks] Error syncing orphan return processing', err);
        });
      }
      await Promise.allSettled(promises);
      this.data.latestArgonBlock = {
        blockNumber: header.blockNumber,
        blockHash: header.blockHash,
      };
      if (hasBitcoinStateEvent || hasNewOracleBitcoinBlockHeight) this.publishFinancialRevision();
    } catch (error) {
      console.warn('[BitcoinLocks] Failed to process incoming Argon block, will retry on the next block', {
        blockNumber: newestHeader.blockNumber,
        blockHash: newestHeader.blockHash,
        error,
      });
    }
  }

  private async tryUpdateFundingUtxo(
    lock: IBitcoinLockRecord,
    apiClient: ArgonQueryClient,
    latestBitcoinLock?: IBitcoinLock,
  ): Promise<void> {
    latestBitcoinLock ??= await BitcoinLock.get(apiClient, lock.utxoId!);
    if (!latestBitcoinLock || latestBitcoinLock.fundedSatoshis === 0n) return;

    latestBitcoinLock.couponFeesPaid = bigIntMax(
      latestBitcoinLock.couponFeesPaid,
      lock.couponFeesPaid,
      latestBitcoinLock.ownerAccount === this.walletKeys.defaultArgonAddress ? latestBitcoinLock.securityFees : 0n,
    );

    let fundingRecord = this.getAcceptedFundingRecord(lock);
    if (!fundingRecord) {
      const utxoRef = await BitcoinLock.getFundingUtxoRef(apiClient, latestBitcoinLock.utxoId);
      if (!utxoRef) return;

      fundingRecord = await this.utxoTracking.upsertUtxoRecord(
        lock,
        {
          txid: utxoRef.txid,
          vout: utxoRef.vout,
          satoshis: latestBitcoinLock.fundedSatoshis,
        },
        { markFundingUtxo: true },
      );
      await this.utxoTracking.setAcceptedFundingRecordForLock(lock, fundingRecord);
    }
    const table = await this.getTable();
    await table.setCurrentLockFunded(lock, latestBitcoinLock);
  }

  private async ensureFundingUtxo(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.utxoId) return;
    if (lock.fundingUtxo) return;
    const record = this.getAcceptedFundingRecord(lock);
    if (!record) return;
    lock.fundingUtxo = record;
    lock.fundedSatoshis = record.satoshis;
  }

  private async updateLockingStatus(lock: IBitcoinLockRecord, finalizedApi: ArgonQueryClient): Promise<void> {
    const bitcoinLock = await BitcoinLock.get(finalizedApi, lock.utxoId!);
    if (!bitcoinLock) {
      console.warn(`Lock with ID ${lock.utxoId} not found`);
      return;
    }

    if (bitcoinLock.fundedSatoshis === 0n) return;

    await this.tryUpdateFundingUtxo(lock, finalizedApi, bitcoinLock);
  }

  private async getFundingRecordOrThrow(lock: IBitcoinLockRecord): Promise<IBitcoinUtxoRecord> {
    const fundingRecord = this.getAcceptedFundingRecord(lock);
    if (!fundingRecord) {
      throw new Error(`Unable to locate funding UTXO record for lock ${lock.utxoId}`);
    }
    return fundingRecord;
  }

  private async ensureLockReleaseProcessing(lock: IBitcoinLockRecord): Promise<void> {
    if (this.isHistoryRecoveryPendingForLock(lock) || this.isTerminalLock(lock)) return;

    const lockTable = await this.getTable();
    await lockTable.setStatus(lock, BitcoinLockStatus.Releasing);
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

    return Object.values(this.data?.locksByUtxoId ?? {}).some(record => {
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

  private resumeAfterHistoryRecovery(locks: IBitcoinLockRecord[]): void {
    for (const lock of locks) {
      const waiter = this.#historyRecoveryWaitersByUuid[lock.uuid];
      if (!waiter) continue;

      waiter.resolve();
      delete this.#historyRecoveryWaitersByUuid[lock.uuid];
    }
    if (!locks.length) return;

    this.publishFinancialRevision();
    this.data.isReconciliationPending = true;
    void this.#blockQueue
      .add(async () => {
        try {
          const archiveClient = await getMainchainClient(true);
          await this.orphanReleases.syncCosignCounterSubscriptions(archiveClient);
        } catch (error) {
          console.warn('[BitcoinLocks] Unable to refresh orphan return counters after history recovery', error);
        }
        await this.runPendingLoadReconciliation();
      })
      .promise.catch(error =>
        console.warn('[BitcoinLocks] Unable to resume reconciliation after history recovery', error),
      );
  }

  private publishFinancialRevision(): void {
    if (this.data.isLoaded) this.data.financialRevision += 1;
  }

  private async getReleaseCosignOnChain(
    lock: IBitcoinLockRecord,
    archiveClient?: ArgonClient,
  ): Promise<{ blockHeight: number; signature: Uint8Array } | undefined> {
    archiveClient ??= await getMainchainClient(true);
    return await BitcoinLock.findVaultCosignSignature(archiveClient, lock.utxoId!);
  }

  private isFundingSignalTrackingStatus(status: BitcoinLockStatus): boolean {
    return status === BitcoinLockStatus.LockPendingFunding;
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
