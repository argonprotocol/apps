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
  BitcoinLock,
  formatArgons,
  type IBitcoinLockConfig,
  ITxProgressCallback,
  KeyringPair,
  u8aToHex,
  Vault,
} from '@argonprotocol/mainchain';
import { Db } from './Db.ts';
import { BitcoinLocksTable, BitcoinLockStatus, IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import { getVaults } from '../stores/vaults.ts';
import { BITCOIN_BLOCK_MILLIS, ESPLORA_HOST } from './Env.ts';
import { type AddressTxsUtxo } from '@mempool/mempool.js/lib/interfaces/bitcoin/addresses';
import { type TxStatus } from '@mempool/mempool.js/lib/interfaces/bitcoin/transactions';
import {
  BlockWatch,
  IBlockHeaderInfo,
  MiningFrames,
  NetworkConfig,
  Currency as CurrencyBase,
  createDeferred,
  getPercent,
  IDeferred,
} from '@argonprotocol/apps-core';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { TransactionTracker } from './TransactionTracker.ts';
import { BlockProgress } from './BlockProgress.ts';
import { WalletKeys } from './WalletKeys.ts';
import { TransactionInfo } from './TransactionInfo.ts';

dayjs.extend(utc);

export interface IMempoolFundingStatus {
  isConfirmed: boolean;
  confirmations: number;
  satoshis: bigint;
  transactionBlockHeight: number;
  transactionBlockTime: number;
  argonBitcoinHeight: number;
}

export interface IMempoolReleaseStatus {
  isConfirmed: boolean;
  transactionBlockHeight: number;
  transactionBlockTime: number;
  argonBitcoinHeight: number;
}

export default class BitcoinLocksStore {
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

  public get totalMintPending() {
    return Object.values(this.locksByUtxoId).reduce(
      (sum, lock) => sum + lock.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n),
      0n,
    );
  }

  public get totalMinted() {
    return Object.values(this.locksByUtxoId).reduce(
      (sum, lock) => sum + lock.ratchets.reduce((sum, ratchet) => sum + ratchet.mintAmount - ratchet.mintPending, 0n),
      0n,
    );
  }

  #config!: IBitcoinLockConfig;

  #lockTicksPerDay!: number;
  #subscription?: () => void;
  #waitForLoad?: IDeferred;
  #currency: CurrencyBase;
  #transactionTracker: TransactionTracker;

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

  public async load(): Promise<void> {
    if (this.#waitForLoad) return this.#waitForLoad.promise;
    this.#waitForLoad = createDeferred<void>();
    try {
      const client = await getMainchainClient(false);
      const table = await this.getTable();
      const locks = await table.fetchAll();

      for (const lock of locks) {
        if (lock.utxoId) {
          this.locksByUtxoId[lock.utxoId] = lock;
        } else {
          this.data.pendingLock = lock;
        }
      }

      this.#config ??= await BitcoinLock.getConfig(client);
      this.#lockTicksPerDay = client.consts.bitcoinLocks.argonTicksPerDay.toNumber();
      this.data.bitcoinNetwork = getBitcoinNetworkFromApi(this.#config.bitcoinNetwork);
      await this.#transactionTracker.load();

      const finalizedHash = await client.rpc.chain.getFinalizedHead();
      const latestArgonHeader = await client.rpc.chain.getHeader(finalizedHash);

      await this.checkIncomingArgonBlock(BlockWatch.readHeader(latestArgonHeader));
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('Error loading BitcoinLocksStore:', error);
      this.#waitForLoad.reject(error);
    }
    return this.#waitForLoad.promise;
  }

  public async subscribeToArgonBlocks() {
    this.#subscription = this.blockWatch.events.on('best-blocks', async headers => {
      await this.checkIncomingArgonBlock(headers.at(-1)!);
    });
    await this.checkIncomingArgonBlock(this.blockWatch.bestBlockHeader);
  }

  public unsubscribeFromArgonBlocks() {
    this.#subscription?.();
    this.#subscription = undefined;
  }

  public async updateVaultUnlockingSignature(
    lock: IBitcoinLockRecord,
    vaultSignature: { blockHeight: number; signature: Uint8Array },
  ): Promise<void> {
    const table = await this.getTable();
    await table.setReleaseSigned(lock, vaultSignature.signature, vaultSignature.blockHeight);
  }

  public async getNextUtxoPubkey(args: { vault: Vault }) {
    const { vault } = args;
    const table = await this.getTable();

    // get bitcoin xpriv to generate the pubkey
    const nextIndex = await table.getNextVaultHdKeyIndex(vault.vaultId);
    const hdPath = `m/1018'/0'/${vault.vaultId}'/0/${nextIndex}'`;
    const ownerBitcoinXpriv = await this.walletKeys.getBitcoinChildXpriv(hdPath, this.bitcoinNetwork);
    const ownerBitcoinPubkey = getCompressedPubkey(ownerBitcoinXpriv.publicKey!);

    return { ownerBitcoinPubkey, hdPath };
  }

  public async satoshisForArgonLiquidity(microgonLiquidity: bigint): Promise<bigint> {
    return BitcoinLock.requiredSatoshisForArgonLiquidity(this.#currency.priceIndex, microgonLiquidity);
  }

  public async canPayMinimumFee(args: {
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

  public async minimumSatoshiPerLock(): Promise<bigint> {
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
  }) {
    const { ownerBitcoinPubkey, hdPath } = await this.getNextUtxoPubkey(args);
    const { vault, argonKeyring, maxMicrogonSpend, tip = 0n, addingVaultSpace = 0n } = args;

    const minimumSatoshis = await this.minimumSatoshiPerLock();
    let microgonLiquidity = args.microgonLiquidity;
    const availableBtcSpace = vault.availableBitcoinSpace() + addingVaultSpace;
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
    const submitTxClient = await getMainchainClient(false);
    while (satoshis >= minimumSatoshis) {
      const { txFee, canAfford } = await BitcoinLock.createInitializeTx({
        client: submitTxClient,
        vault,
        priceIndex: this.#currency.priceIndex,
        ownerBitcoinPubkey,
        argonKeyring,
        satoshis,
        tip,
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
      satoshis,
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
    return {
      getUtxoId: async () => {
        await txInfo.waitForPostProcessing;
        const utxoId = await this.getUtxoForBitcoinLockUuid(bitcoinMeta.uuid);
        if (!utxoId) {
          throw new Error('Unable to get UTXO ID for pending bitcoin lock');
        }
        return utxoId;
      },
    };
  }

  public async onBitcoinLockFinalized(
    txInfo: TransactionInfo<{ bitcoin: { uuid: string; vaultId: number; hdPath: string; satoshis: bigint } }>,
  ) {
    const postProcessor = txInfo.createPostProcessor();
    const typeClient = await getMainchainClient(false);
    const txResult = txInfo.txResult;
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

  public async getUtxoForBitcoinLockUuid(bitcoinUuid: string): Promise<number | undefined> {
    const table = await this.getTable();
    return await table.getUtxoUuid(bitcoinUuid);
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

  public fundingPsbt(lock: IBitcoinLockRecord): Uint8Array {
    if (lock.status !== BitcoinLockStatus.LockReadyForBitcoin) {
      throw new Error(`Lock with ID ${lock.utxoId} is not in the initialized state.`);
    }
    return new CosignScript(lock.lockDetails, this.bitcoinNetwork).getFundingPsbt();
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
    const table = await this.getTable();
    if (lock.status !== BitcoinLockStatus.LockedAndMinted && lock.status !== BitcoinLockStatus.LockedAndIsMinting) {
      throw new Error(`Lock with ID ${lock.utxoId} is not verified.`);
    }

    const vaults = getVaults();
    const bitcoinLock = new BitcoinLock(lock.lockDetails);

    const result = await bitcoinLock.ratchet({
      client: await getMainchainClient(false),
      priceIndex: this.#currency.priceIndex,
      argonKeyring,
      tip,
      vault: vaults.vaultsById[lock.vaultId],
    });

    const {
      burned,
      securityFee,
      bitcoinBlockHeight: oracleBitcoinBlockHeight,
      blockHeight,
      newPeggedPrice,
      pendingMint,
      txFee,
    } = await result.getRatchetResult();

    const liquidityPromised = (result as any).liquidityPromised ?? pendingMint;

    lock.ratchets.push({
      mintAmount: pendingMint,
      mintPending: pendingMint,
      peggedPrice: newPeggedPrice,
      txFee,
      burned,
      securityFee,
      blockHeight,
      oracleBitcoinBlockHeight,
    });
    lock.liquidityPromised = liquidityPromised;
    lock.peggedPrice = newPeggedPrice;
    lock.lockDetails.liquidityPromised = liquidityPromised;
    lock.lockDetails.peggedPrice = newPeggedPrice;

    await table.saveNewRatchet(lock);
  }

  public async ownerCosignAndSendToBitcoin(lock: IBitcoinLockRecord): Promise<void> {
    if (lock.status !== BitcoinLockStatus.ReleaseSigned) return;
    const { bytes } = await this.ownerCosignAndGenerateTxBytes(lock);
    const mempoolPostTxUrl = this.getMempoolApi('tx');
    const response = await fetch(mempoolPostTxUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: u8aToHex(bytes, undefined, false),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to broadcast transaction: ${response.status} ${response.statusText} - ${errorText}`);
    }
    const releasedTxid = (await response.text()).trim();
    if (!releasedTxid.match(/^[0-9a-fA-F]{64}$/)) {
      throw new Error(`Invalid transaction ID returned from broadcast: ${releasedTxid}`);
    }

    const table = await this.getTable();
    await table.setReleaseIsProcessingOnBitcoin(lock, releasedTxid);
  }

  /**
   * Cosigns the transaction.
   *
   * @param lock
   * @param addTx
   */
  public async ownerCosignAndGenerateTxBytes(
    lock: IBitcoinLockRecord,
    addTx?: string,
  ): Promise<{
    txid: string;
    bytes: Uint8Array;
  }> {
    if (lock.cosignVersion !== 'v1') {
      throw new Error(`Unsupported cosign version: ${lock.cosignVersion}`);
    }
    if (!lock.releaseCosignVaultSignature) {
      throw new Error(`Lock with ID ${lock.utxoId} has not been cosigned yet.`);
    }
    if (!lock.releaseToDestinationAddress) {
      throw new Error(`Lock with ID ${lock.utxoId} has not been released yet.`);
    }

    const cosign = new CosignScript(lock.lockDetails, this.bitcoinNetwork);
    const tx = cosign.cosignAndGenerateTx({
      releaseRequest: {
        toScriptPubkey: lock.releaseToDestinationAddress,
        bitcoinNetworkFee: lock.releaseBitcoinNetworkFee!,
      },
      vaultCosignature: lock.releaseCosignVaultSignature,
      utxoRef: { txid: lock.lockedTxid!, vout: lock.lockedVout! },
      ownerXpriv: await this.walletKeys.getBitcoinChildXpriv(lock.hdPath, this.bitcoinNetwork),
      addTx,
    });
    if (!tx) {
      throw new Error(`Failed to cosign and generate transaction for lock with ID ${lock.utxoId}`);
    }
    if (!tx.isFinal) {
      throw new Error(`Transaction for lock with ID ${lock.utxoId} is not finalized.`);
    }
    return { bytes: tx.toBytes(true, true), txid: tx.id };
  }

  public formatP2swhAddress(scriptHex: string): string {
    try {
      return p2wshScriptHexToAddress(scriptHex, this.bitcoinNetwork);
    } catch (e: any) {
      throw new Error(`Invalid address: ${scriptHex}. Ensure it is a valid hex address. ${e.message}`);
    }
  }

  public getRequestReleaseByVaultPercent(lock: IBitcoinLockRecord, miningFrames: MiningFrames): number {
    if (lock.status === BitcoinLockStatus.ReleaseIsWaitingForVault) {
      const startTick = lock.requestedReleaseAtTick!;
      const startFrame = miningFrames.getForTick(startTick);
      const dueFrame = startFrame + this.#config.lockReleaseCosignDeadlineFrames;
      const startTickOfDue = miningFrames.estimateTickForFrame(dueFrame);
      const totalTicks = startTickOfDue + NetworkConfig.rewardTicksPerFrame - startTick;
      const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
      return getPercent(currentTick - startTick, totalTicks);
    }
    return 100;
  }

  public getLockProcessingDetails(lock: IBitcoinLockRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
  } {
    let expectedConfirmations = 6;
    if (lock.status === BitcoinLockStatus.LockReadyForBitcoin)
      return { progressPct: 0, confirmations: -1, expectedConfirmations };
    if (lock.status !== BitcoinLockStatus.LockIsProcessingOnBitcoin)
      return { progressPct: 100, confirmations: 6, expectedConfirmations };

    const recordedOracleHeight = lock.lockProcessingOnBitcoinAtOracleBitcoinHeight;
    const recordedTransactionHeight = lock.lockProcessingOnBitcoinAtBitcoinHeight;

    if (recordedOracleHeight && recordedTransactionHeight) {
      expectedConfirmations = recordedTransactionHeight - recordedOracleHeight;
    }

    const timeOfLastBlock = lock.lockProcessingLastOracleBlockDate || lock.lockProcessingOnBitcoinAtTime;
    const blockProgress = new BlockProgress({
      blockHeightGoal: lock.lockProcessingOnBitcoinAtBitcoinHeight,
      blockHeightCurrent: this.data.oracleBitcoinBlockHeight,
      minimumConfirmations: expectedConfirmations,
      millisPerBlock: BITCOIN_BLOCK_MILLIS,
      timeOfLastBlock: dayjs.utc(timeOfLastBlock),
    });

    const progressPct = blockProgress.getProgress();
    const confirmations = blockProgress.getConfirmations();
    expectedConfirmations = blockProgress.expectedConfirmations;

    return { progressPct, confirmations, expectedConfirmations };
  }

  public getReleaseProcessingDetails(lock: IBitcoinLockRecord): {
    progressPct: number;
    confirmations: number;
    expectedConfirmations: number;
  } {
    let expectedConfirmations = 6;
    if (lock.status === BitcoinLockStatus.ReleaseComplete)
      return { progressPct: 100, confirmations: 6, expectedConfirmations };
    if (lock.status !== BitcoinLockStatus.ReleaseIsProcessingOnBitcoin)
      return { progressPct: 0, confirmations: -1, expectedConfirmations };

    const recordedOracleHeight = lock.releaseProcessingLastOracleBlockHeight;
    const recordedTransactionHeight = lock.releaseProcessingOnBitcoinAtBitcoinHeight;

    if (recordedOracleHeight && recordedTransactionHeight) {
      expectedConfirmations = recordedTransactionHeight - recordedOracleHeight;
    }

    const timeOfLastBlock = lock.releaseProcessingLastOracleBlockDate || lock.releaseProcessingOnBitcoinAtDate;
    const blockProgress = new BlockProgress({
      blockHeightGoal: lock.releaseProcessingOnBitcoinAtBitcoinHeight,
      blockHeightCurrent: this.data.oracleBitcoinBlockHeight,
      minimumConfirmations: expectedConfirmations,
      millisPerBlock: BITCOIN_BLOCK_MILLIS,
      timeOfLastBlock: dayjs.utc(timeOfLastBlock),
    });

    const progressPct = blockProgress.getProgress();
    const confirmations = blockProgress.getConfirmations();
    expectedConfirmations = blockProgress.expectedConfirmations;

    return { progressPct, confirmations, expectedConfirmations };
  }

  public async updateLockIsProcessingOnBitcoin(lock: IBitcoinLockRecord) {
    try {
      const mempoolStatus = await this.checkMempoolFundingStatus(lock);
      if (mempoolStatus) {
        const table = await this.getTable();
        await table.setLockIsProcessingOnBitcoin(lock, mempoolStatus, this.oracleBitcoinBlockHeight);
      }
    } catch (error) {
      console.error('Error checking UTXO status:', error);
    }
  }

  public async updateReleaseIsProcessingOnArgon(lock: IBitcoinLockRecord) {
    const table = await this.getTable();
    await table.setReleaseIsProcessingOnArgon(lock);
  }

  public async updateReleaseIsWaitingForVault(lock: IBitcoinLockRecord) {
    const table = await this.getTable();
    await table.setReleaseIsWaitingForVault(lock);
  }

  public async getTable(): Promise<BitcoinLocksTable> {
    const db = await this.dbPromise;
    return db.bitcoinLocksTable;
  }

  private async checkIncomingArgonBlock(header: Pick<IBlockHeaderInfo, 'blockHash' | 'blockNumber'>): Promise<void> {
    const table = await this.getTable();
    const archivedBitcoinBlockHeight = this.data.oracleBitcoinBlockHeight;
    this.data.latestArgonBlockHeight = header.blockNumber;

    const generalClient = await this.blockWatch.getRpcClient(header.blockNumber);
    const clientAt = await generalClient.at(header.blockHash);

    this.data.oracleBitcoinBlockHeight = await clientAt.query.bitcoinUtxos
      .confirmedBitcoinBlockTip()
      .then(x => (x.isSome ? (x.value?.blockHeight.toNumber() ?? 0) : 0));

    const hasNewOracleBitcoinBlockHeight = archivedBitcoinBlockHeight !== this.data.oracleBitcoinBlockHeight;

    for (const lockRecord of Object.values(this.data.locksByUtxoId)) {
      const bitcoinLock = new BitcoinLock(lockRecord.lockDetails);
      if (
        [
          BitcoinLockStatus.LockReadyForBitcoin,
          BitcoinLockStatus.LockedAndMinted,
          BitcoinLockStatus.LockedAndIsMinting,
          BitcoinLockStatus.LockIsProcessingOnBitcoin,
        ].includes(lockRecord.status)
      ) {
        if (hasNewOracleBitcoinBlockHeight && lockRecord.status === BitcoinLockStatus.LockIsProcessingOnBitcoin) {
          lockRecord.lockProcessingLastOracleBlockDate = dayjs.utc().toDate();
          lockRecord.lockProcessingLastOracleBlockHeight = this.data.oracleBitcoinBlockHeight;
          await table.updateLockProcessingLastOracleBlock(lockRecord);
        }
        await this.updateLockingStatus(lockRecord, clientAt);
      }

      if (
        [BitcoinLockStatus.LockReadyForBitcoin, BitcoinLockStatus.LockIsProcessingOnBitcoin].includes(lockRecord.status)
      ) {
        await this.updateLockIsProcessingOnBitcoin(lockRecord);
      }

      if (lockRecord.status === BitcoinLockStatus.ReleaseIsWaitingForVault) {
        const vaultSignature = await bitcoinLock.findVaultCosignSignature(generalClient);
        if (vaultSignature) await this.updateVaultUnlockingSignature(lockRecord, vaultSignature);
      }

      if (lockRecord.status === BitcoinLockStatus.ReleaseIsProcessingOnBitcoin) {
        lockRecord.releaseProcessingLastOracleBlockDate = dayjs.utc().toDate();
        lockRecord.releaseProcessingLastOracleBlockHeight = this.data.oracleBitcoinBlockHeight;
        await table.updateReleaseProcessingLastOracleBlock(lockRecord);
        try {
          await this.updateReleaseIsProcessingOnBitcoin(lockRecord);
          lockRecord.releaseError = undefined;
        } catch (e) {
          lockRecord.releaseError = String(e);
        }
      }

      if (!lockRecord.lockedTxid) continue;

      const localPendingMint = lockRecord.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
      if (localPendingMint > 0n) {
        const chainPendingArray = await bitcoinLock.findPendingMints(clientAt);
        const chainPendingMint = chainPendingArray.reduce((sum, x) => sum + x, 0n);

        let amountFulfilled = localPendingMint - chainPendingMint;
        // account for the pending amount by allocating to the last entrants in the ratchet list
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

        await table.updateMintState(lockRecord);
      }
    }
  }

  private async updateReleaseIsProcessingOnBitcoin(lock: IBitcoinLockRecord) {
    if (!lock.releasedTxid) {
      throw new Error(`Lock with ID ${lock.utxoId} does not have a released txid saved to the db.`);
    }

    const mempoolStatus = await this.checkMempoolReleaseStatus(lock);
    if (mempoolStatus?.isConfirmed) {
      const table = await this.getTable();
      await table.setReleaseComplete(lock, {
        releasedAtBitcoinHeight: mempoolStatus.transactionBlockHeight,
      });
    }

    console.info('Bitcoin status for released tx', { txid: lock.releasedTxid, mempoolStatus });
  }

  private async updateLockingStatus(lock: IBitcoinLockRecord, finalizedApi: ApiDecoration<'promise'>): Promise<void> {
    if (lock.lockedTxid) return;

    const table = await this.getTable();
    const bitcoinLock = await BitcoinLock.get(finalizedApi, lock.utxoId!);
    if (!bitcoinLock) {
      console.warn(`Lock with ID ${lock.utxoId} not found`);
      await table.setLockFailedToHappen(lock);
      return;
    }
    if (!bitcoinLock?.isVerified) {
      return;
    }

    const utxoRef = await bitcoinLock.getUtxoRef(finalizedApi);
    if (!utxoRef) {
      console.warn(`Utxo with ID ${lock.utxoId} not found`);
      return;
    }

    if (bitcoinLock.isVerified) {
      lock.lockedTxid = utxoRef.txid;
      lock.lockedVout = utxoRef.vout;
      await table.setLockedAndIsMinting(lock);
    } else if (bitcoinLock.isRejectedNeedsRelease) {
      await table.setLockReceivedWrongAmount(lock);
    }
  }

  private getMempoolApi(path: string) {
    const baseUrl = ESPLORA_HOST ?? 'https://mempool.space/api';
    return `${baseUrl}/${path}`;
  }

  private async checkMempoolFundingStatus(lock: IBitcoinLockRecord): Promise<IMempoolFundingStatus | undefined> {
    const payToScriptAddress = lock.lockDetails.p2wshScriptHashHex;
    const mempoolUtxoUrl = this.getMempoolApi(`address/${this.formatP2swhAddress(payToScriptAddress)}/utxo`);
    const response = await fetch(mempoolUtxoUrl);
    const txs = (await response.json()) as AddressTxsUtxo[];
    if (!txs.length) return undefined;

    const tx = txs[0]; // Get the most recent transaction

    const mempoolBlockTipUrl = this.getMempoolApi('blocks/tip/height');
    const blockTipResponse = await fetch(mempoolBlockTipUrl);
    const tip: number = await blockTipResponse.json();
    const status = tx.status;

    return {
      satoshis: BigInt(tx.value),
      isConfirmed: status.confirmed,
      confirmations: status.confirmed ? tip - status.block_height : 0,
      transactionBlockHeight: status.block_height,
      transactionBlockTime: status.block_time,
      argonBitcoinHeight: this.oracleBitcoinBlockHeight,
    };
  }

  private async checkMempoolReleaseStatus(lock: IBitcoinLockRecord): Promise<IMempoolReleaseStatus | undefined> {
    const releasedTxid = lock.releasedTxid;
    console.log('Checking release finalize status for lock', { utxoId: lock.utxoId, releasedTxid: releasedTxid });
    if (!releasedTxid) {
      throw new Error(`Lock with ID ${lock.utxoId} does not have a released txid saved to the db.`);
    }
    const mempoolStatusUrl = this.getMempoolApi(`tx/${releasedTxid}/status`);
    const response = await fetch(mempoolStatusUrl);
    const status = (await response.json()) as TxStatus;
    if (!status) {
      console.warn(`Transaction status for txid ${releasedTxid} not found.`);
      return;
    }

    return {
      isConfirmed: status.confirmed,
      transactionBlockHeight: status.block_height,
      transactionBlockTime: status.block_time,
      argonBitcoinHeight: this.oracleBitcoinBlockHeight,
    };
  }

  public static async getFeeRates() {
    const res = await fetch('https://mempool.space/api/v1/fees/recommended');
    const data = await res.json();
    return {
      fast: { feeRate: BigInt(data.fastestFee), estimatedMinutes: 10 } as IFeeRate,
      medium: { feeRate: BigInt(data.halfHourFee), estimatedMinutes: 30 } as IFeeRate,
      slow: { feeRate: BigInt(data.hourFee), estimatedMinutes: 60 } as IFeeRate,
    };
  }
}

export interface IFeeRate {
  feeRate: bigint; // sat/vB
  estimatedMinutes: number; // estimated time in minutes for the transaction to be included
}
