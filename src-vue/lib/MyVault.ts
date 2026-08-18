import {
  ApiDecoration,
  ArgonClient,
  type ArgonPrimitivesVaultVaultArgonotCommitment,
  BitcoinLock,
  FIXED_U128_DECIMALS,
  hexToU8a,
  IBitcoinLock,
  type IArgonQueryable,
  ITxProgressCallback,
  MICROGONS_PER_ARGON,
  PalletVaultsVaultFrameRevenue,
  type Option,
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
import { BitcoinNetwork, CosignScript, getBitcoinNetworkFromApi, HDKey } from '@argonprotocol/bitcoin';
import { Db } from './Db.ts';
import { getFinalizedClient, getMainchainClient, getMainchainClients } from '../stores/mainchain.ts';
import {
  ArgonQueryClient,
  bigIntMax,
  BondLot,
  createDeferred,
  IBlockHeaderInfo,
  IDeferred,
  IVaultStats,
  isDefaultArgonMoveTo,
  minimumVaultDelegateBalance,
  MiningFrames,
  MoveFrom,
  MoveTo,
  NetworkConfig,
  type RuntimeSpec157,
  SingleFileQueue,
  TreasuryBonds,
  targetVaultDelegateBalance,
  vaultDelegateFeeBuffer,
} from '@argonprotocol/apps-core';
import { IVaultRecord, VaultsTable } from './db/VaultsTable.ts';
import { IVaultingRules } from '../interfaces/IVaultingRules.ts';
import { Vaults } from './Vaults.ts';
import BitcoinLocks from './BitcoinLocks.ts';
import { MyVaultRecovery } from './recovery/MyVaultRecovery.ts';
import { type IBitcoinLockRecord } from './db/BitcoinLocksTable.ts';
import { TransactionTracker, TxAttemptState } from './TransactionTracker.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { computeCollectDeadline } from './VaultDeadlineWatcher.ts';
import { WalletKeys } from './WalletKeys.ts';
import { GlobalCouncil } from './GlobalCouncil.ts';
import { MintingAuthorities } from './MintingAuthorities.ts';
import { Config } from './Config.ts';
import { ICollectOrphanCosignMetadata, IVaultCollectMetadata, VaultCollectBuilder } from './VaultCollectBuilder.ts';
import { getSpendableDefaultArgonMicrogons } from './WalletForArgon.ts';
import bs58check from 'bs58check';
import { VaultHistory } from './recovery/MyVault.ts';
import { isValidOperatorName, OPERATOR_NAME_REQUIREMENTS } from './Utils.ts';

export const DEFAULT_MASTER_XPUB_PATH = "m/84'/0'/0'";
const MINIMUM_BITCOIN_BASE_FEE = BigInt(MICROGONS_PER_ARGON);

type IPendingCosignUtxo = {
  targetValue: bigint;
  dueFrame?: number;
};

export interface IExternalBitcoinLock {
  utxoId: number;
  satoshis: bigint;
  liquidityPromised: bigint;
  isPending: boolean;
  isReleasing: boolean;
  lockDetails: IBitcoinLock;
}

export type IVaultInitialAllocateMetadata = {
  microgonsForSecuritization: bigint;
  vaultId: number;
};

export type IVaultIncreaseAllocationMetadata = {
  securitizationMicrogons?: bigint;
  committedMicronots?: bigint;
  addedSecuritizationMicrogons?: bigint;
  addedMicronots?: bigint;
  vaultId: number;
};

export type IVaultCommittedArgonotsMetadata = {
  committedMicronots: bigint;
  vaultId: number;
};

// These field names are persisted in transaction history from earlier app versions.
export type IVaultFlexibleAssetMetadata = {
  bitcoinChanges: {
    utxoId: number;
    isBackfill: boolean;
  }[];
  bondChanges: {
    bondLotId: number;
    isBackfill: boolean;
  }[];
};

export type IVaultFlexibleAssetChanges = {
  bitcoinChanges: {
    lock: Pick<
      BitcoinLock,
      'utxoId' | 'vaultId' | 'isFunded' | 'ownerAccount' | 'liquidityPromised' | 'getReleaseRequest'
    >;
    isFlexible: boolean;
  }[];
  bondChanges: {
    lot: Pick<BondLot, 'id' | 'vaultId' | 'accountId' | 'isOwn' | 'programType' | 'isReleasing'>;
    isFlexible: boolean;
  }[];
};

// Keep a submitted or recently reorged cosign attempt pending briefly before retrying it.
const COSIGN_ATTEMPT_CONFIRMATIONS_TO_WAIT = 2;

export class MyVault {
  public static async getVaultDelegateTopUpAmount(client: IArgonQueryable, delegateAddress: string): Promise<bigint> {
    const delegateBalance = await client.query.system.account(delegateAddress).then(x => x.data.free.toBigInt());
    if (delegateBalance >= minimumVaultDelegateBalance) {
      return 0n;
    }
    return targetVaultDelegateBalance - delegateBalance;
  }

  public static async isVaultDelegateReady(
    client: IArgonQueryable,
    vault: Pick<Vault, 'delegateAccountId'>,
    delegateAddress: string,
  ): Promise<boolean> {
    if (vault.delegateAccountId !== delegateAddress) return false;

    return (await MyVault.getVaultDelegateTopUpAmount(client, delegateAddress)) === 0n;
  }

  public data: {
    isReady: boolean;
    createdVault: Vault | null;
    metadata: IVaultRecord | null;
    stats: IVaultStats | null;
    argonotCommitment: {
      committedMicronots: bigint;
      encumberedMicronots: bigint;
    };
    pendingCollectRevenue: bigint;
    pendingCosignUtxosById: Map<number, IPendingCosignUtxo>;
    pendingOrphanCosignCount: number;
    releasedExternalUtxoIds: Set<number>;
    myPendingBitcoinCosignTxInfosByUtxoId: Map<number, TransactionInfo<{ utxoId: number }>>;
    nextCollectDueDate: number;
    nextCosignDueDate: number;
    expiringCollectAmount: bigint;
    finalizeMyBitcoinError?: { lockUtxoId: number; error: string };
    currentFrameId: number;
    pendingCollectTxInfo: TransactionInfo<IVaultCollectMetadata> | null;
    externalLocks: { [utxoId: number]: IExternalBitcoinLock };
    pendingAllocateTxInfo: TransactionInfo<IVaultIncreaseAllocationMetadata> | null;
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
  #isSubscribing = false;
  #transactionTracker: TransactionTracker;
  #configs?: {
    timeToCollectFrames: number;
  };
  #singleRunTransactions: Map<ExtrinsicType, Promise<TransactionInfo<unknown>>> = new Map();
  #vaultQueue = new SingleFileQueue();
  // Serialize cosign submissions (collect + individual cosign) and track in-flight intent per UTXO.
  #cosignQueue = new SingleFileQueue();
  #collectFrames: { frameId: number; uncollectedEarnings: bigint }[] = [];
  #finalizedBitcoinCosignUpdateSeq = 0;
  #pendingCosignUpdateSeq = 0;
  #externalLocksUpdateSeq = 0;
  public readonly collectBuilder: VaultCollectBuilder;
  public readonly history: VaultHistory;

  constructor(
    private readonly dbPromise: Promise<Db>,
    public readonly vaults: Vaults,
    public readonly walletKeys: WalletKeys,
    transactionTracker: TransactionTracker,
    public readonly bitcoinLocks: BitcoinLocks,
    private readonly miningFrames: MiningFrames,
    public readonly globalCouncil: GlobalCouncil,
    public readonly mintingAuthorities: MintingAuthorities,
  ) {
    this.data = {
      isReady: false,
      createdVault: null,
      metadata: null,
      stats: null,
      argonotCommitment: {
        committedMicronots: 0n,
        encumberedMicronots: 0n,
      },
      pendingCollectRevenue: 0n,
      pendingCollectTxInfo: null,
      pendingAllocateTxInfo: null,
      pendingCosignUtxosById: new Map(),
      pendingOrphanCosignCount: 0,
      myPendingBitcoinCosignTxInfosByUtxoId: new Map(),
      nextCollectDueDate: 0,
      nextCosignDueDate: 0,
      expiringCollectAmount: 0n,
      currentFrameId: 0,
      externalLocks: {},
      releasedExternalUtxoIds: new Set(),
    };
    this.vaults = vaults;
    this.#transactionTracker = transactionTracker;
    bitcoinLocks.myVault = this;
    this.collectBuilder = new VaultCollectBuilder(this);
    this.history = new VaultHistory(dbPromise, () => walletKeys.defaultArgonAddress);
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
    if (this.#waitForLoad?.isRunning) return this.#waitForLoad.promise;
    if (!reload && this.#waitForLoad?.isResolved) return this.#waitForLoad.promise;

    if (reload || this.#waitForLoad?.isRejected) {
      this.#waitForLoad = createDeferred();
    } else {
      this.#waitForLoad ??= createDeferred();
    }
    this.#collectFrames = [];
    try {
      console.log('Loading MyVault...');
      await this.miningFrames.load();
      await this.vaults.load(reload);

      const latestSyncedRevenueFrame = this.vaults.stats?.synchedToFrame ?? 0;
      if (latestSyncedRevenueFrame < this.miningFrames.currentFrameId - 1) {
        void this.vaults.updateRevenue().then(() => {
          const vaultId = this.metadata?.id;
          if (vaultId) {
            this.data.stats = this.vaults.stats?.vaultsById[vaultId] ?? null;
          }
        });
      }
      const table = await this.getTable();
      const client = await getMainchainClient(false);
      this.data.metadata = (await table.get()) ?? null;
      // prefetch the config
      const timeToCollectFrames = client.consts.vaults.revenueCollectionExpirationFrames.toNumber();
      this.#configs = {
        timeToCollectFrames,
      };

      await this.#transactionTracker.load();
      this.#singleRunTransactions.delete(ExtrinsicType.VaultSetBitcoinLockDelegate);

      for (const txInfo of this.#transactionTracker.pendingBlockTxInfosAtLoad) {
        const { tx } = txInfo;
        if (tx.extrinsicType === ExtrinsicType.VaultCreate) {
          void this.onVaultCreated(txInfo);
          this.#singleRunTransactions.set(tx.extrinsicType, Promise.resolve(txInfo));
        } else if (tx.extrinsicType === ExtrinsicType.VaultInitialAllocate) {
          void this.onInitialVaultAllocate(txInfo);
          this.#singleRunTransactions.set(tx.extrinsicType, Promise.resolve(txInfo));
        } else if (tx.extrinsicType === ExtrinsicType.VaultSetBitcoinLockDelegate) {
          this.#singleRunTransactions.set(tx.extrinsicType, Promise.resolve(txInfo));
        } else if (tx.extrinsicType === ExtrinsicType.VaultModifySettings) {
          void this.onModifySettings(txInfo);
        } else if (tx.extrinsicType === ExtrinsicType.VaultIncreaseAllocation) {
          void this.onIncreaseVaultSecuritization(txInfo);
        } else if (tx.extrinsicType === ExtrinsicType.VaultCosignBitcoinRelease) {
          void this.onCosignResult(txInfo);
        } else if (tx.extrinsicType === ExtrinsicType.VaultCosignOrphanedUtxoRelease) {
          void this.onOrphanCosignResult(txInfo);
        } else if (
          tx.extrinsicType === ExtrinsicType.VaultCollect ||
          tx.extrinsicType === ExtrinsicType.CrosschainTransferApproveCouncil
        ) {
          void this.onVaultCollect(txInfo).catch(error => {
            console.warn(`[MyVault] Unable to finish vault collect transaction #${txInfo.tx.id}`, error);
          });
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
      this.data.argonotCommitment = {
        committedMicronots: 0n,
        encumberedMicronots: 0n,
      };
      if (vaultId) {
        this.data.createdVault = this.vaults.vaultsById[vaultId];
        this.data.stats = this.vaults.stats?.vaultsById[vaultId] ?? null;
        this.updateArgonotCommitment(await client.query.vaults.argonotCommitmentByVaultId(vaultId));

        void this.refreshExternalLocks().catch(error => {
          console.warn('[MyVault] Error refreshing external locks during load', error);
        });
      }

      // Let the vault screen render once the core vault record is ready while bitcoin lock recovery finishes.
      this.data.isReady = true;

      const bitcoinLocksLoad = this.bitcoinLocks.load(reload);
      const globalCouncilLoad = this.globalCouncil.load(reload).catch(error => {
        console.error('[MyVault] Error loading global council data', error);
      });
      const mintingAuthoritiesLoad = this.mintingAuthorities.load(reload).catch(error => {
        console.error('[MyVault] Error loading minting authorities', error);
      });

      await bitcoinLocksLoad;
      await Promise.all([globalCouncilLoad, mintingAuthoritiesLoad]);

      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('[MyVault] Error loading vault data', error);
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  public getTxInfoByType(extrinsicType: ExtrinsicType): TransactionInfo<any> | undefined {
    return this.#transactionTracker.data.txInfosByType[extrinsicType];
  }

  public getCrosschainQueueTxInfos(): TransactionInfo[] {
    return this.#transactionTracker.data.txInfos.filter(({ tx }) => {
      if (
        tx.extrinsicType === ExtrinsicType.CrosschainTransferAuthorize ||
        tx.extrinsicType === ExtrinsicType.CrosschainTransferApproveCouncil
      ) {
        return true;
      }

      const metadata = tx.metadataJson as Partial<IVaultCollectMetadata>;
      return (
        tx.extrinsicType === ExtrinsicType.VaultCollect &&
        (metadata.actionType === 'approveCouncil' || (metadata.councilApprovalCount ?? 0) > 0)
      );
    });
  }

  public getBitcoinReleaseRequestTxInfo(utxoId: number): TransactionInfo<any> | undefined {
    return this.#transactionTracker.findLatestTxInfo<{ utxoId?: number }>(
      txInfo =>
        txInfo.tx.extrinsicType === ExtrinsicType.BitcoinRequestRelease && txInfo.tx.metadataJson.utxoId === utxoId,
    );
  }

  public async subscribe() {
    if (this.#isSubscribing || this.#subscriptions.length) return;
    this.#isSubscribing = true;

    try {
      if (!this.createdVault) {
        throw new Error('No vault created to subscribe to');
      }
      const vaultId = this.createdVault.vaultId;
      const clients = getMainchainClients();
      const client = await clients.get(false);
      const finalizedClient = await this.miningFrames.blockWatch.getFinalizedApi();
      await Promise.all([
        this.refreshFinalizedRevenueState(finalizedClient, vaultId),
        this.refreshFinalizedBitcoinCosignState(finalizedClient, vaultId),
      ]);

      // update stats live
      const sub = await client.query.vaults.vaultsById(vaultId, vault => {
        if (!vault.isSome) return;

        const raw = vault.unwrap();
        const nextVault = new Vault(vaultId, raw, NetworkConfig.tickMillis);
        this.vaults.vaultsById[vaultId] = nextVault;
        this.data.createdVault = nextVault;
      });

      const sub2 = await client.query.vaults.lastCollectFrameByVaultId(vaultId, () => {
        this.updateCollectDeadlines();
      });
      const sub3 = await client.query.vaults.argonotCommitmentByVaultId(vaultId, commitment => {
        this.updateArgonotCommitment(commitment);
      });

      const { unsubscribe: sub4 } = this.miningFrames.onFrameId(frameId => {
        this.data.currentFrameId = frameId;
        this.updateCollectDeadlines();
      });

      const sub5 = this.miningFrames.blockWatch.events.on('best-blocks', headers => {
        void this.refreshVaultBitcoinStateFromBlockEvents(headers).catch(x =>
          console.error(`Error updating vault Bitcoin state from block events`, x),
        );
      });

      const sub6 = this.miningFrames.blockWatch.events.on('finalized', async headers => {
        try {
          let latestBitcoinClient: ApiDecoration<'promise'> | undefined;
          let latestRevenueClient: ApiDecoration<'promise'> | undefined;
          for (const header of headers) {
            const { api, events } = await this.miningFrames.blockWatch.getEventsWithSpec(header);
            if (header.isNewFrame) latestRevenueClient = api;

            for (const { event } of events) {
              if (
                api.events.bitcoinLocks.BitcoinUtxoCosignRequested.is(event) ||
                api.events.bitcoinLocks.BitcoinUtxoCosigned.is(event) ||
                api.events.bitcoinLocks.BitcoinCosignPastDue.is(event) ||
                api.events.bitcoinLocks.OrphanedUtxoReleaseRequested.is(event) ||
                api.events.bitcoinLocks.OrphanedUtxoCosigned.is(event)
              ) {
                if (event.data.vaultId.toNumber() === vaultId) latestBitcoinClient = api;
                continue;
              }

              if (
                api.events.vaults.FundsLocked.is(event) ||
                api.events.vaults.VaultCollected.is(event) ||
                api.events.vaults.VaultRevenueUncollected.is(event)
              ) {
                if (event.data.vaultId.toNumber() === vaultId) latestRevenueClient = api;
              }
            }
          }

          const refreshes: Promise<void>[] = [];
          if (latestBitcoinClient) {
            refreshes.push(this.refreshFinalizedBitcoinCosignState(latestBitcoinClient, vaultId));
          }
          if (latestRevenueClient) {
            refreshes.push(this.refreshFinalizedRevenueState(latestRevenueClient, vaultId));
          }
          await Promise.all(refreshes);
        } catch (error) {
          console.error('Error updating finalized vault collect state', error);
        }
      });

      const sub7 = clients.events.on('on-pruned-client', () => {
        if (client.clientType === 'archive') {
          this.unsubscribe();
          void this.subscribe();
        }
      });
      client.on('disconnected', async () => {
        if (client.clientType === 'pruned') {
          this.unsubscribe();
          void this.subscribe();
        }
      });

      await Promise.all([this.globalCouncil.subscribe(), this.mintingAuthorities.subscribe()]);

      this.#subscriptions.push(sub, sub2, sub3, sub4, sub5, sub6, sub7);
    } finally {
      this.#isSubscribing = false;
    }
  }

  public async refreshFinalizedState(args: { client: ArgonQueryClient; currentFrameId: number }): Promise<void> {
    const vaultId = this.vaultId;
    const refreshes: Promise<unknown>[] = [];

    if (this.data.isReady && vaultId != null) {
      this.data.currentFrameId = args.currentFrameId;
      refreshes.push(
        this.refreshFinalizedBitcoinCosignState(args.client, vaultId),
        this.refreshFinalizedRevenueState(args.client, vaultId),
        this.refreshExternalLocks(args.client),
      );
    }
    if (this.globalCouncil.data.isReady) refreshes.push(this.globalCouncil.refresh(args.client));
    if (this.mintingAuthorities.data.isReady) refreshes.push(this.mintingAuthorities.refresh(args.client));

    await Promise.all(refreshes);
  }

  private updateArgonotCommitment(commitment: Option<ArgonPrimitivesVaultVaultArgonotCommitment>): void {
    if (commitment.isNone) {
      this.data.argonotCommitment = {
        committedMicronots: 0n,
        encumberedMicronots: 0n,
      };
      return;
    }

    const value = commitment.unwrap();
    this.data.argonotCommitment = {
      committedMicronots: value.committedMicronots.toBigInt(),
      encumberedMicronots: value.encumberedMicronots.toBigInt(),
    };
  }

  private async refreshFinalizedBitcoinCosignState(client: ArgonQueryClient, vaultId: number): Promise<void> {
    const updateSeq = ++this.#finalizedBitcoinCosignUpdateSeq;
    const [pendingCosignUtxos, orphanCosignEntries] = await Promise.all([
      client.query.vaults.pendingCosignByVaultId(vaultId),
      client.query.vaults.orphanedUtxoAccountsByVaultId.entries(vaultId),
    ]);
    if (updateSeq !== this.#finalizedBitcoinCosignUpdateSeq) return;

    await this.recordPendingCosignUtxos(pendingCosignUtxos, ++this.#pendingCosignUpdateSeq, client);
    if (updateSeq !== this.#finalizedBitcoinCosignUpdateSeq) return;

    this.data.pendingOrphanCosignCount = orphanCosignEntries.reduce((total, [, count]) => total + count.toNumber(), 0);
  }

  private async refreshFinalizedRevenueState(client: ArgonQueryClient, vaultId: number): Promise<void> {
    await this.updateRevenueStats(await client.query.vaults.revenuePerFrameByVault(vaultId));
    this.updateCollectDeadlines();
  }

  private async refreshVaultBitcoinStateFromBlockEvents(headers: IBlockHeaderInfo[]): Promise<void> {
    const vaultId = this.vaultId;
    if (vaultId == null) return;

    const typeClient = await getMainchainClient(false);
    const bitcoinLockEvents = typeClient.events.bitcoinLocks as
      | ArgonClient['events']['bitcoinLocks']
      | RuntimeSpec157.Events<'promise'>['bitcoinLocks'];
    const bitcoinLockFlexibilityChanged =
      'BitcoinLockFlexibleChanged' in bitcoinLockEvents
        ? bitcoinLockEvents.BitcoinLockFlexibleChanged
        : bitcoinLockEvents.BitcoinLockBackfillChanged;
    let latestApiClient: ApiDecoration<'promise'> | undefined;
    for (const header of headers) {
      const events = await this.miningFrames.blockWatch.getEvents(header);
      let shouldRefreshExternalLocks = false;
      for (const { event } of events) {
        if (
          typeClient.events.bitcoinLocks.BitcoinLockCreated.is(event) ||
          typeClient.events.bitcoinLocks.BitcoinLockRatcheted.is(event) ||
          typeClient.events.bitcoinLocks.UtxoFundedFromCandidate?.is(event) ||
          typeClient.events.bitcoinLocks.SecuritizationIncreased?.is(event) ||
          bitcoinLockFlexibilityChanged.is(event) ||
          typeClient.events.bitcoinLocks.BitcoinUtxoCosignRequested.is(event) ||
          typeClient.events.bitcoinLocks.BitcoinUtxoCosigned.is(event) ||
          typeClient.events.bitcoinLocks.BitcoinCosignPastDue.is(event) ||
          typeClient.events.bitcoinLocks.BitcoinLockBurned.is(event) ||
          typeClient.events.bitcoinLocks.BitcoinSpentAfterRelease?.is(event)
        ) {
          if (vaultId === event.data.vaultId.toNumber()) {
            shouldRefreshExternalLocks = true;
          }
        }
      }
      if (shouldRefreshExternalLocks) {
        latestApiClient = await this.miningFrames.clientAt(header);
      }
    }
    if (latestApiClient) {
      await this.refreshExternalLocks(latestApiClient);
    }
  }

  private updateCollectDeadlines() {
    const cosignDueFrames = [...this.data.pendingCosignUtxosById.values()].map(x => x.dueFrame);
    const { nextCollectFrame, nextCosignFrame, expiringCollectAmount } = computeCollectDeadline({
      collectFrames: this.#collectFrames,
      cosignDueFrames,
      currentFrameId: this.data.currentFrameId,
      timeToCollectFrames: this.#configs!.timeToCollectFrames,
    });
    this.data.expiringCollectAmount = expiringCollectAmount;
    this.data.nextCollectDueDate = this.miningFrames.getFrameDate(nextCollectFrame).getTime();
    this.data.nextCosignDueDate = nextCosignFrame ? this.miningFrames.getFrameDate(nextCosignFrame).getTime() : 0;
  }

  private async recordPendingCosignUtxos(rawUtxoIds: Iterable<u64>, updateSeq: number, client: ArgonQueryClient) {
    const previousPendingCosignsById = new Map(this.data.pendingCosignUtxosById);
    const pendingCosignUtxosById = new Map<number, IPendingCosignUtxo>();
    for (const utxoId of rawUtxoIds) {
      const id = utxoId.toNumber();
      const lock = await BitcoinLock.get(client, id);
      const previousPending = previousPendingCosignsById.get(id);
      const pendingReleaseRaw = await client.query.bitcoinLocks.lockReleaseRequestsByUtxoId(id);
      const dueFrame = pendingReleaseRaw.isSome
        ? pendingReleaseRaw.unwrap().cosignDueFrame.toNumber()
        : previousPending?.dueFrame;
      const targetValue = lock?.lockedTargetPrice ?? previousPending?.targetValue ?? 0n;
      pendingCosignUtxosById.set(id, { targetValue, dueFrame });
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
    this.updateCollectDeadlines();
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

  public async setVaultName(vaultName?: string | null): Promise<TransactionInfo | undefined> {
    if (!this.createdVault) return;

    const currentVaultName = this.createdVault.name;
    const nextVaultName = vaultName?.trim();
    if (!nextVaultName) {
      throw new Error('A vault name is required to enable member invites.');
    }
    if (!isValidOperatorName(nextVaultName)) {
      throw new Error(OPERATOR_NAME_REQUIREMENTS);
    }
    if (currentVaultName === nextVaultName) {
      return;
    }

    return await this.#vaultQueue.add(async () => {
      const client = await getMainchainClient(false);
      const txSigner = await this.walletKeys.getVaultingKeypair();
      const txInfo = await this.#transactionTracker.submitAndWatch({
        tx: this.buildOperatorNameTx(client, nextVaultName),
        txSigner,
        extrinsicType: ExtrinsicType.VaultModifySettings,
        metadata: {
          vaultId: this.createdVault!.vaultId,
          vaultName: nextVaultName,
        },
      });
      void this.onModifySettings(txInfo);
      return txInfo;
    }).promise;
  }

  public async setupVaultInviteProfile(args: {
    operatorName: string;
    currentOperatorName?: string;
  }): Promise<TransactionInfo | undefined> {
    if (!this.createdVault) return;

    const operatorName = args.operatorName.trim();
    if (!operatorName) {
      throw new Error('A vault name is required to enable member invites.');
    }
    if (!isValidOperatorName(operatorName)) {
      throw new Error(OPERATOR_NAME_REQUIREMENTS);
    }

    return await this.#vaultQueue.add(async () => {
      const delegateAddress = await this.walletKeys.getVaultDelegateKeypair().then(x => x.address);
      const vaultId = this.createdVault!.vaultId;
      const pendingAttempt = await this.#transactionTracker.findLatestTxAttempt<{
        vaultId?: number;
        delegateAddress?: string;
        vaultName?: string;
      }>({
        extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
        waitForConfirmations: 2,
        matches: txInfo => {
          return (
            txInfo.tx.metadataJson.vaultId === vaultId &&
            txInfo.tx.metadataJson.delegateAddress === delegateAddress &&
            txInfo.tx.metadataJson.vaultName === operatorName
          );
        },
      });
      if (pendingAttempt?.txAttemptState === TxAttemptState.Pending) {
        return pendingAttempt.txInfo;
      }
      if (pendingAttempt) {
        this.#singleRunTransactions.delete(ExtrinsicType.VaultSetBitcoinLockDelegate);
      }

      const existing = this.#singleRunTransactions.get(ExtrinsicType.VaultSetBitcoinLockDelegate);
      if (existing) {
        return await existing;
      }

      const client = await getMainchainClient(false);
      const { txs } = await this.buildVaultDelegateSetupTxs({
        client,
        delegateAddress,
      });
      const currentOperatorName = args.currentOperatorName ?? this.createdVault?.name;
      if (currentOperatorName?.trim() !== operatorName) {
        txs.push(this.buildOperatorNameTx(client, operatorName));
      }
      if (!txs.length) return;

      const deferred = createDeferred<TransactionInfo>();
      this.#singleRunTransactions.set(ExtrinsicType.VaultSetBitcoinLockDelegate, deferred.promise);

      try {
        const txSigner = await this.walletKeys.getVaultingKeypair();
        const txInfo = await this.#transactionTracker.submitAndWatch({
          tx: client.tx.utility.batchAll(txs),
          txSigner,
          extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
          metadata: {
            vaultId,
            delegateAddress,
            vaultName: operatorName,
          },
        });
        deferred.resolve(txInfo);
      } catch (error) {
        deferred.reject(error as Error);
        this.#singleRunTransactions.delete(ExtrinsicType.VaultSetBitcoinLockDelegate);
      }

      return await deferred.promise;
    }).promise;
  }

  public async setFlexibleAssets({
    bitcoinChanges,
    bondChanges,
    client,
  }: IVaultFlexibleAssetChanges & { client?: ArgonClient }): Promise<TransactionInfo<IVaultFlexibleAssetMetadata>> {
    const vault = this.createdVault;
    if (!vault) {
      throw new Error('Create your vault before managing flexible assets.');
    }
    if (!bitcoinChanges.length && !bondChanges.length) {
      throw new Error('Select at least one flexible asset change.');
    }

    client ??= await getMainchainClient(false);
    const signer = await this.walletKeys.getVaultingKeypair();
    const txs = await this.buildFlexibleAssetTxs({
      bitcoinChanges,
      bondChanges,
      client,
      signerAddress: signer.address,
    });

    return await this.#transactionTracker.submitAndWatch({
      tx: txs.length === 1 ? txs[0] : client.tx.utility.batchAll(txs),
      txSigner: signer,
      extrinsicType: ExtrinsicType.VaultSetFlexibleAssets,
      metadata: serializeFlexibleAssetMetadata({ bitcoinChanges, bondChanges }),
    });
  }

  public async prepareMemberInvite({
    vaultName,
    bitcoinChanges,
    bondChanges,
  }: IVaultFlexibleAssetChanges & { vaultName: string }): Promise<
    TransactionInfo<IVaultFlexibleAssetMetadata> | undefined
  > {
    const vault = this.createdVault;
    if (!vault) {
      throw new Error('Create your vault before sending member invites.');
    }

    const nextVaultName = vaultName.trim();
    if (!nextVaultName) {
      throw new Error('A vault name is required to enable member invites.');
    }
    if (!isValidOperatorName(nextVaultName)) {
      throw new Error(OPERATOR_NAME_REQUIREMENTS);
    }

    return await this.#vaultQueue.add(async () => {
      const client = await getMainchainClient(false);
      const signer = await this.walletKeys.getVaultingKeypair();
      const delegateAddress = await this.walletKeys.getVaultDelegateKeypair().then(x => x.address);
      const { txs } = await this.buildVaultDelegateSetupTxs({ client, delegateAddress });

      if (vault.name !== nextVaultName) {
        txs.push(this.buildOperatorNameTx(client, nextVaultName));
      }

      txs.push(
        ...(await this.buildFlexibleAssetTxs({
          bitcoinChanges,
          bondChanges,
          client,
          signerAddress: signer.address,
        })),
      );

      if (!txs.length) return;

      return await this.#transactionTracker.submitAndWatch({
        tx: txs.length === 1 ? txs[0] : client.tx.utility.batchAll(txs),
        txSigner: signer,
        extrinsicType: ExtrinsicType.VaultSetFlexibleAssets,
        metadata: serializeFlexibleAssetMetadata({ bitcoinChanges, bondChanges }),
      });
    }).promise;
  }

  // The shared vault delegate fronts both bitcoin lock and Ethereum proof relay submissions.
  public async ensureVaultDelegateReady(): Promise<TransactionInfo | undefined> {
    if (!this.createdVault) return;

    const client = await getMainchainClient(false);
    const delegateAddress = await this.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    const vaultId = this.createdVault.vaultId;

    return await this.#vaultQueue.add(async () => {
      const { needsSetup, txs } = await this.buildVaultDelegateSetupTxs({
        client,
        delegateAddress,
      });
      if (!txs.length) {
        return;
      }

      const extrinsicType = needsSetup
        ? ExtrinsicType.VaultSetBitcoinLockDelegate
        : ExtrinsicType.VaultTopUpBitcoinLockDelegate;
      const pendingAttempt = await this.#transactionTracker.findLatestTxAttempt<{
        vaultId?: number;
        delegateAddress?: string;
      }>({
        extrinsicType,
        waitForConfirmations: 2,
        matches: txInfo => {
          return (
            txInfo.tx.metadataJson.vaultId === vaultId && txInfo.tx.metadataJson.delegateAddress === delegateAddress
          );
        },
      });
      if (pendingAttempt?.txAttemptState === TxAttemptState.Pending) {
        return pendingAttempt.txInfo;
      }
      if (pendingAttempt) {
        this.#singleRunTransactions.delete(extrinsicType);
      }

      if (needsSetup) {
        const existing = this.#singleRunTransactions.get(ExtrinsicType.VaultSetBitcoinLockDelegate);
        if (existing) {
          return await existing;
        }

        const deferred = createDeferred<TransactionInfo>();
        this.#singleRunTransactions.set(ExtrinsicType.VaultSetBitcoinLockDelegate, deferred.promise);

        try {
          const txSigner = await this.walletKeys.getVaultingKeypair();
          const txInfo = await this.#transactionTracker.submitAndWatch({
            tx: txs.length === 1 ? txs[0] : client.tx.utility.batchAll(txs),
            txSigner,
            extrinsicType: ExtrinsicType.VaultSetBitcoinLockDelegate,
            metadata: {
              vaultId,
              delegateAddress,
            },
          });
          deferred.resolve(txInfo);
        } catch (error) {
          deferred.reject(error as Error);
          this.#singleRunTransactions.delete(ExtrinsicType.VaultSetBitcoinLockDelegate);
        }

        return await deferred.promise;
      }

      const txSigner = await this.walletKeys.getVaultingKeypair();
      return await this.#transactionTracker.submitAndWatch({
        tx: txs[0],
        txSigner,
        extrinsicType: ExtrinsicType.VaultTopUpBitcoinLockDelegate,
        metadata: {
          vaultId,
          delegateAddress,
        },
      });
    }).promise;
  }

  public async setCommittedArgonots(
    committedMicronots: bigint,
  ): Promise<TransactionInfo<IVaultCommittedArgonotsMetadata>> {
    if (!this.createdVault) {
      throw new Error('Create your vault before setting an Argonot commitment.');
    }

    const vaultId = this.createdVault.vaultId;
    return await this.#vaultQueue.add(async () => {
      const client = await getMainchainClient(false);
      const txSigner = await this.walletKeys.getVaultingKeypair();

      return await this.#transactionTracker.submitAndWatch({
        tx: client.tx.vaults.setCommittedArgonots(committedMicronots),
        txSigner,
        extrinsicType: ExtrinsicType.VaultSetCommittedArgonots,
        metadata: {
          vaultId,
          committedMicronots,
        },
        useLatestNonce: true,
      });
    }).promise;
  }

  public async buildCosignTx(args: {
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
        (latestTxAttempt.txAttemptState === TxAttemptState.Pending ||
          latestTxAttempt.txAttemptState === TxAttemptState.Finalized)
      ) {
        return { txInfo: latestTxAttempt.txInfo, vaultSignature: cosignResult.vaultSignature };
      }
      this.data.releasedExternalUtxoIds.add(utxoId);

      const { tx, vaultSignature } = cosignResult;
      const followOnTx =
        latestTxAttempt?.txInfo && !latestTxAttempt.txInfo.tx.followOnTxId
          ? this.#transactionTracker.createIntentForFollowOnTx(latestTxAttempt.txInfo)
          : undefined;

      try {
        const txSigner = await this.walletKeys.getVaultingKeypair();
        const txInfo = await this.#transactionTracker.submitAndWatch({
          tx,
          txSigner,
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
        (latestTxAttempt.txAttemptState === TxAttemptState.Pending ||
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
        const txSigner = await this.walletKeys.getVaultingKeypair();
        const txInfo = await this.#transactionTracker.submitAndWatch({
          tx,
          txSigner,
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
    } catch (error) {
      postProcessor.reject(error as Error);
      throw error;
    } finally {
      if (this.data.myPendingBitcoinCosignTxInfosByUtxoId.get(utxoId)?.tx.id === txInfo.tx.id) {
        this.data.myPendingBitcoinCosignTxInfosByUtxoId.delete(utxoId);
      }
    }
  }

  private async onOrphanCosignResult(
    txInfo: TransactionInfo<{ lockUtxoId: number; ownerAccount: string; txid: string; vout: number }>,
  ): Promise<void> {
    const { txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    try {
      await txResult.waitForFinalizedBlock;
      await this.trackTxResultFee(txResult);
      postProcessor.resolve();
    } catch (error) {
      postProcessor.reject(error as Error);
      throw error;
    }
  }

  public async collect(afterCollect: { moveTo: MoveTo }): Promise<TransactionInfo | undefined> {
    return await this.#cosignQueue.add(async () => {
      if (this.data.pendingCollectTxInfo) {
        if (!this.data.pendingCollectTxInfo.isPostProcessed) {
          return this.data.pendingCollectTxInfo;
        }
        this.data.pendingCollectTxInfo = null;
      }
      if (!this.createdVault) {
        throw new Error('No vault created to collect revenue');
      }
      if (!this.metadata) {
        throw new Error('No metadata available to collect revenue');
      }
      const finalizedClient = await getFinalizedClient();
      const client = await getMainchainClient(false);
      const submission = await this.collectBuilder.buildPendingSubmission({
        client,
        finalizedClient,
        moveTo: afterCollect.moveTo,
      });

      if (!submission) {
        const vaultId = this.createdVault.vaultId;
        const [bitcoinCosignResult, revenueResult] = await Promise.allSettled([
          this.refreshFinalizedBitcoinCosignState(finalizedClient, vaultId),
          this.refreshFinalizedRevenueState(finalizedClient, vaultId),
        ]);

        if (bitcoinCosignResult.status === 'rejected') {
          console.warn(
            '[MyVault] Unable to refresh finalized Bitcoin cosign state after no-op collect',
            bitcoinCosignResult.reason,
          );
        }

        if (revenueResult.status === 'rejected') {
          console.warn('[MyVault] Unable to refresh finalized revenue state after no-op collect', revenueResult.reason);
        }
        return;
      }

      const txSigner = await this.walletKeys.getVaultingKeypair();
      const txInfo = await this.#transactionTracker.submitAndWatch({
        tx: submission.tx,
        txSigner,
        extrinsicType:
          submission.metadata.actionType === 'approveCouncil'
            ? ExtrinsicType.CrosschainTransferApproveCouncil
            : ExtrinsicType.VaultCollect,
        metadata: submission.metadata,
        useLatestNonce: true,
      });

      for (const utxoId of submission.submittedCosignUtxoIds) {
        this.data.releasedExternalUtxoIds.add(utxoId);
      }

      void this.onVaultCollect(txInfo).catch(() => undefined);

      return txInfo;
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
        COSIGN_ATTEMPT_CONFIRMATIONS_TO_WAIT,
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
        COSIGN_ATTEMPT_CONFIRMATIONS_TO_WAIT,
      ),
    };
  }

  public async buildPendingOrphanCosignTxs(args: {
    finalizedClient: ArgonQueryClient;
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
          (latestTxAttempt.txAttemptState === TxAttemptState.Pending ||
            latestTxAttempt.txAttemptState === TxAttemptState.Finalized)
        ) {
          continue;
        }
        queued.add(key);

        // The orphan is written during this block, so recover its lock from the pre-orphan state.
        const blockNumber = orphan.recordedArgonBlockNumber.toNumber() - 1;
        const apiNode = await this.miningFrames.blockWatch.getRpcClient(blockNumber);
        const blockHash = await apiNode.rpc.chain.getBlockHash(blockNumber);
        const apiClient = await apiNode.at(blockHash);

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

  public async recordFinalizedVaultCapital(txInfo: TransactionInfo): Promise<void> {
    try {
      const finalizedBlockHash = await txInfo.txResult.waitForFinalizedBlock;
      const vaultId = this.vaultId;
      if (vaultId === undefined) return;

      const client = await getMainchainClient(true);
      const api = await client.at(finalizedBlockHash);
      const [vault, argonotCommitment, blockNumber] = await Promise.all([
        Vault.get(api, vaultId),
        api.query.vaults.argonotCommitmentByVaultId(vaultId),
        api.query.system.number(),
      ]);
      this.vaults.vaultsById[vaultId] = vault;
      this.data.createdVault = vault;
      this.updateArgonotCommitment(argonotCommitment);

      const block = await this.miningFrames.blockWatch.getHeader(blockNumber.toNumber());
      const db = await this.dbPromise;
      await db.vaultCapitalHistoryTable.insert({
        eventType: 'modified',
        walletAddress: this.walletKeys.defaultArgonAddress,
        vaultId,
        securitization: vault.securitization,
        securitizationTarget: bigIntMax(vault.securitization - vault.getRelockCapacity(), 0n),
        blockNumber: blockNumber.toNumber(),
        blockHash: u8aToHex(finalizedBlockHash),
        blockTime: new Date(block.blockTime),
        extrinsicIndex: txInfo.tx.blockExtrinsicIndex ?? txInfo.txResult.extrinsicIndex,
      });
    } catch (error) {
      console.warn('Unable to save finalized vault capital history', error);
    }
  }

  public async onVaultCollect(txInfo: TransactionInfo<IVaultCollectMetadata>): Promise<void> {
    this.data.pendingCollectTxInfo = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    const { vaultId } = txInfo.tx.metadataJson;

    try {
      const { txResult } = txInfo;
      const client = await getMainchainClient(false);
      const finalizedBlockHash = await txResult.waitForFinalizedBlock;
      await this.trackTxResultFee(txResult);
      await this.#transactionTracker.ensureStoredEvents(txInfo);
      const collectedEvent = txResult.events.find(event => {
        return client.events.vaults.VaultCollected.is(event) && event.data.vaultId.toNumber() === vaultId;
      });
      const revenue =
        collectedEvent && client.events.vaults.VaultCollected.is(collectedEvent)
          ? collectedEvent.data.revenue.toBigInt()
          : undefined;
      if (revenue !== undefined) {
        try {
          const blockNumber = txResult.blockNumber ?? txInfo.tx.blockHeight;
          if (blockNumber === undefined) throw new Error('Finalized vault collect is missing its block number');

          const [db, block] = await Promise.all([this.dbPromise, this.miningFrames.blockWatch.getHeader(blockNumber)]);
          await db.vaultRevenueEventsTable.insert({
            amount: revenue,
            source: 'vaultCollect',
            blockNumber,
            blockHash: u8aToHex(finalizedBlockHash),
            blockTime: new Date(block.blockTime),
            extrinsicIndex: txInfo.tx.blockExtrinsicIndex ?? txResult.extrinsicIndex,
          });
        } catch (error) {
          console.warn('Unable to save finalized vault revenue history', error);
        }
      }

      if (isDefaultArgonMoveTo(txInfo.tx.metadataJson.moveTo) && revenue && revenue > 0n) {
        const txSigner = await this.walletKeys.getVaultingKeypair();
        const followOnTx = this.#transactionTracker.createIntentForFollowOnTx(txInfo);
        try {
          const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
          const clientAt = await client.at(blockHash);
          const balanceAtBlock = await clientAt.query.system
            .account(this.walletKeys.vaultingAddress)
            .then(x => x.data.free.toBigInt());

          // Make sure the collect amount doesn't drain the account below operational reserves
          const maxAmountToMove = getSpendableDefaultArgonMicrogons(balanceAtBlock);
          if (maxAmountToMove < 50_000n) {
            throw new Error('The amount requested to move is too low after accounting for operational reserves.');
          }
          let amountToMove = revenue;
          if (amountToMove > maxAmountToMove) {
            amountToMove = maxAmountToMove;
          }

          const transferTxInfo = await this.#transactionTracker.submitAndWatch({
            tx: client.tx.balances.transferKeepAlive(this.walletKeys.defaultArgonAddress, amountToMove),
            txSigner,
            extrinsicType: ExtrinsicType.Transfer,
            metadata: {
              moveFrom: MoveFrom.DefaultArgon,
              moveTo: txInfo.tx.metadataJson.moveTo,
              amount: amountToMove,
            },
            useLatestNonce: true,
          });
          followOnTx.resolve(transferTxInfo);
        } catch (error) {
          followOnTx.reject(error);
          throw error;
        }
      }

      const finalizedClient = await getFinalizedClient();
      const frameRevenues = await finalizedClient.query.vaults.revenuePerFrameByVault(vaultId);
      await Promise.all([
        this.updateRevenueStats(frameRevenues),
        this.globalCouncil.refresh(finalizedClient),
        this.mintingAuthorities.refresh(finalizedClient),
      ]);

      postProcessor.resolve();
    } catch (error) {
      postProcessor.reject(error as Error);
      throw error;
    } finally {
      if (this.data.pendingCollectTxInfo?.tx.id === txInfo.tx.id) {
        this.data.pendingCollectTxInfo = null;
      }
    }
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
      const { masterXpubPath, rules } = args;
      const txSigner = await this.walletKeys.getVaultingKeypair();
      console.log('Creating a vault with address', txSigner.address);
      const vaultXpriv = await this.getVaultXpriv(masterXpubPath);
      const masterXpub = vaultXpriv.publicExtendedKey;
      const delegateAddress = await this.walletKeys.getVaultDelegateKeypair().then(x => x.address);
      const client = await getMainchainClient(false);
      if (rules.securitizationRatio < 1 || rules.securitizationRatio > 2) {
        throw new Error('Securitization ratio must be between 1 and 2');
      }
      if (BigInt(rules.btcFlatFee) < MINIMUM_BITCOIN_BASE_FEE) {
        throw new Error('The Bitcoin base fee must be at least ₳1.00.');
      }

      let bitcoinXpubkey = hexToU8a(masterXpub);
      if (bitcoinXpubkey.length !== 78) {
        bitcoinXpubkey = bs58check.decode(masterXpub);
      }
      if (bitcoinXpubkey.length !== 78) {
        throw new Error('Invalid Bitcoin xpub key length, must be 78 bytes');
      }

      const vaultParams = {
        terms: {
          bitcoinAnnualPercentRate: toFixedNumber(rules.btcPctFee / 100, FIXED_U128_DECIMALS),
          bitcoinBaseFee: BigInt(rules.btcFlatFee),
          treasuryProfitSharing: toFixedNumber(rules.profitSharingPct / 100, PERMILL_DECIMALS),
          treasuryBonusProfitSharing: toFixedNumber(0, PERMILL_DECIMALS),
        },
        securitizationRatio: toFixedNumber(rules.securitizationRatio, FIXED_U128_DECIMALS),
        securitization: MyVault.getSecuritizationTarget(rules),
        bitcoinXpubkey,
        delegateAccountId: delegateAddress,
      };

      const txs: SubmittableExtrinsic[] = [];
      txs.push(client.tx.vaults.create(vaultParams));
      const delegateTopUpAmount = await MyVault.getVaultDelegateTopUpAmount(client, delegateAddress);
      if (delegateTopUpAmount) {
        txs.push(client.tx.balances.transferKeepAlive(delegateAddress, delegateTopUpAmount));
      }
      const registerCouncilSignerTx = await this.globalCouncil.buildRegisterCouncilSignerTx(client);
      if (registerCouncilSignerTx) txs.push(registerCouncilSignerTx);
      const tx = txs.length === 1 ? txs[0] : client.tx.utility.batch(txs);
      const txResult = await new TxSubmitter(client, tx, txSigner).submit({
        useLatestNonce: true,
      });
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
    try {
      const client = await getMainchainClient(true);
      const finalizedBlockHash = await txResult.waitForFinalizedBlock;
      await this.#transactionTracker.ensureStoredEvents(txInfo);
      const api = await client.at(finalizedBlockHash);
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
      const vault = await Vault.get(api, vaultId);
      await this.recordVault({
        vault,
        createBlockNumber: blockNumber.toNumber(),
        txFee: txResult.finalFee ?? 0n,
        masterXpubPath: tx.metadataJson.masterXpubPath,
      });

      try {
        const block = await this.miningFrames.blockWatch.getHeader(blockNumber.toNumber());
        const db = await this.dbPromise;
        await db.vaultCapitalHistoryTable.insert({
          eventType: 'created',
          walletAddress: this.walletKeys.defaultArgonAddress,
          vaultId,
          securitization: vault.securitization,
          blockNumber: blockNumber.toNumber(),
          blockHash: u8aToHex(finalizedBlockHash),
          blockTime: new Date(block.blockTime),
          extrinsicIndex: tx.blockExtrinsicIndex ?? txResult.extrinsicIndex,
        });
      } catch (error) {
        console.warn('Unable to save finalized vault creation history', error);
      }
      postProcessor.resolve();
      return vault;
    } catch (error) {
      postProcessor.reject(error as Error);
      throw error;
    }
  }

  private async buildVaultDelegateSetupTxs(args: { client: ArgonClient; delegateAddress: string }): Promise<{
    needsSetup: boolean;
    txs: SubmittableExtrinsic[];
  }> {
    const txs: SubmittableExtrinsic[] = [];
    const needsDelegateSetup = this.createdVault?.delegateAccountId !== args.delegateAddress;
    const amountToFund = await MyVault.getVaultDelegateTopUpAmount(args.client, args.delegateAddress);

    if (needsDelegateSetup) {
      const vaultBalance = await args.client.query.system
        .account(this.createdVault!.operatorAccountId)
        .then(x => x.data.free.toBigInt());
      if (vaultBalance < amountToFund + vaultDelegateFeeBuffer) {
        throw new Error(
          `Your Argon wallet must have a minimum of ${amountToFund + vaultDelegateFeeBuffer} balance to activate the vault delegate.`,
        );
      }

      if (amountToFund) {
        txs.push(args.client.tx.balances.transferKeepAlive(args.delegateAddress, amountToFund));
      }
      txs.push(args.client.tx.vaults.setDelegateAccount(args.delegateAddress));
    } else if (amountToFund) {
      txs.push(args.client.tx.balances.transferKeepAlive(args.delegateAddress, amountToFund));
    }

    const registerCouncilSignerTx = await this.globalCouncil.buildRegisterCouncilSignerTx(args.client);
    if (registerCouncilSignerTx) {
      txs.push(registerCouncilSignerTx);
    }

    return {
      needsSetup: needsDelegateSetup || !!registerCouncilSignerTx,
      txs,
    };
  }

  private buildOperatorNameTx(client: ArgonClient, name: string): SubmittableExtrinsic {
    const vaults = client.tx.vaults as ArgonClient['tx']['vaults'] | RuntimeSpec157.Transactions<'promise'>['vaults'];
    if ('setName' in vaults) {
      return vaults.setName(name);
    }

    return client.tx.operationalAccounts.setName(name);
  }

  private async buildFlexibleAssetTxs({
    bitcoinChanges,
    bondChanges,
    client,
    signerAddress,
  }: IVaultFlexibleAssetChanges & { client: ArgonClient; signerAddress: string }): Promise<SubmittableExtrinsic[]> {
    const vault = this.createdVault!;
    if (!bitcoinChanges.length && !bondChanges.length) return [];

    for (const { lock } of bitcoinChanges) {
      if (!lock.isFunded || lock.vaultId !== vault.vaultId || (await lock.getReleaseRequest(client))) {
        throw new Error('This Bitcoin lock is no longer eligible to be flexible.');
      }
      if (lock.ownerAccount !== signerAddress) {
        throw new Error('Only the Bitcoin lock owner can change its flexible status.');
      }
    }

    for (const { lot } of bondChanges) {
      if (!lot.isOwn || lot.programType !== 'Vault' || lot.vaultId !== vault.vaultId || lot.isReleasing) {
        throw new Error('This bond lot is no longer eligible to be flexible.');
      }
      if (lot.accountId !== signerAddress) {
        throw new Error('Only the bond lot owner can change its flexible status.');
      }
    }

    const txs: SubmittableExtrinsic[] = [];
    const bitcoinLocks = client.tx.bitcoinLocks as
      | ArgonClient['tx']['bitcoinLocks']
      | RuntimeSpec157.Transactions<'promise'>['bitcoinLocks'];
    const treasury = client.tx.treasury as
      | ArgonClient['tx']['treasury']
      | RuntimeSpec157.Transactions<'promise'>['treasury'];
    const setBitcoinFlexible = 'setFlexible' in bitcoinLocks ? bitcoinLocks.setFlexible : bitcoinLocks.setAsBackfill;
    const setBondLotFlexible =
      'setBondLotFlexible' in treasury ? treasury.setBondLotFlexible : treasury.setBondLotAsBackfill;

    for (const isFlexible of [true, false]) {
      for (const change of bitcoinChanges.filter(candidate => candidate.isFlexible === isFlexible)) {
        txs.push(setBitcoinFlexible(change.lock.utxoId, isFlexible));
      }
      for (const change of bondChanges.filter(candidate => candidate.isFlexible === isFlexible)) {
        txs.push(setBondLotFlexible(change.lot.id, isFlexible));
      }
    }

    return txs;
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
    this.globalCouncil.unsubscribe();
    this.mintingAuthorities.unsubscribe();
  }

  public async refreshExternalLocks(clientArg?: ArgonQueryClient): Promise<void> {
    const vaultId = this.vaultId;
    if (vaultId == null) return;
    const updateSeq = ++this.#externalLocksUpdateSeq;

    const client = clientArg ?? (await getMainchainClient(false));

    const utxoIds = await client.query.bitcoinLocks.utxoIdsByVaultId
      .keys(vaultId)
      .then(keys => keys.map(key => key.args[1].toNumber()));

    const next: { [utxoId: number]: IExternalBitcoinLock } = {};
    for (const utxoId of utxoIds) {
      if (this.data.releasedExternalUtxoIds.has(utxoId)) {
        continue;
      }
      if (!!this.bitcoinLocks.data.locksByUtxoId[utxoId]) {
        continue;
      }
      const starting = this.data.externalLocks[utxoId];
      if (starting && !starting.isPending) {
        next[utxoId] = starting;
        next[utxoId].isReleasing = this.data.pendingCosignUtxosById.has(utxoId);
        continue;
      }
      const lock = await BitcoinLock.get(client, utxoId);
      if (!lock) {
        continue;
      }
      if (lock.ownerAccount === this.walletKeys.vaultingAddress) {
        continue;
      }
      next[utxoId] = {
        utxoId,
        satoshis: lock.satoshis,
        liquidityPromised: lock.liquidityPromised,
        isPending: !lock.isFunded,
        isReleasing: this.data.pendingCosignUtxosById.has(utxoId),
        lockDetails: lock,
      };
    }

    if (updateSeq !== this.#externalLocksUpdateSeq) {
      return;
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
      capitalDeployed.push(change.securitization + change.treasuryPool.vaultCapital);
    }

    const averageCapitalDeployed = capitalDeployed.length
      ? capitalDeployed.reduce((acc, val) => acc + val, 0n) / BigInt(capitalDeployed.length)
      : 0n;
    const activeFrames = this.data.currentFrameId - startingFrame;
    return { earnings, activeFrames, averageCapitalDeployed };
  }

  public async recordVault(data: {
    vault: Vault;
    createBlockNumber: number;
    txFee: bigint;
    masterXpubPath: string;
  }): Promise<void> {
    const { vault, createBlockNumber, masterXpubPath, txFee } = data;
    const table = await this.getTable();
    this.data.metadata = await table.insert({
      id: vault.vaultId,
      hdPath: masterXpubPath,
      createdAtBlockHeight: createBlockNumber,
      operationalFeeMicrogons: txFee,
      isClosed: false,
    });
    this.data.createdVault = vault;
    this.vaults.vaultsById[vault.vaultId] = vault;
  }

  public async recoverAccountVault(args: {
    onProgress: (progress: number) => void;
  }): Promise<IVaultingRules | undefined> {
    const { onProgress } = args;
    onProgress(0);
    const vaultingAddress = this.walletKeys.vaultingAddress;
    console.log('Recovering vault for address', vaultingAddress);
    const mainchainClients = getMainchainClients();

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
    if (hasSecuritization) {
      const activeBitcoins = await this.bitcoinLocks.recovery.recoverActiveLocks();
      bitcoin = activeBitcoins.find(record => record.vaultId === vault.vaultId);
    }

    const client = await getMainchainClient(false);
    const finalizedClient = await getFinalizedClient();
    await Promise.all([
      this.globalCouncil.refresh(finalizedClient),
      this.mintingAuthorities.restoreSignerIndexes(finalizedClient),
    ]);

    const table = await this.getTable();
    await table.save(this.metadata!);
    onProgress(90);
    await this.load(true);
    const treasuryBondLots = await TreasuryBonds.getBondLots(client, vault.vaultId, vault.operatorAccountId);

    const rules = MyVaultRecovery.rebuildRules({
      feesInMicrogons: foundVault.txFee ?? 0n,
      vault,
      bitcoin,
      treasuryMicrogons: BondLot.getTotals(treasuryBondLots).activeBondMicrogons,
    });
    onProgress(100);
    return rules;
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
    if (btcFlatFee < MINIMUM_BITCOIN_BASE_FEE) {
      throw new Error('The Bitcoin base fee must be at least ₳1.00.');
    }
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
    const txSigner = await this.walletKeys.getVaultingKeypair();
    const info = await this.#transactionTracker.submitAndWatch({
      tx: txs.length > 1 ? client.tx.utility.batchAll(txs) : txs[0],
      txSigner,
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
    try {
      await txResult.waitForFinalizedBlock;
      await this.trackTxResultFee(txResult);
      await this.recordFinalizedVaultCapital(txInfo);
      console.log('Vault settings updated');
      postProcessor.resolve();
    } catch (error) {
      postProcessor.reject(error as Error);
      throw error;
    }
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
      const microgonsForSecuritization = MyVault.getSecuritizationTarget(rules);

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
        txSigner: vaultingAccount,
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
    txInfo: TransactionInfo<IVaultInitialAllocateMetadata>,
  ): Promise<{ txResult: TxResult }> {
    const { tx, txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    try {
      await txResult.waitForFinalizedBlock;
      await this.trackTxResultFee(txResult);
      await this.recordFinalizedVaultCapital(txInfo);

      const { microgonsForSecuritization } = tx.metadataJson;
      console.log('Saving vault updates', {
        microgonsForSecuritization,
      });
      postProcessor.resolve();

      return { txResult };
    } catch (error) {
      postProcessor.reject(error as Error);
      throw error;
    }
  }

  public async setVaultSecuritization(args: {
    securitizationMicrogons?: bigint;
    committedMicronots?: bigint;
    tip?: bigint;
    metadata?: object;
  }): Promise<TransactionInfo> {
    const client = await getMainchainClient(false);
    const vault = this.createdVault;
    if (!vault) {
      throw new Error('No vault created to get changes needed');
    }

    const change: Parameters<MyVault['buildSecuritizationTx']>[0] = {};
    if (args.securitizationMicrogons !== undefined) {
      change.securitizationMicrogons = args.securitizationMicrogons;
    }
    if (args.committedMicronots !== undefined) {
      change.committedMicronots = args.committedMicronots;
    }
    const tx = await this.buildSecuritizationTx(change, client);
    const txSigner = await this.walletKeys.getVaultingKeypair();
    const submitOptions = {
      useLatestNonce: true,
      tip: args.tip,
    };
    const submitter = new TxSubmitter(client, tx, txSigner);
    const txResult = await submitter.submit(submitOptions);
    const metadata: IVaultIncreaseAllocationMetadata = {
      vaultId: vault.vaultId,
      ...args.metadata,
    };
    if (args.securitizationMicrogons !== undefined) {
      metadata.securitizationMicrogons = args.securitizationMicrogons;
    }
    if (args.committedMicronots !== undefined) {
      metadata.committedMicronots = args.committedMicronots;
    }
    const info = await this.#transactionTracker.trackTxResult({
      txResult,
      extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
      metadata,
    });
    this.data.pendingAllocateTxInfo = info;
    void this.onIncreaseVaultSecuritization(info);
    return info;
  }

  public async buildSecuritizationTx(
    args: {
      securitizationMicrogons?: bigint;
      committedMicronots?: bigint;
    },
    client?: ArgonClient,
  ): Promise<SubmittableExtrinsic> {
    const vault = this.createdVault;
    if (!vault) {
      throw new Error('No vault created to get changes needed');
    }
    const changesSecuritization =
      args.securitizationMicrogons !== undefined && args.securitizationMicrogons !== vault.securitization;
    const changesArgonotCommitment =
      args.committedMicronots !== undefined &&
      args.committedMicronots !== this.data.argonotCommitment.committedMicronots;
    if (!changesSecuritization && !changesArgonotCommitment) {
      throw new Error('A securitization change is required');
    }
    client ??= await getMainchainClient(false);

    const txs: SubmittableExtrinsic[] = [];
    if (args.securitizationMicrogons !== undefined && changesSecuritization) {
      txs.push(
        client.tx.vaults.modifyFunding(
          vault.vaultId,
          args.securitizationMicrogons,
          toFixedNumber(vault.securitizationRatio, FIXED_U128_DECIMALS),
        ),
      );
    }
    if (args.committedMicronots !== undefined && changesArgonotCommitment) {
      txs.push(client.tx.vaults.setCommittedArgonots(args.committedMicronots));
    }

    return txs.length === 1 ? txs[0] : client.tx.utility.batchAll(txs);
  }

  private async onIncreaseVaultSecuritization(txInfo: TransactionInfo): Promise<void> {
    const { txResult } = txInfo;
    const postProcessor = txInfo.createPostProcessor();
    try {
      await txResult.waitForFinalizedBlock;
      await this.trackTxResultFee(txResult);
      await this.recordFinalizedVaultCapital(txInfo);
      postProcessor.resolve();
    } catch (error) {
      postProcessor.reject(error as Error);
      throw error;
    } finally {
      this.data.pendingAllocateTxInfo = null;
    }
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
    this.metadata.operationalFeeMicrogons += txResult.finalFee ?? 0n;
  }

  private async getTable(): Promise<VaultsTable> {
    this.#table ??= await this.dbPromise.then(x => x.vaultsTable);
    return this.#table;
  }

  public static getSecuritizationTarget(rules: IVaultingRules) {
    return bigIntMax(rules.baseMicrogonCommitment, 0n);
  }
}

function serializeFlexibleAssetMetadata(changes: IVaultFlexibleAssetChanges): IVaultFlexibleAssetMetadata {
  return {
    bitcoinChanges: changes.bitcoinChanges.map(({ lock, isFlexible }) => ({
      utxoId: lock.utxoId,
      isBackfill: isFlexible,
    })),
    bondChanges: changes.bondChanges.map(({ lot, isFlexible }) => ({
      bondLotId: lot.id,
      isBackfill: isFlexible,
    })),
  };
}

export function supportsFlexibleAssetsRuntime(client: ArgonClient): boolean {
  const supportsCurrentRuntime = 'setFlexible' in client.tx.bitcoinLocks && 'setBondLotFlexible' in client.tx.treasury;
  const supportsPreviousRuntime =
    'setAsBackfill' in client.tx.bitcoinLocks && 'setBondLotAsBackfill' in client.tx.treasury;

  return supportsCurrentRuntime || supportsPreviousRuntime;
}

export type IMyVaultInspect = Pick<MyVault, 'vaultId' | 'load'>;
