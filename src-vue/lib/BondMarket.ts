import { type ArgonClient, type FrameSystemEventRecord } from '@argonprotocol/mainchain';
import {
  type ArgonQueryClient,
  type BlockWatch,
  BondLot,
  type IBlockHeaderInfo,
  type IFrameBondLot,
  TreasuryBonds,
} from '@argonprotocol/apps-core';
import { getMainchainClient } from '../stores/mainchain.ts';

export interface IVaultBondState {
  bondLots: BondLot[];
  currentFrame: {
    frameId: number;
    vaultBonds: number;
    sharingPct: number;
    bondLots: IFrameBondLot[];
  };
  isLoaded: boolean;
}

export type IBondMarketFrame = {
  frameId: number;
  distributableBidPool: bigint;
  globalBonds: number;
} & IVaultBondState['currentFrame'];

type IVaultBondSubscription = {
  vaultId: number;
  operatorAddress: string;
  accountId?: string;
  frameId?: number;
};

export class BondMarket {
  public data = {
    currentFrameId: 0,
    distributableBidPool: 0n,
    bondFullCapacityPerFrame: TreasuryBonds.bondFullCapacityPerFrame,
    totalActiveBonds: 0,
    vaultsById: {} as Record<number, IVaultBondState>,
  };

  #globalSubscriptions: VoidFunction[] = [];
  #vaultSubscriptionArgs = new Map<number, IVaultBondSubscription>();

  constructor(private readonly blockWatch: BlockWatch) {}

  public async subscribeGlobal(client?: ArgonClient): Promise<void> {
    if (this.#globalSubscriptions.length) return;

    client ??= await getMainchainClient(false);

    await this.blockWatch.start();
    if (this.blockWatch.bestBlockHeader.frameId != null) {
      this.data.currentFrameId = this.blockWatch.bestBlockHeader.frameId;
    }

    this.refreshRuntimeSupport(client);
    await this.refreshBidPool(client);

    const blockSubscription = this.blockWatch.events.on('best-blocks', blocks => {
      this.refreshRuntimeSupport(this.blockWatch.subscriptionClient);
      void this.onNewBestBlocks(blocks);
    });

    this.#globalSubscriptions.push(blockSubscription);
  }

  public async subscribeVault(args: IVaultBondSubscription, client?: ArgonClient): Promise<() => void> {
    client ??= await getMainchainClient(false);

    this.unsubscribeVault(args.vaultId);
    this.#vaultSubscriptionArgs.set(args.vaultId, args);

    await this.refreshVault(args, client);
    return () => this.unsubscribeVault(args.vaultId);
  }

  public async refreshVault(args: IVaultBondSubscription, client?: ArgonQueryClient): Promise<void> {
    client ??= await getMainchainClient(false);

    const vault = this.getVaultBonds(args.vaultId);
    const frameId = args.frameId ?? this.data.currentFrameId;

    const [activeBonds, bondLots, frameBonds] = await Promise.all([
      TreasuryBonds.getActiveBonds(client, args.vaultId),
      TreasuryBonds.getBondLots(client, args.vaultId, args.accountId ?? args.operatorAddress),
      frameId > 0
        ? TreasuryBonds.getCurrentFrameBondLots(client, args.vaultId, args.operatorAddress, frameId)
        : Promise.resolve({ bondLots: [], vaultSharingPct: 0 }),
    ]);

    this.data.totalActiveBonds = activeBonds.totalActiveBonds;
    vault.bondLots = bondLots;
    vault.currentFrame.frameId = frameId;
    vault.currentFrame.vaultBonds = activeBonds.vaultActiveBonds;
    vault.currentFrame.sharingPct = frameBonds.vaultSharingPct;
    vault.currentFrame.bondLots = frameBonds.bondLots;
    vault.isLoaded = true;
  }

  public unsubscribeVault(vaultId: number): void {
    this.#vaultSubscriptionArgs.delete(vaultId);
  }

  public unsubscribe(): void {
    for (const unsubscribe of this.#globalSubscriptions) {
      unsubscribe();
    }

    this.#globalSubscriptions.length = 0;
    this.#vaultSubscriptionArgs.clear();
  }

  public getVaultBonds(vaultId: number): IVaultBondState {
    return (this.data.vaultsById[vaultId] ??= {
      bondLots: [],
      currentFrame: {
        frameId: 0,
        vaultBonds: 0,
        sharingPct: 0,
        bondLots: [],
      },
      isLoaded: false,
    });
  }

  private async refreshBidPool(client: ArgonQueryClient): Promise<void> {
    this.data.distributableBidPool = await TreasuryBonds.getDistributableBidPool(client);
  }

  private async onNewBestBlocks(blocks: IBlockHeaderInfo[]): Promise<void> {
    const latestBlock = blocks.at(-1);
    if (!latestBlock) return;

    let refreshAll = false;
    let refreshBidPool = false;
    const vaultIds = new Set<number>();
    let latestRefreshBlock: IBlockHeaderInfo | undefined;

    for (const block of blocks) {
      if (block.frameId != null) {
        this.data.currentFrameId = block.frameId;
      }

      const refreshScope = await getTreasuryBondRefreshScope(await this.blockWatch.getEvents(block));
      if (refreshScope.refreshBidPool) {
        refreshBidPool = true;
      }

      if (refreshScope.refreshAll || block.isNewFrame) {
        refreshAll = true;
      }

      for (const vaultId of refreshScope.vaultIds) {
        vaultIds.add(vaultId);
      }

      if (refreshScope.refreshAll || refreshScope.vaultIds.size > 0 || block.isNewFrame) {
        latestRefreshBlock = block;
      }
    }

    if (refreshBidPool) {
      await this.refreshBidPool(await this.blockWatch.getApi(latestBlock));
    }

    if (!latestRefreshBlock) return;

    const blockClient = await this.blockWatch.getApi(latestRefreshBlock);
    if (refreshAll) {
      await this.refreshSubscribedVaults(blockClient);
      return;
    }

    const refreshes: Promise<void>[] = [];
    for (const vaultId of vaultIds) {
      const args = this.#vaultSubscriptionArgs.get(vaultId);
      if (args) {
        refreshes.push(this.refreshVault(args, blockClient));
      }
    }
    await Promise.all(refreshes);
  }

  private async refreshSubscribedVaults(client: ArgonQueryClient): Promise<void> {
    await Promise.all(
      [...this.#vaultSubscriptionArgs.values()].map(args => {
        const nextArgs = args.frameId === undefined ? { ...args, frameId: this.data.currentFrameId } : args;
        return this.refreshVault(nextArgs, client);
      }),
    );
  }

