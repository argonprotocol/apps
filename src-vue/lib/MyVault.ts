import {
  BitcoinLock,
  FIXED_U128_DECIMALS,
  FrameSupportTokensMiscIdAmountRuntimeHoldReason,
  ITxProgressCallback,
  PalletVaultsVaultFrameRevenue,
  PERMILL_DECIMALS,
  SubmittableExtrinsic,
  toFixedNumber,
  TxResult,
  u64,
  u8aToHex,
  Vault,
  Vec,
} from '@argonprotocol/mainchain';
import { addressBytesHex, BitcoinNetwork, CosignScript, getBitcoinNetworkFromApi, HDKey } from '@argonprotocol/bitcoin';
import { Db } from './Db.ts';
import { getFinalizedClient, getMainchainClient, getMainchainClients } from '../stores/mainchain.ts';
import {
  bigIntMax,
  bigNumberToBigInt,
  createDeferred,
  IDeferred,
  IVaultStats,
  MiningFrames,
  MoveFrom,
  MoveTo,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { IVaultRecord, VaultsTable } from './db/VaultsTable.ts';
import { IVaultingRules } from '../interfaces/IVaultingRules.ts';
import BigNumber from 'bignumber.js';
import { Vaults } from './Vaults.ts';
import BitcoinLocksStore from './BitcoinLocksStore.ts';
import { MyVaultRecovery } from './MyVaultRecovery.ts';
import { BitcoinLocksTable, BitcoinLockStatus, IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { WalletKeys } from './WalletKeys.ts';

export const FEE_ESTIMATE = 75_000n;
export const DEFAULT_MASTER_XPUB_PATH = "m/84'/0'/0'";

export class MyVault {
  public data: {
    isReady: boolean;
    createdVault: Vault | null;
    metadata: IVaultRecord | null;
    stats: IVaultStats | null;
    ownTreasuryPoolCapitalDeployed: bigint;
    pendingCollectRevenue: bigint;
    pendingCosignUtxoIds: Set<number>;
    nextCollectDueDate: number;
    expiringCollectAmount: bigint;
    finalizeMyBitcoinError?: { lockUtxoId: number; error: string };
    currentFrameId: number;
    prebondedMicrogons: bigint;
    treasuryMicrogonsCommitted: bigint;
    pendingCollectTxInfo: TransactionInfo<{
      expectedCollectRevenue: bigint;
      cosignedUtxoIds: number[];
      moveTo: MoveTo;
      allocationPercents?: { treasury: number; securitization: number };
    }> | null;
    pendingAllocateTxInfo: TransactionInfo<{
      prebondedMicrogons: bigint;
      addedSecuritizationMicrogons: bigint;
      addedTreasuryMicrogons: bigint;
      vaultId: number;
    }> | null;
  };

  public get createdVault(): Vault | null {
    return this.data.createdVault;
  }

  public get metadata(): IVaultRecord | null {
    return this.data.metadata;
  }

  #bitcoinNetwork?: BitcoinNetwork;
  #waitForLoad?: IDeferred;
  #table?: VaultsTable;
  #subscriptions: VoidFunction[] = [];
  #transactionTracker: TransactionTracker;
  #configs?: {
    timeToCollectFrames: number;
  };
  #singleRunTransactions: Map<ExtrinsicType, Promise<TransactionInfo<unknown>>> = new Map();

  constructor(
    private readonly dbPromise: Promise<Db>,
    public readonly vaults: Vaults,
    public readonly walletKeys: WalletKeys,
    transactionTracker: TransactionTracker,
    public readonly bitcoinLocksStore: BitcoinLocksStore,
    private readonly miningFrames: MiningFrames,
  ) {
    this.data = {
      isReady: false,
      createdVault: null,
      metadata: null,
      stats: null,
      ownTreasuryPoolCapitalDeployed: 0n,
      pendingCollectRevenue: 0n,
      pendingCollectTxInfo: null,
      pendingAllocateTxInfo: null,
      pendingCosignUtxoIds: new Set(),
      nextCollectDueDate: 0,
      expiringCollectAmount: 0n,
      currentFrameId: 0,
      prebondedMicrogons: 0n,
      treasuryMicrogonsCommitted: 0n,
    };
    this.vaults = vaults;
    this.#transactionTracker = transactionTracker;
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

  public async getVaultXpriv(masterXpubPath?: string): Promise<HDKey> {
    masterXpubPath ??= this.metadata!.hdPath;
    if (!masterXpubPath) {
      throw new Error('No master xpub path defined in metadata');
    }
    const network = await this.getBitcoinNetwork();
    return await this.walletKeys.getBitcoinChildXpriv(masterXpubPath, network);
  }

  public async load(reload = false): Promise<void> {
    if (this.#waitForLoad && !reload) return this.#waitForLoad.promise;

    this.#waitForLoad = createDeferred();
    try {
      console.log('Loading MyVault...');
      await this.miningFrames.load();
      await this.vaults.load(reload);

      void this.vaults.updateRevenue().then(() => {
        const vaultId = this.metadata?.id;
        if (vaultId) {
          this.data.stats = this.vaults.stats?.vaultsById[vaultId] ?? null;
        }
      });
      const table = await this.getTable();
      const client = await getMainchainClient(false);
      this.data.metadata = (await table.get()) ?? null;
      // prefetch the config
      const timeToCollectFrames = client.consts.vaults.revenueCollectionExpirationFrames.toNumber();
      this.#configs = {
        timeToCollectFrames,
      };

      await this.#transactionTracker.load();
      await this.bitcoinLocksStore.load(reload);

      for (const txInfo of this.#transactionTracker.pendingBlockTxInfosAtLoad) {
        const { tx } = txInfo;
        if (tx.extrinsicType === ExtrinsicType.VaultCreate) {
          void this.onVaultCreated(txInfo);
          this.#singleRunTransactions.set(tx.extrinsicType, Promise.resolve(txInfo));
        } else if (tx.extrinsicType === ExtrinsicType.VaultInitialAllocate) {
          void this.onInitialVaultAllocate(txInfo);
          this.#singleRunTransactions.set(tx.extrinsicType, Promise.resolve(txInfo));
        } else if (tx.extrinsicType === ExtrinsicType.VaultModifySettings) {
          void this.onModifySettings(txInfo);
        } else if (tx.extrinsicType === ExtrinsicType.VaultIncreaseAllocation) {
          void this.onIncreaseVaultAllocations(txInfo);
        } else if (tx.extrinsicType === ExtrinsicType.BitcoinRequestLock) {
          void this.onLockBitcoin(txInfo);
        } else if (tx.extrinsicType === ExtrinsicType.VaultCosignBitcoinRelease) {
          void this.onCosignResult(txInfo);
        } else if (tx.extrinsicType === ExtrinsicType.BitcoinRequestRelease) {
          const { utxoId } = tx.metadataJson!;
          const lock = this.bitcoinLocksStore.data.locksByUtxoId[utxoId];
          void this.onRequestedReleaseInBlock(lock, txInfo, tx.metadataJson);
        } else if (tx.extrinsicType === ExtrinsicType.VaultCollect) {
          void this.onVaultCollect(txInfo);
        }
      }

      const vaultId = this.data.metadata?.id;
      if (vaultId) {
        this.data.createdVault = this.vaults.vaultsById[vaultId];
        this.data.stats = this.vaults.stats?.vaultsById[vaultId] ?? null;
        this.data.treasuryMicrogonsCommitted = await this.fetchTreasuryMicrogonsCommitted();
      }

      this.data.isReady = true;
      this.#waitForLoad.resolve();
    } catch (error) {
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  private async fetchTreasuryMicrogonsCommitted(): Promise<bigint> {
    if (!this.createdVault) return 0n;
    const accountId = this.createdVault.operatorAccountId;
    const client = await getMainchainClient(false);
    const holds = await client.query.balances.holds(accountId);
    return this.extractTreasuryMicrogonsCommitted(holds);
  }

  private extractTreasuryMicrogonsCommitted(holds: Vec<FrameSupportTokensMiscIdAmountRuntimeHoldReason>): bigint {
    for (const hold of holds) {
      if (hold?.id?.isTreasury) {
        return hold.amount.toBigInt();
      }
    }
    return 0n;
  }

  public getTxInfoByType(extrinsicType: ExtrinsicType): TransactionInfo<any> | undefined {
    return this.#transactionTracker.data.txInfosByType[extrinsicType];
  }

  public async subscribe() {
    if (this.#subscriptions.length) return;
    if (!this.createdVault) {
      throw new Error('No vault created to subscribe to');
    }
    const vaultId = this.createdVault.vaultId;
    const accountId = this.createdVault.operatorAccountId;
    const client = await getMainchainClient(false);

    // update stats live
    const sub = await client.query.vaults.vaultsById(vaultId, async vault => {
      if (vault.isSome) this.createdVault?.load(vault.unwrap());
      await this.updateRevenueStats();
    });

    const sub2 = await client.query.vaults.revenuePerFrameByVault(vaultId, async x => {
      await this.updateRevenueStats(x);
      await this.updateCollectDueDate();
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

    const sub7 = await client.query.balances.holds(accountId, holds => {
      this.data.treasuryMicrogonsCommitted = this.extractTreasuryMicrogonsCommitted(holds);
    });

    this.#subscriptions.push(sub, sub2, sub3, sub4, sub5, sub6, sub7);
  }

  private async updateCollectDueDate(_lastCollectFrameId?: number) {
    const framesToCollect = this.#configs!.timeToCollectFrames;
    let nextCollectFrame = this.data.currentFrameId + framesToCollect;
    this.data.expiringCollectAmount = 0n;
    const oldestToCollectFrame = this.data.currentFrameId - framesToCollect;
    for (const frameChange of this.data.stats?.changesByFrame ?? []) {
      if (frameChange.uncollectedEarnings > 0n) {
        this.data.expiringCollectAmount = frameChange.uncollectedEarnings;
        // descending order
        nextCollectFrame = frameChange.frameId + framesToCollect;
      }
      if (frameChange.frameId < oldestToCollectFrame) break;
    }
    nextCollectFrame = Math.max(this.data.currentFrameId + 1, nextCollectFrame);

    this.data.nextCollectDueDate = this.miningFrames.getFrameDate(nextCollectFrame).getTime();
  }

  private async recordPendingCosignUtxos(rawUtxoIds: Iterable<u64>) {
    this.data.pendingCosignUtxoIds.clear();
    for (const utxoId of rawUtxoIds) {
      this.data.pendingCosignUtxoIds.add(utxoId.toNumber());
    }
  }

  public async requestBitcoinRelease(args: {
    lockRecord: IBitcoinLockRecord;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
  }): Promise<TransactionInfo | undefined> {
    const { lockRecord, bitcoinNetworkFee, toScriptPubkey } = args;
    if (
      lockRecord.status !== BitcoinLockStatus.LockedAndMinted &&
      lockRecord.status !== BitcoinLockStatus.LockedAndIsMinting
    ) {
      return;
    }

    const bitcoinLock = new BitcoinLock(lockRecord.lockDetails);
    const txResult = await bitcoinLock.requestRelease({
      ...args,
      client: await getMainchainClient(false),
      priceIndex: this.vaults.currency.priceIndex,
      releaseRequest: {
        toScriptPubkey: addressBytesHex(toScriptPubkey, this.bitcoinLocksStore.bitcoinNetwork),
        bitcoinNetworkFee,
      },
      argonKeyring: await this.walletKeys.getVaultingKeypair(),
      disableAutomaticTxTracking: true,
    });

    const txInfo = await this.#transactionTracker.trackTxResult({
      txResult,
      extrinsicType: ExtrinsicType.BitcoinRequestRelease,
      metadata: { utxoId: lockRecord.utxoId, toScriptPubkey, bitcoinNetworkFee },
    });

    void this.onRequestedReleaseInBlock(lockRecord, txInfo, { toScriptPubkey, bitcoinNetworkFee });
    return txInfo;
  }

  public async onRequestedReleaseInBlock(
    lock: IBitcoinLockRecord,
    txInfo: TransactionInfo,
    releaseInfo: { toScriptPubkey: string; bitcoinNetworkFee: bigint },
  ): Promise<void> {
    const { txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    const releaseStatuses = [
      BitcoinLockStatus.ReleaseIsProcessingOnArgon,
      BitcoinLockStatus.ReleaseIsWaitingForVault,
      BitcoinLockStatus.ReleaseSigned,
      BitcoinLockStatus.ReleaseIsProcessingOnBitcoin,
      BitcoinLockStatus.ReleaseComplete,
    ];
    // if we're not already processing a release, update the lock record
    if (!releaseStatuses.includes(lock.status)) {
      await this.bitcoinLocksStore.updateReleaseIsProcessingOnArgon(lock);
    }

    if (lock.status === BitcoinLockStatus.ReleaseIsProcessingOnArgon) {
      const blockHash = await txResult.waitForFinalizedBlock;
      const client = await getMainchainClient(true);
      const api = await client.at(blockHash);

      const { toScriptPubkey, bitcoinNetworkFee } = releaseInfo;
      lock.requestedReleaseAtTick = await api.query.ticks.currentTick().then(x => x.toNumber());
      lock.releaseToDestinationAddress = toScriptPubkey;
      lock.releaseBitcoinNetworkFee = bitcoinNetworkFee;
      await this.bitcoinLocksStore.updateReleaseIsWaitingForVault(lock);
    }

    // kick off the vault's signing
    await this.handleCosignOfBitcoinUnlock(lock);

    postProcessor.resolve();
  }

  public async handleCosignOfBitcoinUnlock(lock: IBitcoinLockRecord): Promise<void> {
    if (lock.vaultId !== this.createdVault?.vaultId) {
      // this api is only to unlock our own vault's bitcoin locks
      return;
    }
    try {
      this.data.finalizeMyBitcoinError = undefined;
      // could be moved to BitcoinLocksStore
      if (lock.status === BitcoinLockStatus.ReleaseIsWaitingForVault) {
        const result = await this.cosignRelease({
          utxoId: lock.utxoId!,
          toScriptPubkey: lock.releaseToDestinationAddress!,
          bitcoinNetworkFee: lock.releaseBitcoinNetworkFee!,
        });
        if (!result) {
          throw new Error("Failed to add the vault's co-signature.");
        }
        if (!lock.releaseCosignVaultSignature) {
          const txResult = result.txInfo.txResult;
          await txResult.waitForInFirstBlock;
          await this.bitcoinLocksStore.updateVaultUnlockingSignature(lock, {
            signature: result.vaultSignature,
            blockHeight: txResult.blockNumber!,
          });
        }
      }
      if (lock.status === BitcoinLockStatus.ReleaseSigned) {
        await this.bitcoinLocksStore.ownerCosignAndSendToBitcoin(lock);
      }
    } catch (error) {
      console.error(`Error releasing bitcoin lock ${lock.utxoId}`, error);
      this.data.finalizeMyBitcoinError = { lockUtxoId: lock.utxoId!, error: String(error) };
    }
  }

  private async buildCosignTx(args: {
    utxoId: number;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
  }): Promise<{ tx: SubmittableExtrinsic; vaultSignature: Uint8Array } | undefined> {
    const { utxoId, bitcoinNetworkFee, toScriptPubkey } = args;

    const finalizedClient = await getFinalizedClient();
    const lock = await BitcoinLock.get(finalizedClient, utxoId);
    if (!lock) {
      console.warn('No lock found for utxoId:', utxoId);
      return;
    }

    const releaseRequest = await lock.getReleaseRequest(finalizedClient);
    if (!releaseRequest) {
      console.warn('No release request found for utxoId:', utxoId);
      return;
    }
    const utxoRef = await lock.getUtxoRef(finalizedClient);
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
    const vaultXpriv = await this.getVaultXpriv();
    const signedPsbt = cosign.vaultCosignPsbt(psbt, lock, vaultXpriv);
    const vaultSignature = signedPsbt.getInput(0).partialSig?.[0]?.[1];
    if (!vaultSignature) {
      throw new Error('Failed to get vault signature from PSBT for utxoId: ' + utxoId);
    }
    const client = await getMainchainClient(false);
    const signature = u8aToHex(vaultSignature);
    return { tx: client.tx.bitcoinLocks.cosignRelease(utxoId, signature), vaultSignature };
  }

  private async cosignRelease(args: {
    utxoId: number;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
    progressCallback?: ITxProgressCallback;
  }): Promise<{ txInfo: TransactionInfo; vaultSignature: Uint8Array } | undefined> {
    const { utxoId } = args;
    const cosignResult = await this.buildCosignTx(args);
    if (!cosignResult) {
      return;
    }
    const { tx, vaultSignature } = cosignResult;

    const argonKeyring = await this.walletKeys.getVaultingKeypair();
    const txInfo = await this.#transactionTracker.submitAndWatch({
      tx,
      signer: argonKeyring,
      useLatestNonce: true,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadata: { utxoId },
    });
    void this.onCosignResult(txInfo);
    return { txInfo: txInfo, vaultSignature };
  }

  private async onCosignResult(txInfo: TransactionInfo<{ utxoId: number }>): Promise<void> {
    const { tx, txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    const utxoId = tx.metadataJson.utxoId;

    const blockHash = await txResult.waitForFinalizedBlock;
    console.log(`Cosigned and submitted transaction for utxoId ${utxoId} at ${u8aToHex(blockHash)}`);
    await this.trackTxResultFee(txResult, true);
    postProcessor.resolve();
  }

  public async collect(afterCollect: { moveTo: MoveTo }): Promise<TransactionInfo> {
    if (!this.createdVault) {
      throw new Error('No vault created to collect revenue');
    }
    if (!this.metadata) {
      throw new Error('No metadata available to collect revenue');
    }
    const toCollect = [...this.data.pendingCosignUtxoIds];
    const expectedCollectRevenue = this.data.pendingCollectRevenue;
    // You should only cosign finalized releases, so we get a finalized client
    const finalizedClient = await getFinalizedClient();
    const argonKeyring = await this.walletKeys.getVaultingKeypair();
    const txs: SubmittableExtrinsic[] = [];
    for (const utxoId of toCollect) {
      const pendingReleaseRaw = await finalizedClient.query.bitcoinLocks.lockReleaseRequestsByUtxoId(utxoId);
      if (pendingReleaseRaw.isNone) {
        continue;
      }
      const pendingRelease = pendingReleaseRaw.unwrap();
      const result = await this.buildCosignTx({
        utxoId,
        bitcoinNetworkFee: pendingRelease.bitcoinNetworkFee.toBigInt(),
        toScriptPubkey: pendingRelease.toScriptPubkey.toHex(),
      });
      if (result) txs.push(result.tx);
    }

    // now we can collect!
    const client = await getMainchainClient(false);
    const txInfo = await this.#transactionTracker.submitAndWatch({
      tx: client.tx.utility.batchAll([...txs, client.tx.vaults.collect(this.createdVault.vaultId)]),
      signer: argonKeyring,
      extrinsicType: ExtrinsicType.VaultCollect,
      metadata: {
        vaultId: this.createdVault.vaultId,
        cosignedUtxoIds: toCollect,
        expectedCollectRevenue,
        ...afterCollect,
      },
      useLatestNonce: true,
    });
    void this.onVaultCollect(txInfo);
    return txInfo;
  }

  public async getCollectedAmount(txInfo: TransactionInfo<{ vaultId: number }>): Promise<bigint | undefined> {
    const { txResult, tx } = txInfo;
    const { vaultId } = tx.metadataJson;
    await txResult.waitForInFirstBlock;
    const client = await getMainchainClient(false);

    for (const event of txResult.events) {
      if (client.events.vaults.VaultCollected.is(event)) {
        const { vaultId: eventVaultId, revenue: eventRevenue } = event.data;
        if (eventVaultId.toNumber() === vaultId) {
          return eventRevenue.toBigInt();
        }
      }
    }
    return undefined;
  }

  public async onVaultCollect(
    txInfo: TransactionInfo<{
      vaultId: number;
      cosignedUtxoIds: number[];
      expectedCollectRevenue: bigint;
      moveTo: MoveTo;
    }>,
  ): Promise<void> {
    this.data.pendingCollectTxInfo = txInfo;
    const { tx, txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    const followOnTx = this.#transactionTracker.createIntentForFollowOnTx(txInfo);

    if (!followOnTx.isSettled && tx.metadataJson.moveTo === MoveTo.MiningHold) {
      const argonKeyring = await this.walletKeys.getVaultingKeypair();
      const revenue = await this.getCollectedAmount(txInfo);
      if (revenue === undefined) {
        throw new Error('Failed to determine collected revenue from vault collect events');
      }
      const client = await getMainchainClient(false);
      const clientAt = await client.at(txInfo.txResult.blockHash!);
      const balanceAtBlock = await clientAt.query.system
        .account(this.walletKeys.vaultingAddress)
        .then(x => x.data.free.toBigInt());

      // Make sure the collect amount doesn't drain the account below operational reserves
      const maxAmountToMove = bigIntMax(0n, balanceAtBlock - MyVault.OperationalReserves);
      if (maxAmountToMove < 50_000n) {
        throw new Error('The amount requested to move is too low after accounting for operational reserves.');
      }
      let amountToMove = revenue;
      if (amountToMove > maxAmountToMove) {
        amountToMove = maxAmountToMove;
      }

      const moveTo = tx.metadataJson.moveTo; // this can only be Mining because of IF block
      const moveToAddress = this.walletKeys.miningHoldAddress;
      const followOnTxInfo = await this.#transactionTracker.submitAndWatch({
        tx: client.tx.balances.transferKeepAlive(moveToAddress, amountToMove),
        signer: argonKeyring,
        extrinsicType: ExtrinsicType.Transfer,
        metadata: {
          moveFrom: MoveFrom.VaultingHold,
          moveTo,
          amount: amountToMove,
        },
        useLatestNonce: true,
      });
      followOnTx.resolve(followOnTxInfo);
    }
    await txInfo.followOnTxInfo;
    await txResult.waitForFinalizedBlock;
    await this.trackTxResultFee(txInfo.txResult, true);
    await txInfo.txResult.waitForFinalizedBlock;
    this.data.pendingCollectTxInfo = null;

    postProcessor.resolve();
  }

  public async createNew(args: {
    rules: IVaultingRules;
    masterXpubPath: string;
  }): Promise<TransactionInfo<{ masterXpubPath: string; masterXpub: string }>> {
    const pendingTxInfo = this.#singleRunTransactions.get(ExtrinsicType.VaultCreate);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    if (pendingTxInfo) return pendingTxInfo as any;

    const deferred = createDeferred<TransactionInfo<{ masterXpubPath: string; masterXpub: string }>>();
    this.#singleRunTransactions.set(ExtrinsicType.VaultCreate, deferred.promise);
    try {
      const { masterXpubPath, rules } = args;
      const argonKeyring = await this.walletKeys.getVaultingKeypair();
      console.log('Creating a vault with address', argonKeyring.address);
      const vaultXpriv = await this.getVaultXpriv(masterXpubPath);
      const masterXpub = vaultXpriv.publicExtendedKey;
      const client = await getMainchainClient(false);

      const { txResult } = await Vault.create(
        client,
        argonKeyring,
        {
          securitizationRatio: rules.securitizationRatio,
          securitization: 1,
          annualPercentRate: rules.btcPctFee / 100,
          baseFee: rules.btcFlatFee,
          bitcoinXpub: masterXpub,
          treasuryProfitSharing: rules.profitSharingPct / 100,
          disableAutomaticTxTracking: true,
        },
        { tickDurationMillis: NetworkConfig.tickMillis },
      );

      const txInfo = await this.#transactionTracker.trackTxResult({
        txResult,
        extrinsicType: ExtrinsicType.VaultCreate,
        metadata: { masterXpub, masterXpubPath },
      });

      void this.onVaultCreated(txInfo);
      deferred.resolve(txInfo);

      return txInfo;
    } catch (error) {
      this.#singleRunTransactions.delete(ExtrinsicType.VaultCreate);
      deferred.reject(error as Error);
      throw error;
    }
  }

  private async onVaultCreated(txInfo: TransactionInfo<{ masterXpubPath: string }>): Promise<Vault> {
    const { tx, txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    const client = await getMainchainClient(true);
    const table = await this.getTable();
    const blockHash = await txResult.waitForFinalizedBlock;
    const api = await client.at(blockHash);
    const blockNumber = await api.query.system.number();
    let vaultId: number | undefined;
    for (const event of txResult.events) {
      if (client.events.vaults.VaultCreated.is(event)) {
        vaultId = event.data.vaultId.toNumber();
        break;
      }
    }
    if (!vaultId) {
      throw new Error('VaultCreated event not found in transaction events');
    }
    const vault = await Vault.get(api as any, vaultId);
    await this.recordVault({
      vault,
      createBlockNumber: blockNumber.toNumber(),
      txFee: txResult.finalFee ?? 0n,
      masterXpubPath: tx.metadataJson.masterXpubPath,
    });
    postProcessor.resolve();
    return vault;
  }

  public async updateRevenueStats(frameRevenues?: Vec<PalletVaultsVaultFrameRevenue>): Promise<void> {
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

  public revenue(): { earnings: bigint; activeFrames: number; averageCapitalDeployed: bigint } {
    const vaultRevenue = this.data.stats;
    if (!vaultRevenue || !this.createdVault) return { earnings: 0n, activeFrames: 0, averageCapitalDeployed: 0n };

    let startingFrame = this.data.currentFrameId;
    let earnings = 0n;
    const capitalDeployed: bigint[] = [];

    for (const change of vaultRevenue.changesByFrame ?? []) {
      earnings += change.treasuryPool.vaultEarnings + change.bitcoinFeeRevenue - change.uncollectedEarnings;

      // if there's a change record, the vault did something
      startingFrame = Math.min(startingFrame, change.frameId);
      capitalDeployed.push(change.securitization + 10n * change.treasuryPool.vaultCapital);
    }

    const averageCapitalDeployed = capitalDeployed.length
      ? capitalDeployed.reduce((acc, val) => acc + val, 0n) / BigInt(capitalDeployed.length)
      : 0n;
    const activeFrames = this.data.currentFrameId - startingFrame;
    return { earnings, activeFrames, averageCapitalDeployed };
  }

  public async activeMicrogonsForTreasuryPool(): Promise<bigint> {
    if (!this.createdVault) {
      throw new Error('No vault created to get active treasury pool funds');
    }
    const client = await getMainchainClient(false);
    const vaultId = this.createdVault.vaultId;
    const prebondedToPool = await client.query.treasury.prebondedByVaultId(vaultId);
    const oldestFrame = Math.max(0, this.data.currentFrameId - 10);
    const activePoolFunds =
      this.data.stats?.changesByFrame
        .slice(0, 10)
        .filter(change => change.frameId >= oldestFrame)
        .reduce((total, change) => total + change.treasuryPool.vaultCapital, 0n) ?? 0n;

    return prebondedToPool.isSome ? prebondedToPool.unwrap().maxAmountPerFrame.toBigInt() * 10n : activePoolFunds;
  }

  public async recordVault(data: {
    vault: Vault;
    createBlockNumber: number;
    txFee: bigint;
    masterXpubPath: string;
  }): Promise<void> {
    const { vault, createBlockNumber, masterXpubPath, txFee } = data;
    const table = await this.getTable();
    this.data.metadata = await table.insert(vault.vaultId, masterXpubPath, createBlockNumber, txFee);
    this.data.createdVault = vault;
    this.vaults.vaultsById[vault.vaultId] = vault;
  }

  public async recordPersonalBitcoins(bitcoins: IBitcoinLockRecord[]): Promise<void> {
    if (bitcoins.length === 0) {
      return;
    }
    const bitcoin = bitcoins[0];
    this.metadata!.personalUtxoId = bitcoin.utxoId;
    const table = await this.getTable();
    await table.save(this.metadata!);
  }

  public async recoverAccountVault(args: {
    onProgress: (progress: number) => void;
  }): Promise<IVaultingRules | undefined> {
    await this.deleteAllDbData();
    const { onProgress } = args;
    const vaultingAddress = this.walletKeys.vaultingAddress;
    console.log('Recovering vault for address', vaultingAddress);
    const mainchainClients = getMainchainClients();
    const client = await mainchainClients.archiveClientPromise;
    onProgress(0);

    const foundVault = await MyVaultRecovery.findOperatorVault(
      mainchainClients,
      this.bitcoinLocksStore.bitcoinNetwork,
      this.walletKeys,
    );
    onProgress(50);
    if (!foundVault) {
      onProgress(100);
      return;
    }

    const vault = foundVault.vault;
    const vaultId = vault.vaultId;
    await this.recordVault(foundVault);

    const prebond = await MyVaultRecovery.findPrebonded({
      client,
      vaultId,
      walletKeys: this.walletKeys,
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
      const myBitcoins = await MyVaultRecovery.recoverPersonalBitcoin({
        mainchainClients,
        bitcoinLocksStore: this.bitcoinLocksStore,
        vaultSetupBlockNumber: prebond.blockNumber,
        vault,
      });
      bitcoin = myBitcoins[0];
      await this.recordPersonalBitcoins(myBitcoins);
    }

    const table = await this.getTable();
    await table.save(this.metadata!);
    onProgress(100);
    await this.load(true);
    return MyVaultRecovery.rebuildRules({
      feesInMicrogons: (foundVault.txFee ?? 0n) + (prebond.txFee ?? 0n),
      vault,
      bitcoin,
      treasuryMicrogons: prebond?.prebondedMicrogons,
    });
  }

  public async updateSettings(args: {
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
    const { profitSharingPct, btcFlatFee, btcPctFee } = rules;
    if (
      profitSharingPct !== previousRules.profitSharingPct ||
      btcFlatFee !== previousRules.btcFlatFee ||
      btcPctFee !== previousRules.btcPctFee
    ) {
      txs.push(
        client.tx.vaults.modifyTerms(vault.vaultId, {
          bitcoinAnnualPercentRate: toFixedNumber(btcPctFee / 100, FIXED_U128_DECIMALS),
          bitcoinBaseFee: btcFlatFee,
          treasuryProfitSharing: toFixedNumber(profitSharingPct / 100, PERMILL_DECIMALS),
        }),
      );
    }
    if (txs.length === 0) {
      return undefined;
    }
    const argonKeyring = await this.walletKeys.getVaultingKeypair();
    const info = await this.#transactionTracker.submitAndWatch({
      tx: txs.length > 1 ? client.tx.utility.batchAll(txs) : txs[0],
      signer: argonKeyring,
      extrinsicType: ExtrinsicType.VaultModifySettings,
      metadata: { securitizationRatio: rules.securitizationRatio, profitSharingPct, btcFlatFee, btcPctFee },
      txProgressCallback: args.txProgressCallback,
      tip: args.tip,
    });
    void this.onModifySettings(info);
    return info;
  }

  private async onModifySettings(txInfo: TransactionInfo) {
    const { txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    await txResult.waitForFinalizedBlock;
    await this.trackTxResultFee(txResult, false);
    console.log('Vault settings updated');
    postProcessor.resolve();
  }

  public async activateSecuritizationAndTreasury(args: {
    rules: IVaultingRules;
    tip?: bigint;
  }): Promise<TransactionInfo | undefined> {
    const vaultId = this.createdVault?.vaultId;
    if (!vaultId) {
      throw new Error('No vault created to prebond treasury pool');
    }
    const pendingTxInfo = this.#singleRunTransactions.get(ExtrinsicType.VaultInitialAllocate);
    if (pendingTxInfo) return pendingTxInfo;
    const deferred = createDeferred<TransactionInfo>();
    this.#singleRunTransactions.set(ExtrinsicType.VaultInitialAllocate, deferred.promise);
    try {
      const { rules } = args;
      const vault = this.createdVault;
      const client = await getMainchainClient(false);
      const txs: SubmittableExtrinsic[] = [];

      // need to leave enough for the BTC fees
      const { microgonsForTreasury, microgonsForSecuritization } = MyVault.getMicrogonSplit(
        rules,
        this.metadata?.operationalFeeMicrogons ?? 0n,
      );

      const vaultingAccount = await this.walletKeys.getVaultingKeypair();

      const addedSecuritization = microgonsForSecuritization - vault.securitization;
      if (addedSecuritization > 0n) {
        txs.push(
          client.tx.vaults.modifyFunding(vaultId, addedSecuritization, toFixedNumber(rules.securitizationRatio, 18)),
        );
      }
      if (microgonsForTreasury > 0n) {
        txs.push(client.tx.treasury.vaultOperatorPrebond(vaultId, microgonsForTreasury / 10n));
      }

      let bitcoinArgs:
        | { satoshis: bigint; hdPath: string; securityFee: bigint; vaultId: number; uuid: string }
        | undefined;
      if (rules.personalBtcPct > 0n) {
        const personalBtcInMicrogons = bigNumberToBigInt(
          BigNumber(rules.personalBtcPct).div(100).times(microgonsForSecuritization),
        );
        const { tx, satoshis, hdPath, securityFee } = await this.bitcoinLocksStore.createInitializeTx({
          ...args,
          vault,
          argonKeyring: vaultingAccount,
          addingVaultSpace: BigInt(Number(addedSecuritization) / vault.securitizationRatio),
          microgonLiquidity: personalBtcInMicrogons,
        });
        bitcoinArgs = { satoshis, hdPath, securityFee, vaultId, uuid: BitcoinLocksTable.createUuid() };
        txs.push(tx);
      }

      if (!txs.length) {
        deferred.resolve(undefined as any);
        this.#singleRunTransactions.delete(ExtrinsicType.VaultInitialAllocate);

        return undefined;
      }

      const txInfo = await this.#transactionTracker.submitAndWatch({
        tx: txs.length > 1 ? client.tx.utility.batchAll(txs) : txs[0],
        signer: vaultingAccount,
        extrinsicType: ExtrinsicType.VaultInitialAllocate,
        metadata: { bitcoin: bitcoinArgs, microgonsForTreasury, microgonsForSecuritization, vaultId },
        tip: args.tip,
      });
      void this.onInitialVaultAllocate(txInfo);

      deferred.resolve(txInfo);
      return txInfo;
    } catch (error) {
      this.#singleRunTransactions.delete(ExtrinsicType.VaultInitialAllocate);
      deferred.reject(error as Error);
      throw error;
    }
  }

  private async onInitialVaultAllocate(
    txInfo: TransactionInfo<{
      microgonsForTreasury: bigint;
      microgonsForSecuritization: bigint;
      vaultId: number;
      bitcoin?: { uuid: string; satoshis: bigint; hdPath: string; securityFee: bigint; vaultId: number };
    }>,
  ): Promise<{ txResult: TxResult }> {
    const { tx, txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    const blockHash = await txResult.waitForFinalizedBlock;
    await this.trackTxResultFee(txResult, false);
    const client = await getMainchainClient(true);
    const api = await client.at(blockHash);
    const tick = await api.query.ticks.currentTick().then(x => x.toNumber());
    const metadata = this.metadata!;
    const { microgonsForTreasury, microgonsForSecuritization, bitcoin } = tx.metadataJson;
    metadata.prebondedMicrogons = microgonsForTreasury;
    metadata.prebondedMicrogonsAtTick = tick;
    if (bitcoin) {
      // create a separate tx info since we want to chain
      const bitcoinTxInfo = new TransactionInfo<any>({ tx, txResult });
      const { getUtxoId } = await this.bitcoinLocksStore.createPendingBitcoinLock(bitcoinTxInfo);
      metadata.personalUtxoId = await getUtxoId();
      await bitcoinTxInfo?.waitForPostProcessing;
    }
    console.log('Saving vault updates', {
      microgonsForTreasury,
      microgonsForSecuritization,
      meta: metadata,
    });
    await this.saveMetadata();
    postProcessor.resolve();

    return { txResult };
  }

  public async startBitcoinLocking(args: { microgonLiquidity: bigint; tip?: bigint }): Promise<void> {
    const vault = this.createdVault;
    if (!vault) throw new Error('No vault created to lock bitcoin');

    console.log('Saving vault bitcoin lock', { microgonLiquidity: args.microgonLiquidity, metadata: this.metadata! });

    const keyring = await this.walletKeys.getVaultingKeypair();
    const initialTx = await this.bitcoinLocksStore.createInitializeTx({
      ...args,
      argonKeyring: keyring,
      vault,
    });
    console.log('initialTx', initialTx);
    const bitcoinUuid = BitcoinLocksTable.createUuid();
    const txInfo = await this.#transactionTracker.submitAndWatch({
      tx: initialTx.tx,
      signer: keyring,
      extrinsicType: ExtrinsicType.BitcoinRequestLock,
      metadata: {
        bitcoin: {
          uuid: bitcoinUuid,
          vaultId: vault.vaultId,
          satoshis: initialTx.satoshis,
          hdPath: initialTx.hdPath,
          securityFee: initialTx.securityFee,
        },
      },
      tip: args.tip,
    });

    const {
      bitcoin: { vaultId },
    } = txInfo.tx.metadataJson;
    if (vaultId !== this.createdVault?.vaultId) {
      throw new Error('Vault ID mismatch');
    }

    await this.bitcoinLocksStore.createPendingBitcoinLock(txInfo);
    void this.onLockBitcoin(txInfo);
  }

  private async onLockBitcoin(txInfo: TransactionInfo<{ bitcoin: { uuid: string } }>): Promise<void> {
    await txInfo.waitForPostProcessing;
    const bitcoinUuid = txInfo.tx.metadataJson.bitcoin.uuid;
    this.metadata!.personalUtxoId = await this.bitcoinLocksStore.getUtxoForBitcoinLockUuid(bitcoinUuid);
    await this.saveMetadata();
  }

  public async getVaultAllocations(unusedBalance: bigint, rules: IVaultingRules) {
    const vault = this.createdVault;
    if (!vault) {
      throw new Error('No vault created to get allocations');
    }
    const activeTreasuryFunds = await this.activeMicrogonsForTreasuryPool();

    const newMicrogonsForVaulting = vault.securitization + activeTreasuryFunds + unusedBalance;
    const microgonsForSecuritization = bigNumberToBigInt(
      BigNumber(rules.capitalForSecuritizationPct).div(100).times(newMicrogonsForVaulting),
    );
    const microgonsForTreasury = newMicrogonsForVaulting - microgonsForSecuritization;
    const securitizationShortage = bigIntMax(0n, microgonsForSecuritization - vault.securitization);
    const treasuryShortage = bigIntMax(0n, microgonsForTreasury - activeTreasuryFunds);

    return {
      securitizationMicrogons: vault.securitization,
      treasuryMicrogons: activeTreasuryFunds,
      proposedTreasuryMicrogons: activeTreasuryFunds + treasuryShortage,
      proposedSecuritizationMicrogons: vault.securitization + securitizationShortage,
    };
  }

  public async createVaultAllocationTx(args: {
    addedSecuritizationMicrogons: bigint;
    addedTreasuryMicrogons: bigint;
  }): Promise<{
    txs: SubmittableExtrinsic[];
    metadata: {
      addedSecuritizationMicrogons: bigint;
      addedTreasuryMicrogons: bigint;
      prebondedMicrogons: bigint;
      vaultId: number;
    };
  }> {
    const { addedSecuritizationMicrogons, addedTreasuryMicrogons } = args;

    const vault = this.createdVault;
    if (!vault) {
      throw new Error('No vault created to get changes needed');
    }
    const client = await getMainchainClient(false);

    const activeTreasuryFunds = await this.activeMicrogonsForTreasuryPool();

    const txs = [];

    if (addedSecuritizationMicrogons > 0n) {
      const tx = client.tx.vaults.modifyFunding(
        vault.vaultId,
        vault.securitization + addedSecuritizationMicrogons,
        toFixedNumber(vault.securitizationRatio, FIXED_U128_DECIMALS),
      );
      txs.push(tx);
    }

    if (addedTreasuryMicrogons > 0n) {
      const tx = client.tx.treasury.vaultOperatorPrebond(
        vault.vaultId,
        (activeTreasuryFunds + addedTreasuryMicrogons) / 10n,
      );
      txs.push(tx);
    }

    return {
      txs,
      metadata: {
        addedSecuritizationMicrogons,
        addedTreasuryMicrogons,
        prebondedMicrogons: activeTreasuryFunds + addedTreasuryMicrogons,
        vaultId: vault.vaultId,
      },
    };
  }

  public async increaseVaultAllocations(args: {
    addedSecuritizationMicrogons: bigint;
    addedTreasuryMicrogons: bigint;
    tip?: bigint;
  }): Promise<TransactionInfo> {
    const { txs, metadata } = await this.createVaultAllocationTx(args);
    const client = await getMainchainClient(false);

    const argonKeyring = await this.walletKeys.getVaultingKeypair();
    const info = await this.#transactionTracker.submitAndWatch({
      tx: txs.length > 1 ? client.tx.utility.batchAll(txs) : txs[0],
      signer: argonKeyring,
      extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
      metadata,
      tip: args.tip,
    });
    this.data.pendingAllocateTxInfo = info;
    void this.onIncreaseVaultAllocations(info);
    return info;
  }

  private async onIncreaseVaultAllocations(txInfo: TransactionInfo<{ prebondedMicrogons: bigint }>): Promise<void> {
    const { tx, txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    const blockHash = await txResult.waitForFinalizedBlock;
    this.data.pendingAllocateTxInfo = null;
    console.log('Vault allocations increased');
    const metadata = this.metadata!;
    const client = await getMainchainClient(true);
    const api = await client.at(blockHash);
    const tick = await api.query.ticks.currentTick();
    const { prebondedMicrogons } = tx.metadataJson;
    await this.trackTxResultFee(txResult, false);
    metadata.prebondedMicrogons = prebondedMicrogons;
    metadata.prebondedMicrogonsAtTick = tick.toNumber();
    await this.saveMetadata();
    postProcessor.resolve();
  }

  private async trackTxResultFee(txResult: TxResult, saveMetadataOnSuccess = true): Promise<void> {
    try {
      await txResult.waitForFinalizedBlock;
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

  public static OperationalReserves = 1_000_000n;

  public static getMicrogonSplit(rules: IVaultingRules, existingFees: bigint = 0n) {
    const estimatedOperationalFees = existingFees + FEE_ESTIMATE;
    const microgonsForVaulting = bigIntMax(
      rules.baseMicrogonCommitment - estimatedOperationalFees - this.OperationalReserves,
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
