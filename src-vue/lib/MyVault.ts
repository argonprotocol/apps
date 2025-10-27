import {
  ArgonClient,
  BitcoinLocks,
  ExtrinsicError,
  FIXED_U128_DECIMALS,
  ITxProgressCallback,
  KeyringPair,
  PalletVaultsVaultFrameRevenue,
  PERMILL_DECIMALS,
  SubmittableExtrinsic,
  toFixedNumber,
  TxResult,
  TxSubmitter,
  u64,
  u8aToHex,
  Vault,
  Vec,
} from '@argonprotocol/mainchain';
import { BitcoinNetwork, CosignScript, getBitcoinNetworkFromApi, getChildXpriv, HDKey } from '@argonprotocol/bitcoin';
import { Db } from './Db.ts';
import { getMainchainClient, getMainchainClients } from '../stores/mainchain.ts';
import { createDeferred, getPercent, IDeferred, percentOf } from './Utils.ts';
import { IVaultRecord, VaultsTable } from './db/VaultsTable.ts';
import { IVaultingRules } from '../interfaces/IVaultingRules.ts';
import BigNumber from 'bignumber.js';
import { Vaults } from './Vaults.ts';
import { IVaultStats } from '../interfaces/IVaultStats.ts';
import { toRaw } from 'vue';
import BitcoinLocksStore from './BitcoinLocksStore.ts';
import { bigIntMax, bigIntMin, bigNumberToBigInt, MiningFrames } from '@argonprotocol/commander-core';
import { MyVaultRecovery } from './MyVaultRecovery.ts';
import { BitcoinLockStatus, IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';

export const FEE_ESTIMATE = 75_000n;
export const DEFAULT_MASTER_XPUB_PATH = "m/84'/0'/0'";

export class MyVault {
  public data: {
    isReady: boolean;
    createdVault: Vault | null;
    creatingVaultPromise?: Promise<{ vault: Vault; txResult: TxResult }>;
    metadata: IVaultRecord | null;
    stats: IVaultStats | null;
    ownTreasuryPoolCapitalDeployed: bigint;
    pendingCollectRevenue: bigint;
    pendingCosignUtxoIds: Set<number>;
    nextCollectDueDate: number;
    finalizeMyBitcoinError?: { lockUtxoId: number; error: string };
    currentFrameId: number;
    prebondedMicrogons: bigint;
  };

  public get createdVault(): Vault | null {
    return this.data.createdVault;
  }

  public get metadata(): IVaultRecord | null {
    return this.data.metadata;
  }

  public get tickDuration(): number {
    return this.vaults?.tickDuration ?? 0;
  }

  #bitcoinNetwork?: BitcoinNetwork;
  #waitForLoad?: IDeferred;
  #table?: VaultsTable;
  #subscriptions: VoidFunction[] = [];
  #bitcoinLocks?: BitcoinLocks;
  #configs?: {
    timeToCollectFrames: number;
  };

  constructor(
    readonly dbPromise: Promise<Db>,
    readonly vaults: Vaults,
  ) {
    this.data = {
      isReady: false,
      createdVault: null,
      metadata: null,
      stats: null,
      ownTreasuryPoolCapitalDeployed: 0n,
      pendingCollectRevenue: 0n,
      pendingCosignUtxoIds: new Set(),
      nextCollectDueDate: 0,
      currentFrameId: 0,
      prebondedMicrogons: 0n,
    };
    this.vaults = vaults;
  }

  public async getBitcoinNetwork(): Promise<BitcoinNetwork> {
    if (this.#bitcoinNetwork) {
      return this.#bitcoinNetwork;
    }
    const client = await getMainchainClient(false);
    const bitcoinNetwork = await client.query.bitcoinUtxos.bitcoinNetwork();
    this.#bitcoinNetwork = getBitcoinNetworkFromApi(bitcoinNetwork);
    return this.#bitcoinNetwork;
  }

  public async getVaultXpriv(bip39Seed: Uint8Array, masterXpubPath?: string): Promise<HDKey> {
    masterXpubPath ??= this.metadata!.hdPath;
    if (!masterXpubPath) {
      throw new Error('No master xpub path defined in metadata');
    }
    const network = await this.getBitcoinNetwork();
    return getChildXpriv(bip39Seed, masterXpubPath, network);
  }

  public async load(reload = false): Promise<void> {
    if (this.#waitForLoad && !reload) return this.#waitForLoad.promise;

    this.#waitForLoad ??= createDeferred();
    try {
      console.log('Loading MyVault...');
      await this.vaults.load(reload);

      void this.vaults.refreshRevenue().then(() => {
        const vaultId = this.metadata?.id;
        if (vaultId) {
          this.data.stats = this.vaults.stats?.vaultsById[vaultId] ?? null;
        }
      });
      const table = await this.getTable();
      const client = await getMainchainClient(true);
      this.#bitcoinLocks ??= new BitcoinLocks(client);
      this.data.metadata = (await table.get()) ?? null;
      // prefetch the config
      const timeToCollectFrames = client.consts.vaults.revenueCollectionExpirationFrames.toNumber();
      this.#configs = {
        timeToCollectFrames,
      };
      const vaultId = this.data.metadata?.id;
      if (vaultId) {
        this.data.createdVault = this.vaults.vaultsById[vaultId];
        this.data.stats = this.vaults.stats?.vaultsById[vaultId] ?? null;
        console.log('Stats on load:', toRaw(this.data.stats));
      }

      this.data.isReady = true;
      this.#waitForLoad.resolve();
    } catch (error) {
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  public async subscribe() {
    if (this.#subscriptions.length) return;
    if (!this.createdVault) {
      throw new Error('No vault created to subscribe to');
    }
    const vaultId = this.createdVault.vaultId;
    const client = await getMainchainClient(false);
    const sub = await client.query.vaults.vaultsById(vaultId, async vault => {
      if (vault.isNone) return;
      this.createdVault?.load(vault.unwrap());
      await this.updateRevenue();
    });

    const sub2 = await client.query.vaults.revenuePerFrameByVault(vaultId, async x => {
      await this.updateRevenue(x);
    });

    const sub3 = await client.query.vaults.pendingCosignByVaultId(vaultId, x => this.recordPendingCosignUtxos(x));
    const sub4 = await client.query.vaults.lastCollectFrameByVaultId(vaultId, x =>
      this.updateCollectDueDate(x.isSome ? x.unwrap().toNumber() : undefined),
    );

    const sub5 = await client.query.miningSlot.nextFrameId(frameId => {
      this.data.currentFrameId = frameId.toNumber() - 1;
      void this.updateCollectDueDate();
    });

    const sub6 = await client.query.treasury.prebondedByVaultId(vaultId, prebonded => {
      this.data.prebondedMicrogons = prebonded.isSome ? prebonded.unwrap().amountUnbonded.toBigInt() : 0n;
    });

    this.#subscriptions.push(sub, sub2, sub3, sub4, sub5);
  }

  private async updateCollectDueDate(lastCollectFrameId?: number) {
    const framesToCollect = this.#configs!.timeToCollectFrames;
    let nextCollectFrame;
    if (lastCollectFrameId) {
      nextCollectFrame = lastCollectFrameId + framesToCollect;
    } else {
      nextCollectFrame = this.data.currentFrameId + framesToCollect;
      const oldestToCollectFrame = this.data.currentFrameId - framesToCollect;
      for (const frameChange of this.data.stats?.changesByFrame ?? []) {
        if (frameChange.frameId >= oldestToCollectFrame && frameChange.uncollectedEarnings > 0n) {
          nextCollectFrame = frameChange.frameId + framesToCollect;
        }
      }
    }
    this.data.nextCollectDueDate = MiningFrames.frameToDateRange(nextCollectFrame)[1].getTime();
  }

  private async recordPendingCosignUtxos(rawUtxoIds: Iterable<u64>) {
    this.data.pendingCosignUtxoIds.clear();
    for (const utxoId of rawUtxoIds) {
      this.data.pendingCosignUtxoIds.add(utxoId.toNumber());
    }
  }

  public async finalizeMyBitcoinUnlock(args: {
    argonKeyring: KeyringPair;
    lock: IBitcoinLockRecord;
    bitcoinXprivSeed: Uint8Array;
    bitcoinLocks: BitcoinLocksStore;
  }): Promise<void> {
    const { lock, bitcoinLocks, argonKeyring, bitcoinXprivSeed } = args;
    if (lock.vaultId !== this.createdVault?.vaultId) {
      // this api is only to unlock our own vault's bitcoin locks
      return;
    }
    try {
      this.data.finalizeMyBitcoinError = undefined;
      // could be moved to BitcoinLocksStore
      if (lock.status === BitcoinLockStatus.ReleaseWaitingForVault) {
        const result = await this.cosignRelease({
          argonKeyring: argonKeyring,
          vaultXpriv: await this.getVaultXpriv(bitcoinXprivSeed),
          utxoId: lock.utxoId,
          toScriptPubkey: lock.releaseToDestinationAddress!,
          bitcoinNetworkFee: lock.releaseBitcoinNetworkFee!,
        });
        if (!result) {
          throw new Error("Failed to add the vault's co-signature.");
        }
        if (!lock.releaseCosignVaultSignature) {
          await bitcoinLocks.updateVaultSignature(lock, {
            signature: result.vaultSignature,
            blockHeight: result.blockNumber,
          });
        }
      }
      if (lock.status === BitcoinLockStatus.ReleasedByVault) {
        await bitcoinLocks.ownerCosignAndSendToBitcoin(lock, bitcoinXprivSeed);
      }
    } catch (error) {
      console.error(`Error releasing bitcoin lock ${lock.utxoId}`, error);
      this.data.finalizeMyBitcoinError = { lockUtxoId: lock.utxoId, error: String(error) };
    }
  }

  public async cosignRelease(args: {
    argonKeyring: KeyringPair;
    vaultXpriv: HDKey;
    utxoId: number;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
    progressCallback?: ITxProgressCallback;
  }): Promise<
    { blockNumber: number; blockHash: Uint8Array; txResult: TxResult; vaultSignature: Uint8Array } | undefined
  > {
    const { argonKeyring, vaultXpriv, utxoId, progressCallback, bitcoinNetworkFee, toScriptPubkey } = args;

    const lock = await this.#bitcoinLocks!.getBitcoinLock(utxoId);
    if (!lock) {
      console.warn('No lock found for utxoId:', utxoId);
      return;
    }

    const releaseRequest = await this.#bitcoinLocks!.getReleaseRequest(utxoId);
    if (!releaseRequest) {
      console.warn('No release request found for utxoId:', utxoId);
      return;
    }
    const utxoRef = await this.#bitcoinLocks!.getUtxoRef(utxoId);
    if (!utxoRef) {
      console.warn('No UTXO reference found for utxoId:', utxoId);
      return;
    }

    const cosign = new CosignScript(lock, await this.getBitcoinNetwork());
    const psbt = cosign.getCosignPsbt({
      releaseRequest: {
        bitcoinNetworkFee,
        toScriptPubkey,
      },
      utxoRef,
    });
    const signedPsbt = cosign.vaultCosignPsbt(psbt, lock, vaultXpriv);
    const vaultSignature = signedPsbt.getInput(0).partialSig?.[0]?.[1];
    if (!vaultSignature) {
      throw new Error('Failed to get vault signature from PSBT for utxoId: ' + utxoId);
    }

    const txResult = await this.#bitcoinLocks!.submitVaultSignature({
      utxoId,
      vaultSignature,
      argonKeyring,
      txProgressCallback: progressCallback,
    });
    await this.trackTxResultFee(txResult, true);
    const client = await getMainchainClient(false);
    const blockHash = txResult.includedInBlock!;
    const api = await client.at(blockHash);
    const txResultBlockNumber = await api.query.system.number();

    console.log(`Cosigned and submitted transaction for utxoId ${utxoId} at ${u8aToHex(blockHash)}`);
    return { blockNumber: txResultBlockNumber.toNumber(), blockHash, txResult, vaultSignature };
  }

  public async collect(
    args: { argonKeyring: KeyringPair; xprivSeed: Uint8Array },
    progressCallback?: (cosignProgress: number, activeTransactionProgress: number, steps: number) => void,
  ) {
    if (!this.createdVault) {
      throw new Error('No vault created to collect revenue');
    }
    if (!this.metadata) {
      throw new Error('No metadata available to collect revenue');
    }
    const { argonKeyring, xprivSeed } = args;
    const toCollect = this.data.pendingCosignUtxoIds;

    const steps = toCollect.size + 1; // +1 for the final collect transaction
    const vaultXpriv = await this.getVaultXpriv(xprivSeed, this.metadata.hdPath);
    let completed = 0;
    const client = await getMainchainClient(false);
    for (const utxoId of toCollect) {
      const pendingReleaseRaw = await client.query.bitcoinLocks.lockReleaseRequestsByUtxoId(utxoId);
      if (pendingReleaseRaw.isNone) {
        continue;
      }
      const pendingRelease = pendingReleaseRaw.unwrap();

      await this.cosignRelease({
        argonKeyring,
        vaultXpriv,
        utxoId,
        bitcoinNetworkFee: pendingRelease.bitcoinNetworkFee.toBigInt(),
        toScriptPubkey: pendingRelease.toScriptPubkey.toHex(),
        progressCallback(progressPct) {
          if (progressCallback) {
            progressCallback((completed * 100) / steps, progressPct, steps);
          }
        },
      });
      completed++;
    }
    // now we can collect!
    const tx = new TxSubmitter(client, client.tx.vaults.collect(this.createdVault.vaultId), argonKeyring);
    const txResult = await tx.submit({
      txProgressCallback(progressPct) {
        if (progressCallback) {
          progressCallback((completed * 100) / steps, progressPct, steps);
        }
      },
    });
    await this.trackTxResultFee(txResult, true);
    completed++;
    if (progressCallback) {
      progressCallback(100, 100, steps);
    }
  }

  public async create(args: {
    argonKeyring: KeyringPair;
    xprivSeed: Uint8Array;
    rules: IVaultingRules;
    masterXpubPath: string;
    progressCallback?: ITxProgressCallback;
  }) {
    if (this.data.creatingVaultPromise) {
      return this.data.creatingVaultPromise;
    }

    console.log('Creating a vault with address', args.argonKeyring.address);

    const createVaultDeferred = createDeferred<{ vault: Vault; txResult: TxResult }>();
    this.data.creatingVaultPromise = createVaultDeferred.promise;
    try {
      const { argonKeyring, xprivSeed, masterXpubPath, rules } = args;

      const vaultXpriv = await this.getVaultXpriv(xprivSeed, masterXpubPath);
      const masterXpub = vaultXpriv.publicExtendedKey;
      const client = await getMainchainClient(false);
      const table = await this.getTable();
      const { vault, txResult } = await Vault.create(
        client,
        argonKeyring,
        {
          securitizationRatio: rules.securitizationRatio,
          securitization: 1,
          annualPercentRate: rules.btcPctFee / 100,
          baseFee: rules.btcFlatFee,
          bitcoinXpub: masterXpub,
          treasuryProfitSharing: rules.profitSharingPct / 100,
          txProgressCallback: args.progressCallback,
        },
        { tickDurationMillis: this.vaults.tickDuration },
      );
      const api = await client.at(txResult.includedInBlock!);
      const blockNumber = await api.query.system.number();
      this.data.metadata = await table.insert(
        vault.vaultId,
        masterXpubPath,
        blockNumber.toNumber(),
        (txResult.finalFee ?? 0n) + (txResult.finalFeeTip ?? 0n),
      );
      this.data.createdVault = vault;
      this.vaults.vaultsById[vault.vaultId] = vault;
      createVaultDeferred.resolve({ vault, txResult });
    } catch (error) {
      if (error instanceof ExtrinsicError) {
        // TODO: where to record these fees that are still paid by the user?
      }
      console.error('Error creating vault:', error);
      createVaultDeferred.reject(error as Error);
    }
    this.data.creatingVaultPromise = undefined;
    return createVaultDeferred.promise;
  }

  public async updateRevenue(frameRevenues?: Vec<PalletVaultsVaultFrameRevenue>): Promise<void> {
    if (!this.createdVault) {
      throw new Error('No vault created to update revenue');
    }
    const client = await getMainchainClient(false);
    const vaultId = this.createdVault.vaultId;
    frameRevenues ??= await client.query.vaults.revenuePerFrameByVault(vaultId);
    this.vaults.vaultsById[vaultId] = this.createdVault;

    await this.vaults.updateVaultRevenue(vaultId, frameRevenues);
    this.data.ownTreasuryPoolCapitalDeployed = 0n;
    this.data.pendingCollectRevenue = 0n;
    for (const frameRevenue of frameRevenues) {
      this.data.ownTreasuryPoolCapitalDeployed += frameRevenue.treasuryVaultCapital.toBigInt();
      this.data.pendingCollectRevenue += frameRevenue.uncollectedRevenue.toBigInt();
    }
    const data = this.vaults.stats?.vaultsById?.[vaultId];
    if (data) {
      this.data.stats = { ...data };
    }
  }

  public unsubscribe() {
    for (const sub of this.#subscriptions) {
      sub();
    }
    this.#subscriptions.length = 0;
  }

  public async activeMicrogonsForTreasuryPool(): Promise<{ maxAmountPerFrame?: bigint; active: bigint }> {
    if (!this.createdVault) {
      throw new Error('No vault created to get active treasury pool funds');
    }
    const client = await getMainchainClient(false);
    const vaultId = this.createdVault.vaultId;
    const prebondedToPool = await client.query.treasury.prebondedByVaultId(vaultId);
    const activePoolFunds =
      this.data.stats?.changesByFrame
        .slice(0, 10)
        .reduce((total, change) => total + change.treasuryPool.vaultCapital, 0n) ?? 0n;

    const maxAmountPerFrame = prebondedToPool.isSome
      ? prebondedToPool.unwrap().maxAmountPerFrame.toBigInt()
      : undefined;
    return { active: activePoolFunds, maxAmountPerFrame };
  }

  public async recoverAccountVault(
    bitcoinLocksStore: BitcoinLocksStore,
    args: { vaultingAddress: string; bitcoinXprivSeed: Uint8Array; onProgress: (progress: number) => void },
  ): Promise<IVaultingRules | undefined> {
    await this.deleteAllDbData();
    const { vaultingAddress, bitcoinXprivSeed, onProgress } = args;
    console.log('Recovering vault for address', vaultingAddress);
    const mainchainClients = getMainchainClients();
    const client = await mainchainClients.archiveClientPromise;
    onProgress(0);

    const foundVault = await MyVaultRecovery.findOperatorVault(
      mainchainClients,
      bitcoinLocksStore.bitcoinNetwork,
      vaultingAddress,
      bitcoinXprivSeed,
    );
    onProgress(50);
    if (!foundVault) {
      onProgress(100);
      return;
    }

    const vault = foundVault.vault;
    const vaultId = vault.vaultId;
    const table = await this.getTable();

    this.data.metadata = await table.insert(
      vault.vaultId,
      foundVault.masterXpubPath,
      foundVault.createBlockNumber,
      foundVault.txFee,
    );
    this.data.createdVault = vault;
    this.vaults.vaultsById[vault.vaultId] = vault;

    const prebond = await MyVaultRecovery.findPrebonded({
      client,
      vaultId,
      vaultingAddress,
      vaultCreatedBlockNumber: foundVault.createBlockNumber,
    });
    if (prebond) {
      // add fee from update
      this.metadata!.prebondedMicrogons = prebond.prebondedMicrogons;
      this.metadata!.prebondedMicrogonsAtTick = prebond.tick;
      this.metadata!.operationalFeeMicrogons ??= 0n;
      this.metadata!.operationalFeeMicrogons += prebond.txFee ?? 0n;
    }
    onProgress(75);

    let bitcoin: IBitcoinLockRecord | undefined;
    const hasSecuritization = vault.activatedSecuritization() > 0n || vault.argonsPendingActivation > 0n;
    if (hasSecuritization && prebond.blockNumber) {
      const bitcoins = await MyVaultRecovery.recoverPersonalBitcoin({
        mainchainClients,
        bitcoinLocksStore,
        vaultSetupBlockNumber: prebond.blockNumber,
        bip39Seed: bitcoinXprivSeed,
        vault,
      });

      if (bitcoins.length) {
        bitcoin = bitcoins[0];
        this.metadata!.personalUtxoId = bitcoin.utxoId;
      }
    }

    await table.save(this.metadata!);
    onProgress(100);
    return MyVaultRecovery.rebuildRules({
      feesInMicrogons: (foundVault.txFee ?? 0n) + (prebond.txFee ?? 0n),
      vault,
      bitcoin,
      treasuryMicrogons: prebond?.prebondedMicrogons,
    });
  }

  public async updateSettings(args: {
    argonKeyring: KeyringPair;
    previousRules: IVaultingRules;
    rules: IVaultingRules;
    tip?: bigint;
    txProgressCallback: ITxProgressCallback;
  }): Promise<{ txResult: TxResult } | undefined> {
    const vault = this.createdVault;
    if (!vault) {
      throw new Error('No vault created to update settings');
    }
    const txs = [];
    const { rules, previousRules } = args;
    const client = await getMainchainClient(false);
    if (rules.securitizationRatio !== previousRules.securitizationRatio) {
      txs.push(
        client.tx.vaults.modifyFunding(
          vault.vaultId,
          vault.securitization,
          toFixedNumber(rules.securitizationRatio, FIXED_U128_DECIMALS),
        ),
      );
    }
    if (
      rules.profitSharingPct !== previousRules.profitSharingPct ||
      rules.btcFlatFee !== previousRules.btcFlatFee ||
      rules.btcPctFee !== previousRules.btcPctFee
    ) {
      txs.push(
        client.tx.vaults.modifyTerms(vault.vaultId, {
          bitcoinAnnualPercentRate: toFixedNumber(rules.btcPctFee / 100, FIXED_U128_DECIMALS),
          bitcoinBaseFee: rules.btcFlatFee,
          treasuryProfitSharing: toFixedNumber(rules.profitSharingPct / 100, PERMILL_DECIMALS),
        }),
      );
    }
    if (txs.length === 0) {
      return undefined;
    }
    const txResult = await this.submitOneOrMoreTx(txs, {
      client,
      ...args,
    });
    return { txResult };
  }

  public async initialActivate(args: {
    argonKeyring: KeyringPair;
    rules: IVaultingRules;
    bip39Seed: Uint8Array;
    bitcoinLocksStore: BitcoinLocksStore;
    txProgressCallback: ITxProgressCallback;
    tip?: bigint;
  }): Promise<{ txResult: TxResult } | undefined> {
    const vaultId = this.createdVault?.vaultId;
    if (!vaultId) {
      throw new Error('No vault created to prebond treasury pool');
    }
    const vault = this.createdVault;
    const { rules, txProgressCallback } = args;
    const client = await getMainchainClient(false);

    // need to leave enough for the BTC fees
    const { microgonsForTreasury, microgonsForSecuritization } = MyVault.getMicrogonSplit(
      rules,
      this.metadata?.operationalFeeMicrogons ?? 0n,
    );

    const addedSecuritization = microgonsForSecuritization - vault.securitization;
    const txs: SubmittableExtrinsic[] = [];
    if (addedSecuritization > 0n) {
      txs.push(
        client.tx.vaults.modifyFunding(vaultId, addedSecuritization, toFixedNumber(rules.securitizationRatio, 18)),
      );
    }
    if (microgonsForTreasury > 0n) {
      txs.push(client.tx.treasury.vaultOperatorPrebond(vaultId, microgonsForTreasury / 10n));
    }

    let bitcoinArgs: { satoshis: bigint; hdPath: string; securityFee: bigint } | undefined;
    if (rules.personalBtcPct > 0n) {
      const { bitcoinLocksStore } = args;
      const personalBtcInMicrogons = bigNumberToBigInt(
        BigNumber(rules.personalBtcPct).div(100).times(microgonsForSecuritization),
      );
      const { tx, satoshis, hdPath, securityFee } = await bitcoinLocksStore.createInitializeTx({
        ...args,
        vault,
        addingVaultSpace: BigInt(Number(addedSecuritization) / vault.securitizationRatio),
        microgonLiquidity: personalBtcInMicrogons,
      });
      bitcoinArgs = { satoshis, hdPath, securityFee };
      txs.push(tx);
    }

    if (!txs.length) {
      return undefined;
    }
    txProgressCallback(5);

    const txResult = await this.submitOneOrMoreTx(txs, {
      ...args,
      client,
      updateMetadata: async (metadata, tick, txResult) => {
        metadata.prebondedMicrogons = microgonsForTreasury;
        metadata.prebondedMicrogonsAtTick = tick;
        if (bitcoinArgs) {
          const record = await args.bitcoinLocksStore.saveBitcoinLock({ vaultId, txResult, ...bitcoinArgs });
          metadata.personalUtxoId = record.utxoId;
        }
        console.log('Saving vault updates', {
          microgonsForTreasury,
          microgonsForSecuritization,
          meta: metadata,
        });
      },
    });
    txProgressCallback(100);
    return { txResult };
  }

  public async lockBitcoin(args: {
    argonKeyring: KeyringPair;
    microgonLiquidity: bigint;
    bitcoinLocksStore: BitcoinLocksStore;
    bip39Seed: Uint8Array;
    txProgressCallback: ITxProgressCallback;
    tip?: bigint;
  }): Promise<{ txResult: TxResult; utxoId: number }> {
    const vault = this.createdVault;
    if (!vault) {
      throw new Error('No vault created to lock bitcoin');
    }
    const { microgonLiquidity, bitcoinLocksStore } = args;
    const client = await getMainchainClient(false);
    const { tx, satoshis, hdPath, securityFee } = await bitcoinLocksStore.createInitializeTx({
      ...args,
      vault,
    });
    let utxoId = 0;
    const txResult = await this.submitOneOrMoreTx([tx], {
      ...args,
      client,
      updateMetadata: async (metadata, _tick, txResult) => {
        console.log('Saving vault bitcoin lock', { microgonLiquidity, meta: metadata });

        const record = await bitcoinLocksStore.saveBitcoinLock({
          vaultId: vault.vaultId,
          txResult,
          satoshis,
          hdPath,
          securityFee,
        });
        metadata.personalUtxoId = record.utxoId;
        utxoId = record.utxoId;
      },
    });
    return { txResult, utxoId };
  }

  public async increaseVaultAllocations(args: {
    freeBalance: bigint;
    rules: IVaultingRules;
    argonKeyring: KeyringPair;
    tip?: bigint;
  }): Promise<{ txResult?: TxResult; newlyAllocated: bigint }> {
    const { argonKeyring, tip = 0n, rules, freeBalance } = args;

    const { microgonsForSecuritization, microgonsForTreasury } = MyVault.getMicrogonSplit(
      {
        ...rules,
        baseMicrogonCommitment: rules.baseMicrogonCommitment + freeBalance,
      },
      this.metadata?.operationalFeeMicrogons ?? 0n,
    );
    const vault = this.createdVault;
    if (!vault) {
      throw new Error('No vault created to get changes needed');
    }
    const client = await getMainchainClient(false);

    const activeTreasuryFunds = await this.activeMicrogonsForTreasuryPool();
    const amountAllocatedToTreasury = activeTreasuryFunds.maxAmountPerFrame
      ? activeTreasuryFunds.maxAmountPerFrame * 10n
      : activeTreasuryFunds.active;

    const securitizationShortage = bigIntMax(0n, microgonsForSecuritization - vault.securitization);
    const treasuryShortage = bigIntMax(0n, microgonsForTreasury - amountAllocatedToTreasury);
    const totalFundsToAllocate = securitizationShortage + treasuryShortage;

    // if this is less than a minimum fee amount, skip allocation
    if (totalFundsToAllocate <= 25_000n) {
      return { newlyAllocated: 0n };
    }

    const securitizationPercent = getPercent(securitizationShortage, totalFundsToAllocate);

    const availableFunds = bigIntMin(freeBalance, totalFundsToAllocate);
    const securitizationToAllocate = percentOf(availableFunds, securitizationPercent);
    const treasuryToAllocate = availableFunds - securitizationToAllocate;

    const txs = [];

    if (securitizationToAllocate > 0n) {
      const tx = client.tx.vaults.modifyFunding(
        vault.vaultId,
        vault.securitization + securitizationToAllocate,
        toFixedNumber(vault.securitizationRatio, FIXED_U128_DECIMALS),
      );
      txs.push(tx);
    }
    if (treasuryToAllocate > 0n) {
      const tx = client.tx.treasury.vaultOperatorPrebond(
        vault.vaultId,
        (amountAllocatedToTreasury + treasuryToAllocate) / 10n,
      );
      txs.push(tx);
    }

    console.log(
      'Allocating additional vault funds',
      txs.map(x => x.toHuman()),
    );

    const txResult = await this.submitOneOrMoreTx(txs, {
      client,
      argonKeyring,
      tip,
      updateMetadata: async (metadata, tick) => {
        metadata.prebondedMicrogons = microgonsForTreasury;
        metadata.prebondedMicrogonsAtTick = tick;
      },
    });
    return { txResult, newlyAllocated: treasuryToAllocate + securitizationToAllocate };
  }

  private async submitOneOrMoreTx(
    txs: SubmittableExtrinsic[],
    args: {
      client: ArgonClient;
      argonKeyring: KeyringPair;
      tip?: bigint;
      txProgressCallback?: ITxProgressCallback;
      updateMetadata?: (metadata: IVaultRecord, tick: number, txResult: TxResult) => Promise<void>;
    },
  ): Promise<TxResult> {
    const { client, argonKeyring, tip = 0n, txProgressCallback } = args;
    if (txs.length === 0) {
      throw new Error('No transactions to submit in batch');
    }
    const tx = txs.length > 1 ? client.tx.utility.batchAll(txs) : txs[0];
    const txSubmitter = new TxSubmitter(client, tx, argonKeyring);
    const txResult = await txSubmitter.submit({ tip, txProgressCallback });
    await this.trackTxResultFee(txResult, false);
    const blockHash = txResult.includedInBlock!;
    const api = await client.at(blockHash);
    const tick = await api.query.ticks.currentTick();

    await args.updateMetadata?.(this.metadata!, tick.toNumber(), txResult);
    await this.saveMetadata();
    return txResult;
  }

  private async trackTxResultFee(txResult: TxResult, saveMetadataOnSuccess = true): Promise<void> {
    try {
      await txResult.inBlockPromise;
      txResult.txProgressCallback = undefined;
      this.recordFee(txResult);
      if (saveMetadataOnSuccess) {
        await this.saveMetadata();
      }
    } catch (error) {
      this.recordFee(txResult);
      await this.saveMetadata();
      throw error;
    }
  }

  private async saveMetadata() {
    const table = await this.getTable();
    await table.save(this.metadata!);
  }

  private recordFee(txResult: TxResult) {
    if (!this.metadata) {
      throw new Error('No metadata available to record fee');
    }
    this.metadata.operationalFeeMicrogons ??= 0n;
    this.metadata.operationalFeeMicrogons += (txResult.finalFee ?? 0n) + (txResult.finalFeeTip ?? 0n);
  }

  private async getTable(): Promise<VaultsTable> {
    this.#table ??= await this.dbPromise.then(x => x.vaultsTable);
    return this.#table;
  }

  private async deleteAllDbData() {
    const db = await this.dbPromise;
    await db.vaultsTable.deleteAll();
    await db.bitcoinLocksTable.deleteAll();
  }

  public static getMicrogonSplit(rules: IVaultingRules, existingFees: bigint = 0n) {
    const estimatedOperationalFees = existingFees + FEE_ESTIMATE;
    const operationalReserves = 200_000n;
    const microgonsForVaulting = bigIntMax(
      rules.baseMicrogonCommitment - estimatedOperationalFees - operationalReserves,
      0n,
    );
    const microgonsForSecuritization = bigNumberToBigInt(
      BigNumber(rules.capitalForSecuritizationPct).div(100).times(microgonsForVaulting),
    );

    const microgonsForTreasury = bigNumberToBigInt(
      BigNumber(rules.capitalForTreasuryPct).div(100).times(microgonsForVaulting),
    );
    return {
      microgonsForVaulting,
      microgonsForSecuritization,
      microgonsForTreasury,
      estimatedOperationalFees,
    };
  }
}
