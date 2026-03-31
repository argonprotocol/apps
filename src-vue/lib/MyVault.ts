import {
  ApiDecoration,
  ArgonClient,
  BitcoinLock,
  FIXED_U128_DECIMALS,
  IBitcoinLock,
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
  BondFunder,
  createDeferred,
  IDeferred,
  type IFrameBondHolder,
  IVaultStats,
  MiningFrames,
  MoveFrom,
  MoveTo,
  NetworkConfig,
  SingleFileQueue,
  TreasuryPool,
} from '@argonprotocol/apps-core';
import { IVaultRecord, VaultsTable } from './db/VaultsTable.ts';
import { IVaultingRules } from '../interfaces/IVaultingRules.ts';
import { Vaults } from './Vaults.ts';
import BitcoinLocks from './BitcoinLocks.ts';
import { MyVaultRecovery } from './MyVaultRecovery.ts';
import { type IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import { TransactionTracker, TxAttemptState } from './TransactionTracker.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { WalletKeys } from './WalletKeys.ts';
import { ensureOperatorAccountRegistered } from './OperationalAccount.ts';
import { Config } from './Config.ts';

export const FEE_ESTIMATE = 75_000n;
export const DEFAULT_MASTER_XPUB_PATH = "m/84'/0'/0'";

type ICollectOrphanCosignMetadata = {
  lockUtxoId: number;
  ownerAccount: string;
  txid: string;
  vout: number;
  vaultSignatureHex: string;
};
type IPendingCosignUtxo = {
  marketValue: bigint;
  dueFrame?: number;
};

export interface IExternalBitcoinLock {
  utxoId: number;
  satoshis: bigint;
  liquidityPromised: bigint;
  isPending: boolean;
  lockDetails: IBitcoinLock;
}

export type { IFrameBondHolder };
export { BondFunder };

// Keep following a submitted/reorged cosign attempt briefly before retrying it.
const COSIGN_ATTEMPT_FOLLOW_WINDOW_FINALIZED_BLOCKS = 2;

export class MyVault {
  public data: {
    isReady: boolean;
    createdVault: Vault | null;
    metadata: IVaultRecord | null;
    stats: IVaultStats | null;
    pendingCollectRevenue: bigint;
    pendingCosignUtxosById: Map<number, IPendingCosignUtxo>;
    myPendingBitcoinCosignTxInfosByUtxoId: Map<number, TransactionInfo<{ utxoId: number }>>;
    nextCollectDueDate: number;
    expiringCollectAmount: bigint;
    finalizeMyBitcoinError?: { lockUtxoId: number; error: string };
    currentFrameId: number;
    treasury: {
      heldPrincipal: bigint;
      pendingReturnAmount: bigint;
      pendingReturnAtFrame: number | null;
    };
    pendingCollectTxInfo: TransactionInfo<{
      expectedCollectRevenue: bigint;
      cosignedUtxoIds: number[];
      cosignedOrphanUtxos?: ICollectOrphanCosignMetadata[];
      moveTo: MoveTo;
      allocationPercents?: { treasury: number; securitization: number };
    }> | null;
    securitizedSatoshis: bigint;
    currentFrameBondData: {
      distributableBidPool: bigint;
      globalCapital: bigint;
      myVaultCapital: bigint;
      sharingPct: number;
      bondHolders: IFrameBondHolder[];
    };
    externalLocks: { [utxoId: number]: IExternalBitcoinLock };
    bondFunders: BondFunder[];
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
  #collectFrames: { frameId: number; uncollectedEarnings: bigint }[] = [];
  #pendingCosignUpdateSeq = 0;

  constructor(
    private readonly dbPromise: Promise<Db>,
    public readonly vaults: Vaults,
    public readonly walletKeys: WalletKeys,
    transactionTracker: TransactionTracker,
    public readonly bitcoinLocks: BitcoinLocks,
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
      myPendingBitcoinCosignTxInfosByUtxoId: new Map(),
      nextCollectDueDate: 0,
      expiringCollectAmount: 0n,
      currentFrameId: 0,
      securitizedSatoshis: 0n,
      currentFrameBondData: {
        distributableBidPool: 0n,
        globalCapital: 0n,
        myVaultCapital: 0n,
        sharingPct: 0,
        bondHolders: [],
      },
      externalLocks: {},
      bondFunders: [],
      treasury: {
        heldPrincipal: 0n,
        pendingReturnAmount: 0n,
        pendingReturnAtFrame: null,
      },
    };
    this.vaults = vaults;
    this.#transactionTracker = transactionTracker;
    bitcoinLocks.myVault = this;
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

  private async getVaultXpriv(masterXpubPath?: string): Promise<HDKey> {
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
    this.#collectFrames = [];
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
      await this.bitcoinLocks.load(reload);

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
        const operatorFunder = await MyVault.fetchAllocatedMicrogonsForTreasuryPool(this.createdVault!);
        if (operatorFunder) {
          this.data.treasury.heldPrincipal = operatorFunder.heldPrincipal;
          this.data.treasury.pendingReturnAmount = operatorFunder.pendingReturnAmount;
          this.data.treasury.pendingReturnAtFrame = operatorFunder.pendingReturnAtFrame;
        }
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

  public getBitcoinReleaseRequestTxInfo(utxoId: number): TransactionInfo<any> | undefined {
    return this.#transactionTracker.findLatestTxInfo(txInfo => {
      const metadata = txInfo.tx.metadataJson as any;
      return txInfo.tx.extrinsicType === ExtrinsicType.BitcoinRequestRelease && metadata?.utxoId === utxoId;
    });
  }

  public async subscribe() {
    if (this.#subscriptions.length) return;
    if (!this.createdVault) {
      throw new Error('No vault created to subscribe to');
    }
    const vaultId = this.createdVault.vaultId;
    const client = await getMainchainClient(false);

    // update stats live
    const sub = await client.query.vaults.vaultsById(vaultId, vault => {
      if (!vault.isSome) return;

      const raw = vault.unwrap();
      const nextVault = new Vault(vaultId, raw, NetworkConfig.tickMillis);
      this.vaults.vaultsById[vaultId] = nextVault;
      this.data.createdVault = nextVault;
      this.data.securitizedSatoshis = raw.securitizedSatoshis.toBigInt();
      void this.refreshExternalLocks();
    });

    const sub2 = await client.query.vaults.revenuePerFrameByVault(vaultId, async x => {
      await this.updateRevenueStats(x);
      this.updateCollectDueDate();
    });

    const sub3 = await client.query.vaults.pendingCosignByVaultId(vaultId, async x => {
      const updateSeq = ++this.#pendingCosignUpdateSeq;
      await this.recordPendingCosignUtxos(x, updateSeq);
    });
    const sub4 = await client.query.vaults.lastCollectFrameByVaultId(vaultId, () => {
      this.updateCollectDueDate();
    });

    const sub5 = await client.query.miningSlot.nextFrameId(frameId => {
      this.data.currentFrameId = frameId.toNumber() - 1;
      this.updateCollectDueDate();
      void this.refreshBondData();
    });

    const sub6 = await this.subscribeToTreasuryAllocated();
    const sub7 = await this.subscribeToBidPool(client);

    this.#subscriptions.push(sub, sub2, sub3, sub4, sub5, sub6, sub7);

    void this.refreshBondData();
  }

  private updateCollectDueDate() {
    const framesToCollect = this.#configs!.timeToCollectFrames;
    let nextCollectFrame = this.data.currentFrameId + framesToCollect;
    this.data.expiringCollectAmount = 0n;
    const oldestToCollectFrame = this.data.currentFrameId - framesToCollect;
    for (const frameChange of this.#collectFrames) {
      if (frameChange.uncollectedEarnings > 0n) {
        this.data.expiringCollectAmount = frameChange.uncollectedEarnings;
        // descending order
        nextCollectFrame = frameChange.frameId + framesToCollect;
      }
      if (frameChange.frameId < oldestToCollectFrame) break;
    }
    if (this.data.pendingCosignUtxosById.size > 0) {
      let earliestCosignDueFrame = Number.MAX_SAFE_INTEGER;
      for (const pendingCosign of this.data.pendingCosignUtxosById.values()) {
        if (pendingCosign.dueFrame === undefined) {
          continue;
        }
        earliestCosignDueFrame = Math.min(earliestCosignDueFrame, pendingCosign.dueFrame);
      }
      if (earliestCosignDueFrame < Number.MAX_SAFE_INTEGER) {
        nextCollectFrame = Math.min(nextCollectFrame, earliestCosignDueFrame);
      }
    }
    nextCollectFrame = Math.max(this.data.currentFrameId + 1, nextCollectFrame);

    this.data.nextCollectDueDate = this.miningFrames.getFrameDate(nextCollectFrame).getTime();
  }

  private async recordPendingCosignUtxos(rawUtxoIds: Iterable<u64>, updateSeq: number) {
    const previousPendingCosignsById = new Map(this.data.pendingCosignUtxosById);
    const pendingCosignUtxosById = new Map<number, IPendingCosignUtxo>();
    const client = await getMainchainClient(false);
    for (const utxoId of rawUtxoIds) {
      const id = utxoId.toNumber();
      const lock = await BitcoinLock.get(client, id);
      const previousPending = previousPendingCosignsById.get(id);
      const pendingReleaseRaw = await client.query.bitcoinLocks.lockReleaseRequestsByUtxoId(id);
      const dueFrame = pendingReleaseRaw.isSome
        ? pendingReleaseRaw.unwrap().cosignDueFrame.toNumber()
        : previousPending?.dueFrame;
      const marketValue = lock?.lockedMarketRate ?? previousPending?.marketValue ?? 0n;
      if (marketValue === 0n && !lock && previousPending?.marketValue === undefined) {
        console.warn(`Pending cosign UTXO ${id} has no lock data; using 0 as fallback market value.`);
      }
      pendingCosignUtxosById.set(id, { marketValue, dueFrame });
    }
    if (updateSeq !== this.#pendingCosignUpdateSeq) {
      return;
    }

    const myPendingBitcoinCosignTxInfosByUtxoId = new Map<number, TransactionInfo<{ utxoId: number }>>();
    for (const [utxoId, txInfo] of this.data.myPendingBitcoinCosignTxInfosByUtxoId) {
      if (!pendingCosignUtxosById.has(utxoId)) continue;
      myPendingBitcoinCosignTxInfosByUtxoId.set(utxoId, txInfo);
    }

    this.data.pendingCosignUtxosById = pendingCosignUtxosById;
    this.data.myPendingBitcoinCosignTxInfosByUtxoId = myPendingBitcoinCosignTxInfosByUtxoId;
    this.updateCollectDueDate();
  }

  public async cosignMyLock(
    lock: IBitcoinLockRecord,
  ): Promise<{ txInfo: TransactionInfo; vaultSignature: Uint8Array } | undefined> {
    if (lock.vaultId !== this.createdVault?.vaultId) {
      // this api is only to unlock our own vault's bitcoin locks
      return;
    }
    try {
      this.data.finalizeMyBitcoinError = undefined;
      const fundingUtxo = lock.fundingUtxoRecord;
      if (!lock.utxoId || !fundingUtxo?.releaseToDestinationAddress || fundingUtxo.releaseBitcoinNetworkFee == null) {
        return;
      }
      const result = await this.cosignRelease({
        utxoId: lock.utxoId,
        releaseRequest: {
          toScriptPubkey: fundingUtxo.releaseToDestinationAddress,
          bitcoinNetworkFee: fundingUtxo.releaseBitcoinNetworkFee,
        },
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

  public async createVaultSignatureForMyOrphanedUtxoRelease(args: {
    lock: IBitcoinLockRecord;
    txid: string;
    vout: number;
    satoshis: bigint;
    toScriptPubkey: string;
    bitcoinNetworkFee: bigint;
  }): Promise<Uint8Array | undefined> {
    const { lock } = args;
    if (!lock.utxoId || lock.vaultId !== this.createdVault?.vaultId) {
      return;
    }
    try {
      this.data.finalizeMyBitcoinError = undefined;
      const result = await this.buildOrphanSignature({
        lock: lock.lockDetails,
        txid: args.txid,
        vout: args.vout,
        satoshis: args.satoshis,
        bitcoinNetworkFee: args.bitcoinNetworkFee,
        toScriptPubkey: args.toScriptPubkey,
      });
      return result.vaultSignature;
    } catch (error) {
      console.error(`Error creating orphan release signature for lock ${lock.utxoId}`, error);
      this.data.finalizeMyBitcoinError = { lockUtxoId: lock.utxoId, error: String(error) };
    }
  }

  private async cosignMyOrphanedUtxoRelease(args: {
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
    releaseRequest: { toScriptPubkey: string; bitcoinNetworkFee: bigint };
  }): Promise<{ tx: SubmittableExtrinsic; vaultSignature: Uint8Array } | undefined> {
    const { utxoId, releaseRequest } = args;
    const finalizedClient = await getFinalizedClient();
    const lock = await BitcoinLock.get(finalizedClient, utxoId);
    if (!lock) {
      console.warn('No lock found for utxoId:', utxoId);
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
        bitcoinNetworkFee: releaseRequest.bitcoinNetworkFee,
        toScriptPubkey: releaseRequest.toScriptPubkey,
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
    releaseRequest: { toScriptPubkey: string; bitcoinNetworkFee: bigint };
    progressCallback?: ITxProgressCallback;
  }): Promise<{ txInfo: TransactionInfo; vaultSignature: Uint8Array } | undefined> {
    return await this.#cosignQueue.add(async () => {
      const { utxoId } = args;
      const latestTxAttempt = await this.findLatestReleaseCosignTxAttempt(utxoId);

      const cosignResult = await this.buildCosignTx(args);
      if (!cosignResult) {
        return;
      }

      if (
        latestTxAttempt &&
        (latestTxAttempt.txAttemptState === TxAttemptState.Follow ||
          latestTxAttempt.txAttemptState === TxAttemptState.Finalized)
      ) {
        return { txInfo: latestTxAttempt.txInfo, vaultSignature: cosignResult.vaultSignature };
      }

      const { tx, vaultSignature } = cosignResult;
      const followOnTx =
        latestTxAttempt?.txInfo && !latestTxAttempt.txInfo.tx.followOnTxId
          ? this.#transactionTracker.createIntentForFollowOnTx(latestTxAttempt.txInfo)
          : undefined;

      try {
        const argonKeyring = await this.walletKeys.getVaultingKeypair();
        const txInfo = await this.#transactionTracker.submitAndWatch({
          tx,
          signer: argonKeyring,
          useLatestNonce: true,
          extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
          metadata: { utxoId },
        });
        followOnTx?.resolve(txInfo);
        void this.onCosignResult(txInfo);
        return { txInfo: txInfo, vaultSignature };
      } catch (error) {
        followOnTx?.reject(error);
        throw error;
      }
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
      const latestTxAttempt = await this.findLatestOrphanCosignTxAttempt({
        ownerAccount: args.ownerAccount,
        txid: args.txid,
        vout: args.vout,
      });

      if (
        latestTxAttempt &&
        (latestTxAttempt.txAttemptState === TxAttemptState.Follow ||
          latestTxAttempt.txAttemptState === TxAttemptState.Finalized)
      ) {
        const cosignResult = await this.buildOrphanCosignTx(args);
        if (!cosignResult) return;
        return { txInfo: latestTxAttempt.txInfo, vaultSignature: cosignResult.vaultSignature };
      }

      const cosignResult = await this.buildOrphanCosignTx(args);
      if (!cosignResult) return;
      const { tx, vaultSignature } = cosignResult;
      const followOnTx =
        latestTxAttempt?.txInfo && !latestTxAttempt.txInfo.tx.followOnTxId
          ? this.#transactionTracker.createIntentForFollowOnTx(latestTxAttempt.txInfo)
          : undefined;

      try {
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
        followOnTx?.resolve(txInfo);
        void this.onOrphanCosignResult(txInfo);
        return { txInfo, vaultSignature };
      } catch (error) {
        followOnTx?.reject(error);
        throw error;
      }
    }).promise;
  }

  private async onCosignResult(txInfo: TransactionInfo<{ utxoId: number }>): Promise<void> {
    const { tx, txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    const utxoId = tx.metadataJson.utxoId;

    this.data.myPendingBitcoinCosignTxInfosByUtxoId.set(utxoId, txInfo);
    try {
      const blockHash = await txResult.waitForFinalizedBlock;
      console.log(`Cosigned and submitted transaction for utxoId ${utxoId} at ${u8aToHex(blockHash)}`);
      await this.trackTxResultFee(txResult);
      postProcessor.resolve();
    } finally {
      if (this.data.myPendingBitcoinCosignTxInfosByUtxoId.get(utxoId) === txInfo) {
        this.data.myPendingBitcoinCosignTxInfosByUtxoId.delete(utxoId);
      }
    }
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
      const toCosign = [...this.data.pendingCosignUtxosById.keys()];
      const cosignedUtxoIds: number[] = [];
      const cosignedOrphanUtxos: ICollectOrphanCosignMetadata[] = [];
      const expectedCollectRevenue = this.data.pendingCollectRevenue;
      // You should only cosign finalized releases, so we get a finalized client
      const finalizedClient = await getFinalizedClient();
      const client = await getMainchainClient(false);
      const argonKeyring = await this.walletKeys.getVaultingKeypair();
      const txs: SubmittableExtrinsic[] = [];
      try {
        for (const utxoId of toCosign) {
          const latestTxAttempt = await this.findLatestReleaseCosignTxAttempt(utxoId);
          if (
            latestTxAttempt &&
            (latestTxAttempt.txAttemptState === TxAttemptState.Follow ||
              latestTxAttempt.txAttemptState === TxAttemptState.Finalized)
          ) {
            continue;
          }
          const pendingReleaseRaw = await finalizedClient.query.bitcoinLocks.lockReleaseRequestsByUtxoId(utxoId);
          if (pendingReleaseRaw.isNone) {
            continue;
          }
          const pendingRelease = pendingReleaseRaw.unwrap();
          const result = await this.buildCosignTx({
            utxoId,
            releaseRequest: {
              bitcoinNetworkFee: pendingRelease.bitcoinNetworkFee.toBigInt(),
              toScriptPubkey: pendingRelease.toScriptPubkey.toHex(),
            },
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

  public async findLatestReleaseCosignTxAttempt(
    utxoId: number,
  ): Promise<{ txInfo: TransactionInfo; txAttemptState: TxAttemptState } | undefined> {
    const latestTxInfo = this.#transactionTracker.findLatestTxInfo(txInfo => {
      const { extrinsicType, metadataJson } = txInfo.tx;
      const metadata = metadataJson as any;

      if (extrinsicType === ExtrinsicType.VaultCosignBitcoinRelease) {
        return utxoId === metadata.utxoId;
      }

      if (extrinsicType !== ExtrinsicType.VaultCollect) {
        return false;
      }

      const cosignedUtxoIds = metadata.cosignedUtxoIds;
      return Array.isArray(cosignedUtxoIds) && cosignedUtxoIds.includes(utxoId);
    });

    if (!latestTxInfo) {
      return;
    }

    return {
      txInfo: latestTxInfo,
      txAttemptState: await this.#transactionTracker.getTxAttemptState(
        latestTxInfo,
        COSIGN_ATTEMPT_FOLLOW_WINDOW_FINALIZED_BLOCKS,
      ),
    };
  }

  public async findLatestOrphanCosignTxAttempt(args: {
    ownerAccount: string;
    txid: string;
    vout: number;
  }): Promise<{ txInfo: TransactionInfo; txAttemptState: TxAttemptState } | undefined> {
    const latestTxInfo = this.#transactionTracker.findLatestTxInfo(txInfo => {
      const { extrinsicType, metadataJson } = txInfo.tx;
      const metadata = metadataJson as any;

      if (extrinsicType === ExtrinsicType.VaultCosignOrphanedUtxoRelease) {
        return (
          metadata.ownerAccount === args.ownerAccount && metadata.txid === args.txid && metadata.vout === args.vout
        );
      }

      if (extrinsicType !== ExtrinsicType.VaultCollect) {
        return false;
      }

      const cosignedOrphanUtxos = metadata.cosignedOrphanUtxos as ICollectOrphanCosignMetadata[] | undefined;
      return (
        Array.isArray(cosignedOrphanUtxos) &&
        cosignedOrphanUtxos.some(orphan => {
          return orphan.ownerAccount === args.ownerAccount && orphan.txid === args.txid && orphan.vout === args.vout;
        })
      );
    });

    if (!latestTxInfo) {
      return;
    }

    return {
      txInfo: latestTxInfo,
      txAttemptState: await this.#transactionTracker.getTxAttemptState(
        latestTxInfo,
        COSIGN_ATTEMPT_FOLLOW_WINDOW_FINALIZED_BLOCKS,
      ),
    };
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
        const latestTxAttempt = await this.findLatestOrphanCosignTxAttempt({
          ownerAccount,
          txid,
          vout,
        });
        if (
          latestTxAttempt &&
          (latestTxAttempt.txAttemptState === TxAttemptState.Follow ||
            latestTxAttempt.txAttemptState === TxAttemptState.Finalized)
        ) {
          continue;
        }
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

  private async buildOrphanSignature(args: {
    lock: IBitcoinLock;
    txid: string;
    vout: number;
    satoshis: bigint;
    bitcoinNetworkFee: bigint;
    toScriptPubkey: string;
    vaultXpriv?: HDKey;
    bitcoinNetwork?: BitcoinNetwork;
  }): Promise<{ vaultSignature: Uint8Array; vaultSignatureHex: string }> {
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
      throw new Error(`Failed to get orphan vault signature for ${args.txid}:${args.vout}`);
    }
    return { vaultSignature, vaultSignatureHex: u8aToHex(vaultSignature) };
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
    const { vaultSignature, vaultSignatureHex } = await this.buildOrphanSignature({
      lock: args.lock,
      txid: args.txid,
      vout: args.vout,
      satoshis: args.satoshis,
      bitcoinNetworkFee: args.bitcoinNetworkFee,
      toScriptPubkey: args.toScriptPubkey,
      vaultXpriv: args.vaultXpriv,
      bitcoinNetwork: args.bitcoinNetwork,
    });
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
        try {
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
        } catch (error) {
          followOnTx.reject(error);
          throw error;
        }
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
    config: Config;
  }): Promise<TransactionInfo<{ masterXpubPath: string; masterXpub: string }>> {
    const pendingTxInfo = this.#singleRunTransactions.get(ExtrinsicType.VaultCreate);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    if (pendingTxInfo) return pendingTxInfo as any;

    const deferred = createDeferred<TransactionInfo<{ masterXpubPath: string; masterXpub: string }>>();
    this.#singleRunTransactions.set(ExtrinsicType.VaultCreate, deferred.promise);
    try {
      const { masterXpubPath, rules, config } = args;
      await ensureOperatorAccountRegistered('vaulting', { walletKeys: this.walletKeys, config });
      const argonKeyring = await this.walletKeys.getVaultingKeypair();
      console.log('Creating a vault with address', argonKeyring.address);
      const vaultXpriv = await this.getVaultXpriv(masterXpubPath);
      const masterXpub = vaultXpriv.publicExtendedKey;
      const client = await getMainchainClient(false);

      const microgonsForSecuritization = MyVault.getSecuritizationTarget(rules);

      const { txResult } = await Vault.create(
        client,
        argonKeyring,
        {
          securitizationRatio: rules.securitizationRatio,
          securitization: microgonsForSecuritization,
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
    this.#collectFrames = frameRevenues
      .map(frameRevenue => ({
        frameId: frameRevenue.frameId.toNumber(),
        uncollectedEarnings: frameRevenue.uncollectedRevenue.toBigInt(),
      }))
      .sort((a, b) => b.frameId - a.frameId);
    this.vaults.vaultsById[vaultId] = this.createdVault;

    await this.vaults.updateVaultRevenue(vaultId, frameRevenues);
    this.data.pendingCollectRevenue = this.#collectFrames.reduce(
      (total, frame) => total + frame.uncollectedEarnings,
      0n,
    );
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

  public async refreshBondData(): Promise<void> {
    const vaultId = this.vaultId;
    if (vaultId == null) return;

    const client = await getMainchainClient(false);
    const capital = await TreasuryPool.getActiveCapital(client, vaultId);

    this.data.currentFrameBondData.globalCapital = capital.totalActivatedCapital;
    this.data.currentFrameBondData.myVaultCapital = capital.vaultActivatedCapital;

    await this.refreshBondFunders(client);
    await this.refreshCurrentFrameBonds(client);
  }

  private async refreshBondFunders(client?: ArgonClient): Promise<void> {
    const vaultId = this.vaultId;
    if (vaultId == null) return;

    client ??= await getMainchainClient(false);
    const ownAddress = this.walletKeys.vaultingAddress;

    const entries = await client.query.treasury.funderStateByVaultAndAccount.entries(vaultId);

    const funders: BondFunder[] = [];
    for (const [key, stateOption] of entries) {
      if (stateOption.isNone) continue;
      const accountId = key.args[1].toString();
      funders.push(new BondFunder(accountId, stateOption.unwrap(), accountId === ownAddress));
    }
    this.data.bondFunders = funders;
  }

  private async refreshCurrentFrameBonds(client?: ArgonClient): Promise<void> {
    const vaultId = this.vaultId;
    if (vaultId == null) return;

    client ??= await getMainchainClient(false);
    const frameId = this.data.currentFrameId;
    if (frameId <= 0) return;

    const poolMap = await client.query.treasury.vaultPoolsByFrame(frameId);
    for (const [vaultIdCodec, pool] of poolMap.entries()) {
      if (vaultIdCodec.toNumber() !== vaultId) continue;
      const parsed = TreasuryPool.parseFrameBondHolders(pool, this.walletKeys.vaultingAddress);
      this.data.currentFrameBondData.bondHolders = parsed.holders;
      this.data.currentFrameBondData.sharingPct = parsed.vaultSharingPct;
      return;
    }
    this.data.currentFrameBondData.bondHolders = [];
    this.data.currentFrameBondData.sharingPct = 0;
  }

  private async subscribeToBidPool(client: ArgonClient): Promise<() => void> {
    return await TreasuryPool.subscribeBidPool(client, bidPool => {
      this.data.currentFrameBondData.distributableBidPool = bidPool;
    });
  }

  public async refreshExternalLocks(): Promise<void> {
    const vaultId = this.vaultId;
    if (vaultId == null) return;

    const client = await getMainchainClient(false);
    const entries = await client.query.bitcoinLocks.utxoIdsByVaultId.entries(vaultId);

    const activeLocks = this.bitcoinLocks.getActiveLocks();
    const localUtxoIds = new Set(activeLocks.map(lock => lock.utxoId).filter((id): id is number => id != null));

    const utxoIds: number[] = [];
    for (const [key] of entries) {
      const utxoId = key.args[1].toNumber();
      if (!localUtxoIds.has(utxoId)) {
        utxoIds.push(utxoId);
      }
    }

    if (utxoIds.length === 0) {
      this.data.externalLocks = {};
      return;
    }

    const next: { [utxoId: number]: IExternalBitcoinLock } = {};
    for (const utxoId of utxoIds) {
      const starting = this.data.externalLocks[utxoId];
      if (starting && !starting.isPending) {
        next[utxoId] = starting;
        continue;
      }
      const lock = await BitcoinLock.get(client, utxoId);
      if (!lock) continue;
      if (lock.ownerAccount === this.walletKeys.vaultingAddress) continue;
      next[utxoId] = {
        utxoId,
        satoshis: lock.satoshis,
        liquidityPromised: lock.liquidityPromised,
        isPending: !lock.isFunded,
        lockDetails: lock as IBitcoinLock,
      };
    }
    this.data.externalLocks = next;
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

    return await TreasuryPool.subscribeFunderState(client, vaultId, this.walletKeys.vaultingAddress, true, state => {
      if (state) {
        this.data.treasury.heldPrincipal = state.heldPrincipal;
        this.data.treasury.pendingReturnAmount = state.pendingReturnAmount;
        this.data.treasury.pendingReturnAtFrame = state.pendingReturnAtFrame;
      } else {
        this.data.treasury.heldPrincipal = 0n;
        this.data.treasury.pendingReturnAmount = 0n;
        this.data.treasury.pendingReturnAtFrame = null;
      }
    });
  }

  public static async fetchAllocatedMicrogonsForTreasuryPool(vault: Vault): Promise<BondFunder | null> {
    const vaultId = vault.vaultId;
    const accountId = vault.operatorAccountId;
    const client = await getMainchainClient(false);

    const treasuryFunderState = await client.query.treasury.funderStateByVaultAndAccount(vaultId, accountId);
    if (treasuryFunderState.isNone) return null;
    return new BondFunder(accountId, treasuryFunderState.unwrap(), true);
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
      this.bitcoinLocks.bitcoinNetwork,
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
        bitcoinLocks: this.bitcoinLocks,
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
    return client.tx.treasury.setAllocation(vaultId, newAllocation);
  }

  public async activateSecuritization(args: {
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
      const microgonsForSecuritization = MyVault.getSecuritizationTarget(
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

      if (!txs.length) {
        deferred.resolve(undefined as any);
        this.#singleRunTransactions.delete(ExtrinsicType.VaultInitialAllocate);

        return undefined;
      }

      const txInfo = await this.#transactionTracker.submitAndWatch({
        tx: txs.length > 1 ? client.tx.utility.batchAll(txs) : txs[0],
        signer: vaultingAccount,
        extrinsicType: ExtrinsicType.VaultInitialAllocate,
        metadata: { microgonsForSecuritization, vaultId },
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
      microgonsForSecuritization: bigint;
      vaultId: number;
    }>,
  ): Promise<{ txResult: TxResult }> {
    const { tx, txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    await txResult.waitForFinalizedBlock;
    await this.trackTxResultFee(txResult);

    const { microgonsForSecuritization } = tx.metadataJson;
    console.log('Saving vault updates', {
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

  public async startBitcoinLocking(args: { satoshis: bigint; tip?: bigint }): Promise<TransactionInfo> {
    const vault = this.createdVault;
    if (!vault) throw new Error('No vault created to lock bitcoin');

    return await this.#singleActiveBitcoinQueue.add(async () => {
      console.log('Saving vault bitcoin lock', { satoshis: args.satoshis, metadata: this.metadata! });
      const { txInfo } = await this.bitcoinLocks.initializeLock({
        ...args,
        vault,
      });

      const {
        bitcoin: { vaultId },
      } = txInfo.tx.metadataJson;
      if (vaultId !== this.createdVault?.vaultId) {
        throw new Error('Vault ID mismatch');
      }

      return txInfo;
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

    let treasuryMicrogons = this.data.treasury.heldPrincipal;
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

  public static getSecuritizationTarget(rules: IVaultingRules, existingFees: bigint = 0n) {
    const estimatedOperationalFees = existingFees + FEE_ESTIMATE;
    return bigIntMax(rules.baseMicrogonCommitment - estimatedOperationalFees - this.OperationalReserves, 0n);
  }
}

export type IMyVaultInspect = Pick<MyVault, 'vaultId' | 'load'>;
