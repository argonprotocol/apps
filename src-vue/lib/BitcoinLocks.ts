import { getMainchainClient } from '../stores/mainchain.ts';
import {
  addressBytesHex,
  BitcoinNetwork,
  CosignScript,
  getBitcoinNetworkFromApi,
  getCompressedPubkey,
  getScureNetwork,
  p2wshScriptHexToAddress,
} from '@argonprotocol/bitcoin';
import { Address, NETWORK, OutScript, TEST_NETWORK } from '@scure/btc-signer';
import {
  ApiDecoration,
  ArgonClient,
  BitcoinLock,
  formatArgons,
  hexToU8a,
  type IBitcoinLockConfig,
  type SubmittableExtrinsic,
  type TxSigningAccount,
  TxResult,
  u8aToHex,
  Vault,
} from '@argonprotocol/mainchain';
import { Db } from './Db.ts';
import {
  BitcoinLocksTable,
  BitcoinLockStatus,
  IBitcoinLockRecord,
  IBitcoinLockRelayMetadata,
} from './db/BitcoinLocksTable.ts';
import BitcoinUtxoTracking from './BitcoinUtxoTracking.ts';
import BitcoinMempool from './BitcoinMempool.ts';
import { getVaults } from '../stores/vaults.ts';
import { BITCOIN_BLOCK_MILLIS, ESPLORA_HOST } from './Env.ts';
import { UpstreamOperatorClient } from './UpstreamOperatorClient.ts';
import {
  BlockWatch,
  createDeferred,
  Currency as CurrencyBase,
  IBlockHeaderInfo,
  IDeferred,
  getPercent,
  MiningFrames,
  NetworkConfig,
  SATOSHIS_PER_BITCOIN,
  SingleFileQueue,
} from '@argonprotocol/apps-core';
import type { BitcoinLockRelayStatus, IBitcoinLockCouponStatus } from '@argonprotocol/apps-router';
import { TransactionTracker } from './TransactionTracker.ts';
import { WalletKeys } from './WalletKeys.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { ExtrinsicType, type ITransactionRecord, TransactionStatus } from './db/TransactionsTable.ts';
import { MyVault } from './MyVault.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from './db/BitcoinUtxosTable.ts';

export type IBitcoinMismatchPhase =
  | 'none'
  | 'review'
  | 'accepting'
  | 'returningOnArgon'
  | 'returningOnBitcoin'
  | 'readyToResume'
  | 'returned'
  | 'error';

export interface IBitcoinMismatchCandidateView {
  record: IBitcoinUtxoRecord;
  isNext: boolean;
  observedSatoshis: bigint;
  differenceSatoshis: bigint;
  canAccept: boolean;
  canReturn: boolean;
  acceptTx?: TransactionInfo;
  returnRecord?: IBitcoinUtxoRecord;
}

export interface IBitcoinMismatchViewState {
  phase: IBitcoinMismatchPhase;
  error?: string;
  candidateCount: number;
  isFundingExpired: boolean;
  nextCandidateId?: number;
  nextCandidate?: IBitcoinMismatchCandidateView;
  candidates: IBitcoinMismatchCandidateView[];
}

export interface IBitcoinVaultMismatchState {
  hasActiveLock: boolean;
  lockStatus?: BitcoinLockStatus;
  phase: IBitcoinMismatchPhase;
  isPendingFunding: boolean;
  isFundingReadyToResume: boolean;
  isPostFundingLock: boolean;
  candidateCount: number;
  hasError: boolean;
  hasNextCandidate: boolean;
  nextCandidateCanAccept: boolean;
  nextCandidateCanReturn: boolean;
}

export interface IBitcoinUnlockReleaseState {
  hasActiveLock: boolean;
  lockStatus?: BitcoinLockStatus;
  isPendingFunding: boolean;
  isLockReadyForUnlock: boolean;
  hasFundingRecord: boolean;
  fundingStatus?: BitcoinUtxoStatus;
  isReleaseStatus: boolean;
  isArgonSubmitting: boolean;
  isWaitingForVaultCosign: boolean;
  isBitcoinReleaseProcessing: boolean;
  hasRequestDetails: boolean;
  hasCosign: boolean;
  hasReleaseTxid: boolean;
  isReleaseComplete: boolean;
}

export type IBitcoinVaultUnlockStateDetails = {
  activeLocks: Array<{
    lock: IBitcoinLockRecord;
    fundingRecord?: IBitcoinUtxoRecord;
    latestAcceptTx?: ITransactionRecord;
    fundingCandidates: IBitcoinUtxoRecord[];
  }>;
};

export interface IOperatorBitcoinLockCouponRoute {
  vaultId: number;
  offerCode: string;
  operatorHost: string;
  accountId?: string;
}

export interface IBitcoinRequestLockMetadata {
  bitcoin: {
    uuid: string;
    vaultId: number;
    satoshis: bigint;
    hdPath: string;
    lockedMarketRate: bigint;
    liquidityPromised: bigint;
    securityFee: bigint;
  };
}

interface IAcceptedFundingState {
  record?: IBitcoinUtxoRecord;
  recordId?: number;
}

interface IMismatchReturnState {
  records: IBitcoinUtxoRecord[];
  activeRecord?: IBitcoinUtxoRecord;
  completedRecord?: IBitcoinUtxoRecord;
  currentRecord?: IBitcoinUtxoRecord;
}

export default class BitcoinLocks {
  public data: {
    pendingLocks: IBitcoinLockRecord[];
    locksByUtxoId: { [utxoId: number]: IBitcoinLockRecord };
    mismatchErrorsByLockUtxoId: { [lockUtxoId: number]: string };
    oracleBitcoinBlockHeight: number;
    bitcoinNetwork: BitcoinNetwork;
    latestArgonBlockHeight: number;
  };

  public get bitcoinNetwork() {
    return this.data.bitcoinNetwork;
  }

  public get recordCount() {
    const activeLocks = Object.values(this.locksByUtxoId).filter(lock => !this.isInactiveForVaultDisplay(lock)).length;
    return activeLocks + this.data.pendingLocks.length;
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

  #config!: IBitcoinLockConfig;

  #lockTicksPerDay!: number;
  #subscription?: () => void;
  #waitForLoad?: IDeferred;
  #currency: CurrencyBase;
  #transactionTracker: TransactionTracker;
  #blockQueue = new SingleFileQueue();
  #txQueueByUuid: { [uuid: string]: SingleFileQueue } = {};
  #relayPollingUuids = new Set<string>();
  #mempool: BitcoinMempool;
  #reportedMissingFundingForReleaseLocks = new Set<string>();

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
      mismatchErrorsByLockUtxoId: {},
      oracleBitcoinBlockHeight: 0,
      bitcoinNetwork: BitcoinNetwork.Bitcoin,
      latestArgonBlockHeight: 0,
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
  }

  public getActiveLocks(): IBitcoinLockRecord[] {
    const locks = Object.values(this.data.locksByUtxoId);
    locks.unshift(...this.data.pendingLocks);
    locks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return locks.filter(lock => !this.isInactiveForVaultDisplay(lock));
  }

  public getAllLocks(): IBitcoinLockRecord[] {
    const locks = Object.values(this.data.locksByUtxoId);
    locks.unshift(...this.data.pendingLocks);
    locks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return locks;
  }

  public getLockByUtxoId(utxoId: number): IBitcoinLockRecord | undefined {
    return this.data.locksByUtxoId[utxoId];
  }

