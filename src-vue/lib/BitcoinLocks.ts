import { getMainchainClient } from '../stores/mainchain.ts';
import {
  addressBytesHex,
  BitcoinNetwork,
  CosignScript,
  getBitcoinNetworkFromApi,
  getCompressedPubkey,
  p2wshScriptHexToAddress,
} from '@argonprotocol/bitcoin';
import {
  ApiDecoration,
  ArgonClient,
  BitcoinLock,
  formatArgons,
  type IBitcoinLockConfig,
  ITxProgressCallback,
  KeyringPair,
  Vault,
  u8aToHex,
} from '@argonprotocol/mainchain';
import { Db } from './Db.ts';
import { BitcoinLocksTable, BitcoinLockStatus, IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import BitcoinUtxoTracking from './BitcoinUtxoTracking.ts';
import BitcoinMempool from './BitcoinMempool.ts';
import { getVaults } from '../stores/vaults.ts';
import { BITCOIN_BLOCK_MILLIS, ESPLORA_HOST } from './Env.ts';
import {
  bigNumberToBigInt,
  BlockWatch,
  createDeferred,
  Currency as CurrencyBase,
  IBlockHeaderInfo,
  IDeferred,
  MiningFrames,
  SATOSHIS_PER_BITCOIN,
  SingleFileQueue,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { TransactionTracker } from './TransactionTracker.ts';
import { WalletKeys } from './WalletKeys.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { MyVault } from './MyVault.ts';
import { type IBitcoinUtxoRecord } from './db/BitcoinUtxosTable.ts';

export default class BitcoinLocks {
  public data: {
    pendingLock: IBitcoinLockRecord | undefined;
    locksByUtxoId: { [utxoId: number]: IBitcoinLockRecord };
    oracleBitcoinBlockHeight: number;
    bitcoinNetwork: BitcoinNetwork;
    latestArgonBlockHeight: number;
  };

  public get bitcoinNetwork() {
    return this.data.bitcoinNetwork;
  }

  public get recordCount() {
    return Object.keys(this.locksByUtxoId).length + (this.data.pendingLock ? 1 : 0);
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
  #mempool: BitcoinMempool;
  #reportedMissingFundingForReleaseLocks = new Set<string>();

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly walletKeys: WalletKeys,
    private readonly blockWatch: BlockWatch,
    currency: CurrencyBase,
    transactionTracker: TransactionTracker,
  ) {
    this.#currency = currency;
    this.#transactionTracker = transactionTracker;
    this.data = {
      pendingLock: undefined,
      locksByUtxoId: {},
      oracleBitcoinBlockHeight: 0,
      bitcoinNetwork: BitcoinNetwork.Bitcoin,
      latestArgonBlockHeight: 0,
    };
    this.#mempool = new BitcoinMempool(ESPLORA_HOST);
    this.utxoTracking = new BitcoinUtxoTracking({
      dbPromise,
      getBitcoinNetwork: () => this.bitcoinNetwork,
      getOracleBitcoinBlockHeight: () => this.oracleBitcoinBlockHeight,
      getConfig: () => this.#config,
      getMainchainClient,
      mempool: this.#mempool,
    });
  }

  public getActiveLocksForVault(vaultId: number): IBitcoinLockRecord[] {
    const locks = Object.values(this.data.locksByUtxoId);
    if (this.data.pendingLock?.vaultId === vaultId) {
      locks.unshift(this.data.pendingLock);
    }
    locks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return locks.filter(lock => {
      return lock.vaultId === vaultId && !this.isFinishedStatus(lock);
    });
  }

  public getLockByUtxoId(utxoId: number): IBitcoinLockRecord | undefined {
    return this.data.locksByUtxoId[utxoId];
  }

  public approximateExpirationTime(lock: IBitcoinLockRecord): number {
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

  public verifyExpirationTime(lock: IBitcoinLockRecord) {
    if (!this.#config) {
      throw new Error('Bitcoin lock configuration is not loaded for verify time.');
    }
    const expirationHeight = this.#config.pendingConfirmationExpirationBlocks + lock.lockDetails.createdAtHeight;

    if (expirationHeight <= this.oracleBitcoinBlockHeight) {
      return Date.now() - 1; // Already expired
    }
    return Date.now() + (expirationHeight - this.oracleBitcoinBlockHeight) * BITCOIN_BLOCK_MILLIS;
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
      this.utxoTracking.updateSupportsCandidateUtxos(latestClient);
      this.#lockTicksPerDay = archiveClient.consts.bitcoinLocks.argonTicksPerDay.toNumber();
      this.data.bitcoinNetwork = getBitcoinNetworkFromApi(this.#config.bitcoinNetwork);

      const table = await this.getTable();
      const locks = await table.fetchAll();
      for (const lock of locks) {
        if (lock.utxoId) {
          this.locksByUtxoId[lock.utxoId] = lock;
        } else {
          this.data.pendingLock = lock;
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
          await this.onRequestedReleaseInBlock(lock, txInfo, tx.metadataJson);
        }
      }

      await this.blockWatch.start();
      await this.#blockQueue.add(() => this.checkIncomingArgonBlock(this.blockWatch.bestBlockHeader), {
        timeoutMs: 120e3,
      }).promise;
      for (const lock of Object.values(this.locksByUtxoId)) {
        await this.reconcilePendingFundingState(lock);
        await this.reconcileLockReleasePhasesOnBlock(lock, false);
      }
      await this.syncLockReleaseBitcoinProcessing(this.locksByUtxoId);
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
    argonKeyring: KeyringPair;
    tip?: bigint;
  }): Promise<{ canAfford: boolean; txFeePlusTip: bigint; securityFee: bigint }> {
    const { vault, argonKeyring, tip = 0n } = args;
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
      argonKeyring,
      tip,
      satoshis: await this.minimumSatoshiPerLock(),
    });
  }

  private async minimumSatoshiPerLock(): Promise<bigint> {
    const client = await getMainchainClient(false);
    return await client.query.bitcoinLocks.minimumSatoshis().then(x => x.toBigInt());
  }

  public async createInitializeTx(args: {
    vault: Vault;
    argonKeyring: KeyringPair;
    microgonLiquidity: bigint;
    maxMicrogonSpend?: bigint;
    addingVaultSpace?: bigint;
    tip?: bigint;
    txProgressCallback?: ITxProgressCallback;
    couponProofKeypair?: KeyringPair;
    skipCouponValidation?: boolean;
  }) {
    const { ownerBitcoinPubkey, hdPath } = await this.getNextUtxoPubkey(args);
    const {
      vault,
      argonKeyring,
      maxMicrogonSpend,
      tip = 0n,
      addingVaultSpace = 0n,
      skipCouponValidation,
      couponProofKeypair,
    } = args;

    const minimumSatoshis = await this.minimumSatoshiPerLock();
    let microgonLiquidity = args.microgonLiquidity;
    const availableBtcSpace =
      vault.availableBitcoinSpace() +
      bigNumberToBigInt(BigNumber(addingVaultSpace).dividedBy(vault.securitizationRatioBN()));
    if (availableBtcSpace < microgonLiquidity) {
      console.info('Vault liquidity is less than requested microgon liquidity, using vault available space instead.', {
        availableBtcSpace,
        requestedLiquidity: microgonLiquidity,
      });
      microgonLiquidity = availableBtcSpace;
    }

    if (!this.#currency.priceIndex.btcUsdPrice) {
      throw new Error('Network bitcoin pricing is currently unavailable. Please try again later.');
    }

    const basicFeeCapability = await this.canPayMinimumFee(args);
    if (!basicFeeCapability.canAfford) {
      const { txFeePlusTip, securityFee } = basicFeeCapability;
      throw new Error(
        `You cannot afford the basic transaction fees of this transaction (Tx Fees: ${formatArgons(txFeePlusTip)}, Security Fee: ${formatArgons(securityFee)})`,
      );
    }

    let satoshis = await this.satoshisForArgonLiquidity(microgonLiquidity);
    const microgonsPerBtc = this.#currency.priceIndex.getBtcMicrogonPrice(SATOSHIS_PER_BITCOIN);
    const submitTxClient = await getMainchainClient(false);
    while (satoshis >= minimumSatoshis) {
      const { txFee, canAfford } = await BitcoinLock.createInitializeTx({
        client: submitTxClient,
        vault,
        priceIndex: this.#currency.priceIndex,
        ownerBitcoinPubkey,
        argonKeyring,
        microgonsPerBtc,
        satoshis,
        tip,
        couponProofKeypair,
        skipCouponProofCheck: skipCouponValidation,
      });

      if (canAfford && (maxMicrogonSpend === undefined || maxMicrogonSpend >= txFee)) {
        break;
      }
      console.log(`Failed to create affordable bitcoin lock with ${satoshis} satoshis, trying with less...`);
      // If the transaction creation fails, reduce the satoshis by 10 and try again
      satoshis -= 10n;
    }
    if (satoshis < minimumSatoshis) {
      throw new Error(`Unable to create a bitcoin lock with the given liquidity: ${microgonLiquidity}`);
    }
    const { tx, securityFee } = await BitcoinLock.createInitializeTx({
      ...args,
      client: submitTxClient,
      priceIndex: this.#currency.priceIndex,
      ownerBitcoinPubkey,
      microgonsPerBtc,
      satoshis,
      tip,
      couponProofKeypair,
      skipCouponProofCheck: skipCouponValidation,
    });

    return { hdPath, tx, ownerBitcoinPubkey, satoshis, securityFee };
  }

  public async insertPending(details: {
    uuid: string;
    satoshis: bigint;
    vaultId: number;
    hdPath: string;
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
        securityFee: bigint;
      };
    }>,
  ) {
    const { bitcoin: bitcoinMeta } = txInfo.tx.metadataJson;
    this.data.pendingLock = await this.insertPending(bitcoinMeta);
    void this.onBitcoinLockFinalized(txInfo);
  }

  private async onBitcoinLockFinalized(
    txInfo: TransactionInfo<{ bitcoin: { uuid: string; vaultId: number; hdPath: string; satoshis: bigint } }>,
  ) {
    const postProcessor = txInfo.createPostProcessor();
    const genericClient = await getMainchainClient(true);
    const txResult = txInfo.txResult;
    await txResult.waitForFinalizedBlock;
    const typeClient = await genericClient.at(txResult.blockHash!);
    const { lock, createdAtHeight } = await BitcoinLock.getBitcoinLockFromTxResult(typeClient, txResult);
    const uuid = txInfo.tx.metadataJson.bitcoin.uuid;
    const table = await this.getTable();
    const record = await table.finalizePending({
      uuid,
      lock,
      createdAtArgonBlockHeight: createdAtHeight,
      finalFee: txResult.finalFee!,
    });
    console.log('FINALIZED PENDING BITCOIN LOCK', lock.liquidityPromised, { record });
    this.locksByUtxoId[record.utxoId!] = record;
    if (this.data.pendingLock?.uuid === uuid) {
      this.data.pendingLock = undefined;
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
    vaultingAddress: string;
    toScriptPubkey?: string;
    bitcoinFeeRatePerVb?: bigint;
  }): Promise<bigint> {
    const {
      lock,
      // NOTE: not submitting, so a default value is ok
      toScriptPubkey = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
      bitcoinFeeRatePerVb = 5n,
      vaultingAddress,
    } = args;
    // get release fee at current block
    const client = await getMainchainClient(false);

    const bitcoinNetworkFee = await this.calculateBitcoinNetworkFee(lock, bitcoinFeeRatePerVb, toScriptPubkey);

    const fee = await client.tx.bitcoinLocks
      .requestRelease(lock.utxoId!, addressBytesHex(toScriptPubkey, this.bitcoinNetwork), bitcoinNetworkFee)
      .paymentInfo(vaultingAddress, { tip: args.tip ?? 0n });
    return fee.partialFee.toBigInt();
  }

  public async ratchet(lock: IBitcoinLockRecord, argonKeyring: KeyringPair, tip = 0n) {
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
        argonKeyring,
        tip,
        vault: vaults.vaultsById[lock.vaultId],
      });

      const {
        burned,
        securityFee,
        bitcoinBlockHeight: oracleBitcoinBlockHeight,
        blockHeight,
        newLockedMarketRate,
        pendingMint,
        txFee,
      } = await result.getRatchetResult();

      const liquidityPromised = (result as unknown as { liquidityPromised?: bigint }).liquidityPromised ?? pendingMint;

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

  public getLockProcessingDetails(lock: IBitcoinLockRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    receivedSatoshis?: bigint;
    isInvalidAmount?: boolean;
  } {
    if (lock.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
      const txInfo = this.#transactionTracker.data.txInfosByType[ExtrinsicType.BitcoinRequestLock];
      if (txInfo) {
        const progress = txInfo.getStatus();
        return {
          progressPct: progress.progressPct,
          confirmations: progress.confirmations,
          expectedConfirmations: progress.expectedConfirmations,
        };
      }
    }
    return this.utxoTracking.getLockProcessingDetails(lock);
  }

  public getAcceptedFundingRecord(lock: IBitcoinLockRecord): IBitcoinUtxoRecord | undefined {
    return lock.fundingUtxoRecord ?? this.utxoTracking.getAcceptedFundingRecordForLock(lock);
  }

  public getReleaseProcessingDetails(lock: IBitcoinLockRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
    releaseError?: string;
  } {
    return this.utxoTracking.getLockReleaseProcessingDetails(lock);
  }

  private async syncPendingFundingSignals(lock: IBitcoinLockRecord) {
    try {
      await this.utxoTracking.syncPendingFundingSignals(lock);
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
      lockRecord.status === BitcoinLockStatus.LockPendingFunding
    );
  }

  public isLockedStatus(lockRecord: IBitcoinLockRecord): boolean {
    return (
      lockRecord.status === BitcoinLockStatus.LockedAndIsMinting ||
      lockRecord.status === BitcoinLockStatus.LockedAndMinted
    );
  }

  public isFinishedStatus(lock: IBitcoinLockRecord): boolean {
    return lock.status === BitcoinLockStatus.Released || lock.status === BitcoinLockStatus.LockExpiredWaitingForFunding;
  }

  public isReleaseStatus(lock: IBitcoinLockRecord): boolean {
    return lock.status === BitcoinLockStatus.Releasing || lock.status === BitcoinLockStatus.Released;
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
        argonKeyring: await this.walletKeys.getVaultingKeypair(),
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
    void this.onRequestedReleaseInBlock(lockRecord, txInfo, {
      toScriptPubkey: args.toScriptPubkey,
      bitcoinNetworkFee: args.bitcoinNetworkFee,
    });
    return txInfo;
  }

  public async getTable(): Promise<BitcoinLocksTable> {
    const db = await this.dbPromise;
    return db.bitcoinLocksTable;
  }

  private async onRequestedReleaseInBlock(
    lock: IBitcoinLockRecord,
    txInfo: TransactionInfo,
    releaseInfo: { toScriptPubkey: string; bitcoinNetworkFee: bigint },
  ): Promise<void> {
    const { txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    await this.ensureLockReleaseProcessing(lock);

    try {
      const blockHash = await txResult.waitForFinalizedBlock;
      const client = await getMainchainClient(true);
      const api = await client.at(blockHash);
      const requestedReleaseAtTick = await api.query.ticks.currentTick().then(x => x.toNumber());
      const fundingRecord = await this.getFundingRecordOrThrow(lock);
      await this.utxoTracking.setReleaseRequest(fundingRecord, {
        requestedReleaseAtTick,
        releaseToDestinationAddress: releaseInfo.toScriptPubkey,
        releaseBitcoinNetworkFee: releaseInfo.bitcoinNetworkFee,
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
    if (fundingRecord.releaseToDestinationAddress) {
      await this.syncLockReleaseStatusFromFundingRecord(lock, fundingRecord);
      return;
    }

    const bitcoinLock = new BitcoinLock(lock.lockDetails);
    const releaseRequest = await bitcoinLock.getReleaseRequest(apiClient);
    if (!releaseRequest) return;

    const requestedReleaseAtTick = await apiClient.query.ticks.currentTick().then(x => x.toNumber());
    const releaseToDestinationAddress = releaseRequest.toScriptPubkey;
    const releaseBitcoinNetworkFee = releaseRequest.bitcoinNetworkFee;
    await this.utxoTracking.setReleaseRequest(fundingRecord, {
      requestedReleaseAtTick,
      releaseToDestinationAddress,
      releaseBitcoinNetworkFee,
    });

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

    if (latestFundingRecord.releaseCosignVaultSignature) {
      await this.ensureLockReleaseProcessing(lock);
      return;
    }

    const bitcoinLock = new BitcoinLock(lock.lockDetails);
    const vaultSignature = await bitcoinLock.findVaultCosignSignature(archiveClient);
    if (vaultSignature) {
      await this.utxoTracking.setReleaseCosign(latestFundingRecord, {
        releaseCosignVaultSignature: vaultSignature.signature,
        releaseCosignHeight: vaultSignature.blockHeight,
      });
      await this.ensureLockReleaseProcessing(lock);
      return;
    }

    const vault = this.myVault;
    if (lock.vaultId !== vault?.vaultId) return;
    if (!latestFundingRecord.releaseToDestinationAddress || latestFundingRecord.releaseBitcoinNetworkFee == null)
      return;

    const result = await vault.cosignMyLock(lock, {
      toScriptPubkey: latestFundingRecord.releaseToDestinationAddress,
      bitcoinNetworkFee: latestFundingRecord.releaseBitcoinNetworkFee,
    });
    if (!result?.txInfo) return;

    await result.txInfo.txResult.waitForInFirstBlock;
    await this.utxoTracking.setReleaseCosign(latestFundingRecord, {
      releaseCosignVaultSignature: result.vaultSignature,
      releaseCosignHeight: result.txInfo.txResult.blockNumber,
    });
    await this.ensureLockReleaseProcessing(lock);
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
      if (!this.utxoTracking.hasFundingRecordReleaseSignal(fundingRecord)) continue;
      if (this.utxoTracking.isFundingRecordReleaseComplete(fundingRecord)) {
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

  private async reconcileLockReleasePhasesOnBlock(
    lock: IBitcoinLockRecord,
    hasNewOracleBitcoinBlockHeight: boolean,
  ): Promise<void> {
    let fundingRecord = this.getAcceptedFundingRecord(lock);
    if (!fundingRecord) {
      this.reportMissingFundingRecordForReleasingLock(lock);
      return;
    }

    const getReleaseState = (record: IBitcoinUtxoRecord) => ({
      hasSignal: this.utxoTracking.hasFundingRecordReleaseSignal(record),
      isComplete: this.utxoTracking.isFundingRecordReleaseComplete(record),
      isProcessingOnBitcoin: this.utxoTracking.isFundingRecordReleaseProcessingOnBitcoin(record),
      hasRequestDetails: this.utxoTracking.hasFundingRecordReleaseRequestDetails(record),
      hasCosign: !!record.releaseCosignVaultSignature,
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
    if (!releaseState.hasSignal || releaseState.isComplete) return;

    let archiveClient: ArgonClient | undefined;
    const getArchiveClient = async (): Promise<ArgonClient> => {
      archiveClient ??= await getMainchainClient(true);
      return archiveClient;
    };

    if (
      releaseState.hasSignal &&
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
      releaseState.hasSignal &&
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
      releaseState.hasSignal &&
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
      releaseState.hasSignal &&
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
    if (this.utxoTracking.isFundingRecordReleaseComplete(record)) {
      nextStatus = BitcoinLockStatus.Released;
    } else if (this.utxoTracking.hasFundingRecordReleaseSignal(record)) {
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
          if (isPendingFunding && hasNewOracleBitcoinBlockHeight) {
            await this.utxoTracking.updateFundingLastConfirmationCheck(lockRecord).catch(err => {
              console.warn(`[BitcoinLocks] Error updating funding confirmation check for utxo ${lockRecord.uuid}`, err);
            });
          }
          if (isPendingFunding) {
            await this.syncPendingFundingSignals(lockRecord).catch(err => {
              console.warn(`[BitcoinLocks] Error syncing funding signals for utxo ${lockRecord.uuid}`, err);
            });
          }

          // Phase 3: pending funding sync.
          await this.reconcilePendingFundingState(lockRecord).catch(err => {
            console.warn(`[BitcoinLocks] Error reconciling pending funding state for utxo ${lockRecord.uuid}`, err);
          });

          // Phase 4: release sync.
          await this.reconcileLockReleasePhasesOnBlock(lockRecord, hasNewOracleBitcoinBlockHeight).catch(err => {
            console.warn(`[BitcoinLocks] Error reconciling release phases for utxo ${lockRecord.uuid}`, err);
          });

          // Phase 5: mint sync.
          await this.syncMintPendingState(lockRecord, table, clientAt);
        }).catch(err => {
          console.warn(`[BitcoinLocks] Error processing lock for utxo ${lockRecord.uuid}`, err);
        });
      })
      .filter(x => x !== undefined);
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
    lock.fundingUtxoRecordId = fundingRecord.id;
    lock.fundingUtxoRecord = fundingRecord;
    const table = await this.getTable();
    await table.setLockedAndIsMinting(lock);
  }

  private async reconcilePendingFundingState(lock: IBitcoinLockRecord): Promise<void> {
    if (!lock.utxoId) return;
    if (lock.status !== BitcoinLockStatus.LockPendingFunding) return;

    const fundingRecord = this.utxoTracking.getAcceptedFundingRecordForLock(lock);
    if (!fundingRecord) return;

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
}
