import { getMainchainClient } from '../stores/mainchain.ts';
import {
  addressBytesHex,
  BitcoinNetwork,
  CosignScript,
  getBitcoinNetworkFromApi,
  getChildXpriv,
  getCompressedPubkey,
  p2wshScriptHexToAddress,
} from '@argonprotocol/bitcoin';
import {
  BitcoinLocks,
  formatArgons,
  Header,
  IBitcoinLock,
  type IBitcoinLockConfig,
  ISubmittableOptions,
  ITxProgressCallback,
  KeyringPair,
  TxResult,
  TxSubmitter,
  u8aToHex,
  Vault,
} from '@argonprotocol/mainchain';
import { Db } from './Db.ts';
import { BitcoinLocksTable, BitcoinLockStatus, IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import { useVaults } from '../stores/vaults.ts';
import { createDeferred, getPercent, IDeferred } from './Utils.ts';
import { BITCOIN_BLOCK_MILLIS, ESPLORA_HOST } from './Env.ts';
import { type AddressTxsUtxo } from '@mempool/mempool.js/lib/interfaces/bitcoin/addresses';
import { type TxStatus } from '@mempool/mempool.js/lib/interfaces/bitcoin/transactions';
import { MiningFrames, PriceIndex } from '@argonprotocol/apps-core';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { TransactionTracker } from './TransactionTracker.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { BlockProgress } from './BlockProgress.ts';

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
  public get bitcoinNetwork() {
    return this.data.bitcoinNetwork;
  }

  data: {
    pendingLock: IBitcoinLockRecord | undefined;
    locksByUtxoId: { [utxoId: number]: IBitcoinLockRecord };
    oracleBitcoinBlockHeight: number;
    bitcoinNetwork: BitcoinNetwork;
    latestArgonBlockHeight: number;
  };

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

  #config!: IBitcoinLockConfig;
  #lockTicksPerDay!: number;
  #bitcoinLocksApi!: BitcoinLocks;
  #subscription?: () => void;
  #waitForLoad?: IDeferred;
  #priceIndex: PriceIndex;
  #transactionTracker: TransactionTracker;

  constructor(
    private readonly dbPromise: Promise<Db>,
    priceIndex: PriceIndex,
    transactionTracker: TransactionTracker,
  ) {
    this.#priceIndex = priceIndex;
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

      this.#bitcoinLocksApi ??= new BitcoinLocks(await getMainchainClient(true));
      this.#config ??= await this.#bitcoinLocksApi.getConfig();
      this.#lockTicksPerDay = client.consts.bitcoinLocks.argonTicksPerDay.toNumber();
      this.data.bitcoinNetwork = getBitcoinNetworkFromApi(this.#config.bitcoinNetwork);
      await this.#transactionTracker.load();

      const latestArgonHeader = await client.rpc.chain.getHeader();
      await this.checkIncomingArgonBlock(latestArgonHeader);
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('Error loading BitcoinLocksStore:', error);
      this.#waitForLoad.reject(error);
    }
    return this.#waitForLoad.promise;
  }

  public async subscribeToArgonBlocks() {
    const client = await getMainchainClient(false);
    this.#subscription ??= await client.rpc.chain.subscribeNewHeads(h => this.checkIncomingArgonBlock(h));
  }

  public unsubscribeFromArgonBlocks() {
    this.#subscription?.();
    this.#subscription = undefined;
  }

  public async updateVaultUnlockingSignature(
    lock: IBitcoinLockRecord,
    vaultSignature?: { blockHeight: number; signature: Uint8Array },
  ): Promise<void> {
    const signature = vaultSignature ?? (await this.#bitcoinLocksApi.findVaultCosignSignature(lock.utxoId!));

    if (signature) {
      const table = await this.getTable();
      await table.setReleaseSigned(lock, signature.signature, signature.blockHeight);
    }
  }

  public async getNextUtxoPubkey(args: { vault: Vault; bip39Seed: Uint8Array }) {
    const { vault, bip39Seed } = args;
    const table = await this.getTable();

    // get bitcoin xpriv to generate the pubkey
    const nextIndex = await table.getNextVaultHdKeyIndex(vault.vaultId);
    const hdPath = `m/1018'/0'/${vault.vaultId}'/0/${nextIndex}'`;
    const ownerBitcoinXpriv = getChildXpriv(bip39Seed, hdPath, this.bitcoinNetwork);
    const ownerBitcoinPubkey = getCompressedPubkey(ownerBitcoinXpriv.publicKey!);

    return { ownerBitcoinPubkey, hdPath };
  }

  public async satoshisForArgonLiquidity(microgonLiquidity: bigint): Promise<bigint> {
    return this.#bitcoinLocksApi.requiredSatoshisForArgonLiquidity(this.#priceIndex.current, microgonLiquidity);
  }

  public async canPayMinimumFee(args: {
    vault: Vault;
    argonKeyring: KeyringPair;
    tip?: bigint;
    bip39Seed: Uint8Array;
  }): Promise<{ canAfford: boolean; txFeePlusTip: bigint; securityFee: bigint }> {
    const { vault, argonKeyring, tip = 0n, bip39Seed } = args;
    const ownerBitcoinXpriv = getChildXpriv(bip39Seed, `m/1018'/0'/${vault.vaultId}'/0/0'`, this.bitcoinNetwork);
    const ownerBitcoinPubkey = getCompressedPubkey(ownerBitcoinXpriv.publicKey!);

    // explode on purpose if we can't afford even the minimum
    return await this.#bitcoinLocksApi.createInitializeLockTx({
      vault,
      priceIndex: this.#priceIndex.current,
      ownerBitcoinPubkey,
      argonKeyring,
      satoshis: await this.minimumSatoshiPerLock(),
      tip,
    });
  }

  public async minimumSatoshiPerLock(): Promise<bigint> {
    const client = await getMainchainClient(false);
    return await client.query.bitcoinLocks.minimumSatoshis().then(x => x.toBigInt());
  }

  public async createInitializeTx(args: {
    vault: Vault;
    bip39Seed: Uint8Array;
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

    if (!this.#priceIndex.current.btcUsdPrice) {
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
    while (satoshis >= minimumSatoshis) {
      const { txFee, canAfford } = await this.#bitcoinLocksApi.createInitializeLockTx({
        vault,
        priceIndex: this.#priceIndex.current,
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
    const { tx, securityFee } = await this.#bitcoinLocksApi.createInitializeLockTx({
      ...args,
      priceIndex: this.#priceIndex.current,
      ownerBitcoinPubkey,
      satoshis,
    });

    return { hdPath, tx, ownerBitcoinPubkey, satoshis, securityFee };
  }

  public async createPendingBitcoinLock(args: { vaultId: number; satoshis: bigint; hdPath: string }) {
    const { satoshis, vaultId, hdPath } = args;
    const table = await this.getTable();
    const record = await table.insertPending({
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      satoshis,
      cosignVersion: 'v1',
      network: this.#config.bitcoinNetwork.toString(),
      hdPath,
      vaultId,
    });
    this.data.pendingLock = record;
    return record;
  }

  public async finalizePendingBitcoinLock(args: {
    id: number;
    lock: IBitcoinLock;
    createdAtHeight: number;
    txFee: bigint;
  }) {
    const { id, lock, txFee, createdAtHeight } = args;
    const table = await this.getTable();
    const record = await table.finalizePending({
      id,
      status: BitcoinLockStatus.LockReadyForBitcoin,
      utxoId: lock.utxoId,
      ratchets: [
        {
          mintAmount: lock.liquidityPromised,
          mintPending: lock.liquidityPromised,
          peggedPrice: lock.peggedPrice,
          blockHeight: createdAtHeight,
          burned: 0n,
          securityFee: lock.securityFees,
          txFee,
          oracleBitcoinBlockHeight: lock.createdAtHeight,
        },
      ],
      liquidityPromised: lock.liquidityPromised,
      peggedPrice: lock.peggedPrice,
      lockDetails: lock,
    });
    console.log('FINALIZED PENDING BITCOIN LOCK', lock.liquidityPromised, { record });
    this.locksByUtxoId[record.utxoId!] = record;
    this.data.pendingLock = undefined;

    return record;
  }

  public async getFromApi(utxoId: number): Promise<IBitcoinLock> {
    const result = await this.#bitcoinLocksApi.getBitcoinLock(utxoId);
    if (!result) throw new Error('Unable to get bitcoin lock');
    return result;
  }

  public async createBitcoinLockAfterVaultCreate(args: {
    vaultId: number;
    hdPath: string;
    satoshis: bigint;
    txResult: TxResult;
    securityFee: bigint;
  }): Promise<IBitcoinLockRecord> {
    const { txResult, vaultId, hdPath, satoshis } = args;

    const { id } = await this.createPendingBitcoinLock({ vaultId, satoshis, hdPath });
    const { lock, createdAtHeight } = await this.#bitcoinLocksApi.getBitcoinLockFromTxResult(txResult);
    return this.finalizePendingBitcoinLock({
      id,
      lock,
      createdAtHeight,
      txFee: txResult.finalFee ?? 0n,
    });
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
    argonKeyring: KeyringPair;
    tip?: bigint;
    toScriptPubkey?: string;
    bitcoinFeeRatePerVb?: bigint;
  }): Promise<bigint> {
    const {
      lock,
      argonKeyring,
      // NOTE: not submitting, so a default value is ok
      toScriptPubkey = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
      bitcoinFeeRatePerVb = 5n,
    } = args;
    const client = this.#bitcoinLocksApi.client;

    const bitcoinNetworkFee = await this.calculateBitcoinNetworkFee(lock, bitcoinFeeRatePerVb, toScriptPubkey);
    const submitter = new TxSubmitter(
      client,
      client.tx.bitcoinLocks.requestRelease(
        lock.utxoId!,
        addressBytesHex(toScriptPubkey, this.bitcoinNetwork),
        bitcoinNetworkFee,
      ),
      argonKeyring,
    );
    return submitter.feeEstimate();
  }

  public async ratchet(lock: IBitcoinLockRecord, argonKeyring: KeyringPair, tip = 0n) {
    const table = await this.getTable();
    if (lock.status !== BitcoinLockStatus.LockedAndMinted && lock.status !== BitcoinLockStatus.LockedAndIsMinting) {
      throw new Error(`Lock with ID ${lock.utxoId} is not verified.`);
    }

    const vaults = useVaults();

    const result = await this.#bitcoinLocksApi.ratchet({
      lock: lock.lockDetails,
      priceIndex: this.#priceIndex.current,
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

  public async ownerCosignAndSendToBitcoin(lock: IBitcoinLockRecord, bitcoinSeed: Uint8Array): Promise<void> {
    if (lock.status !== BitcoinLockStatus.ReleaseSigned) return;
    const { bytes } = await this.ownerCosignAndGenerateTxBytes(lock, bitcoinSeed);
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
   * @param bip39Seed
   * @param addTx
   */
  public async ownerCosignAndGenerateTxBytes(
    lock: IBitcoinLockRecord,
    bip39Seed: Uint8Array,
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
    if (!lock.lockedTxid) {
      await this.updateLockingStatus(lock);
      if (!lock.lockedTxid) {
        throw new Error(`Utxo with ID ${lock.utxoId} not found.`);
      }
    }
    // NOTE: using api because the locally stored signature is encoded without the sighash byte. Should be fixed to
    // record correctly locally later.
    const cosignature = await this.#bitcoinLocksApi.findVaultCosignSignature(lock.utxoId!);
    if (!cosignature) {
      throw new Error(`Lock with ID ${lock.utxoId} has not been cosigned yet.`);
    }

    const cosign = new CosignScript(lock.lockDetails, this.bitcoinNetwork);
    const tx = cosign.cosignAndGenerateTx({
      releaseRequest: {
        toScriptPubkey: lock.releaseToDestinationAddress,
        bitcoinNetworkFee: lock.releaseBitcoinNetworkFee!,
      },
      vaultCosignature: cosignature.signature,
      utxoRef: { txid: lock.lockedTxid, vout: lock.lockedVout! },
      ownerXpriv: getChildXpriv(bip39Seed, lock.hdPath, this.bitcoinNetwork),
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
  public getRequestReleaseByVaultPercent(lock: IBitcoinLockRecord): number {
    if (lock.status === BitcoinLockStatus.ReleaseIsWaitingForVault) {
      const startTick = lock.requestedReleaseAtTick!;
      const startFrame = MiningFrames.getForTick(startTick);
      const dueFrame = startFrame + this.#config.lockReleaseCosignDeadlineFrames;
      const tickRangeOfDue = MiningFrames.getTickRangeForFrame(dueFrame);
      const totalTicks = tickRangeOfDue[1] - startTick;
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

  private async checkIncomingArgonBlock(header: Header): Promise<void> {
    const table = await this.getTable();
    const client = await getMainchainClient(false);

    const archivedBitcoinBlockHeight = this.data.oracleBitcoinBlockHeight;

    this.data.latestArgonBlockHeight = header.number.toNumber();
    this.data.oracleBitcoinBlockHeight = await client.query.bitcoinUtxos
      .confirmedBitcoinBlockTip()
      .then(x => x.value?.blockHeight.toNumber() ?? 0);

    const hasNewOracleBitcoinBlockHeight = archivedBitcoinBlockHeight !== this.data.oracleBitcoinBlockHeight;

    for (const lock of Object.values(this.data.locksByUtxoId)) {
      if (
        [
          BitcoinLockStatus.LockReadyForBitcoin,
          BitcoinLockStatus.LockedAndMinted,
          BitcoinLockStatus.LockedAndIsMinting,
          BitcoinLockStatus.LockIsProcessingOnBitcoin,
        ].includes(lock.status)
      ) {
        if (hasNewOracleBitcoinBlockHeight && lock.status === BitcoinLockStatus.LockIsProcessingOnBitcoin) {
          lock.lockProcessingLastOracleBlockDate = dayjs.utc().toDate();
          lock.lockProcessingLastOracleBlockHeight = this.data.oracleBitcoinBlockHeight;
          await table.updateLockProcessingLastOracleBlock(lock);
        }
        await this.updateLockingStatus(lock);
      }

      if ([BitcoinLockStatus.LockReadyForBitcoin, BitcoinLockStatus.LockIsProcessingOnBitcoin].includes(lock.status)) {
        await this.updateLockIsProcessingOnBitcoin(lock);
      }

      if (lock.status === BitcoinLockStatus.ReleaseIsWaitingForVault) {
        await this.updateVaultUnlockingSignature(lock);
      }

      if (lock.status === BitcoinLockStatus.ReleaseIsProcessingOnBitcoin) {
        lock.releaseProcessingLastOracleBlockDate = dayjs.utc().toDate();
        lock.releaseProcessingLastOracleBlockHeight = this.data.oracleBitcoinBlockHeight;
        await table.updateReleaseProcessingLastOracleBlock(lock);
        try {
          await this.updateReleaseIsProcessingOnBitcoin(lock);
          lock.releaseError = undefined;
        } catch (e) {
          lock.releaseError = String(e);
        }
      }

      if (!lock.lockedTxid) continue;

      const localPendingMint = lock.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
      if (localPendingMint > 0n) {
        const chainPendingArray = await this.#bitcoinLocksApi.findPendingMints(lock.utxoId!);
        const chainPendingMint = chainPendingArray.reduce((sum, x) => sum + x, 0n);

        let amountFulfilled = localPendingMint - chainPendingMint;
        // account for the pending amount by allocating to the last entrants in the ratchet list
        for (const ratchet of lock.ratchets) {
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

        await table.updateMintState(lock);
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

  private async updateLockingStatus(lock: IBitcoinLockRecord): Promise<void> {
    if (lock.lockedTxid) return;

    const table = await this.getTable();
    const utxo = await this.#bitcoinLocksApi.getBitcoinLock(lock.utxoId!);
    if (!utxo) {
      console.warn(`Lock with ID ${lock.utxoId} not found`);
      await table.setLockFailedToHappen(lock);
      return;
    }
    if (!utxo?.isVerified) {
      return;
    }

    const utxoRef = await this.#bitcoinLocksApi.getUtxoRef(lock.utxoId!);
    if (!utxoRef) {
      console.warn(`Utxo with ID ${lock.utxoId} not found`);
      return;
    }

    if (utxo.isVerified) {
      lock.lockedTxid = utxoRef.txid;
      lock.lockedVout = utxoRef.vout;
      await table.setLockedAndIsMinting(lock);
    } else if (utxo.isRejectedNeedsRelease) {
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

  private async getTable(): Promise<BitcoinLocksTable> {
    const db = await this.dbPromise;
    return db.bitcoinLocksTable;
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