  public unlockDeadlineTime(lock: IBitcoinLockRecord): number {
    if (!this.#config) {
      throw new Error('Bitcoin lock configuration is not loaded for expiration time.');
    }
    const oracleBitcoinBlockHeight = this.oracleBitcoinBlockHeight;
    const expirationBlock = lock.lockDetails.vaultClaimHeight;
    if (expirationBlock <= oracleBitcoinBlockHeight) {
      return 0; // Already expired
    }
    const lockReleaseCosignDeadlineFrames = this.#config?.lockReleaseCosignDeadlineFrames ?? 0;
    const releaseOffset = this.#config.tickDurationMillis * this.#lockTicksPerDay * lockReleaseCosignDeadlineFrames;
    const expirationDateMillis = (expirationBlock - oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS;
    return Date.now() + expirationDateMillis - releaseOffset;
  }

  public verifyExpirationTime(lock: Pick<IBitcoinLockRecord, 'lockDetails'>) {
    if (!this.#config) {
      throw new Error('Bitcoin lock configuration is not loaded for verify time.');
    }
    const expirationHeight = this.#config.pendingConfirmationExpirationBlocks + lock.lockDetails.createdAtHeight;

    if (expirationHeight <= this.oracleBitcoinBlockHeight) {
      return Date.now() - 1; // Already expired
    }
    return Date.now() + (expirationHeight - this.oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS;
  }

  public getFundingWindowProgress(lock: Pick<IBitcoinLockRecord, 'lockDetails'>): number {
    try {
      const expTime = this.verifyExpirationTime(lock);
      if (expTime <= Date.now()) return 100;

      const created = lock.lockDetails.createdAtHeight ?? 0;
      const current = this.data.oracleBitcoinBlockHeight;
      const windowBlocks = this.config?.pendingConfirmationExpirationBlocks;
      if (!windowBlocks) return 0;

      const elapsed = Math.max(current - created, 0);
      return Math.min((elapsed / windowBlocks) * 100, 100);
    } catch {
      return 0;
    }
  }

  public getLockTermProgress(lock: Pick<IBitcoinLockRecord, 'lockDetails'>): number {
    const created = lock.lockDetails.createdAtHeight ?? 0;
    const expires = lock.lockDetails.vaultClaimHeight ?? 0;
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
      return this.isFundingExpiredStatus(lock);
    }
  }

  public confirmAddress(lock: IBitcoinLockRecord) {
    console.log('CONFIRM ADDRESS', lock.lockDetails, this.bitcoinNetwork);
    const cosignScript = new CosignScript(lock.lockDetails, this.bitcoinNetwork);
    const pubkey = cosignScript.calculateScriptPubkey();
    if (lock.lockDetails.p2wshScriptHashHex !== pubkey) {
      throw new Error(`Lock with ID ${lock.utxoId} has an invalid address.`);
    }
  }

  public async load(force = false): Promise<void> {
    if (this.#waitForLoad && !force) return this.#waitForLoad.promise;
    this.#waitForLoad = createDeferred<void>();
    try {
      const archiveClient = await getMainchainClient(true);
      const latestClient = await getMainchainClient(false);
      this.#config ??= await BitcoinLock.getConfig(archiveClient);
      this.#lockTicksPerDay = archiveClient.consts.bitcoinLocks.argonTicksPerDay.toNumber();
      this.data.bitcoinNetwork = getBitcoinNetworkFromApi(this.#config.bitcoinNetwork);

      const table = await this.getTable();
      const locks = await table.fetchAll();
      for (const lock of locks) {
        if (lock.utxoId) {
          this.locksByUtxoId[lock.utxoId] = lock;
        } else {
          this.data.pendingLocks.push(lock);
        }
      }
      await this.utxoTracking.load();
      for (const lock of Object.values(this.locksByUtxoId)) {
        this.utxoTracking.getAcceptedFundingRecordForLock(lock);
      }
      for (const lock of Object.values(this.locksByUtxoId)) {
        if (!this.isFinishedStatus(lock)) {
          await this.checkForMissingBitcoinLockState(lock);
        }
      }

      await this.#transactionTracker.load();
      for (const txInfo of this.#transactionTracker.pendingBlockTxInfosAtLoad) {
        const { tx } = txInfo;
        if (tx.extrinsicType === ExtrinsicType.BitcoinRequestLock) {
          const result = await this.onBitcoinLockFinalized(txInfo);
          await this.checkForMissingBitcoinLockState(result);
        } else if (tx.extrinsicType === ExtrinsicType.BitcoinRequestRelease) {
          const { utxoId } = tx.metadataJson!;
          const lock = this.locksByUtxoId[utxoId];
          await this.onRequestedReleaseInBlock(lock, txInfo);
        }
      }

      for (const pendingLock of [...this.data.pendingLocks]) {
        if (!pendingLock.relayMetadataJson?.offerCode) continue;

        const relay = await this.fetchRelayStatus(
          pendingLock.relayMetadataJson.operatorHost,
          pendingLock.relayMetadataJson.offerCode,
        ).catch(error => {
          console.warn(
            `[BitcoinLocks] Unable to recover bitcoin lock for coupon ${pendingLock.relayMetadataJson?.offerCode}`,
            error,
          );
          return undefined;
        });
        if (!relay) {
          void this.pollRelayUntilSettled(pendingLock.uuid);
          continue;
        }
        if (!isBitcoinLockRelayStatus(relay.status)) {
          void this.pollRelayUntilSettled(pendingLock.uuid);
          continue;
        }
        const settledRelay = relay as IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus };

        await this.syncRelayBackedPendingLock(pendingLock, settledRelay);
      }

      await this.blockWatch.start();
      await this.#blockQueue.add(() => this.checkIncomingArgonBlock(this.blockWatch.bestBlockHeader), {
        timeoutMs: 120e3,
      }).promise;
      for (const lock of Object.values(this.locksByUtxoId)) {
        await this.reconcileMismatchState(lock);
        await this.reconcileMismatchReturnOnBlock(lock);
        await this.reconcileAcceptedFundingReleaseOnBlock(lock, false);
      }
      await this.syncLockReleaseBitcoinProcessing(this.locksByUtxoId);
      await this.syncOrphanReturnBitcoinProcessing(this.oracleBitcoinBlockHeight);
      this.#subscription = this.blockWatch.events.on('best-blocks', async headers => {
        void this.#blockQueue.add(() => this.checkIncomingArgonBlock(headers.at(-1)!), { timeoutMs: 120e3 });
      });
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('Error loading BitcoinLocks:', error);
      this.#waitForLoad.reject(error);
    }
    return this.#waitForLoad.promise;
  }

  private async checkForMissingBitcoinLockState(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.utxoId) {
      return;
    }
    if (!lock.fundingUtxoRecord && lock.fundingUtxoRecordId) {
      this.utxoTracking.getAcceptedFundingRecordForLock(lock);
    }
    const table = await this.getTable();
    const archiveClient = await getMainchainClient(true);
    const bitcoinLock = await BitcoinLock.get(archiveClient, lock.utxoId);
    if (bitcoinLock) {
      lock.lockDetails = bitcoinLock;
      await this.tryUpdateFundingUtxo(lock, archiveClient);
      await this.syncLockReleaseArgonRequest(lock, archiveClient);
    } else {
      await this.syncLockReleaseArgonCosign(lock, archiveClient);
      const fundingRecord = this.getAcceptedFundingRecord(lock);
      if (fundingRecord) {
        await this.syncLockReleaseStatusFromFundingRecord(lock, fundingRecord);
      } else if (lock.status === BitcoinLockStatus.LockPendingFunding) {
        await table.setLockExpiredWaitingForFunding(lock);
      }
    }
  }

  public unsubscribeFromArgonBlocks() {
    this.#subscription?.();
    this.#subscription = undefined;
  }

  public async shutdown() {
    this.unsubscribeFromArgonBlocks();
    await this.#blockQueue.stop(true);
    await Promise.all(Object.values(this.#txQueueByUuid).map(queue => queue.stop(true)));
  }

  private async getNextUtxoPubkey(args: { vault: Vault }) {
    const { vault } = args;
    const table = await this.getTable();

    // get bitcoin xpriv to generate the pubkey
    const nextIndex = await table.getNextVaultHdKeyIndex(vault.vaultId);
    return this.getDerivedPubkey(vault.vaultId, nextIndex);
  }

  public async getDerivedPubkey(vaultId: number, index: number) {
    const hdPath = `m/1018'/0'/${vaultId}'/0/${index}'`;
    const ownerBitcoinXpriv = await this.walletKeys.getBitcoinChildXpriv(hdPath, this.bitcoinNetwork);
    const ownerBitcoinPubkey = getCompressedPubkey(ownerBitcoinXpriv.publicKey!);
    return { ownerBitcoinPubkey, hdPath };
  }

  public async satoshisForArgonLiquidity(microgonLiquidity: bigint): Promise<bigint> {
    await this.#currency.load(true);
    return BitcoinLock.requiredSatoshisForArgonLiquidity(this.#currency.priceIndex, microgonLiquidity);
  }

  private async canPayMinimumFee(args: {
    vault: Vault;
    txSigner: TxSigningAccount;
    tip?: bigint;
  }): Promise<{ canAfford: boolean; txFeePlusTip: bigint; securityFee: bigint }> {
    const { vault, txSigner, tip = 0n } = args;
    const ownerBitcoinXpriv = await this.walletKeys.getBitcoinChildXpriv(
      `m/1018'/0'/${vault.vaultId}'/0/0'`,
      this.bitcoinNetwork,
    );
    const ownerBitcoinPubkey = getCompressedPubkey(ownerBitcoinXpriv.publicKey!);

    // explode on purpose if we can't afford even the minimum
    return await BitcoinLock.createInitializeTx({
      client: await getMainchainClient(false),
      vault,
      priceIndex: this.#currency.priceIndex,
      ownerBitcoinPubkey,
      txSigner,
      tip,
      satoshis: await this.minimumSatoshiPerLock(),
    });
  }

  private async minimumSatoshiPerLock(): Promise<bigint> {
    const client = await getMainchainClient(false);
    return await client.query.bitcoinLocks.minimumSatoshis().then(x => x.toBigInt());
  }

  public async initializeLock(args: {
    vault: Vault;
    satoshis: bigint;
    tip?: bigint;
    operatorCoupon?: IOperatorBitcoinLockCouponRoute;
  }): Promise<{ pendingLock: IBitcoinLockRecord; txInfo?: TransactionInfo<IBitcoinRequestLockMetadata> }> {
    const { vault, satoshis, tip, operatorCoupon } = args;
    const txSigner = await this.walletKeys.getLiquidLockingKeypair();

    const minimumSatoshis = await this.minimumSatoshiPerLock();
    if (satoshis < minimumSatoshis) {
      throw new Error(
        `Unable to create a bitcoin lock with the given sats: ${satoshis}. Minimum is ${minimumSatoshis}`,
      );
    }
    if (!this.#currency.priceIndex.btcUsdPrice) {
      throw new Error('Network bitcoin pricing is currently unavailable. Please try again later.');
    }

    if (operatorCoupon) {
      if (operatorCoupon.vaultId !== vault.vaultId) {
        throw new Error('This bitcoin lock coupon is for a different vault.');
      }
      if (operatorCoupon.accountId && operatorCoupon.accountId !== txSigner.address) {
        throw new Error(
          `This invite is claimed by ${operatorCoupon.accountId}. Import or switch to that account before continuing.`,
        );
      }

      return await this.initializeOperatorCouponLock({
        txSigner,
        vault,
        satoshis,
        operatorCoupon,
      });
    }

    const basicFeeCapability = await this.canPayMinimumFee({ ...args, txSigner });
    if (!basicFeeCapability.canAfford) {
      const { txFeePlusTip, securityFee } = basicFeeCapability;
      throw new Error(
        `You cannot afford the basic transaction fees of this transaction (Tx Fees: ${formatArgons(txFeePlusTip)}, Minimum Possible Security Fee: ${formatArgons(securityFee)})`,
      );
    }
    const submitTxClient = await getMainchainClient(false);
    const microgonsPerBtc = this.#currency.priceIndex.getBtcMicrogonPrice(SATOSHIS_PER_BITCOIN);
    const liquidityPromised = this.#currency.priceIndex.getBtcMicrogonPrice(satoshis);

    const { ownerBitcoinPubkey, hdPath } = await this.getNextUtxoPubkey(args);
    const { tx, securityFee } = await BitcoinLock.createInitializeTx({
      client: submitTxClient,
      vault,
      priceIndex: this.#currency.priceIndex,
      ownerBitcoinPubkey,
      txSigner,
      microgonsPerBtc,
      satoshis,
      tip,
    });
    const bitcoinUuid = BitcoinLocksTable.createUuid();
    const txInfo = await this.#transactionTracker.submitAndWatch({
      tx,
      txSigner,
      extrinsicType: ExtrinsicType.BitcoinRequestLock,
      metadata: {
        bitcoin: {
          uuid: bitcoinUuid,
          vaultId: args.vault.vaultId,
          satoshis,
          hdPath,
          lockedMarketRate: microgonsPerBtc,
          liquidityPromised,
          securityFee,
        },
      },
      tip: args.tip,
    });

    await this.createPendingBitcoinLock(txInfo);
    const pendingLock = this.data.pendingLocks.at(-1);
    if (!pendingLock) throw new Error('Pending lock was not created');
    return { pendingLock, txInfo };
  }

  private async initializeOperatorCouponLock(args: {
    txSigner: TxSigningAccount;
    vault: Vault;
    satoshis: bigint;
    operatorCoupon: IOperatorBitcoinLockCouponRoute;
  }): Promise<{ pendingLock: IBitcoinLockRecord; txInfo?: TransactionInfo<IBitcoinRequestLockMetadata> }> {
    const { offerCode, operatorHost } = args.operatorCoupon;

    const microgonsPerBtc = this.#currency.priceIndex.getBtcMicrogonPrice(SATOSHIS_PER_BITCOIN);
    const liquidityPromised = this.#currency.priceIndex.getBtcMicrogonPrice(args.satoshis);
    const { ownerBitcoinPubkey, hdPath } = await this.getNextUtxoPubkey({ vault: args.vault });

    const relay = await this.requestBitcoinLockInitialization({
      offerCode,
      operatorHost,
      ownerAccountId: args.txSigner.address,
      ownerBitcoinPubkey: u8aToHex(ownerBitcoinPubkey),
      requestedSatoshis: args.satoshis,
      microgonsPerBtc,
    });

    const pendingLock = await this.insertPending({
      uuid: BitcoinLocksTable.createUuid(),
      satoshis: args.satoshis,
      lockedMarketRate: microgonsPerBtc,
      liquidityPromised,
      vaultId: args.vault.vaultId,
      hdPath,
      relayMetadataJson: this.toRelayMetadata(operatorHost, offerCode, relay),
    });
    this.data.pendingLocks.push(pendingLock);

    await this.syncRelayBackedPendingLock(pendingLock, relay);
    return { pendingLock };
  }

  private async requestBitcoinLockInitialization(args: {
    offerCode: string;
    operatorHost: string;
    ownerAccountId: string;
    ownerBitcoinPubkey: string;
    requestedSatoshis: bigint;
    microgonsPerBtc: bigint;
  }): Promise<IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus }> {
    const { offerCode, operatorHost, ownerAccountId, ownerBitcoinPubkey, requestedSatoshis, microgonsPerBtc } = args;

    return await UpstreamOperatorClient.initializeBitcoinLock(operatorHost, offerCode, {
      ownerAccountId,
      ownerBitcoinPubkey,
      requestedSatoshis,
      microgonsPerBtc,
    });
  }

  private async fetchRelayStatus(
    operatorHost?: string,
    offerCode?: string,
  ): Promise<IBitcoinLockCouponStatus | undefined> {
    if (!operatorHost || !offerCode) return undefined;

    return await UpstreamOperatorClient.getBitcoinLockStatus(operatorHost, offerCode);
  }

  private async syncRelayBackedPendingLock(
    lock: IBitcoinLockRecord,
    relay: IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus },
  ): Promise<TransactionInfo<IBitcoinRequestLockMetadata> | undefined> {
    const table = await this.getTable();
    await table.setRelayMetadata(
      lock,
      this.toRelayMetadata(lock.relayMetadataJson?.operatorHost, relay.coupon.offerCode, relay),
    );

    if (relay.status === 'Failed') {
      return undefined;
    }

    if (relay.status === 'Finalized') {
      await this.finalizePendingFromRelay(lock, relay);
      return undefined;
    }

    const txInfo = await this.trackSubmittedRelay(lock, relay);
    void this.pollRelayUntilSettled(lock.uuid);
    return txInfo;
  }

  private async trackSubmittedRelay(
    lock: IBitcoinLockRecord,
    relay: IBitcoinLockCouponStatus,
  ): Promise<TransactionInfo<IBitcoinRequestLockMetadata> | undefined> {
    const relayRecord = relay.relay;
    if (
      !relayRecord?.extrinsicHash ||
      !relayRecord.extrinsicMethodJson ||
      !relayRecord.delegateAddress ||
      relayRecord.txSubmittedAtBlockHeight == null ||
      !relayRecord.txSubmittedAtTime
    ) {
      return undefined;
    }

    const existingTxInfo = this.#transactionTracker.findLatestTxInfo<IBitcoinRequestLockMetadata>(
      txInfo =>
        txInfo.tx.extrinsicType === ExtrinsicType.BitcoinRequestLock &&
        txInfo.tx.metadataJson.bitcoin.uuid === lock.uuid,
    );
    if (existingTxInfo) {
      return existingTxInfo;
    }

    const client = await getMainchainClient(false);
    const txResult = new TxResult(client, {
      signedHash: relayRecord.extrinsicHash,
      method: relayRecord.extrinsicMethodJson,
      nonce: relayRecord.txNonce ?? 0,
      accountAddress: relayRecord.delegateAddress,
      submittedTime: relayRecord.txSubmittedAtTime,
      submittedAtBlockNumber: relayRecord.txSubmittedAtBlockHeight,
    });
    txResult.isBroadcast = true;

    const txInfo = await this.#transactionTracker.trackTxResult({
      txResult,
      extrinsicType: ExtrinsicType.BitcoinRequestLock,
      metadata: {
        bitcoin: {
          uuid: lock.uuid,
          vaultId: lock.vaultId,
          satoshis: lock.satoshis,
          hdPath: lock.hdPath,
          lockedMarketRate: lock.lockedMarketRate,
          liquidityPromised: lock.liquidityPromised,
          securityFee: lock.ratchets[0]?.securityFee ?? 0n,
        },
      },
    });

    void this.onBitcoinLockFinalized(txInfo);
    return txInfo;
  }

  private async finalizePendingFromRelay(lock: IBitcoinLockRecord, relay: IBitcoinLockCouponStatus): Promise<void> {
    const relayRecord = relay.relay;
    if (lock.utxoId) return;
    if (!relayRecord?.utxoId) return;

    const existingRecord = this.locksByUtxoId[relayRecord.utxoId];
    if (existingRecord) {
      const pendingIdx = this.data.pendingLocks.findIndex(x => x.uuid === lock.uuid);
      if (pendingIdx >= 0) {
        this.data.pendingLocks.splice(pendingIdx, 1);
      }
      return;
    }

    const lockDetails = await this.getFromApi(relayRecord.utxoId);
    const createdAtArgonBlockHeight = relayRecord.txInBlockHeight ?? relayRecord.txFinalizedHeight ?? 0;

    const table = await this.getTable();
    const record = await table.finalizePending({
      uuid: lock.uuid,
      lock: lockDetails,
      createdAtArgonBlockHeight,
      finalFee: relayRecord.txFeePlusTip ?? 0n,
    });
    this.locksByUtxoId[record.utxoId!] = record;

    const pendingIdx = this.data.pendingLocks.findIndex(x => x.uuid === lock.uuid);
    if (pendingIdx >= 0) {
      this.data.pendingLocks.splice(pendingIdx, 1);
    }
  }

  private async pollRelayUntilSettled(uuid: string): Promise<void> {
    if (this.#relayPollingUuids.has(uuid)) return;
    this.#relayPollingUuids.add(uuid);

    try {
      let relayMetadata = this.data.pendingLocks.find(x => x.uuid === uuid)?.relayMetadataJson;
      if (!relayMetadata?.offerCode || !relayMetadata.operatorHost) {
        return;
      }

      while (true) {
        const lock = this.data.pendingLocks.find(x => x.uuid === uuid);
        relayMetadata = lock?.relayMetadataJson ?? relayMetadata;

        if (!relayMetadata?.offerCode || !relayMetadata.operatorHost) {
          return;
        }
        const currentRelayMetadata = relayMetadata;

        const relay = await this.fetchRelayStatus(
          currentRelayMetadata.operatorHost,
          currentRelayMetadata.offerCode,
        ).catch(error => {
          console.warn(
            `[BitcoinLocks] Failed to poll bitcoin lock for coupon ${currentRelayMetadata.offerCode}`,
            error,
          );
          return undefined;
        });
        if (!relay) {
          await new Promise(resolve => setTimeout(resolve, 2_500));
          continue;
        }
        if (!isBitcoinLockRelayStatus(relay.status)) {
          await new Promise(resolve => setTimeout(resolve, 2_500));
          continue;
        }
        const settledRelay = relay as IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus };

        if (lock) {
          await this.syncRelayBackedPendingLock(lock, settledRelay);
        }

        if (settledRelay.status === 'Finalized' || settledRelay.status === 'Failed') {
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 2_500));
      }
    } finally {
      this.#relayPollingUuids.delete(uuid);
    }
  }

  private toRelayMetadata(
    operatorHost: string | undefined,
    offerCode: string,
    relay: IBitcoinLockCouponStatus & { status: BitcoinLockRelayStatus },
  ): IBitcoinLockRelayMetadata {
    return {
      operatorHost,
      offerCode,
      status: relay.status,
      error: relay.relay?.error ?? undefined,
      expiresAtBlockHeight: relay.relay?.txExpiresAtBlockHeight,
    };
  }

  public async insertPending(details: {
    uuid: string;
    satoshis: bigint;
    lockedMarketRate?: bigint;
    liquidityPromised?: bigint;
    vaultId: number;
    hdPath: string;
    relayMetadataJson?: IBitcoinLockRelayMetadata | null;
  }): Promise<IBitcoinLockRecord> {
    const table = await this.getTable();
    return await table.insertPending({
      ...details,
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      cosignVersion: 'v1',
      network: this.#config.bitcoinNetwork.toString(),
    });
  }

  public async createPendingBitcoinLock(
    txInfo: TransactionInfo<{
      bitcoin: {
        uuid: string;
        vaultId: number;
        hdPath: string;
        satoshis: bigint;
        lockedMarketRate: bigint;
        liquidityPromised: bigint;
        securityFee: bigint;
      };
    }>,
  ) {
    const { bitcoin: bitcoinMeta } = txInfo.tx.metadataJson;
    const pendingLock = await this.insertPending(bitcoinMeta);
    this.data.pendingLocks.push(pendingLock);
    void this.onBitcoinLockFinalized(txInfo);
  }

  private async onBitcoinLockFinalized(txInfo: TransactionInfo<IBitcoinRequestLockMetadata>) {
    const postProcessor = txInfo.createPostProcessor();
    const genericClient = await getMainchainClient(true);
    const txResult = txInfo.txResult;
    await txResult.waitForFinalizedBlock;
    const typeClient = await genericClient.at(txResult.blockHash!);
    const { lock, createdAtHeight } = await BitcoinLock.getBitcoinLockFromTxResult(typeClient, txResult);
    const uuid = txInfo.tx.metadataJson.bitcoin.uuid;
    const table = await this.getTable();
    let record = this.locksByUtxoId[lock.utxoId];
    if (!record) {
      record = await table.finalizePending({
        uuid,
        lock,
        createdAtArgonBlockHeight: createdAtHeight,
        finalFee: txResult.finalFee!,
      });
    }

    this.locksByUtxoId[record.utxoId!] = record;
    const pendingIdx = this.data.pendingLocks.findIndex(l => l.uuid === uuid);
    if (pendingIdx >= 0) {
      this.data.pendingLocks.splice(pendingIdx, 1);
    }
    postProcessor.resolve();

    return record;
  }

  public async getFromApi(utxoId: number): Promise<BitcoinLock> {
    const result = await BitcoinLock.get(await getMainchainClient(false), utxoId);
    if (!result) throw new Error('Unable to get bitcoin lock');
    return result;
  }

  public async calculateBitcoinNetworkFee(
    lock: IBitcoinLockRecord,
    feeRatePerSatVb: bigint,
    toScriptPubkey: string,
  ): Promise<bigint> {
    const cosignScript = new CosignScript(lock.lockDetails, this.bitcoinNetwork);
    toScriptPubkey = addressBytesHex(toScriptPubkey, this.bitcoinNetwork);
    console.log('Calculating fee for lock', {
      utxoId: lock.utxoId,
      feeRatePerSatVb: feeRatePerSatVb.toString(),
      toScriptPubkey,
    });
    return cosignScript.calculateFee(feeRatePerSatVb, toScriptPubkey);
  }

  public async estimatedReleaseArgonTxFee(args: {
    lock: IBitcoinLockRecord;
    tip?: bigint;
    liquidLockingAddress: string;
    toScriptPubkey?: string;
    bitcoinFeeRatePerVb?: bigint;
  }): Promise<bigint> {
    const {
      lock,
      // NOTE: not submitting, so a default value is ok
      toScriptPubkey = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
      bitcoinFeeRatePerVb = 5n,
      liquidLockingAddress,
    } = args;
    // get release fee at current block
    const client = await getMainchainClient(false);

    const bitcoinNetworkFee = await this.calculateBitcoinNetworkFee(lock, bitcoinFeeRatePerVb, toScriptPubkey);

    const fee = await client.tx.bitcoinLocks
      .requestRelease(lock.utxoId!, addressBytesHex(toScriptPubkey, this.bitcoinNetwork), bitcoinNetworkFee)
      .paymentInfo(liquidLockingAddress, { tip: args.tip ?? 0n });
    return fee.partialFee.toBigInt();
  }

  public async estimatedMismatchAcceptArgonTxFee(args: {
    lock: IBitcoinLockRecord;
    candidateRecord: IBitcoinUtxoRecord;
    liquidLockingAddress: string;
    tip?: bigint;
  }): Promise<bigint> {
    const { lock, candidateRecord, liquidLockingAddress } = args;
    if (!lock.utxoId) return 0n;
    const client = await getMainchainClient(false);
    const { tx } = await this.buildMismatchAcceptTx({ client, lock, candidateRecord });
    const fee = await tx.paymentInfo(liquidLockingAddress, { tip: args.tip ?? 0n });
    return fee.partialFee.toBigInt();
  }

  public async estimatedMismatchReturnArgonTxFee(args: {
    lock: IBitcoinLockRecord;
    candidateRecord: IBitcoinUtxoRecord;
    liquidLockingAddress: string;
    toScriptPubkey: string;
    feeRatePerSatVb?: bigint;
    tip?: bigint;
  }): Promise<bigint> {
    const { lock, candidateRecord, toScriptPubkey, feeRatePerSatVb = 5n, liquidLockingAddress } = args;
    if (!lock.utxoId) return 0n;

    const client = await getMainchainClient(false);
    const request = await this.getMismatchOrphanReturnRequest({
      lock,
      candidateRecord,
      toScriptPubkey,
      feeRatePerSatVb,
    });
    const tx = await this.buildMismatchOrphanReturnTx({
      client,
      lock,
      candidateRecord,
      request,
      // Estimated fee only; signature bytes length needs to be valid, content is not used for weight estimation.
      vaultSignature: new Uint8Array(71).fill(1),
    });
    const fee = await tx.paymentInfo(liquidLockingAddress, { tip: args.tip ?? 0n });
    return fee.partialFee.toBigInt();
  }

  public getMintPercent(lock: Pick<IBitcoinLockRecord, 'ratchets'>): number {
    const ratchets = lock.ratchets ?? [];
    const totalMint = ratchets.reduce((sum, r) => sum + (r.mintAmount ?? 0n), 0n);
    const totalPending = ratchets.reduce((sum, r) => sum + (r.mintPending ?? 0n), 0n);
    if (totalMint <= 0n) return 0;
    return Math.round(Number(((totalMint - totalPending) * 100n) / totalMint));
  }

  public async ratchet(lock: IBitcoinLockRecord, txSigner: TxSigningAccount, tip = 0n) {
    return await this.runInQueueForUtxo(lock, 180e3, async () => {
      const table = await this.getTable();
      if (!this.isLockedStatus(lock)) {
        throw new Error(`Lock with ID ${lock.utxoId} is not verified.`);
      }

      const vaults = getVaults();
      const bitcoinLock = new BitcoinLock(lock.lockDetails);
      // Use whatever is loaded into the price index at this time. NOTE: this could be old, but is likely what the user has seen
      const microgonsPerBtc = this.#currency.priceIndex.getBtcMicrogonPrice(SATOSHIS_PER_BITCOIN);

      const result = await bitcoinLock.ratchet({
        client: await getMainchainClient(false),
        priceIndex: this.#currency.priceIndex,
        microgonsPerBtc,
        txSigner,
        tip,
        vault: vaults.vaultsById[lock.vaultId],
      });

      const {
        burned,
        securityFee,
        bitcoinBlockHeight: oracleBitcoinBlockHeight,
        blockHeight,
        liquidityPromised,
        newLockedMarketRate,
        pendingMint,
        txFee,
      } = await result.getRatchetResult();

      lock.ratchets.push({
        mintAmount: pendingMint,
        mintPending: pendingMint,
        lockedMarketRate: newLockedMarketRate,
        txFee,
        burned,
        securityFee,
        blockHeight,
        oracleBitcoinBlockHeight,
      });
      lock.liquidityPromised = liquidityPromised;
      lock.lockedMarketRate = newLockedMarketRate;
      lock.lockDetails.liquidityPromised = liquidityPromised;
      lock.lockDetails.lockedMarketRate = newLockedMarketRate;

      await table.saveNewRatchet(lock);
    });
  }

  private async ownerCosignAndSendToBitcoin(lock: IBitcoinLockRecord): Promise<void> {
    const fundingRecord = await this.getFundingRecordOrThrow(lock);
    if (!this.utxoTracking.canSubmitFundingRecordReleaseToBitcoin(fundingRecord)) return;

    try {
      await this.utxoTracking.clearStatusError(fundingRecord);
      const { bytes, txid } = await this.ownerCosignAndGenerateTxBytes(lock);
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
    addTx?: string,
  ): Promise<{ txid: string; bytes: Uint8Array }> {
    if (lock.cosignVersion !== 'v1') {
      throw new Error(`Unsupported cosign version: ${lock.cosignVersion}`);
    }

    const fundingRecord = await this.getFundingRecordOrThrow(lock);
    if (!fundingRecord.releaseCosignVaultSignature) {
      throw new Error(`Lock with ID ${lock.utxoId} has not been cosigned yet.`);
    }
    if (fundingRecord.releaseCosignHeight == null) {
      throw new Error(`Lock with ID ${lock.utxoId} does not have an Argon cosign block height yet.`);
    }
    if (!fundingRecord.releaseToDestinationAddress || fundingRecord.releaseBitcoinNetworkFee == null) {
      throw new Error(`Lock with ID ${lock.utxoId} has no release request details yet.`);
    }

    const cosign = new CosignScript({ ...lock.lockDetails, utxoSatoshis: fundingRecord.satoshis }, this.bitcoinNetwork);
    const tx = cosign.cosignAndGenerateTx({
      releaseRequest: {
        toScriptPubkey: fundingRecord.releaseToDestinationAddress,
        bitcoinNetworkFee: fundingRecord.releaseBitcoinNetworkFee,
      },
      vaultCosignature: fundingRecord.releaseCosignVaultSignature,
      utxoRef: { txid: fundingRecord.txid, vout: fundingRecord.vout },
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

  public getLockProcessingDetails(lock: IBitcoinLockRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    receivedSatoshis?: bigint;
    isInvalidAmount?: boolean;
  } {
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
    if (lock.relayMetadataJson?.error) {
      return lock.relayMetadataJson.error;
    }

    const txInfo = this.#transactionTracker.findLatestTxInfo<IBitcoinRequestLockMetadata>(
      candidate =>
        candidate.tx.extrinsicType === ExtrinsicType.BitcoinRequestLock &&
        candidate.tx.metadataJson.bitcoin.uuid === lock.uuid,
    );
    return txInfo?.getStatus().error?.message ?? '';
  }

  public getReceivedFundingSatoshis(lock: IBitcoinLockRecord): bigint | undefined {
    return this.utxoTracking.getReceivedFundingSatoshis(lock);
  }

  public getDisplayLiquidityPromised(lock: Pick<IBitcoinLockRecord, 'liquidityPromised' | 'satoshis'>): bigint {
    if (lock.liquidityPromised > 0n) {
      return lock.liquidityPromised;
    }
    if (lock.satoshis <= 0n) {
      return 0n;
    }
    return this.#currency.priceIndex.getBtcMicrogonPrice(lock.satoshis);
  }

  public hasObservedFundingSignal(lock: IBitcoinLockRecord): boolean {
    return this.utxoTracking.hasObservedFundingSignal(lock);
  }

  public getMismatchViewState(lock: IBitcoinLockRecord): IBitcoinMismatchViewState {
    type IMismatchCandidateBuildState = IBitcoinMismatchCandidateView & { canAcceptBase: boolean };

    const records = this.getMismatchViewRecords(lock);
    const isFundingExpired = this.isFundingWindowExpired(lock);
    const hasAcceptedFunding = !!this.getAcceptedFundingState(lock).record;
    const latestMismatchAcceptTx = lock.utxoId != null ? this.getLatestMismatchAcceptTxInfo(lock.utxoId) : undefined;
    const hasMismatchAcceptInProgress =
      latestMismatchAcceptTx != null &&
      [TransactionStatus.Submitted, TransactionStatus.InBlock].includes(latestMismatchAcceptTx.tx.status);

    const candidateBuildStates: IMismatchCandidateBuildState[] = records.map(record => {
      const acceptTx = this.getMismatchAcceptTxInfo(lock, record);
      const returnState = this.getMismatchReturnState(lock, record);
      const returnRecord = returnState.currentRecord;
      const canActOnCandidate =
        !!lock.utxoId &&
        record.lockUtxoId === lock.utxoId &&
        this.isMismatchCandidate(lock, record.satoshis) &&
        !hasMismatchAcceptInProgress &&
        !returnState.activeRecord;
      const canReturn =
        canActOnCandidate &&
        this.isMismatchPhaseStatus(lock.status) &&
        record.status !== BitcoinUtxoStatus.FundingUtxo &&
        !this.utxoTracking.isReleaseStatus(record.status) &&
        this.isMismatchCandidateSeenOnArgon(record);
      const canAcceptBase =
        canActOnCandidate &&
        lock.status === BitcoinLockStatus.LockPendingFunding &&
        record.status !== BitcoinUtxoStatus.Orphaned &&
        !this.utxoTracking.isReleaseStatus(record.status) &&
        !hasAcceptedFunding &&
        this.isMismatchCandidateSeenOnArgon(record);

      return {
        record,
        isNext: false,
        observedSatoshis: record.satoshis,
        differenceSatoshis: record.satoshis - lock.satoshis,
        canAcceptBase,
        canAccept: false,
        canReturn,
        acceptTx,
        returnRecord,
      };
    });

    const actionableCandidateCount = candidateBuildStates.filter(candidate => {
      return candidate.canAcceptBase || candidate.canReturn;
    }).length;
    const candidates: IBitcoinMismatchCandidateView[] = candidateBuildStates.map(({ canAcceptBase, ...candidate }) => {
      return {
        ...candidate,
        canAccept: canAcceptBase && actionableCandidateCount === 1 && !isFundingExpired,
      };
    });

    const nextCandidate =
      candidates.find(candidate => this.isMismatchCandidateReturning(candidate.returnRecord)) ??
      candidates.find(candidate => candidate.returnRecord?.status === BitcoinUtxoStatus.ReleaseComplete) ??
      candidates.find(candidate => this.isMismatchAcceptTxActive(candidate.acceptTx)) ??
      candidates.find(candidate => candidate.canAccept || candidate.canReturn) ??
      candidates[0];

    if (nextCandidate) {
      nextCandidate.isNext = true;
    }

    const error = this.getMismatchError(lock);
    let phase: IBitcoinMismatchPhase = 'none';
    if (error) {
      phase = 'error';
    } else if (nextCandidate?.returnRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
      phase = 'returningOnBitcoin';
    } else if (nextCandidate?.returnRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon) {
      phase = 'returningOnArgon';
    } else if (nextCandidate?.returnRecord?.status === BitcoinUtxoStatus.ReleaseComplete) {
      phase = this.isFundingReadyToResumeStatus(lock) ? 'readyToResume' : 'returned';
    } else if (this.isMismatchAcceptTxActive(nextCandidate?.acceptTx)) {
      phase = 'accepting';
    } else if (candidates.length > 0) {
      phase = 'review';
    }

    return {
      phase,
      error,
      candidateCount: candidates.length,
      isFundingExpired,
      nextCandidateId: nextCandidate?.record.id,
      nextCandidate,
      candidates,
    };
  }

  public getLockMismatchState(lock: IBitcoinLockRecord | undefined): IBitcoinVaultMismatchState {
    if (!lock) {
      return {
        hasActiveLock: false,
        phase: 'none',
        isPendingFunding: false,
        isFundingReadyToResume: false,
        isPostFundingLock: false,
        candidateCount: 0,
        hasError: false,
        hasNextCandidate: false,
        nextCandidateCanAccept: false,
        nextCandidateCanReturn: false,
      };
    }

    const mismatchView = this.getMismatchViewState(lock);
    return {
      hasActiveLock: true,
      lockStatus: lock.status,
      phase: mismatchView.phase,
      isPendingFunding: lock.status === BitcoinLockStatus.LockPendingFunding,
      isFundingReadyToResume: this.isFundingReadyToResumeStatus(lock),
      isPostFundingLock: this.isLockedStatus(lock),
      candidateCount: mismatchView.candidateCount,
      hasError: !!mismatchView.error,
      hasNextCandidate: !!mismatchView.nextCandidate,
      nextCandidateCanAccept: !!mismatchView.nextCandidate?.canAccept,
      nextCandidateCanReturn: !!mismatchView.nextCandidate?.canReturn,
    };
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

    const fundingRecord = this.getAcceptedFundingRecord(lock) ?? lock.fundingUtxoRecord;
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
      isLockReadyForUnlock: this.isLockedStatus(lock),
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
    const activeLocks = this.getActiveLocks();
    return {
      activeLocks: activeLocks.map(lock => {
        const fundingRecord = this.getAcceptedFundingRecord(lock) ?? lock.fundingUtxoRecord;
        const latestAcceptTx = lock.utxoId != null ? this.getLatestMismatchAcceptTxInfo(lock.utxoId) : undefined;

        return {
          lock,
          fundingRecord,
          latestAcceptTx: latestAcceptTx?.tx,
          fundingCandidates: this.getMismatchViewState(lock).candidates.map(candidate => candidate.record),
        };
      }),
    };
  }

  public getMismatchAcceptTxInfo(
    lock: IBitcoinLockRecord,
    candidateRecord: Pick<IBitcoinUtxoRecord, 'id' | 'txid' | 'vout'>,
  ): TransactionInfo | undefined {
    if (!lock.utxoId) return undefined;
    return this.getMismatchAcceptTxInfoForCandidate(lock.utxoId, candidateRecord);
  }

  public getOrphanedReturnTxInfoForRecord(
    utxoId: number,
    candidateRecord: Pick<IBitcoinUtxoRecord, 'id' | 'txid' | 'vout'>,
  ): TransactionInfo | undefined {
    const matches = this.#transactionTracker.data.txInfos.filter(txInfo => {
      if (txInfo.tx.extrinsicType !== ExtrinsicType.BitcoinOrphanedUtxoRelease) return false;
      const metadata = txInfo.tx.metadataJson as { utxoId?: number; utxoRecordId?: number } | undefined;
      if (metadata?.utxoId !== utxoId) return false;
      return metadata.utxoRecordId === candidateRecord.id;
    });
    return matches.at(-1);
  }

  public getReleaseLifecycleProgress(record: IBitcoinUtxoRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    error?: string;
  } {
    return this.utxoTracking.getReleaseLifecycleProgress(record);
  }

  public getUnderSecuritizedMicrogons(lock: IBitcoinLockRecord, candidateRecord: IBitcoinUtxoRecord): bigint | null {
    const vault = getVaults().vaultsById[lock.vaultId];
    if (!vault) return null;
    const received = candidateRecord.satoshis;
    if (received <= lock.satoshis) return null;
    const extraLiquidity = getExtraLiquidityMicrogons({
      lockSatoshis: lock.satoshis,
      lockLiquidityPromised: lock.liquidityPromised,
      receivedSatoshis: received,
    });
    if (extraLiquidity === null || extraLiquidity <= 0n) return null;
    const availableLiquidity = vault.availableBitcoinSpace();
    if (availableLiquidity >= extraLiquidity) return null;
    return extraLiquidity - availableLiquidity;
  }

  public getIncreaseSecuritizationMicrogons(
    lock: IBitcoinLockRecord,
    candidateRecord: IBitcoinUtxoRecord,
  ): bigint | null {
    const vault = getVaults().vaultsById[lock.vaultId];
    if (!vault) return null;
    const received = candidateRecord.satoshis;
    if (received <= lock.satoshis) return 0n;
    const extraLiquidity = getExtraLiquidityMicrogons({
      lockSatoshis: lock.satoshis,
      lockLiquidityPromised: lock.liquidityPromised,
      receivedSatoshis: received,
    });
    if (extraLiquidity === null || extraLiquidity <= 0n) return 0n;
    const availableLiquidity = vault.availableBitcoinSpace();
    if (availableLiquidity <= 0n) return 0n;
    return extraLiquidity > availableLiquidity ? availableLiquidity : extraLiquidity;
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

  private async syncPendingFundingSignals(lock: IBitcoinLockRecord, apiClient?: ApiDecoration<'promise'>) {
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

  public isFundingExpiredStatus(lockOrStatus: Pick<IBitcoinLockRecord, 'status'> | BitcoinLockStatus): boolean {
    const status = typeof lockOrStatus === 'string' ? lockOrStatus : lockOrStatus.status;
    return [
      BitcoinLockStatus.LockExpiredWaitingForFunding,
      BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged,
    ].includes(status);
  }

  public isFundingReadyToResumeStatus(lockOrStatus: Pick<IBitcoinLockRecord, 'status'> | BitcoinLockStatus): boolean {
    const status = typeof lockOrStatus === 'string' ? lockOrStatus : lockOrStatus.status;
    return status === BitcoinLockStatus.LockFundingReadyToResume;
  }

  public isLockedStatus(lockRecord: Pick<IBitcoinLockRecord, 'status'>): boolean {
    return (
      lockRecord.status === BitcoinLockStatus.LockedAndIsMinting ||
      lockRecord.status === BitcoinLockStatus.LockedAndMinted
    );
  }

  public isFinishedStatus(lock: Pick<IBitcoinLockRecord, 'status'>): boolean {
    return lock.status === BitcoinLockStatus.Released;
  }

  public isInactiveForVaultDisplay(lock: Pick<IBitcoinLockRecord, 'status'>): boolean {
    return this.isFinishedStatus(lock) || lock.status === BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged;
  }

  public isReleaseStatus(lock: Pick<IBitcoinLockRecord, 'status'>): boolean {
    return lock.status === BitcoinLockStatus.Releasing || lock.status === BitcoinLockStatus.Released;
  }

  public getLockSatoshiAllowedVariance(): number | undefined {
    return this.#config?.lockSatoshiAllowedVariance;
  }

  private isMismatchCandidate(
    lock: IBitcoinLockRecord,
    receivedSatoshis: bigint | undefined,
    options: { defaultWhenVarianceMissing?: boolean } = {},
  ): boolean {
    if (receivedSatoshis === undefined) return false;

    const allowedVariance = this.getLockSatoshiAllowedVariance();
    if (allowedVariance == null) {
      return options.defaultWhenVarianceMissing ?? true;
    }

    const satoshiDiff =
      lock.satoshis >= receivedSatoshis ? lock.satoshis - receivedSatoshis : receivedSatoshis - lock.satoshis;
    return satoshiDiff > BigInt(allowedVariance);
  }

  private isMismatchCandidateSeenOnArgon(candidateRecord: IBitcoinUtxoRecord): boolean {
    if (candidateRecord.status === BitcoinUtxoStatus.Orphaned) return true;
    return !!candidateRecord.firstSeenOnArgonAt;
  }

  private getMismatchViewRecords(lock: IBitcoinLockRecord): IBitcoinUtxoRecord[] {
    const hasAcceptedFunding = !!this.getAcceptedFundingState(lock).record;
    const candidates = hasAcceptedFunding ? [] : this.utxoTracking.getFundingCandidateRecords(lock);
    const orphanedCandidates = hasAcceptedFunding
      ? []
      : this.utxoTracking.getUtxosForLock(lock).filter(candidate => {
          if (candidate.status !== BitcoinUtxoStatus.Orphaned) return false;
          return !candidates.some(existing => existing.id === candidate.id);
        });
    const lifecycleCandidates = this.getMismatchReturnState(lock).records.filter(candidate => {
      return (
        !candidates.some(existing => existing.id === candidate.id) &&
        !orphanedCandidates.some(existing => existing.id === candidate.id)
      );
    });
    return [...candidates, ...orphanedCandidates, ...lifecycleCandidates]
      .filter(candidate => this.isMismatchCandidate(lock, candidate.satoshis))
      .sort((a, b) => this.compareMismatchCandidates(a, b));
  }

  private findMismatchCandidateView(
    lock: IBitcoinLockRecord,
    candidateRecord: Pick<IBitcoinUtxoRecord, 'id' | 'txid' | 'vout'>,
  ): IBitcoinMismatchCandidateView | undefined {
    return this.getMismatchViewState(lock).candidates.find(candidate => {
      return (
        candidate.record.id === candidateRecord.id ||
        (candidate.record.txid === candidateRecord.txid && candidate.record.vout === candidateRecord.vout)
      );
    });
  }

  private isMismatchAcceptTxActive(txInfo?: TransactionInfo): boolean {
    if (!txInfo) return false;
    if (this.getTxFailureMessage(txInfo)) return false;
    return [TransactionStatus.Submitted, TransactionStatus.InBlock, TransactionStatus.Finalized].includes(
      txInfo.tx.status,
    );
  }

  private getMismatchError(lock: IBitcoinLockRecord): string | undefined {
    if (!lock.utxoId) return undefined;
    return this.data.mismatchErrorsByLockUtxoId[lock.utxoId];
  }

  private isMismatchCandidateReturning(record?: IBitcoinUtxoRecord): boolean {
    return (
      record?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon ||
      record?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin
    );
  }

  private compareMismatchCandidates(a: IBitcoinUtxoRecord, b: IBitcoinUtxoRecord): number {
    const blockHeightA = this.getMismatchCandidateOrderBlock(a);
    const blockHeightB = this.getMismatchCandidateOrderBlock(b);
    if (blockHeightA !== undefined && blockHeightB !== undefined && blockHeightA !== blockHeightB) {
      return blockHeightA - blockHeightB;
    }

    const seenAtDiff =
      (a.firstSeenOnArgonAt ?? a.firstSeenAt).getTime() - (b.firstSeenOnArgonAt ?? b.firstSeenAt).getTime();
    if (seenAtDiff !== 0) return seenAtDiff;

    const txidDiff = a.txid.localeCompare(b.txid);
    if (txidDiff !== 0) return txidDiff;

    if (a.vout !== b.vout) return a.vout - b.vout;
    return a.id - b.id;
  }

  private getMismatchCandidateOrderBlock(record: IBitcoinUtxoRecord): number | undefined {
    if (record.firstSeenOracleHeight !== undefined) {
      return record.firstSeenOracleHeight;
    }
    if (record.firstSeenBitcoinHeight > 0) {
      return record.firstSeenBitcoinHeight;
    }
    return undefined;
  }

  public async requestBitcoinRelease(args: {
    utxoId: number;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
  }): Promise<TransactionInfo | undefined> {
    const lockRecord = this.data.locksByUtxoId[args.utxoId];
    if (!lockRecord) {
      throw new Error(`No lock found with UTXO ID ${args.utxoId}`);
    }
    const txInfo = await this.runInQueueForUtxo(lockRecord, 60e3, async () => {
      if (!this.isLockedStatus(lockRecord)) {
        const existingTxInfo = this.#transactionTracker.data.txInfos.find(txInfo => {
          if (txInfo.tx.extrinsicType !== ExtrinsicType.BitcoinRequestRelease) return false;
          const metadata = txInfo.tx.metadataJson as { utxoId?: number } | undefined;
          return metadata?.utxoId === lockRecord.utxoId;
        });
        if (existingTxInfo) return existingTxInfo;
        throw new Error('This Bitcoin lock is not fully locked, so it cannot be released.');
      }

      const bitcoinLock = new BitcoinLock(lockRecord.lockDetails);
      const client = await getMainchainClient(false);
      const txResult = await bitcoinLock.requestRelease({
        ...args,
        client,
        priceIndex: this.#currency.priceIndex,
        releaseRequest: {
          toScriptPubkey: addressBytesHex(args.toScriptPubkey, this.bitcoinNetwork),
          bitcoinNetworkFee: args.bitcoinNetworkFee,
        },
        txSigner: await this.walletKeys.getLiquidLockingKeypair(),
        disableAutomaticTxTracking: true,
      });

      const txInfo = await this.#transactionTracker.trackTxResult({
        txResult,
        extrinsicType: ExtrinsicType.BitcoinRequestRelease,
        metadata: {
          utxoId: lockRecord.utxoId,
          toScriptPubkey: args.toScriptPubkey,
          bitcoinNetworkFee: args.bitcoinNetworkFee,
        },
      });

      return txInfo;
    });
    // Run post-finalization reconciliation even when reusing an existing tx so release metadata
    // is backfilled if a previous run exited before writing it (for example after an app restart).
    void this.onRequestedReleaseInBlock(lockRecord, txInfo);
    return txInfo;
  }

  public async acceptMismatchedFunding(
    lock: IBitcoinLockRecord,
    candidateRecord: IBitcoinUtxoRecord,
  ): Promise<TransactionInfo | undefined> {
    return await this.runInQueueForUtxo(lock, 60e3, () => this.acceptMismatchedFundingUnqueued(lock, candidateRecord));
  }

  public async requestMismatchOrphanReturnOnArgon(args: {
    lock: IBitcoinLockRecord;
    candidateRecord: IBitcoinUtxoRecord;
    toScriptPubkey: string;
    bitcoinNetworkFee?: bigint;
    feeRatePerSatVb?: bigint;
  }): Promise<TransactionInfo | undefined> {
    return await this.runInQueueForUtxo(args.lock, 90e3, () => this.requestMismatchOrphanReturnUnqueued(args));
  }

  public async resumeWaitingForFunding(lock: IBitcoinLockRecord): Promise<void> {
    await this.runInQueueForUtxo(lock, 30e3, () => this.resumeWaitingForFundingUnqueued(lock));
  }

  public async acknowledgeExpiredWaitingForFunding(lock: IBitcoinLockRecord): Promise<void> {
    await this.runInQueueForUtxo(lock, 30e3, () => this.acknowledgeExpiredWaitingForFundingUnqueued(lock));
  }

  public getLatestMismatchAcceptTxInfo(utxoId: number): TransactionInfo | undefined {
    const matches = this.#transactionTracker.data.txInfos.filter(txInfo =>
      this.isMismatchAcceptTxForUtxo(txInfo, utxoId),
    );
    return matches.at(-1);
  }

  private getMismatchAcceptTxInfoForCandidate(
    utxoId: number,
    candidateRecord: Pick<IBitcoinUtxoRecord, 'id' | 'txid' | 'vout'>,
  ): TransactionInfo | undefined {
    const matches = this.#transactionTracker.data.txInfos.filter(txInfo => {
      if (!this.isMismatchAcceptTxForUtxo(txInfo, utxoId)) return false;
      const metadata = txInfo.tx.metadataJson as { utxoId?: number; utxoRecordId?: number } | undefined;
      if (!metadata) return false;
      return metadata.utxoRecordId === candidateRecord.id;
    });
    return matches.at(-1);
  }

  private async reconcileMismatchState(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.utxoId) return;
    const utxoId = lock.utxoId;
    if (this.isFinishedStatus(lock) || this.isReleaseStatus(lock)) return;

    const table = await this.getTable();
    const returnState = this.getMismatchReturnState(lock);
    const activeOrphanedRecord = returnState.activeRecord;
    const latestOrphanedRecord = returnState.currentRecord;
    const acceptTx = this.getLatestMismatchAcceptTxInfo(utxoId);
    const acceptInProgress = this.isTxInProgress(acceptTx);
    const acceptFinalized = this.isTxFinalized(acceptTx);
    const acceptFailed = this.getTxFailureMessage(acceptTx);

    if (!this.getAcceptedFundingState(lock).record && acceptFinalized) {
      const metadata = acceptTx?.tx.metadataJson as { utxoRecordId?: number } | undefined;
      const acceptedUtxoRecordId = metadata?.utxoRecordId;
      const acceptedRecord =
        acceptedUtxoRecordId != null ? this.utxoTracking.getUtxoRecordById(acceptedUtxoRecordId) : undefined;
      if (acceptedRecord && acceptedRecord.lockUtxoId === utxoId) {
        await this.utxoTracking.setAcceptedFundingRecordForLock(lock, acceptedRecord);
        await this.ensureFundingUtxoRecordPointer(lock);
      }
    }

    const hasAcceptedFunding = !!this.getAcceptedFundingState(lock).record;
    const hasActiveOrphanedReturn = !!activeOrphanedRecord;
    const hasCompletedOrphanedReturn = !!returnState.completedRecord;

    if (acceptInProgress || acceptFinalized || hasActiveOrphanedReturn || hasCompletedOrphanedReturn) {
      this.clearMismatchError(utxoId);
    }

    if (activeOrphanedRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon) {
      const returnTx = this.getOrphanedReturnTxInfoForRecord(utxoId, activeOrphanedRecord);
      const returnFailure = this.getTxFailureMessage(returnTx);
      if (returnFailure) {
        await this.utxoTracking.setReleaseError(activeOrphanedRecord, returnFailure);
      }
    }

    if (hasCompletedOrphanedReturn) {
      if (this.isFundingWindowExpired(lock)) {
        if (lock.status === BitcoinLockStatus.LockFundingReadyToResume) {
          await table.setLockExpiredWaitingForFundingAcknowledged(lock);
        }
      } else if (lock.status !== BitcoinLockStatus.LockFundingReadyToResume) {
        await table.setLockFundingReadyToResume(lock);
      }
      return;
    }

    if (lock.status === BitcoinLockStatus.LockFundingReadyToResume) {
      return;
    }

    if (
      lock.status === BitcoinLockStatus.LockPendingFunding &&
      !hasAcceptedFunding &&
      !latestOrphanedRecord &&
      !!acceptFailed
    ) {
      this.setMismatchError(utxoId, acceptFailed);
      return;
    }

    const failedReturnCandidate =
      !hasAcceptedFunding && !latestOrphanedRecord
        ? this.getMismatchViewState(lock).candidates.find(candidate => candidate.canReturn)?.record
        : undefined;
    if (
      failedReturnCandidate?.statusError &&
      (failedReturnCandidate.requestedReleaseAtTick != null ||
        !!failedReturnCandidate.releaseToDestinationAddress ||
        failedReturnCandidate.releaseBitcoinNetworkFee != null ||
        !!failedReturnCandidate.releaseCosignVaultSignature ||
        !!failedReturnCandidate.releaseTxid)
    ) {
      this.setMismatchError(utxoId, failedReturnCandidate.statusError);
      return;
    }

    if (
      lock.status === BitcoinLockStatus.LockPendingFunding &&
      hasAcceptedFunding &&
      !latestOrphanedRecord &&
      !acceptInProgress
    ) {
      this.clearMismatchError(utxoId);
      await table.setLockedAndIsMinting(lock);
    }
  }

  private async acceptMismatchedFundingUnqueued(
    lock: IBitcoinLockRecord,
    candidateRecord: IBitcoinUtxoRecord,
  ): Promise<TransactionInfo | undefined> {
    if (!lock.utxoId) {
      throw new Error('This lock has no Bitcoin funding ID yet.');
    }
    const mismatchCandidateCount = this.utxoTracking.getFundingCandidateRecords(lock).length;
    if (mismatchCandidateCount > 1) {
      throw new Error(
        'Multiple mismatch candidates are pending. Return any candidates you do not want before accepting funding.',
      );
    }
    if (!this.findMismatchCandidateView(lock, candidateRecord)?.canAccept) {
      throw new Error('This mismatch candidate can no longer be locked for this funding request.');
    }
    const hasActiveReturn = !!this.getMismatchReturnState(lock).activeRecord;
    if (hasActiveReturn) {
      throw new Error('A mismatch return is already processing for this lock.');
    }

    const existing = this.getMismatchAcceptTxInfoForCandidate(lock.utxoId, candidateRecord);
    if (
      existing &&
      [TransactionStatus.Submitted, TransactionStatus.InBlock, TransactionStatus.Finalized].includes(existing.tx.status)
    ) {
      return existing;
    }

    this.clearMismatchError(lock.utxoId);
    const client = await getMainchainClient(false);
    const { tx, receivedSatoshis, increaseSatoshis } = await this.buildMismatchAcceptTx({
      client,
      lock,
      candidateRecord,
    });
    const txSigner = await this.walletKeys.getLiquidLockingKeypair();

    return await this.#transactionTracker.submitAndWatch({
      tx,
      txSigner,
      extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoUseAsFunding,
      metadata: {
        utxoId: lock.utxoId,
        utxoRecordId: candidateRecord.id,
        utxoRef: { txid: candidateRecord.txid, vout: candidateRecord.vout },
        receivedSatoshis,
        increaseSatoshis,
      },
    });
  }

  private async requestMismatchOrphanReturnUnqueued(args: {
    lock: IBitcoinLockRecord;
    candidateRecord: IBitcoinUtxoRecord;
    toScriptPubkey: string;
    bitcoinNetworkFee?: bigint;
    feeRatePerSatVb?: bigint;
  }): Promise<TransactionInfo | undefined> {
    const { lock } = args;
    const candidateRecord =
      this.utxoTracking
        .getUtxosForLock(lock)
        .find(record => record.txid === args.candidateRecord.txid && record.vout === args.candidateRecord.vout) ??
      args.candidateRecord;
    if (!lock.utxoId) {
      throw new Error('This lock has no Bitcoin funding ID yet.');
    }
    if (
      !this.isMismatchCandidate(lock, candidateRecord.satoshis) ||
      !this.findMismatchCandidateView(lock, candidateRecord)?.canReturn
    ) {
      throw new Error('This mismatch return is not currently available.');
    }

    const client = await getMainchainClient(false);
    let record: IBitcoinUtxoRecord | undefined;

    try {
      const request = await this.getMismatchOrphanReturnRequest({
        lock,
        candidateRecord,
        toScriptPubkey: args.toScriptPubkey,
        bitcoinNetworkFee: args.bitcoinNetworkFee,
        feeRatePerSatVb: args.feeRatePerSatVb,
      });

      const vaultSignature = await this.createVaultSignatureForOrphanReturn(lock, candidateRecord, {
        toScriptPubkey: request.toScriptPubkeyHex,
        bitcoinNetworkFee: request.bitcoinNetworkFee,
      });
      const tx = await this.buildMismatchOrphanReturnTx({
        client,
        lock,
        candidateRecord,
        request,
        vaultSignature,
      });

      if (
        [
          BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
          BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
          BitcoinUtxoStatus.ReleaseComplete,
        ].includes(candidateRecord.status)
      ) {
        return this.getOrphanedReturnTxInfoForRecord(lock.utxoId, candidateRecord);
      }

      await this.utxoTracking.setReleaseIsProcessingOnArgon(candidateRecord, {
        releaseToDestinationAddress: request.toScriptPubkeyHex,
        releaseBitcoinNetworkFee: request.bitcoinNetworkFee,
      });
      record = candidateRecord;

      const txSigner = await this.walletKeys.getLiquidLockingKeypair();
      const txInfo = await this.#transactionTracker.submitAndWatch({
        tx,
        txSigner,
        extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoRelease,
        metadata: {
          releaseKind: 'Orphan',
          utxoId: lock.utxoId,
          utxoRecordId: candidateRecord.id,
          utxoRef: request.utxoRef,
        },
      });

      void this.continueOrphanReleaseAfterArgonInclusion(
        lock,
        record,
        {
          toScriptPubkey: request.toScriptPubkeyHex,
          bitcoinNetworkFee: request.bitcoinNetworkFee,
          vaultSignature,
        },
        txInfo,
      );

      return txInfo;
    } catch (error) {
      if (record) {
        await this.utxoTracking.setReleaseError(record, String(error));
      }
      throw error;
    }
  }

  private async resumeWaitingForFundingUnqueued(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.utxoId) return;
    if (this.isFundingWindowExpired(lock)) {
      throw new Error('This funding request has expired and cannot be resumed. Start a new Bitcoin lock instead.');
    }
    if (lock.status !== BitcoinLockStatus.LockFundingReadyToResume) {
      throw new Error('This lock is not ready to resume funding yet.');
    }

    const utxoId = lock.utxoId;
    if (this.getMismatchReturnState(lock).activeRecord) {
      throw new Error('Mismatch return is still processing.');
    }

    const completedReturnRecord = this.getMismatchReturnState(lock).completedRecord;
    if (completedReturnRecord) {
      await this.utxoTracking.setReleaseCompleteAcknowledged(completedReturnRecord);
    }

    this.clearMismatchError(utxoId);
    const lockTable = await this.getTable();
    await lockTable.setLockPendingFunding(lock);
  }

  private async acknowledgeExpiredWaitingForFundingUnqueued(lock: IBitcoinLockRecord): Promise<void> {
    if (lock.status !== BitcoinLockStatus.LockExpiredWaitingForFunding) return;
    const completedReturnRecord = this.getMismatchReturnState(lock).completedRecord;
    if (completedReturnRecord) {
      await this.utxoTracking.setReleaseCompleteAcknowledged(completedReturnRecord);
    }
    const lockTable = await this.getTable();
    await lockTable.setLockExpiredWaitingForFundingAcknowledged(lock);
  }

  private async reconcileMismatchReturnOnBlock(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.utxoId) return;
    const records = this.getMismatchReturnState(lock).records.filter(
      record => record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
    );
    for (const record of records) {
      if (!record.releaseToDestinationAddress || record.releaseBitcoinNetworkFee == null) continue;
      const txInfo = this.getOrphanedReturnTxInfoForRecord(record.lockUtxoId, record);
      if (!txInfo) {
        if (record.requestedReleaseAtTick == null) {
          const recoveredFromChain = await this.syncOrphanReleaseRequestFromChain(lock, record);
          if (!recoveredFromChain) {
            await this.utxoTracking.setReleaseError(
              record,
              'Mismatch return was interrupted before submission. Please retry return or collect the adjusted amount.',
            );
            continue;
          }
        }
        await this.submitOrphanReleaseToBitcoin(lock, record, {
          toScriptPubkey: record.releaseToDestinationAddress,
          bitcoinNetworkFee: record.releaseBitcoinNetworkFee,
        });
      } else {
        const txFailure = this.getTxFailureMessage(txInfo);
        if (txFailure) {
          await this.utxoTracking.setReleaseError(record, txFailure);
          continue;
        }
        if (txInfo.tx.status !== TransactionStatus.Finalized) {
          continue;
        }
        await this.ensureOrphanReleaseObservedAtTick(record, txInfo);
        const vaultSignature =
          record.releaseCosignVaultSignature && record.releaseCosignHeight != null
            ? record.releaseCosignVaultSignature
            : await this.createVaultSignatureForOrphanReturn(lock, record, {
                toScriptPubkey: record.releaseToDestinationAddress,
                bitcoinNetworkFee: record.releaseBitcoinNetworkFee,
              });
        if (!record.releaseCosignVaultSignature || record.releaseCosignHeight == null) {
          await this.utxoTracking.setReleaseCosign(record, {
            releaseCosignVaultSignature: vaultSignature,
            releaseCosignHeight: txInfo.txResult.blockNumber!,
          });
        }
        await this.submitOrphanReleaseToBitcoin(lock, record, {
          toScriptPubkey: record.releaseToDestinationAddress,
          bitcoinNetworkFee: record.releaseBitcoinNetworkFee,
          vaultSignature,
        });
      }
    }
  }

  private async syncOrphanReturnBitcoinProcessing(oracleBitcoinBlockHeight: number): Promise<void> {
    await this.syncOrphanReleaseProcessingOnBitcoin({
      oracleBitcoinBlockHeight,
      getLockByUtxoId: utxoId => this.data.locksByUtxoId[utxoId],
    });
  }

  public async getTable(): Promise<BitcoinLocksTable> {
    const db = await this.dbPromise;
    return db.bitcoinLocksTable;
  }

  private async onRequestedReleaseInBlock(lock: IBitcoinLockRecord, txInfo: TransactionInfo): Promise<void> {
    const { txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    await this.ensureLockReleaseProcessing(lock);

    try {
      const blockHash = await txResult.waitForFinalizedBlock;
      const client = await getMainchainClient(true);
      const api = await client.at(blockHash);
      const bitcoinLock = new BitcoinLock(lock.lockDetails);
      const releaseRequest = await bitcoinLock.getReleaseRequest(api);
      if (!releaseRequest) {
        console.warn(`[BitcoinLocks] Missing canonical release request for ${lock.uuid} after finalization`);
        return;
      }
      const requestedReleaseAtTick = await api.query.ticks.currentTick().then(x => x.toNumber());
      const fundingRecord = await this.getFundingRecordOrThrow(lock);
      await this.utxoTracking.setReleaseRequest(fundingRecord, {
        requestedReleaseAtTick,
        releaseToDestinationAddress: releaseRequest.toScriptPubkey,
        releaseBitcoinNetworkFee: releaseRequest.bitcoinNetworkFee,
      });
      await this.ensureLockReleaseProcessing(lock);
    } finally {
      postProcessor.resolve();
    }
  }

  private async syncLockReleaseArgonRequest(
    lock: IBitcoinLockRecord,
    apiClient: ApiDecoration<'promise'>,
  ): Promise<void> {
    const fundingRecord = this.getAcceptedFundingRecord(lock);
    if (!fundingRecord) return;

    const bitcoinLock = new BitcoinLock(lock.lockDetails);
    const releaseRequest = await bitcoinLock.getReleaseRequest(apiClient);
    if (!releaseRequest) {
      await this.syncLockReleaseStatusFromFundingRecord(lock, fundingRecord);
      return;
    }

    const requestedReleaseAtTick = await apiClient.query.ticks.currentTick().then(x => x.toNumber());
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
    const txFailure = this.getTxFailureMessage(result.txInfo);
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
      const txFailure = this.getTxFailureMessage(txInfo);
      if (txFailure) {
        return;
      }
      if (txInfo.txResult.blockNumber == null) {
        return;
      }

      const fundingRecord = this.getAcceptedFundingRecord(lock);
      if (!fundingRecord) {
        return;
      }

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
      if (lock.status === BitcoinLockStatus.Released) continue;
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

  private async runInQueueForUtxo<T>(
    lockRecord: Pick<IBitcoinLockRecord, 'uuid'>,
    timeoutMs: number,
    task: () => Promise<T>,
  ): Promise<T> {
    const { uuid } = lockRecord;
    this.#txQueueByUuid[uuid] ??= new SingleFileQueue();
    return this.#txQueueByUuid[uuid].add(task, { timeoutMs }).promise;
  }

  private async checkIncomingArgonBlock(
    newestHeader: Pick<IBlockHeaderInfo, 'blockHash' | 'blockNumber'>,
  ): Promise<void> {
    if (newestHeader.blockNumber === 0) {
      return;
    }
    // We look at the previous block to give more time for blocks to settle so we don't bounce data around, but don't
    // wait for finality because of how long it can take. We might need to revisit this for anything where finality is
    // important.
    const generalClient = await this.blockWatch.getRpcClient(newestHeader.blockNumber - 1);
    const header = await this.blockWatch.getHeader(newestHeader.blockNumber - 1);

    if (header.blockNumber <= this.data.latestArgonBlockHeight) {
      return;
    }
    const table = await this.getTable();
    const archivedBitcoinBlockHeight = this.data.oracleBitcoinBlockHeight;
    this.data.latestArgonBlockHeight = header.blockNumber;

    const clientAt = await generalClient.at(header.blockHash);

    this.data.oracleBitcoinBlockHeight = await clientAt.query.bitcoinUtxos
      .confirmedBitcoinBlockTip()
      .then(x => (x.isSome ? (x.value?.blockHeight.toNumber() ?? 0) : 0));

    const hasNewOracleBitcoinBlockHeight = archivedBitcoinBlockHeight !== this.data.oracleBitcoinBlockHeight;

    const promises = Object.values(this.data.locksByUtxoId)
      .map(lockRecord => {
        if (lockRecord.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
          // waiting for a utxo to be found
          return undefined;
        }
        return this.runInQueueForUtxo(lockRecord, 30e3, async () => {
          const isPendingFunding = lockRecord.status === BitcoinLockStatus.LockPendingFunding;
          const shouldTrackFundingSignals = this.isFundingSignalTrackingStatus(lockRecord.status);
          const shouldSyncLockingState = this.isLockedStatus(lockRecord) || isPendingFunding;

          // Phase 1: lock sync.
          if (shouldSyncLockingState) {
            await this.updateLockingStatus(lockRecord, clientAt).catch(err =>
              console.warn(`[BitcoinLocks] Error updating locking status for utxo ${lockRecord.uuid}`, err),
            );
          }

          // Phase 2: funding sync.
          if (!lockRecord.fundingUtxoRecordId) {
            await this.ensureFundingUtxoRecordPointer(lockRecord).catch(err =>
              console.warn(`[BitcoinLocks] Error linking funding UTXO record for utxo ${lockRecord.uuid}`, err),
            );
          }
          if (shouldTrackFundingSignals && hasNewOracleBitcoinBlockHeight) {
            await this.utxoTracking.updateFundingLastConfirmationCheck(lockRecord).catch(err => {
              console.warn(`[BitcoinLocks] Error updating funding confirmation check for utxo ${lockRecord.uuid}`, err);
            });
          }
          if (shouldTrackFundingSignals) {
            await this.syncPendingFundingSignals(lockRecord, clientAt).catch(err => {
              console.warn(`[BitcoinLocks] Error syncing funding signals for utxo ${lockRecord.uuid}`, err);
            });
          }

          // Phase 3: mismatch sync.
          await this.reconcileMismatchState(lockRecord).catch(err => {
            console.warn(`[BitcoinLocks] Error reconciling mismatch state for utxo ${lockRecord.uuid}`, err);
          });

          // Phase 4: mismatch return sync.
          await this.reconcileMismatchReturnOnBlock(lockRecord).catch(err => {
            console.warn(`[BitcoinLocks] Error reconciling mismatch return for utxo ${lockRecord.uuid}`, err);
          });

          // Phase 5: accepted funding release sync.
          await this.reconcileAcceptedFundingReleaseOnBlock(lockRecord, hasNewOracleBitcoinBlockHeight).catch(err => {
            console.warn(`[BitcoinLocks] Error reconciling accepted release for utxo ${lockRecord.uuid}`, err);
          });

          // Phase 6: mint sync.
          await this.syncMintPendingState(lockRecord, table, clientAt);
        }).catch(err => {
          console.warn(`[BitcoinLocks] Error processing lock for utxo ${lockRecord.uuid}`, err);
        });
      })
      .filter(x => x !== undefined);
    if (hasNewOracleBitcoinBlockHeight) {
      await this.syncOrphanReturnBitcoinProcessing(this.data.oracleBitcoinBlockHeight);
    }
    await Promise.allSettled(promises);
  }

  private async syncMintPendingState(
    lockRecord: IBitcoinLockRecord,
    table: BitcoinLocksTable,
    clientAt: ApiDecoration<'promise'>,
  ): Promise<void> {
    const localPendingMint = lockRecord.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
    if (localPendingMint <= 0n) return;

    const fundingRecord = this.utxoTracking.getAcceptedFundingRecordForLock(lockRecord);
    if (!fundingRecord) return;

    const bitcoinLock = new BitcoinLock(lockRecord.lockDetails);
    const chainPendingArray = await bitcoinLock.findPendingMints(clientAt);
    const chainPendingMint = chainPendingArray.reduce((sum, x) => sum + x, 0n);

    let amountFulfilled = localPendingMint - chainPendingMint;
    // Account for fulfilled pending mint by walking ratchets oldest -> newest.
    for (const ratchet of lockRecord.ratchets) {
      if (chainPendingMint === 0n) {
        ratchet.mintPending = 0n;
        continue;
      }
      if (amountFulfilled === 0n) break;
      if (ratchet.mintPending > 0) {
        if (amountFulfilled >= ratchet.mintPending) {
          amountFulfilled -= ratchet.mintPending;
          ratchet.mintPending = 0n;
        } else {
          ratchet.mintPending -= amountFulfilled;
          amountFulfilled = 0n;
        }
      }
    }

    await table.updateMintState(lockRecord).catch(err => {
      console.warn(`[BitcoinLocks] Error updating mint state for utxo ${lockRecord.uuid}`, err);
    });
  }

  private async tryUpdateFundingUtxo(
    lock: IBitcoinLockRecord,
    apiClient: ApiDecoration<'promise'>,
    latestBitcoinLock?: BitcoinLock,
  ): Promise<void> {
    if (lock.fundingUtxoRecordId) return;

    latestBitcoinLock ??= await BitcoinLock.get(apiClient, lock.utxoId!);
    if (!latestBitcoinLock) return;
    const utxoRef = await latestBitcoinLock.getFundingUtxoRef(apiClient);
    if (!utxoRef) return;

    if (latestBitcoinLock.utxoSatoshis) {
      lock.satoshis = latestBitcoinLock.satoshis;
    }
    lock.lockDetails = latestBitcoinLock;
    lock.lockedMarketRate = latestBitcoinLock.lockedMarketRate;
    lock.liquidityPromised = latestBitcoinLock.liquidityPromised;
    lock.ratchets[0].lockedMarketRate = latestBitcoinLock.lockedMarketRate;
    lock.ratchets[0].mintAmount = latestBitcoinLock.liquidityPromised;
    lock.ratchets[0].mintPending = latestBitcoinLock.liquidityPromised;
    const fundingRecord = await this.utxoTracking.upsertUtxoRecord(
      lock,
      {
        txid: utxoRef.txid,
        vout: utxoRef.vout,
        satoshis: latestBitcoinLock.utxoSatoshis ?? lock.satoshis,
      },
      { markFundingUtxo: true },
    );
    await this.utxoTracking.setAcceptedFundingRecordForLock(lock, fundingRecord);
    const table = await this.getTable();
    await table.setLockedAndIsMinting(lock);
  }

  private async ensureFundingUtxoRecordPointer(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.utxoId) return;
    if (lock.fundingUtxoRecordId) return;
    const record = this.getAcceptedFundingRecord(lock);
    if (!record) return;
    lock.fundingUtxoRecord = record;
    const table = await this.getTable();
    await table.setFundingUtxoRecordId(lock, record.id);
  }

  private async updateLockingStatus(lock: IBitcoinLockRecord, finalizedApi: ApiDecoration<'promise'>): Promise<void> {
    if (lock.fundingUtxoRecordId) return;

    const bitcoinLock = await BitcoinLock.get(finalizedApi, lock.utxoId!);
    if (!bitcoinLock) {
      const table = await this.getTable();
      console.warn(`Lock with ID ${lock.utxoId} not found`);
      if (lock.status === BitcoinLockStatus.LockPendingFunding) {
        await table.setLockExpiredWaitingForFunding(lock);
      }
      return;
    }

    if (!bitcoinLock.isFunded) {
      return;
    }
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
    const lockTable = await this.getTable();
    await lockTable.setStatus(lock, BitcoinLockStatus.Releasing);
  }

  private async buildMismatchAcceptTx(args: {
    client: ArgonClient;
    lock: IBitcoinLockRecord;
    candidateRecord: IBitcoinUtxoRecord;
  }): Promise<{ tx: SubmittableExtrinsic; receivedSatoshis: bigint; increaseSatoshis?: bigint }> {
    const { client, lock, candidateRecord } = args;
    if (!lock.utxoId) {
      throw new Error('This lock has no Bitcoin funding ID yet.');
    }

    const txs: SubmittableExtrinsic[] = [];
    let increaseSatoshis: bigint | undefined;
    const receivedSatoshis = candidateRecord.satoshis;

    if (receivedSatoshis > lock.satoshis) {
      const increaseMicrogons = this.getIncreaseSecuritizationMicrogons(lock, candidateRecord) ?? 0n;
      if (increaseMicrogons > 0n) {
        const additionalSatoshis = this.getSatoshisForLiquidityAtLockRate(lock, increaseMicrogons);
        increaseSatoshis = lock.satoshis + additionalSatoshis;
        if (increaseSatoshis > receivedSatoshis) {
          increaseSatoshis = receivedSatoshis;
        }
        if (increaseSatoshis > lock.satoshis) {
          const increaseTx = await BitcoinLock.createIncreaseSecuritizationTx({
            client,
            utxoId: lock.utxoId,
            newSatoshis: increaseSatoshis,
          });
          if (!increaseTx) {
            throw new Error('Increase securitization is not supported on this chain.');
          }
          txs.push(increaseTx);
        }
      }
    }

    const fundTx = await BitcoinLock.createFundWithUtxoCandidateTx({
      client,
      utxoId: lock.utxoId,
      utxoRef: { txid: candidateRecord.txid, outputIndex: candidateRecord.vout },
    });
    if (!fundTx) {
      throw new Error('Funding mismatch acceptance is not supported on this chain.');
    }
    txs.push(fundTx);

    return {
      tx: txs.length > 1 ? client.tx.utility.batchAll(txs) : txs[0],
      receivedSatoshis,
      increaseSatoshis,
    };
  }

  private async getMismatchOrphanReturnRequest(args: {
    lock: IBitcoinLockRecord;
    candidateRecord: IBitcoinUtxoRecord;
    toScriptPubkey: string;
    bitcoinNetworkFee?: bigint;
    feeRatePerSatVb?: bigint;
  }): Promise<{ utxoRef: { txid: string; vout: number }; toScriptPubkeyHex: string; bitcoinNetworkFee: bigint }> {
    const { lock, candidateRecord, toScriptPubkey } = args;
    const utxoRef = this.getUtxoRef(candidateRecord);
    const toScriptPubkeyHex = addressBytesHex(toScriptPubkey, this.bitcoinNetwork);
    const bitcoinNetworkFee =
      args.bitcoinNetworkFee ??
      (await this.calculateBitcoinNetworkFee(lock, args.feeRatePerSatVb ?? 5n, toScriptPubkey));

    return {
      utxoRef,
      toScriptPubkeyHex,
      bitcoinNetworkFee,
    };
  }

  private async buildMismatchOrphanReturnTx(args: {
    client: ArgonClient;
    lock: IBitcoinLockRecord;
    candidateRecord: Pick<IBitcoinUtxoRecord, 'txid' | 'vout'>;
    request: { utxoRef: { txid: string; vout: number }; toScriptPubkeyHex: string; bitcoinNetworkFee: bigint };
    vaultSignature: Uint8Array;
  }): Promise<SubmittableExtrinsic> {
    if (!args.lock.lockDetails?.ownerAccount) {
      throw new Error('Missing lock owner account needed for orphan release.');
    }
    const txs: SubmittableExtrinsic[] = [];
    const candidateRefs = await args.client.query.bitcoinUtxos.candidateUtxoRefsByUtxoId(args.lock.utxoId!);
    const candidateStillOnChain =
      !!candidateRefs &&
      [...candidateRefs.entries()].some(([utxoRef]) => {
        return (
          utxoRef.txid.toHex() === args.request.utxoRef.txid &&
          utxoRef.outputIndex.toNumber() === args.request.utxoRef.vout
        );
      });
    if (candidateStillOnChain) {
      txs.push(
        args.client.tx.bitcoinUtxos.rejectUtxoCandidate(args.lock.utxoId!, {
          txid: args.request.utxoRef.txid,
          outputIndex: args.request.utxoRef.vout,
        }),
      );
    }
    const requestTx = await BitcoinLock.createOrphanedUtxoReleaseRequestTx({
      client: args.client,
      utxoRef: { txid: args.request.utxoRef.txid, outputIndex: args.request.utxoRef.vout },
      releaseRequest: {
        toScriptPubkey: args.request.toScriptPubkeyHex,
        bitcoinNetworkFee: args.request.bitcoinNetworkFee,
      },
    });
    if (!requestTx) {
      throw new Error('Orphan release is not supported on this chain.');
    }
    const cosignTx = await BitcoinLock.createOrphanedUtxoCosignTx({
      client: args.client,
      orphanOwner: args.lock.lockDetails.ownerAccount,
      utxoRef: { txid: args.request.utxoRef.txid, outputIndex: args.request.utxoRef.vout },
      vaultSignature: args.vaultSignature,
    });
    if (!cosignTx) {
      throw new Error('Orphan release is not supported on this chain.');
    }
    txs.push(requestTx, cosignTx);
    return args.client.tx.utility.batchAll(txs);
  }

  private async createVaultSignatureForOrphanReturn(
    lock: IBitcoinLockRecord,
    candidateRecord: Pick<IBitcoinUtxoRecord, 'txid' | 'vout' | 'satoshis'>,
    releaseRequest: { toScriptPubkey: string; bitcoinNetworkFee: bigint },
  ): Promise<Uint8Array> {
    const vault = this.myVault;
    if (!vault) {
      throw new Error('No vault available to cosign this release.');
    }
    const vaultSignature = await vault.createVaultSignatureForMyOrphanedUtxoRelease({
      lock,
      txid: candidateRecord.txid,
      vout: candidateRecord.vout,
      satoshis: candidateRecord.satoshis,
      toScriptPubkey: releaseRequest.toScriptPubkey,
      bitcoinNetworkFee: releaseRequest.bitcoinNetworkFee,
    });
    if (!vaultSignature) {
      throw new Error('Failed to generate vault signature for orphan release.');
    }
    return vaultSignature;
  }

  private async syncOrphanReleaseProcessingOnBitcoin(args: {
    oracleBitcoinBlockHeight: number;
    getLockByUtxoId: (utxoId: number) => IBitcoinLockRecord | undefined;
  }): Promise<void> {
    const records = this.utxoTracking.getAllOrphanLifecycleUtxos();
    const tasks = records
      .filter(record => {
        if (record.status !== BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) return false;
        const lock = args.getLockByUtxoId(record.lockUtxoId);
        return record.id !== this.getAcceptedFundingState(lock).recordId;
      })
      .map(record => {
        const lock = args.getLockByUtxoId(record.lockUtxoId);
        const task = async () => {
          if (!lock || !record.releaseTxid) return;
          try {
            await this.utxoTracking.updateReleaseLastConfirmationCheck(record);
          } catch (err) {
            console.warn(`[BitcoinLocks] Error updating orphan return confirmation check`, err);
          }

          const mempoolTxStatus = await this.#mempool
            .getTxStatus(record.releaseTxid, args.oracleBitcoinBlockHeight)
            .catch(() => undefined);
          if (mempoolTxStatus?.isConfirmed) {
            await this.utxoTracking.setReleaseComplete(record, mempoolTxStatus.transactionBlockHeight);
          }
        };
        return task();
      });
    await Promise.allSettled(tasks);
  }

  private async ensureOrphanReleaseObservedAtTick(record: IBitcoinUtxoRecord, txInfo: TransactionInfo): Promise<void> {
    if (record.requestedReleaseAtTick != null) return;
    if (!record.releaseToDestinationAddress || record.releaseBitcoinNetworkFee == null) return;

    const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
    const client = await getMainchainClient(false);
    const api = await client.at(blockHash);
    const requestedReleaseAtTick = await api.query.ticks.currentTick().then(x => x.toNumber());

    await this.utxoTracking.setReleaseIsProcessingOnArgon(record, {
      requestedReleaseAtTick,
      releaseToDestinationAddress: record.releaseToDestinationAddress,
      releaseBitcoinNetworkFee: record.releaseBitcoinNetworkFee,
    });
  }

  private async syncOrphanReleaseRequestFromChain(
    lock: IBitcoinLockRecord,
    record: IBitcoinUtxoRecord,
  ): Promise<boolean> {
    if (record.requestedReleaseAtTick != null) return true;

    const client = await getMainchainClient(true);
    const orphanMaybe = await client.query.bitcoinLocks.orphanedUtxosByAccount(lock.lockDetails.ownerAccount, {
      txid: record.txid,
      outputIndex: record.vout,
    });
    if (!orphanMaybe.isSome) return false;

    const orphan = orphanMaybe.unwrap();
    if (orphan.utxoId.toNumber() !== lock.utxoId) return false;
    if (orphan.cosignRequest.isNone) return false;

    const request = orphan.cosignRequest.unwrap();
    const blockHash = await client.rpc.chain.getBlockHash(request.createdAtArgonBlockNumber.toNumber());
    const apiAt = await client.at(blockHash);
    const requestedReleaseAtTick = await apiAt.query.ticks.currentTick().then(x => x.toNumber());

    await this.utxoTracking.setReleaseIsProcessingOnArgon(record, {
      requestedReleaseAtTick,
      releaseToDestinationAddress: u8aToHex(request.toScriptPubkey, undefined, false),
      releaseBitcoinNetworkFee: request.bitcoinNetworkFee.toBigInt(),
    });
    return true;
  }

  private async submitOrphanReleaseToBitcoin(
    lock: IBitcoinLockRecord,
    record: IBitcoinUtxoRecord,
    args: { toScriptPubkey: string; bitcoinNetworkFee: bigint; vaultSignature?: Uint8Array },
  ): Promise<void> {
    try {
      const vaultSignature =
        args.vaultSignature ??
        (record.releaseCosignVaultSignature && record.releaseCosignHeight != null
          ? record.releaseCosignVaultSignature
          : undefined) ??
        (await this.createVaultSignatureForOrphanReturn(lock, record, {
          toScriptPubkey: args.toScriptPubkey,
          bitcoinNetworkFee: args.bitcoinNetworkFee,
        }));
      const ownerXpriv = await this.walletKeys.getBitcoinChildXpriv(lock.hdPath, this.bitcoinNetwork);
      const utxoRef = this.getUtxoRef(record);
      const cosign = new CosignScript({ ...lock.lockDetails, utxoSatoshis: record.satoshis }, this.bitcoinNetwork);
      const tx = cosign.cosignAndGenerateTx({
        releaseRequest: {
          toScriptPubkey: args.toScriptPubkey,
          bitcoinNetworkFee: args.bitcoinNetworkFee,
        },
        vaultCosignature: vaultSignature,
        utxoRef,
        ownerXpriv,
      });
      if (!tx || !tx.isFinal) {
        throw new Error('Failed to generate orphan release transaction.');
      }

      const txid = tx.id;
      const hexTx = u8aToHex(tx.toBytes(true, true), undefined, false);
      const existingTxStatus = await this.#mempool
        .getTxStatus(txid, this.oracleBitcoinBlockHeight)
        .catch(() => undefined);
      if (existingTxStatus?.isConfirmed) {
        const mempoolTip = await this.#mempool.getTipHeight().catch(() => this.oracleBitcoinBlockHeight);
        await this.utxoTracking.setReleaseSeenOnBitcoinAndProcessing(record, txid, mempoolTip);
        return;
      }

      let bitcoinTxid: string;
      try {
        bitcoinTxid = await this.#mempool.broadcastTx(hexTx);
      } catch (error) {
        if (!this.isAlreadyBroadcastBitcoinTxError(error)) throw error;
        bitcoinTxid = txid;
      }
      const mempoolTip = await this.#mempool.getTipHeight().catch(() => this.oracleBitcoinBlockHeight);
      await this.utxoTracking.setReleaseSeenOnBitcoinAndProcessing(record, bitcoinTxid, mempoolTip);
    } catch (error) {
      await this.utxoTracking.setReleaseError(record, String(error));
    }
  }

  private async continueOrphanReleaseAfterArgonInclusion(
    lock: IBitcoinLockRecord,
    record: IBitcoinUtxoRecord,
    args: { toScriptPubkey: string; bitcoinNetworkFee: bigint; vaultSignature: Uint8Array },
    txInfo: TransactionInfo,
  ): Promise<void> {
    try {
      await txInfo.txResult.waitForInFirstBlock;
      const txFailure = this.getTxFailureMessage(txInfo);
      if (txFailure) {
        await this.utxoTracking.setReleaseError(record, txFailure);
        return;
      }

      await this.ensureOrphanReleaseObservedAtTick(record, txInfo);
      await this.utxoTracking.setReleaseCosign(record, {
        releaseCosignVaultSignature: args.vaultSignature,
        releaseCosignHeight: txInfo.txResult.blockNumber!,
      });
      await this.submitOrphanReleaseToBitcoin(lock, record, args);
    } catch (error) {
      await this.utxoTracking.setReleaseError(record, String(error));
    }
  }

  private getUtxoRef(record: Pick<IBitcoinUtxoRecord, 'txid' | 'vout'>): { txid: string; vout: number } {
    return { txid: record.txid, vout: record.vout };
  }

  private isAlreadyBroadcastBitcoinTxError(error: unknown): boolean {
    const message = String(error ?? '').toLowerCase();
    return (
      message.includes('txn-already-in-mempool') ||
      message.includes('txn-already-known') ||
      message.includes('already in mempool') ||
      message.includes('already known') ||
      message.includes('already have transaction')
    );
  }

  private async getReleaseCosignOnChain(
    lock: IBitcoinLockRecord,
    archiveClient?: ArgonClient,
  ): Promise<{ blockHeight: number; signature: Uint8Array } | undefined> {
    archiveClient ??= await getMainchainClient(true);
    const bitcoinLock = new BitcoinLock(lock.lockDetails);
    return await bitcoinLock.findVaultCosignSignature(archiveClient, true);
  }

  private getSatoshisForLiquidityAtLockRate(lock: IBitcoinLockRecord, microgons: bigint): bigint {
    if (lock.satoshis <= 0n || lock.liquidityPromised <= 0n) return 0n;
    return (microgons * lock.satoshis) / lock.liquidityPromised;
  }

  private isMismatchAcceptTxForUtxo(txInfo: TransactionInfo, utxoId: number): boolean {
    if (txInfo.tx.extrinsicType !== ExtrinsicType.BitcoinOrphanedUtxoUseAsFunding) return false;
    const metadata = txInfo.tx.metadataJson as { utxoId?: number } | undefined;
    return metadata?.utxoId === utxoId;
  }

  private getAcceptedFundingState(lock?: IBitcoinLockRecord): IAcceptedFundingState {
    if (!lock) return { record: undefined, recordId: undefined };
    const record = this.getAcceptedFundingRecord(lock);
    return {
      record,
      recordId: record?.id ?? lock.fundingUtxoRecordId ?? undefined,
    };
  }

  private getMismatchReturnState(
    lock: IBitcoinLockRecord,
    candidateRecord?: Pick<IBitcoinUtxoRecord, 'id' | 'txid' | 'vout'>,
  ): IMismatchReturnState {
    if (!lock.utxoId) {
      return { records: [] };
    }

    const records = this.utxoTracking.getMismatchOrphanReleases(
      lock.utxoId,
      candidateRecord,
      this.getAcceptedFundingState(lock).recordId,
    );

    let activeRecord: IBitcoinUtxoRecord | undefined;
    let completedRecord: IBitcoinUtxoRecord | undefined;
    for (const record of records) {
      if (!activeRecord && this.isMismatchOrphanProcessingRecordActive(lock.utxoId, record)) {
        activeRecord = record;
      }
      if (!completedRecord && record.status === BitcoinUtxoStatus.ReleaseComplete) {
        completedRecord = record;
      }
      if (activeRecord && completedRecord) break;
    }

    return {
      records,
      activeRecord,
      completedRecord,
      currentRecord: activeRecord ?? completedRecord,
    };
  }

  private isMismatchPhaseStatus(status: BitcoinLockStatus): boolean {
    return [
      BitcoinLockStatus.LockPendingFunding,
      BitcoinLockStatus.LockExpiredWaitingForFunding,
      BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged,
    ].includes(status);
  }

  private isFundingSignalTrackingStatus(status: BitcoinLockStatus): boolean {
    return [
      BitcoinLockStatus.LockPendingFunding,
      BitcoinLockStatus.LockExpiredWaitingForFunding,
      BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged,
    ].includes(status);
  }

  private isTxInProgress(txInfo?: TransactionInfo): boolean {
    if (!txInfo) return false;
    return [TransactionStatus.Submitted, TransactionStatus.InBlock].includes(txInfo.tx.status);
  }

  private isTxFinalized(txInfo?: TransactionInfo): boolean {
    if (!txInfo) return false;
    return txInfo.tx.status === TransactionStatus.Finalized && !this.getTxFailureMessage(txInfo);
  }

  private isMismatchOrphanProcessingRecordActive(utxoId: number, record: IBitcoinUtxoRecord): boolean {
    if (record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
      return !!record.releaseTxid;
    }
    if (record.status !== BitcoinUtxoStatus.ReleaseIsProcessingOnArgon) return false;
    const txInfo = this.getOrphanedReturnTxInfoForRecord(utxoId, record);
    if (!txInfo) return true;
    if (this.getTxFailureMessage(txInfo)) return false;
    return this.isTxInProgress(txInfo) || this.isTxFinalized(txInfo);
  }

  private getTxFailureMessage(txInfo?: TransactionInfo): string | undefined {
    if (!txInfo) return undefined;
    const submissionError = txInfo.txResult.submissionError;
    if (submissionError) return submissionError.message || String(submissionError);
    const extrinsicError = txInfo.txResult.extrinsicError;
    if (extrinsicError) {
      const details = (extrinsicError as { details?: string; message?: string }).details;
      if (details) return details;
      return extrinsicError.message || String(extrinsicError);
    }
    if ([TransactionStatus.Error, TransactionStatus.TimedOutWaitingForBlock].includes(txInfo.tx.status)) {
      return `Transaction ended with status ${txInfo.tx.status}.`;
    }
    return undefined;
  }

  private setMismatchError(lockUtxoId: number, error: string): void {
    this.data.mismatchErrorsByLockUtxoId[lockUtxoId] = error;
  }

  private clearMismatchError(lockUtxoId: number): void {
    delete this.data.mismatchErrorsByLockUtxoId[lockUtxoId];
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

export type IBitcoinLocksMismatchInspect = Pick<BitcoinLocks, 'load' | 'getLockMismatchState' | 'getActiveLocks'>;
export type IBitcoinLocksUnlockReleaseInspect = Pick<
  BitcoinLocks,
  'load' | 'getLockUnlockReleaseState' | 'getActiveLocks'
>;
export type IBitcoinLocksUnlockDetailsInspect = Pick<BitcoinLocks, 'load' | 'getVaultUnlockStateDetails'>;
export type IBitcoinLocksVarianceInspect = Pick<BitcoinLocks, 'load' | 'getLockSatoshiAllowedVariance'>;

function isBitcoinLockRelayStatus(status: IBitcoinLockCouponStatus['status']): status is BitcoinLockRelayStatus {
  return status === 'Submitted' || status === 'InBlock' || status === 'Finalized' || status === 'Failed';
}

function getExtraLiquidityMicrogons(args: {
  lockSatoshis: bigint;
  lockLiquidityPromised: bigint;
  receivedSatoshis: bigint;
}): bigint | null {
  const { lockSatoshis, lockLiquidityPromised, receivedSatoshis } = args;
  if (lockSatoshis <= 0n || lockLiquidityPromised <= 0n) return null;
  if (receivedSatoshis <= lockSatoshis) return 0n;
  const extraSatoshis = receivedSatoshis - lockSatoshis;
  return (lockLiquidityPromised * extraSatoshis) / lockSatoshis;
}
