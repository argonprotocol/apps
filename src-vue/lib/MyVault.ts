import {
  ApiDecoration,
  ArgonClient,
  BitcoinLock,
  FIXED_U128_DECIMALS,
  FrameSupportTokensMiscIdAmountRuntimeHoldReason,
  ITxProgressCallback,
  Keyring,
  KeyringPair,
  mnemonicGenerate,
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
import { BitcoinNetwork, CosignScript, getBitcoinNetworkFromApi, HDKey } from '@argonprotocol/bitcoin';
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
  SingleFileQueue,
  SpecLte146,
} from '@argonprotocol/apps-core';
import { IVaultRecord, VaultsTable } from './db/VaultsTable.ts';
import { IVaultingRules } from '../interfaces/IVaultingRules.ts';
import BigNumber from 'bignumber.js';
import { Vaults } from './Vaults.ts';
import BitcoinLocks from './BitcoinLocks.ts';
import { MyVaultRecovery } from './MyVaultRecovery.ts';
import { BitcoinLocksTable, IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { WalletKeys } from './WalletKeys.ts';

export const FEE_ESTIMATE = 75_000n;
export const DEFAULT_MASTER_XPUB_PATH = "m/84'/0'/0'";

type ICollectOrphanCosignMetadata = {
  lockUtxoId: number;
  ownerAccount: string;
  txid: string;
  vout: number;
  vaultSignatureHex: string;
};

export class MyVault {
  public data: {
    isReady: boolean;
    createdVault: Vault | null;
    metadata: IVaultRecord | null;
    stats: IVaultStats | null;
    pendingCollectRevenue: bigint;
    pendingCosignUtxosById: Map<number, bigint>;
    nextCollectDueDate: number;
    expiringCollectAmount: bigint;
    finalizeMyBitcoinError?: { lockUtxoId: number; error: string };
    currentFrameId: number;
    treasury: {
      targetPrincipal: bigint;
      heldPrincipal: bigint;
    };
    pendingCollectTxInfo: TransactionInfo<{
      expectedCollectRevenue: bigint;
      cosignedUtxoIds: number[];
      cosignedOrphanUtxos?: ICollectOrphanCosignMetadata[];
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

  public get vaultId(): number | undefined {
    return this.metadata?.id;
  }

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
  // The vault currently only keeps a single active bitcoin at once
  #singleActiveBitcoinQueue = new SingleFileQueue();
  // Serialize cosign submissions (collect + individual cosign) and track in-flight intent per UTXO.
  #cosignQueue = new SingleFileQueue();

  constructor(
    private readonly dbPromise: Promise<Db>,
    public readonly vaults: Vaults,
    public readonly walletKeys: WalletKeys,
    transactionTracker: TransactionTracker,
    public readonly bitcoinLocksStore: BitcoinLocks,
    private readonly miningFrames: MiningFrames,
  ) {
    this.data = {
      isReady: false,
      createdVault: null,
      metadata: null,
      stats: null,
      pendingCollectRevenue: 0n,
      pendingCollectTxInfo: null,
      pendingAllocateTxInfo: null,
      pendingCosignUtxosById: new Map(),
      nextCollectDueDate: 0,
      expiringCollectAmount: 0n,
      currentFrameId: 0,
      treasury: {
        targetPrincipal: 0n,
        heldPrincipal: 0n,
      },
    };
    this.vaults = vaults;
    this.#transactionTracker = transactionTracker;
    bitcoinLocksStore.myVault = this;
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
        } else if (tx.extrinsicType === ExtrinsicType.VaultCosignBitcoinRelease) {
          void this.onCosignResult(txInfo);
        } else if (tx.extrinsicType === ExtrinsicType.VaultCosignOrphanedUtxoRelease) {
          void this.onOrphanCosignResult(txInfo);
        } else if (tx.extrinsicType === ExtrinsicType.VaultCollect) {
          void this.onVaultCollect(txInfo);
        }
      }
      if (!this.#singleRunTransactions.has(ExtrinsicType.VaultInitialAllocate)) {
        const completedTxInfo = this.#transactionTracker.data.txInfosByType[ExtrinsicType.VaultInitialAllocate];
        if (completedTxInfo) {
          this.#singleRunTransactions.set(ExtrinsicType.VaultInitialAllocate, Promise.resolve(completedTxInfo));
        }
      }
      if (!this.#singleRunTransactions.has(ExtrinsicType.VaultCreate)) {
        const completedTxInfo = this.#transactionTracker.data.txInfosByType[ExtrinsicType.VaultCreate];
        if (completedTxInfo) {
          this.#singleRunTransactions.set(ExtrinsicType.VaultCreate, Promise.resolve(completedTxInfo));
        }
      }

      const vaultId = this.data.metadata?.id;
      if (vaultId) {
        this.data.createdVault = this.vaults.vaultsById[vaultId];
        this.data.stats = this.vaults.stats?.vaultsById[vaultId] ?? null;
        this.data.treasury = await MyVault.fetchAllocatedMicrogonsForTreasuryPool(this.createdVault!);
      }

      this.data.isReady = true;
      this.#waitForLoad.resolve();
    } catch (error) {
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  public getTxInfoByType(extrinsicType: ExtrinsicType): TransactionInfo<any> | undefined {
    return this.#transactionTracker.data.txInfosByType[extrinsicType];
  }

  public getTxInfo(
    filterCb: (extrinsicType: ExtrinsicType, metadata: any) => boolean,
  ): TransactionInfo<any> | undefined {
    for (const txInfo of this.#transactionTracker.data.txInfos) {
      if (filterCb(txInfo.tx.extrinsicType, txInfo.tx.metadataJson)) {
        return txInfo;
      }
    }
  }

  public async subscribe() {
    if (this.#subscriptions.length) return;
    if (!this.createdVault) {
      throw new Error('No vault created to subscribe to');
    }
    const vaultId = this.createdVault.vaultId;
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

    const sub6 = await this.subscribeToTreasuryAllocated();

    this.#subscriptions.push(sub, sub2, sub3, sub4, sub5, sub6);
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
    this.data.pendingCosignUtxosById.clear();
    const client = await getMainchainClient(false);
    for (const utxoId of rawUtxoIds) {
      const id = utxoId.toNumber();
      const lock = await BitcoinLock.get(client, id);
      this.data.pendingCosignUtxosById.set(id, lock?.lockedMarketRate ?? 0n);
    }
  }

  public async cosignMyLock(
    lock: IBitcoinLockRecord,
    releaseRequest?: { toScriptPubkey: string; bitcoinNetworkFee: bigint },
  ): Promise<{ txInfo: TransactionInfo; vaultSignature: Uint8Array } | undefined> {
    if (lock.vaultId !== this.createdVault?.vaultId) {
      // this api is only to unlock our own vault's bitcoin locks
      return;
    }
    try {
      this.data.finalizeMyBitcoinError = undefined;
      const fundingUtxo = lock.fundingUtxoRecord;
      const effectiveReleaseRequest =
        releaseRequest ??
        (fundingUtxo?.releaseToDestinationAddress !== undefined && fundingUtxo.releaseBitcoinNetworkFee !== undefined
          ? {
              toScriptPubkey: fundingUtxo.releaseToDestinationAddress,
              bitcoinNetworkFee: fundingUtxo.releaseBitcoinNetworkFee,
            }
          : undefined);
      if (!effectiveReleaseRequest) {
        return;
      }
      const result = await this.cosignRelease({
        utxoId: lock.utxoId!,
        toScriptPubkey: effectiveReleaseRequest.toScriptPubkey,
        bitcoinNetworkFee: effectiveReleaseRequest.bitcoinNetworkFee,
      });
      if (!result) {
        // The release request can lag briefly on finalized views. Treat as retryable and
        // let the next lock-processing poll attempt cosign again.
        return;
      }
      return result;
    } catch (error) {
      console.error(`Error releasing bitcoin lock ${lock.utxoId}`, error);
      this.data.finalizeMyBitcoinError = { lockUtxoId: lock.utxoId!, error: String(error) };
    }
  }

  public async cosignMyOrphanedUtxoRelease(args: {
    lock: IBitcoinLockRecord;
    ownerAccount: string;
    txid: string;
    vout: number;
    satoshis: bigint;
    toScriptPubkey: string;
    bitcoinNetworkFee: bigint;
  }): Promise<{ txInfo: TransactionInfo; vaultSignature: Uint8Array } | undefined> {
    const { lock } = args;
    if (!lock.utxoId || lock.vaultId !== this.createdVault?.vaultId) {
      return;
    }
    try {
      this.data.finalizeMyBitcoinError = undefined;
      return await this.cosignOrphanedRelease({
        lockUtxoId: lock.utxoId,
        ownerAccount: args.ownerAccount,
        txid: args.txid,
        vout: args.vout,
        satoshis: args.satoshis,
        toScriptPubkey: args.toScriptPubkey,
        bitcoinNetworkFee: args.bitcoinNetworkFee,
      });
    } catch (error) {
      console.error(`Error cosigning orphan release for lock ${lock.utxoId}`, error);
      this.data.finalizeMyBitcoinError = { lockUtxoId: lock.utxoId, error: String(error) };
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
    const utxoRef = await lock.getFundingUtxoRef(finalizedClient);
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

  private async buildOrphanCosignTx(args: {
    lockUtxoId: number;
    ownerAccount: string;
    txid: string;
    vout: number;
    satoshis: bigint;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
  }): Promise<{ tx: SubmittableExtrinsic; vaultSignature: Uint8Array } | undefined> {
    const finalizedClient = await getFinalizedClient();
    const lock = await BitcoinLock.get(finalizedClient, args.lockUtxoId);
    if (!lock) {
      console.warn('No lock found for orphaned utxo release cosign:', args.lockUtxoId);
      return;
    }
    const client = await getMainchainClient(false);
    return await this.buildOrphanCosignSubmission({
      submitClient: client,
      lock,
      ownerAccount: args.ownerAccount,
      txid: args.txid,
      vout: args.vout,
      satoshis: args.satoshis,
      bitcoinNetworkFee: args.bitcoinNetworkFee,
      toScriptPubkey: args.toScriptPubkey,
    });
  }

  private async cosignRelease(args: {
    utxoId: number;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
    progressCallback?: ITxProgressCallback;
  }): Promise<{ txInfo: TransactionInfo; vaultSignature: Uint8Array } | undefined> {
    return await this.#cosignQueue.add(async () => {
      const { utxoId } = args;
      const pendingTxInfo = this.findPendingCosignTxInfo(utxoId);
      const cosignResult = await this.buildCosignTx(args);
      if (!cosignResult) {
        return;
      }
      if (pendingTxInfo) {
        return { txInfo: pendingTxInfo, vaultSignature: cosignResult.vaultSignature };
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
    }).promise;
  }

  private async cosignOrphanedRelease(args: {
    lockUtxoId: number;
    ownerAccount: string;
    txid: string;
    vout: number;
    satoshis: bigint;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
  }): Promise<{ txInfo: TransactionInfo; vaultSignature: Uint8Array } | undefined> {
    return await this.#cosignQueue.add(async () => {
      const pendingTxInfo = this.findPendingOrphanCosignTxInfo({
        ownerAccount: args.ownerAccount,
        txid: args.txid,
        vout: args.vout,
      });
      if (pendingTxInfo) {
        const cosignResult = await this.buildOrphanCosignTx(args);
        if (!cosignResult) return;
        return { txInfo: pendingTxInfo, vaultSignature: cosignResult.vaultSignature };
      }

      const cosignResult = await this.buildOrphanCosignTx(args);
      if (!cosignResult) return;
      const { tx, vaultSignature } = cosignResult;

      const argonKeyring = await this.walletKeys.getVaultingKeypair();
      const txInfo = await this.#transactionTracker.submitAndWatch({
        tx,
        signer: argonKeyring,
        useLatestNonce: true,
        extrinsicType: ExtrinsicType.VaultCosignOrphanedUtxoRelease,
        metadata: {
          lockUtxoId: args.lockUtxoId,
          ownerAccount: args.ownerAccount,
          txid: args.txid,
          vout: args.vout,
          vaultSignatureHex: u8aToHex(vaultSignature),
        },
      });
      void this.onOrphanCosignResult(txInfo);
      return { txInfo, vaultSignature };
    }).promise;
  }

  private async onCosignResult(txInfo: TransactionInfo<{ utxoId: number }>): Promise<void> {
    const { tx, txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    const utxoId = tx.metadataJson.utxoId;

    const blockHash = await txResult.waitForFinalizedBlock;
    console.log(`Cosigned and submitted transaction for utxoId ${utxoId} at ${u8aToHex(blockHash)}`);
    await this.trackTxResultFee(txResult);
    postProcessor.resolve();
  }

  private async onOrphanCosignResult(
    txInfo: TransactionInfo<{ lockUtxoId: number; ownerAccount: string; txid: string; vout: number }>,
  ): Promise<void> {
    const { txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    await txResult.waitForFinalizedBlock;
    await this.trackTxResultFee(txResult);
    postProcessor.resolve();
  }

  public async collect(afterCollect: { moveTo: MoveTo }): Promise<TransactionInfo> {
    return await this.#cosignQueue.add(async () => {
      if (!this.createdVault) {
        throw new Error('No vault created to collect revenue');
      }
      if (!this.metadata) {
        throw new Error('No metadata available to collect revenue');
      }
      const toCosign = [...this.data.pendingCosignUtxosById];
      const cosignedUtxoIds: number[] = [];
      const cosignedOrphanUtxos: ICollectOrphanCosignMetadata[] = [];
      const expectedCollectRevenue = this.data.pendingCollectRevenue;
      // You should only cosign finalized releases, so we get a finalized client
      const finalizedClient = await getFinalizedClient();
      const client = await getMainchainClient(false);
      const argonKeyring = await this.walletKeys.getVaultingKeypair();
      const txs: SubmittableExtrinsic[] = [];
      try {
        for (const [utxoId, _amount] of toCosign) {
          if (this.findPendingCosignTxInfo(utxoId)) {
            continue;
          }
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
          if (result) {
            txs.push(result.tx);
            cosignedUtxoIds.push(utxoId);
          }
        }

        const orphanCosigns = await this.buildPendingOrphanCosignTxs({
          finalizedClient,
          submitClient: client,
          vaultId: this.createdVault.vaultId,
        });
        for (const orphanCosign of orphanCosigns) {
          txs.push(orphanCosign.tx);
          cosignedOrphanUtxos.push(orphanCosign.metadata);
        }

        // now we can collect!
        const txInfo = await this.#transactionTracker.submitAndWatch({
          tx: client.tx.utility.batchAll([...txs, client.tx.vaults.collect(this.createdVault.vaultId)]),
          signer: argonKeyring,
          extrinsicType: ExtrinsicType.VaultCollect,
          metadata: {
            vaultId: this.createdVault.vaultId,
            cosignedUtxoIds,
            cosignedOrphanUtxos,
            expectedCollectRevenue,
            ...afterCollect,
          },
          useLatestNonce: true,
        });
        void this.onVaultCollect(txInfo);
        return txInfo;
      } finally {
        // no-op
      }
    }).promise;
  }

  public findPendingCosignTxInfo(utxoId: number): TransactionInfo | undefined {
    return this.getTxInfo((extrinsicType, metadata) => {
      if (extrinsicType === ExtrinsicType.VaultCosignBitcoinRelease && metadata.utxoId === utxoId) {
        return true;
      }
      if (extrinsicType === ExtrinsicType.VaultCollect) {
        const cosignedUtxoIds = metadata.cosignedUtxoIds;
        if (Array.isArray(cosignedUtxoIds) && cosignedUtxoIds.includes(utxoId)) {
          return true;
        }
      }
      return false;
    });
  }

  public findPendingOrphanCosignTxInfo(args: {
    ownerAccount: string;
    txid: string;
    vout: number;
  }): TransactionInfo | undefined {
    return this.getTxInfo((extrinsicType, metadata) => {
      if (extrinsicType === ExtrinsicType.VaultCosignOrphanedUtxoRelease) {
        return (
          metadata.ownerAccount === args.ownerAccount && metadata.txid === args.txid && metadata.vout === args.vout
        );
      }
      if (extrinsicType !== ExtrinsicType.VaultCollect) return false;
      const cosignedOrphanUtxos = metadata.cosignedOrphanUtxos as ICollectOrphanCosignMetadata[] | undefined;
      if (!Array.isArray(cosignedOrphanUtxos)) return false;
      return cosignedOrphanUtxos.some(orphan => {
        return orphan.ownerAccount === args.ownerAccount && orphan.txid === args.txid && orphan.vout === args.vout;
      });
    });
  }

  private async buildPendingOrphanCosignTxs(args: {
    finalizedClient: ArgonClient | ApiDecoration<'promise'>;
    submitClient: ArgonClient;
    vaultId: number;
  }): Promise<{ tx: SubmittableExtrinsic; metadata: ICollectOrphanCosignMetadata }[]> {
    const { finalizedClient, submitClient, vaultId } = args;
    const ownerEntries = await finalizedClient.query.vaults.orphanedUtxoAccountsByVaultId.entries(vaultId);
    const vaultXpriv = await this.getVaultXpriv();
    const bitcoinNetwork = await this.getBitcoinNetwork();
    const queued = new Set<string>();
    const txs: { tx: SubmittableExtrinsic; metadata: ICollectOrphanCosignMetadata }[] = [];

    for (const [ownerKey, pendingCountRaw] of ownerEntries) {
      if (pendingCountRaw.toNumber() <= 0) continue;
      const ownerAccount = ownerKey.args[1].toString();
      const orphanEntries = await finalizedClient.query.bitcoinLocks.orphanedUtxosByAccount.entries(ownerAccount);

      for (const [orphanKey, orphanMaybe] of orphanEntries) {
        if (orphanMaybe.isNone) continue;
        const orphan = orphanMaybe.unwrap();
        if (orphan.vaultId.toNumber() !== vaultId) continue;
        if (orphan.cosignRequest.isNone) continue;

        const utxoRef = orphanKey.args[1];
        const txid = utxoRef.txid.toHex();
        const vout = utxoRef.outputIndex.toNumber();
        const lockUtxoId = orphan.utxoId.toNumber();
        const key = `${ownerAccount}:${txid}:${vout}`;
        if (queued.has(key)) continue;
        if (this.findPendingOrphanCosignTxInfo({ ownerAccount, txid, vout })) continue;
        queued.add(key);

        const blockNumber = orphan.recordedArgonBlockNumber.toNumber();
        const apiNode = await this.miningFrames.blockWatch.getRpcClient(blockNumber);
        const blockHash = await apiNode.rpc.chain.getBlockHash(blockNumber);
        const apiClient = await submitClient.at(blockHash);

        const lock = await BitcoinLock.get(apiClient, lockUtxoId);
        if (!lock) {
          console.warn('No lock found for orphaned cosign request:', { lockUtxoId, ownerAccount, txid, vout });
          continue;
        }

        const cosignRequest = orphan.cosignRequest.unwrap();
        const toScriptPubkey = cosignRequest.toScriptPubkey.toHex();
        const bitcoinNetworkFee = cosignRequest.bitcoinNetworkFee.toBigInt();
        const result = await this.buildOrphanCosignSubmission({
          submitClient,
          lock,
          ownerAccount,
          txid,
          vout,
          satoshis: orphan.satoshis.toBigInt(),
          bitcoinNetworkFee,
          toScriptPubkey,
          vaultXpriv,
          bitcoinNetwork,
        });
        txs.push({
          tx: result.tx,
          metadata: { lockUtxoId, ownerAccount, txid, vout, vaultSignatureHex: result.vaultSignatureHex },
        });
      }
    }

    return txs;
  }

  private async buildOrphanCosignSubmission(args: {
    submitClient: ArgonClient;
    lock: BitcoinLock;
    ownerAccount: string;
    txid: string;
    vout: number;
    satoshis: bigint;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
    vaultXpriv?: HDKey;
    bitcoinNetwork?: BitcoinNetwork;
  }): Promise<{ tx: SubmittableExtrinsic; vaultSignature: Uint8Array; vaultSignatureHex: string }> {
    const bitcoinNetwork = args.bitcoinNetwork ?? (await this.getBitcoinNetwork());
    const vaultXpriv = args.vaultXpriv ?? (await this.getVaultXpriv());
    const cosign = new CosignScript({ ...args.lock, utxoSatoshis: args.satoshis }, bitcoinNetwork);
    const psbt = cosign.getCosignPsbt({
      releaseRequest: {
        bitcoinNetworkFee: args.bitcoinNetworkFee,
        toScriptPubkey: args.toScriptPubkey,
      },
      utxoRef: { txid: args.txid, vout: args.vout },
    });
    const signedPsbt = cosign.vaultCosignPsbt(psbt, args.lock, vaultXpriv);
    const vaultSignature = signedPsbt.getInput(0).partialSig?.[0]?.[1];
    if (!vaultSignature) {
      throw new Error(`Failed to get orphan vault signature for ${args.ownerAccount}:${args.txid}:${args.vout}`);
    }
    const vaultSignatureHex = u8aToHex(vaultSignature);
    return {
      tx: args.submitClient.tx.bitcoinLocks.cosignOrphanedUtxoRelease(
        args.ownerAccount,
        { txid: args.txid, outputIndex: args.vout },
        vaultSignatureHex,
      ),
      vaultSignature,
      vaultSignatureHex,
    };
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

    if (tx.metadataJson.moveTo === MoveTo.MiningHold) {
      const followOnTx = this.#transactionTracker.createIntentForFollowOnTx(txInfo);
      if (!followOnTx.isSettled) {
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
      try {
        await txInfo.followOnTxInfo;
      } catch (error) {
        console.error('Error in follow-on move after vault collect:', error);
        // don't block the main collect finalization
      }
    }
    await txResult.waitForFinalizedBlock;
    await this.trackTxResultFee(txInfo.txResult);
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
    this.data.pendingCollectRevenue = 0n;
    for (const frameRevenue of frameRevenues) {
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

  public async subscribeToTreasuryAllocated(): Promise<VoidFunction> {
    const client = await getMainchainClient(false);
    const vaultId = this.createdVault!.vaultId;
    // TODO: Remove this compatibility check once all nodes are updated beyond v146
    if (SpecLte146.isAtSpec(client)) {
      const accountId = this.createdVault!.operatorAccountId;
      return await client.query.balances.holds(accountId, holds => {
        this.data.treasury.heldPrincipal = MyVault.extractTreasuryMicrogonsCommitted(holds);
        this.data.treasury.targetPrincipal = this.data.treasury.heldPrincipal;
      });
    } else {
      return await client.query.treasury.funderStateByVaultAndAccount(
        vaultId,
        this.walletKeys.vaultingAddress,
        state => {
          if (state.isSome) {
            const funderState = state.unwrap();
            this.data.treasury.heldPrincipal = funderState.heldPrincipal.toBigInt();
            this.data.treasury.targetPrincipal = funderState.targetPrincipal.toBigInt();
          } else {
            this.data.treasury.heldPrincipal = 0n;
            this.data.treasury.targetPrincipal = 0n;
          }
        },
      );
    }
  }

  private static extractTreasuryMicrogonsCommitted(
    holds: Vec<FrameSupportTokensMiscIdAmountRuntimeHoldReason>,
  ): bigint {
    for (const hold of holds) {
      if (hold?.id?.isTreasury) {
        return hold.amount.toBigInt();
      }
    }
    return 0n;
  }

  public static async fetchAllocatedMicrogonsForTreasuryPool(
    vault: Vault,
  ): Promise<{ heldPrincipal: bigint; targetPrincipal: bigint }> {
    const vaultId = vault.vaultId;
    const accountId = vault.operatorAccountId;
    const client = await getMainchainClient(false);

    // TODO: Remove this compatibility check once all nodes are updated beyond v146
    if (SpecLte146.isAtSpec(client)) {
      const holds = await client.query.balances.holds(accountId);
      const held = this.extractTreasuryMicrogonsCommitted(holds);
      return { heldPrincipal: held, targetPrincipal: held };
    }

    const treasuryFunderState = await client.query.treasury.funderStateByVaultAndAccount(vaultId, accountId);
    if (treasuryFunderState.isNone) {
      return { heldPrincipal: 0n, targetPrincipal: 0n };
    }
    const state = treasuryFunderState.unwrap();
    return {
      heldPrincipal: state.heldPrincipal.toBigInt(),
      targetPrincipal: state.targetPrincipal.toBigInt(),
    };
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

  public async recoverAccountVault(args: {
    onProgress: (progress: number) => void;
  }): Promise<IVaultingRules | undefined> {
    await this.deleteAllDbData();
    const { onProgress } = args;
    const vaultingAddress = this.walletKeys.vaultingAddress;
    console.log('Recovering vault for address', vaultingAddress);
    const mainchainClients = getMainchainClients();
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
    await this.recordVault(foundVault);

    onProgress(75);

    let bitcoin: IBitcoinLockRecord | undefined;
    const hasSecuritization = vault.activatedSecuritization() > 0n || vault.securitizationPendingActivation > 0n;
    if (hasSecuritization && foundVault.createBlockNumber) {
      const myBitcoins = await MyVaultRecovery.recoverPersonalBitcoin({
        mainchainClients,
        bitcoinLocksStore: this.bitcoinLocksStore,
        vaultSetupBlockNumber: foundVault.createBlockNumber,
        vault,
      });
      bitcoin = myBitcoins[0];
    }

    const table = await this.getTable();
    await table.save(this.metadata!);
    onProgress(100);
    await this.load(true);
    return MyVaultRecovery.rebuildRules({
      feesInMicrogons: foundVault.txFee ?? 0n,
      vault,
      bitcoin,
      treasuryMicrogons: this.data.treasury.heldPrincipal,
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
    await this.trackTxResultFee(txResult);
    console.log('Vault settings updated');
    postProcessor.resolve();
  }

  public async buildTreasuryAllocationTx(newAllocation: bigint): Promise<SubmittableExtrinsic> {
    const vaultId = this.createdVault?.vaultId;
    if (!vaultId) {
      throw new Error('No vault created to build treasury allocation tx');
    }

    const client = await getMainchainClient(false);
    // TODO: remove after we upgrade past spec 146
    if (SpecLte146.isAtSpec(client)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return (client.tx.treasury as unknown as SpecLte146.ITreasuryTxSpec).vaultOperatorPrebond(
        vaultId,
        newAllocation / 10n,
      ) as any;
    } else {
      return client.tx.treasury.setAllocation(vaultId, newAllocation);
    }
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
        txs.push(await this.buildTreasuryAllocationTx(microgonsForTreasury));
      }

      let bitcoinArgs:
        | { satoshis: bigint; hdPath: string; securityFee: bigint; vaultId: number; uuid: string }
        | undefined;
      if (rules.personalBtcPct > 0n) {
        const personalBtcInMicrogons = bigNumberToBigInt(
          BigNumber(rules.personalBtcPct).div(100).times(microgonsForSecuritization),
        );

        const couponProofKeypair = this.createCouponProofKeypair(client);
        const { tx, satoshis, hdPath, securityFee } = await this.bitcoinLocksStore.createInitializeTx({
          ...args,
          vault,
          argonKeyring: vaultingAccount,
          addingVaultSpace: addedSecuritization,
          microgonLiquidity: personalBtcInMicrogons,
          couponProofKeypair,
          skipCouponValidation: true,
        });
        bitcoinArgs = { satoshis, hdPath, securityFee, vaultId, uuid: BitcoinLocksTable.createUuid() };

        this.registerFeeCoupon({
          client,
          couponProofKeypair,
          maxSatoshis: satoshis,
          txs,
        });
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
    await txResult.waitForFinalizedBlock;
    await this.trackTxResultFee(txResult);

    const { microgonsForTreasury, microgonsForSecuritization, bitcoin } = tx.metadataJson;
    if (bitcoin) {
      // create a separate tx info since we want to chain
      const bitcoinTxInfo = new TransactionInfo<any>({ tx, txResult });
      await this.bitcoinLocksStore.createPendingBitcoinLock(bitcoinTxInfo);
      await bitcoinTxInfo?.waitForPostProcessing;
    }
    console.log('Saving vault updates', {
      microgonsForTreasury,
      microgonsForSecuritization,
    });
    postProcessor.resolve();

    return { txResult };
  }

  public createCouponProofKeypair(client: ArgonClient): KeyringPair | undefined {
    if (!BitcoinLock.areFeeCouponsSupported(client)) {
      return undefined;
    }
    return new Keyring({ type: 'sr25519' }).addFromMnemonic(mnemonicGenerate());
  }

  public registerFeeCoupon(args: {
    client: ArgonClient;
    couponProofKeypair?: KeyringPair;
    maxSatoshis: number | bigint;
    txs: SubmittableExtrinsic[];
  }) {
    const { client, couponProofKeypair, maxSatoshis } = args;
    if (!BitcoinLock.areFeeCouponsSupported(client) || !couponProofKeypair) {
      return undefined;
    }
    const tx = BitcoinLock.createFeeCouponTx({
      client,
      couponProofKeypair,
      maxSatoshis: Number(maxSatoshis),
    });
    if (tx) {
      args.txs.push(tx);
    }
  }

  public async startBitcoinLocking(args: { microgonLiquidity: bigint; tip?: bigint }): Promise<void> {
    const vault = this.createdVault;
    if (!vault) throw new Error('No vault created to lock bitcoin');

    await this.#singleActiveBitcoinQueue.add(async () => {
      const activeLock = this.bitcoinLocksStore.getActiveLocksForVault(vault.vaultId);
      if (activeLock.length > 0) {
        console.log('Active bitcoin lock already exists for vault, skipping new lock creation');
        return;
      }
      console.log('Saving vault bitcoin lock', { microgonLiquidity: args.microgonLiquidity, metadata: this.metadata! });

      const keyring = await this.walletKeys.getVaultingKeypair();
      const client = await getMainchainClient(false);

      const initialTx = await this.bitcoinLocksStore.createInitializeTx({
        ...args,
        argonKeyring: keyring,
        vault,
      });
      const bitcoinUuid = BitcoinLocksTable.createUuid();
      const txs: SubmittableExtrinsic[] = [];

      txs.push(initialTx.tx);

      const txInfo = await this.#transactionTracker.submitAndWatch({
        tx: txs.length > 1 ? client.tx.utility.batchAll(txs) : txs[0],
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
    }).promise;
  }

  public async increaseVaultAllocations(args: {
    addedSecuritizationMicrogons: bigint;
    addedTreasuryMicrogons: bigint;
    tip?: bigint;
  }): Promise<TransactionInfo> {
    const { addedSecuritizationMicrogons, addedTreasuryMicrogons } = args;
    const client = await getMainchainClient(false);
    const vault = this.createdVault;
    if (!vault) {
      throw new Error('No vault created to get changes needed');
    }

    const txs = [];

    if (addedSecuritizationMicrogons > 0n) {
      const tx = client.tx.vaults.modifyFunding(
        vault.vaultId,
        vault.securitization + addedSecuritizationMicrogons,
        toFixedNumber(vault.securitizationRatio, FIXED_U128_DECIMALS),
      );
      txs.push(tx);
    }

    let treasuryMicrogons = this.data.treasury.targetPrincipal;
    if (addedTreasuryMicrogons > 0n) {
      treasuryMicrogons += addedTreasuryMicrogons;
      txs.push(await this.buildTreasuryAllocationTx(treasuryMicrogons));
    }
    const argonKeyring = await this.walletKeys.getVaultingKeypair();
    const info = await this.#transactionTracker.submitAndWatch({
      tx: txs.length > 1 ? client.tx.utility.batchAll(txs) : txs[0],
      signer: argonKeyring,
      extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
      metadata: {
        addedSecuritizationMicrogons,
        addedTreasuryMicrogons,
        prebondedMicrogons: treasuryMicrogons,
        vaultId: vault.vaultId,
      },
      tip: args.tip,
    });
    this.data.pendingAllocateTxInfo = info;
    void this.onIncreaseVaultAllocations(info);
    return info;
  }

  private async onIncreaseVaultAllocations(txInfo: TransactionInfo<{ prebondedMicrogons: bigint }>): Promise<void> {
    const { txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    await txResult.waitForFinalizedBlock;
    this.data.pendingAllocateTxInfo = null;
    console.log('Vault allocations increased');
    await this.trackTxResultFee(txResult);
    postProcessor.resolve();
  }

  private async trackTxResultFee(txResult: TxResult): Promise<void> {
    try {
      await txResult.waitForFinalizedBlock;
      txResult.txProgressCallback = undefined;
      this.recordFee(txResult);
      await this.saveMetadata();
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