  private refreshRuntimeSupport(client: ArgonQueryClient): void {
    const bondFullCapacityPerFrame = TreasuryBonds.hasFullCapacityPerFrame(client);
    TreasuryBonds.bondFullCapacityPerFrame = bondFullCapacityPerFrame;
    this.data.bondFullCapacityPerFrame = bondFullCapacityPerFrame;
  }
}

export async function getTreasuryBondRefreshScope(events: FrameSystemEventRecord[]) {
  const typeClient = await getMainchainClient(false);
  const vaultIds = new Set<number>();
  let refreshAll = false;
  let refreshBidPool = false;

  for (const { event } of events) {
    if (typeClient.events.miningSlot.SlotBidderAdded.is(event) && event.data.bidAmount.toBigInt() > 0n) {
      refreshBidPool = true;
      continue;
    }

    if (typeClient.events.miningSlot.SlotBidderDropped.is(event)) {
      refreshBidPool = true;
      continue;
    }

    if (typeClient.events.treasury.FrameEarningsDistributed.is(event)) {
      refreshAll = true;
      if (event.data.bidPoolDistributed.toBigInt() > 0n) {
        refreshBidPool = true;
      }
      continue;
    }

    if (typeClient.events.treasury.FrameVaultCapitalLocked.is(event)) {
      refreshAll = true;
      continue;
    }

    if (
      typeClient.events.treasury.BondLotPurchased.is(event) ||
      typeClient.events.treasury.BondLotReleaseScheduled.is(event) ||
      typeClient.events.treasury.BondLotReleased.is(event)
    ) {
      vaultIds.add(event.data.vaultId.toNumber());
    }
  }

  return { refreshAll, refreshBidPool, vaultIds };
}
