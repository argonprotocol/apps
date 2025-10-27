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
  ITxProgressCallback,
  KeyringPair,
  PriceIndex as PriceIndexModel,
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
import { MiningFrames, PriceIndex } from '@argonprotocol/commander-core';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

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
    locksById: { [utxoId: number]: IBitcoinLockRecord };
    oracleBitcoinBlockHeight: number;
    bitcoinNetwork: BitcoinNetwork;
    latestArgonBlockHeight: number;
  };

  private get locksById() {
    return this.data.locksById;
  }

  private get oracleBitcoinBlockHeight() {
    return this.data.oracleBitcoinBlockHeight;
  }

  public get totalMintPending() {
    return Object.values(this.locksById).reduce(
      (sum, lock) => sum + lock.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n),
      0n,
    );
  }

  public onBlockCallbackFn?: () => void;

  #config!: IBitcoinLockConfig;
  #lockTicksPerDay!: number;
  #bitcoinLocksApi!: BitcoinLocks;
  #subscription?: () => void;
  #waitForLoad?: IDeferred;
  #priceIndex: PriceIndex;

  constructor(
    readonly dbPromise: Promise<Db>,
    priceIndex: PriceIndex,
  ) {
    this.#priceIndex = priceIndex;
    this.data = {
      locksById: {},
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
    const cosignScript = new CosignScript(lock.lockDetails, this.bitcoinNetwork);
    const pubkey = cosignScript.calculateScriptPubkey();
    if (lock.lockDetails.p2wshScriptHashHex !== pubkey) {
      throw new Error(`Lock with ID ${lock.utxoId} has an invalid address.`);
    }
  }

  async load(): Promise<void> {
    if (this.#waitForLoad) return this.#waitForLoad.promise;
    this.#waitForLoad = createDeferred<void>();
    try {
      const client = await getMainchainClient(false);
      const table = await this.getTable();
      const locks = await table.fetchAll();

      for (const lock of locks) {
        this.locksById[lock.utxoId] = lock;
      }

      this.#bitcoinLocksApi ??= new BitcoinLocks(await getMainchainClient(true));
      this.#config ??= await this.#bitcoinLocksApi.getConfig();
      this.#lockTicksPerDay = client.consts.bitcoinLocks.argonTicksPerDay.toNumber();
      this.data.bitcoinNetwork = getBitcoinNetworkFromApi(this.#config.bitcoinNetwork);

      const latestArgonHeader = await client.rpc.chain.getHeader();
      await this.checkIncomingArgonBlock(latestArgonHeader);
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('Error loading BitcoinLocksStore:', error);
      this.#waitForLoad.reject(error);
    }
    return this.#waitForLoad.promise;
  }

  async subscribeToArgonBlocks() {
    const client = await getMainchainClient(false);
    this.#subscription ??= await client.rpc.chain.subscribeNewHeads(h => this.checkIncomingArgonBlock(h));
  }

  unsubscribeFromArgonBlocks() {
    this.#subscription?.();
    this.#subscription = undefined;
  }

  async updateVaultSignature(
    lock: IBitcoinLockRecord,
    vaultSignature?: { blockHeight: number; signature: Uint8Array },
  ): Promise<void> {
    const signature = vaultSignature ?? (await this.#bitcoinLocksApi.findVaultCosignSignature(lock.utxoId));

    if (signature) {
      const table = await this.getTable();
      await table.setReleasedByVault(lock, signature.signature, signature.blockHeight);
    }
  }

  private async checkIncomingArgonBlock(header: Header): Promise<void> {
    const table = await this.getTable();
    const client = await getMainchainClient(false);

    this.data.latestArgonBlockHeight = header.number.toNumber();
    this.data.oracleBitcoinBlockHeight = await client.query.bitcoinUtxos
      .confirmedBitcoinBlockTip()
      .then(x => x.value?.blockHeight.toNumber() ?? 0);

    for (const lock of Object.values(this.data.locksById)) {
      if (
        [
          BitcoinLockStatus.LockInitialized,
          BitcoinLockStatus.LockedAndMinted,
          BitcoinLockStatus.LockedAndMinting,
          BitcoinLockStatus.LockProcessingOnBitcoin,
        ].includes(lock.status)
      ) {
        await this.updateLockingStatus(lock);
      }

      if ([BitcoinLockStatus.LockInitialized, BitcoinLockStatus.LockProcessingOnBitcoin].includes(lock.status)) {
        await this.updateLockProcessingOnBitcoin(lock);
      }

      if (lock.status === BitcoinLockStatus.ReleaseWaitingForVault) {
        await this.updateVaultSignature(lock);
      }

      if (lock.status === BitcoinLockStatus.ReleaseProcessingOnBitcoin) {
        try {
          await this.updateReleaseProcessingOnBitcoin(lock);
          lock.releaseError = undefined;
        } catch (e) {
          lock.releaseError = String(e);
        }
      }

      const localPendingMint = lock.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
      if (localPendingMint > 0n) {
        const chainPending = await this.#bitcoinLocksApi.findPendingMints(lock.utxoId);
        const chainStillPending = chainPending.reduce((sum, x) => sum + x, 0n);

        let amountFulfilled = localPendingMint - chainStillPending;
        // account for the pending amount by allocating to the last entrants in the ratchet list
        for (const ratchet of lock.ratchets) {
          if (chainStillPending === 0n) {
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
    this.onBlockCallbackFn?.();
  }

  async getNextUtxoPubkey(args: { vault: Vault; bip39Seed: Uint8Array }) {
    const { vault, bip39Seed } = args;
    const table = await this.getTable();

    // get bitcoin xpriv to generate the pubkey
    const nextIndex = await table.getNextVaultHdKeyIndex(vault.vaultId);
    const hdPath = `m/1018'/0'/${vault.vaultId}'/0/${nextIndex}`;
    const ownerBitcoinXpriv = getChildXpriv(bip39Seed, hdPath, this.bitcoinNetwork);
    const ownerBitcoinPubkey = getCompressedPubkey(ownerBitcoinXpriv.publicKey!);

    return { ownerBitcoinPubkey, hdPath };
  }

  async satoshisForArgonLiquidity(microgonLiquidity: bigint): Promise<bigint> {
    return this.#bitcoinLocksApi.requiredSatoshisForArgonLiquidity(this.#priceIndex.current, microgonLiquidity);
  }

  async canPayMinimumFee(args: {
    vault: Vault;
    argonKeyring: KeyringPair;
    tip?: bigint;
    bip39Seed: Uint8Array;
  }): Promise<{ canAfford: boolean; txFeePlusTip: bigint; securityFee: bigint }> {
    const { vault, argonKeyring, tip = 0n, bip39Seed } = args;
    const ownerBitcoinXpriv = getChildXpriv(bip39Seed, `m/1018'/0'/${vault.vaultId}'/0/1`, this.bitcoinNetwork);
    const ownerBitcoinPubkey = getCompressedPubkey(ownerBitcoinXpriv.publicKey!);

    // explode on purpose if we can't afford even the minimum
    return await this.apiCreateInitializeLockTx({
      vault,
      priceIndex: this.#priceIndex.current,
      ownerBitcoinPubkey,
      argonKeyring,
      satoshis: await this.minimumSatoshiPerLock(),
      tip,
    });
  }

  async minimumSatoshiPerLock(): Promise<bigint> {
    const client = await getMainchainClient(false);
    return await client.query.bitcoinLocks.minimumSatoshis().then(x => x.toBigInt());
  }

  // TEMP COPY FROM MAINCHAIN
  // TODO: remove
  private async apiCreateInitializeLockTx(args: {
    vault: Vault;
    priceIndex: PriceIndexModel;
    ownerBitcoinPubkey: Uint8Array;
    satoshis: bigint;
    argonKeyring: KeyringPair;
    reducedBalanceBy?: bigint;
    tip?: bigint;
  }) {
    const { vault, priceIndex, argonKeyring, satoshis, tip = 0n, ownerBitcoinPubkey } = args;
    const client = await getMainchainClient(false);
    if (ownerBitcoinPubkey.length !== 33) {
      throw new Error(
        `Invalid Bitcoin key length: ${ownerBitcoinPubkey.length}. Must be a compressed pukey (33 bytes).`,
      );
    }

    const tx = client.tx.bitcoinLocks.initialize(vault.vaultId, satoshis, ownerBitcoinPubkey);
    const submitter = new TxSubmitter(
      client,
      client.tx.bitcoinLocks.initialize(vault.vaultId, satoshis, ownerBitcoinPubkey),
      argonKeyring,
    );
    const marketPrice = await this.#bitcoinLocksApi.getMarketRate(priceIndex, satoshis);
    const isVaultOwner = argonKeyring.address === vault.operatorAccountId;
    const securityFee = isVaultOwner ? 0n : vault.calculateBitcoinFee(marketPrice);

    const { canAfford, availableBalance, txFee } = await submitter.canAfford({
      tip,
      unavailableBalance: securityFee + (args.reducedBalanceBy ?? 0n),
      includeExistentialDeposit: true,
    });
    return { tx, securityFee, txFee, canAfford, availableBalance, txFeePlusTip: txFee + tip };
  }

  async createInitializeTx(args: {
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
      const { txFee, canAfford } = await this.apiCreateInitializeLockTx({
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

  public async saveUtxo(args: {
    vaultId: number;
    hdPath: string;
    securityFee: bigint;
    txFee: bigint;
    utxo: IBitcoinLock;
    blockNumber: number;
  }) {
    const { utxo, txFee, vaultId, hdPath, blockNumber: createdAtHeight, securityFee } = args;

    const table = await this.getTable();

    const record = await table.insert({
      utxoId: utxo.utxoId,
      status: BitcoinLockStatus.LockInitialized,
      satoshis: utxo.satoshis,
      ratchets: [
        {
          mintAmount: utxo.liquidityPromised,
          mintPending: utxo.liquidityPromised,
          peggedPrice: utxo.peggedPrice,
          blockHeight: createdAtHeight,
          burned: 0n,
          securityFee,
          txFee,
          oracleBitcoinBlockHeight: utxo.createdAtHeight,
        },
      ],
      liquidityPromised: utxo.liquidityPromised,
      peggedPrice: utxo.peggedPrice,
      cosignVersion: 'v1',
      lockDetails: utxo,
      network: this.#config.bitcoinNetwork.toString(),
      hdPath,
      vaultId,
    });
    this.locksById[record.utxoId] = record;
    return record;
  }

  public async getFromApi(utxoId: number): Promise<IBitcoinLock> {
    const result = await this.#bitcoinLocksApi.getBitcoinLock(utxoId);
    if (!result) throw new Error('Unable to get bitcoin lock');
    return result;
  }

  public async saveBitcoinLock(args: {
    vaultId: number;
    hdPath: string;
    satoshis: bigint;
    txResult: TxResult;
    securityFee: bigint;
  }): Promise<IBitcoinLockRecord> {
    const { txResult } = args;

    const { lock: utxo, createdAtHeight } = await this.#bitcoinLocksApi.getBitcoinLockFromTxResult(txResult);
    return this.saveUtxo({ ...args, utxo, blockNumber: createdAtHeight, txFee: txResult.finalFee ?? 0n });
  }

  async calculateBitcoinNetworkFee(
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

  fundingPsbt(lock: IBitcoinLockRecord): Uint8Array {
    if (lock.status !== BitcoinLockStatus.LockInitialized) {
      throw new Error(`Lock with ID ${lock.utxoId} is not in the initialized state.`);
    }
    return new CosignScript(lock.lockDetails, this.bitcoinNetwork).getFundingPsbt();
  }

  async estimatedReleaseArgonTxFee(args: {
    lock: IBitcoinLockRecord;
    argonKeyring: KeyringPair;
    tip?: bigint;
    toScriptPubkey?: string;
    bitcoinFeeRatePerVb?: bigint;
  }): Promise<bigint> {
    const {
      lock,
      argonKeyring,
      toScriptPubkey = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
      bitcoinFeeRatePerVb = 5n,
    } = args;
    const client = this.#bitcoinLocksApi.client;

    const bitcoinNetworkFee = await this.calculateBitcoinNetworkFee(lock, bitcoinFeeRatePerVb, toScriptPubkey);
    const submitter = new TxSubmitter(
      client,
      client.tx.bitcoinLocks.requestRelease(
        lock.utxoId,
        addressBytesHex(toScriptPubkey, this.bitcoinNetwork),
        bitcoinNetworkFee,
      ),
      argonKeyring,
    );
    return submitter.feeEstimate();
  }

  async requestRelease(args: {
    lock: IBitcoinLockRecord;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
    argonKeyring: KeyringPair;
    tip?: bigint;
    txProgressCallback?: ITxProgressCallback;
  }): Promise<void> {
    const { lock, bitcoinNetworkFee, toScriptPubkey, argonKeyring, tip = 0n, txProgressCallback } = args;
    if (lock.status !== BitcoinLockStatus.LockedAndMinted && lock.status !== BitcoinLockStatus.LockedAndMinting) {
      return;
    }
    const release = await this.#bitcoinLocksApi.requestRelease({
      lock: lock.lockDetails,
      priceIndex: this.#priceIndex.current,
      releaseRequest: {
        toScriptPubkey: addressBytesHex(toScriptPubkey, this.bitcoinNetwork),
        bitcoinNetworkFee,
      },
      argonKeyring,
      tip,
      txProgressCallback,
    });

    const api = await this.#bitcoinLocksApi.client.at(release.blockHash);

    lock.requestedReleaseAtTick = await api.query.ticks.currentTick().then(x => x.toNumber());
    lock.releaseToDestinationAddress = toScriptPubkey;
    lock.releaseBitcoinNetworkFee = bitcoinNetworkFee;

    const table = await this.getTable();
    await table.setReleaseWaitingForVault(lock);
  }

  private async ratchet(lock: IBitcoinLockRecord, argonKeyring: KeyringPair, tip = 0n) {
    const table = await this.getTable();
    if (lock.status !== BitcoinLockStatus.LockedAndMinted && lock.status !== BitcoinLockStatus.LockedAndMinting) {
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
    } = result;

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

  async ownerCosignAndSendToBitcoin(lock: IBitcoinLockRecord, bitcoinSeed: Uint8Array): Promise<void> {
    if (lock.status !== BitcoinLockStatus.ReleasedByVault) return;
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
    const txid = (await response.text()).trim();
    if (!txid.match(/^[0-9a-fA-F]{64}$/)) {
      throw new Error(`Invalid transaction ID returned from broadcast: ${txid}`);
    }

    const table = await this.getTable();
    await table.setReleaseProcessingOnBitcoin(lock, txid);
  }

  /**
   * Cosigns the transaction.
   *
   * @param lock
   * @param bip39Seed
   * @param addTx
   */
  async ownerCosignAndGenerateTxBytes(
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
    if (!lock.txid) {
      await this.updateLockingStatus(lock);
      if (!lock.txid) {
        throw new Error(`Utxo with ID ${lock.utxoId} not found.`);
      }
    }
    // NOTE: using api because the locally stored signature is encoded without the sighash byte. Should be fixed to
    // record correctly locally later.
    const cosignature = await this.#bitcoinLocksApi.findVaultCosignSignature(lock.utxoId);
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
      utxoRef: { txid: lock.txid, vout: lock.vout! },
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

  formatP2swhAddress(scriptHex: string): string {
    try {
      return p2wshScriptHexToAddress(scriptHex, this.bitcoinNetwork);
    } catch (e: any) {
      throw new Error(`Invalid address: ${scriptHex}. Ensure it is a valid hex address. ${e.message}`);
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

    console.log('STATUS ', status);
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
    const txid = lock.releasedTxid;
    console.log('Checking release finalize status for lock', { utxoId: lock.utxoId, txid });
    if (!txid) {
      throw new Error(`Lock with ID ${lock.utxoId} does not have a released txid saved to the db.`);
    }
    const mempoolStatusUrl = this.getMempoolApi(`tx/${txid}/status`);
    const response = await fetch(mempoolStatusUrl);
    const status = (await response.json()) as TxStatus;
    if (!status) {
      console.warn(`Transaction status for txid ${txid} not found.`);
      return;
    }

    return {
      isConfirmed: status.confirmed,
      transactionBlockHeight: status.block_height,
      transactionBlockTime: status.block_time,
      argonBitcoinHeight: this.oracleBitcoinBlockHeight,
    };
  }

  static async getFeeRates() {
    const res = await fetch('https://mempool.space/api/v1/fees/recommended');
    const data = await res.json();
    return {
      fast: { feeRate: BigInt(data.fastestFee), estimatedMinutes: 10 } as IFeeRate,
      medium: { feeRate: BigInt(data.halfHourFee), estimatedMinutes: 30 } as IFeeRate,
      slow: { feeRate: BigInt(data.hourFee), estimatedMinutes: 60 } as IFeeRate,
    };
  }

  getRequestReleaseByVaultPercent(lock: IBitcoinLockRecord): number {
    if (lock.status === BitcoinLockStatus.ReleaseWaitingForVault) {
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

  getLockProcessingPercent(lock: IBitcoinLockRecord): number {
    if (lock.status === BitcoinLockStatus.LockInitialized) return 0;
    if (lock.status !== BitcoinLockStatus.LockProcessingOnBitcoin) return 100;

    const currentOracleBitcoinHeight = this.data.oracleBitcoinBlockHeight;
    const startOracleBitcoinHeight = lock.lockProcessingOnBitcoinAtOracleBitcoinHeight!;
    const startBlock = lock.lockProcessingOnBitcoinAtBitcoinHeight!;

    if (!startBlock && lock.lockMempool) return 1;
    else if (!startBlock) return 0;

    const blocksNeeded = startBlock - startOracleBitcoinHeight;
    const blocksFound = currentOracleBitcoinHeight - startOracleBitcoinHeight;
    const maxProgress = getPercent(blocksFound, blocksNeeded);

    const startSeconds = lock.lockProcessingOnBitcoinAtBitcoinTime!;
    const currentSeconds = Math.floor(dayjs.utc().valueOf() / 1000);
    const secondsPerBlock = BITCOIN_BLOCK_MILLIS / 1000;
    const secondsExpected = blocksNeeded * secondsPerBlock;
    const secondsEllapsed = currentSeconds - startSeconds;
    const progress = getPercent(secondsEllapsed, secondsExpected);

    return Math.min(maxProgress, progress);
  }

  getReleaseProcessingPercent(lock: IBitcoinLockRecord): number {
    if (lock.status === BitcoinLockStatus.ReleaseComplete) return 100;
    if (lock.status !== BitcoinLockStatus.ReleaseProcessingOnBitcoin) return 0;

    const currentOracleBitcoinHeight = this.data.oracleBitcoinBlockHeight;
    const startOracleBitcoinHeight = lock.releaseProcessingOnBitcoinAtOracleBitcoinHeight!;
    const startBlock = lock.releaseProcessingOnBitcoinAtBitcoinHeight!;

    if (!startBlock && lock.releaseMempool) return 1;
    else if (!startBlock) return 0;

    const blocksNeeded = startBlock - startOracleBitcoinHeight;
    const blocksFound = currentOracleBitcoinHeight - startOracleBitcoinHeight;
    const maxProgress = getPercent(blocksFound, blocksNeeded);

    const startSeconds = lock.releaseProcessingOnBitcoinAtBitcoinTime!;
    const currentSeconds = Math.floor(dayjs.utc().valueOf() / 1000);
    const secondsPerBlock = BITCOIN_BLOCK_MILLIS / 1000;
    const secondsExpected = blocksNeeded * secondsPerBlock;
    const secondsEllapsed = currentSeconds - startSeconds;
    const progress = getPercent(secondsEllapsed, secondsExpected);

    return Math.min(maxProgress, progress);
  }

  private async updateLockProcessingOnBitcoin(lock: IBitcoinLockRecord) {
    try {
      const mempoolStatus = await this.checkMempoolFundingStatus(lock);
      if (mempoolStatus) {
        console.log('MEMPOOL STATUS:', mempoolStatus);
        const table = await this.getTable();
        await table.setLockProcessingOnBitcoin(lock, mempoolStatus, this.oracleBitcoinBlockHeight);
      }
    } catch (error) {
      console.error('Error checking UTXO status:', error);
    }
  }

  async updateReleaseProcessingOnBitcoin(lock: IBitcoinLockRecord) {
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
    if (lock.txid) return;

    const table = await this.getTable();
    const utxo = await this.#bitcoinLocksApi.getBitcoinLock(lock.utxoId);
    if (!utxo) {
      console.warn(`Lock with ID ${lock.utxoId} not found`);
      await table.setLockVerificationExpired(lock);
      return;
    }
    if (!utxo?.isVerified) {
      return;
    }

    const utxoRef = await this.#bitcoinLocksApi.getUtxoRef(lock.utxoId);
    if (!utxoRef) {
      console.warn(`Utxo with ID ${lock.utxoId} not found`);
      return;
    }

    if (utxo.isVerified) {
      lock.txid = utxoRef.txid;
      lock.vout = utxoRef.vout;
      await table.setLockedAndMinting(lock);
    } else if (utxo.isRejectedNeedsRelease) {
      await table.setLockReceivedWrongAmount(lock);
    }
  }

  private async getTable(): Promise<BitcoinLocksTable> {
    const db = await this.dbPromise;
    return db.bitcoinLocksTable;
  }
}

export interface IFeeRate {
  feeRate: bigint; // sat/vB
  estimatedMinutes: number; // estimated time in minutes for the transaction to be included
}
