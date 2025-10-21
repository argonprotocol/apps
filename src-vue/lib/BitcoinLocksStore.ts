import { getMainchainClient, getMainchainClientAt } from '../stores/mainchain.ts';
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
  Header,
  IBitcoinLock,
  type IBitcoinLockConfig,
  ITxProgressCallback,
  KeyringPair,
  TxResult,
  u8aToHex,
  Vault,
} from '@argonprotocol/mainchain';
import { Db } from './Db.ts';
import { BitcoinLocksTable, BitcoinLockStatus, IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import { useVaults } from '../stores/vaults.ts';
import { createDeferred, IDeferred } from './Utils.ts';
import { BITCOIN_BLOCK_MILLIS, ESPLORA_HOST } from './Env.ts';
import { type AddressTxsUtxo } from '@mempool/mempool.js/lib/interfaces/bitcoin/addresses';
import { type TxStatus } from '@mempool/mempool.js/lib/interfaces/bitcoin/transactions';
import { PriceIndex } from '@argonprotocol/commander-core';

export interface IMempoolFundingStatus {
  isConfirmed: boolean;
  confirmations: number;
  satoshis: bigint;
  transactionBlockHeight: number;
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
    latestBlockHeight: number;
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

  #config!: IBitcoinLockConfig;
  #lockTicksPerDay!: number;
  #bitcoinLocksApi!: BitcoinLocks;
  #subscription?: () => void;
  #waitForLoad?: IDeferred;
  #priceIndex: PriceIndex;
  #isMonitoringLockProcessingOnBitcoin: boolean = false;

  constructor(
    readonly dbPromise: Promise<Db>,
    priceIndex: PriceIndex,
  ) {
    this.#priceIndex = priceIndex;
    this.data = {
      locksById: {},
      oracleBitcoinBlockHeight: 0,
      bitcoinNetwork: BitcoinNetwork.Bitcoin,
      latestBlockHeight: 0,
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
    this.#subscription = await client.rpc.chain.subscribeNewHeads(h => this.checkIncomingArgonBlock(h));
  }

  unsubscribeFromArgonBlocks() {
    this.#subscription?.();
    this.#subscription = undefined;
  }

  async updateVaultSignature(lock: IBitcoinLockRecord): Promise<void> {
    const signature = await this.#bitcoinLocksApi.findVaultCosignSignature(lock.utxoId);

    if (signature) {
      const table = await this.getTable();
      await table.setReleaseSubmittingToBitcoin(lock, signature.signature, signature.blockHeight);
    }
  }

  private async checkIncomingArgonBlock(header: Header): Promise<void> {
    const table = await this.getTable();
    const client = await getMainchainClient(false);

    this.data.latestBlockHeight = header.number.toNumber();
    this.data.oracleBitcoinBlockHeight = await client.query.bitcoinUtxos
      .confirmedBitcoinBlockTip()
      .then(x => x.value?.blockHeight.toNumber() ?? 0);

    for (const lock of Object.values(this.data.locksById)) {
      if (lock.status === BitcoinLockStatus.LockInitialized || lock.status === BitcoinLockStatus.LockedAndMinted) {
        await this.updateLockingStatus(lock);
      } else if (lock.status === BitcoinLockStatus.ReleaseWaitingForVault) {
        await this.updateVaultSignature(lock);
      }

      if (lock.status === BitcoinLockStatus.LockedAndMinting) {
        await this.updateLockingStatus(lock);
        const chainPending = await this.#bitcoinLocksApi.findPendingMints(lock.utxoId);
        const localPending = lock.ratchets.reduce((sum, ratchet) => sum + ratchet.mintPending, 0n);
        const chainStillPending = chainPending.reduce((sum, x) => sum + x, 0n);
        if (chainStillPending === 0n) {
          for (const ratchet of lock.ratchets) {
            ratchet.mintPending = 0n;
          }
          await table.setLockedAndMinted(lock);
        } else {
          let amountFulfilled = localPending - chainStillPending;
          // account for the pending amount by allocating to the last entrants in the ratchet list
          for (const ratchet of lock.ratchets) {
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
          await table.updateLockedAndMinting(lock);
        }
      }
    }
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

    const client = await getMainchainClient(false);

    const minimumSatoshis = await client.query.bitcoinLocks.minimumSatoshis().then(x => x.toBigInt());
    let microgonLiquidity = args.microgonLiquidity;
    const availableBtcSpace = vault.availableBitcoinSpace() + addingVaultSpace;
    if (availableBtcSpace < microgonLiquidity) {
      console.info('Vault liquidity is less than requested microgon liquidity, using vault available space instead.', {
        availableBtcSpace,
        requestedLiquidity: microgonLiquidity,
      });
      microgonLiquidity = availableBtcSpace;
    }
    let satoshis = await this.#bitcoinLocksApi.requiredSatoshisForArgonLiquidity(
      this.#priceIndex.current,
      microgonLiquidity,
    );
    while (satoshis >= minimumSatoshis) {
      try {
        const { txFee } = await this.#bitcoinLocksApi.createInitializeLockTx({
          vault,
          priceIndex: this.#priceIndex.current,
          ownerBitcoinPubkey,
          argonKeyring,
          satoshis,
          tip,
        });

        if (maxMicrogonSpend === undefined || maxMicrogonSpend >= txFee) {
          break;
        }
      } catch (e) {}
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

  async requestRelease(args: {
    lock: IBitcoinLockRecord;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
    argonKeyring: KeyringPair;
    tip?: bigint;
    txProgressCallback?: ITxProgressCallback;
  }): Promise<void> {
    const { lock, bitcoinNetworkFee, toScriptPubkey, argonKeyring, tip = 0n, txProgressCallback } = args;
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

    lock.requestedReleaseAtHeight = release.blockHeight;
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

  async broadcastReleaseTransaction(txBytes: Uint8Array, utxo: IBitcoinLockRecord): Promise<string> {
    const api = this.getMempoolApi();
    const response = await fetch(`${api}tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: u8aToHex(txBytes, undefined, false),
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
    await table.setReleaseProcessingOnBitcoin(utxo);

    return txid;
  }

  /**
   * Cosigns the transaction.
   *
   * @param lock
   * @param bip39Seed
   * @param addTx
   */
  async cosignAndGenerateTxBytes(
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
    if (!lock.releaseCosignSignature) {
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

  getMempoolApi() {
    let network = 'mainnet';
    if (this.bitcoinNetwork === BitcoinNetwork.Testnet) {
      network = 'testnet';
    } else if (this.bitcoinNetwork === BitcoinNetwork.Signet) {
      network = 'signet';
    } else if (this.bitcoinNetwork === BitcoinNetwork.Regtest) {
      network = 'regtest';
    }

    return `${ESPLORA_HOST ?? 'https://mempool.space/api'}/`;
  }

  async checkTxidStatus(
    lock: IBitcoinLockRecord,
    txid: string,
  ): Promise<{
    isConfirmed: boolean;
    blockHeight: number;
  }> {
    const api = this.getMempoolApi();
    const response = await fetch(`${api}tx/${txid}/status`);
    const status = (await response.json()) as TxStatus;
    if (!status) {
      throw new Error(`Transaction with ID ${txid} not found.`);
    }

    if (status.confirmed) {
      lock.releasedAtHeight = status.block_height;
      lock.releasedTxId = txid;

      const table = await this.getTable();
      await table.setReleaseComplete(lock);
    }

    return {
      blockHeight: status.block_height,
      isConfirmed: status.confirmed,
    };
  }

  async checkMempoolFundingStatus(lock: IBitcoinLockRecord): Promise<IMempoolFundingStatus | undefined> {
    const baseUrl = this.getMempoolApi();
    const payToScriptAddress = lock.lockDetails.p2wshScriptHashHex;
    const response = await fetch(`${baseUrl}address/${this.formatP2swhAddress(payToScriptAddress)}/utxo`);
    const txs = (await response.json()) as AddressTxsUtxo[];
    if (!txs.length) return undefined;

    const tx = txs[0]; // Get the most recent transaction
    const argonBitcoinHeight = this.oracleBitcoinBlockHeight;
    const blockTipResponse = await fetch(`${baseUrl}blocks/tip/height`);
    const tip: number = await blockTipResponse.json();
    const status = tx.status;

    return {
      satoshis: BigInt(tx.value),
      isConfirmed: status.confirmed,
      confirmations: status.confirmed ? tip - status.block_height : 0,
      transactionBlockHeight: status.block_height,
      argonBitcoinHeight,
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

  async monitorLockProcessingOnBitcoin(
    lock: IBitcoinLockRecord,
    statusCallbackFn: (status: IMempoolFundingStatus | undefined) => void,
  ) {
    if (this.#isMonitoringLockProcessingOnBitcoin) throw new Error('Bitcoin processing monitor already activated');
    else if (!lock) throw new Error('Utxo is not set');

    const table = await this.getTable();
    let mempoolStatus: IMempoolFundingStatus | undefined;

    while (true) {
      if (![BitcoinLockStatus.LockInitialized, BitcoinLockStatus.LockProcessingOnBitcoin].includes(lock.status)) break;
      try {
        mempoolStatus = await this.checkMempoolFundingStatus(lock);
        if (mempoolStatus?.isConfirmed) {
          const pendingBlocks = mempoolStatus.transactionBlockHeight - this.data.oracleBitcoinBlockHeight;
          if (pendingBlocks > 0) {
            await table.setLockProcessingOnBitcoin(lock);
          } else {
            await table.setLockedAndMinting(lock);
          }
        } else if (mempoolStatus) {
          await table.setLockProcessingOnBitcoin(lock);
        }
      } catch (error) {
        console.error('Error checking UTXO status:', error);
      }
      statusCallbackFn(mempoolStatus);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    this.stopMonitoringLockProcessingOnBitcoin();
  }

  stopMonitoringLockProcessingOnBitcoin() {
    this.#isMonitoringLockProcessingOnBitcoin = false;
  }

  async monitorReleaseProcessingOnBitcoin(utxo: IBitcoinLockRecord, txid: string): Promise<void> {
    // if (!waitForReleasedUtxoId.value) return;
    // if (utxo.status === BitcoinLockStatus.ReleaseSubmittingToBitcoin) {
    //   const status = await this.checkTxidStatus(utxo, waitForReleasedUtxoId.value);
    //   if (status.isConfirmed) {
    //     if (releasedUtxoCheckInterval) clearInterval(releasedUtxoCheckInterval);
    //     emit('close');
    //   }
    // }
  }

  private async updateLockingStatus(lock: IBitcoinLockRecord): Promise<void> {
    if (lock.txid) return;

    const utxo = await this.#bitcoinLocksApi.getBitcoinLock(lock.utxoId);
    if (!utxo || !utxo.isVerified) return;

    const utxoRef = await this.#bitcoinLocksApi.getUtxoRef(lock.utxoId);
    if (!utxoRef) {
      console.warn(`Utxo with ID ${lock.utxoId} not found`);
      return;
    }

    const table = await this.getTable();

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
