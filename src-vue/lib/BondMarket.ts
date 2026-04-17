import { type ArgonClient } from '@argonprotocol/mainchain';
import { BondLot, TreasuryBonds, type IFrameBondLot } from '@argonprotocol/apps-core';
import { getBlockWatch, getMainchainClient, getMiningFrames } from '../stores/mainchain.ts';

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
  #vaultSubscriptions = new Map<number, VoidFunction[]>();
  #vaultSubscriptionArgs = new Map<number, IVaultBondSubscription>();

  public async subscribeGlobal(client?: ArgonClient): Promise<void> {
    if (this.#globalSubscriptions.length) return;

    client ??= await getMainchainClient(false);
    const miningFrames = getMiningFrames();
    const blockWatch = getBlockWatch();

    await blockWatch.start();
    this.refreshRuntimeSupport(client);

    const frameSubscription = miningFrames.onFrameId(frameId => {
      this.data.currentFrameId = frameId;
      void this.refreshSubscribedVaults(client);
    });

    const runtimeSubscription = blockWatch.events.on('best-blocks', () => {
      this.refreshRuntimeSupport(blockWatch.subscriptionClient);
    });

    const bidPoolSubscription = await TreasuryBonds.subscribeBidPool(client, bidPool => {
      this.data.distributableBidPool = bidPool;
    });

    this.#globalSubscriptions.push(() => frameSubscription.unsubscribe(), runtimeSubscription, bidPoolSubscription);
  }

  public async subscribeVault(args: IVaultBondSubscription, client?: ArgonClient): Promise<() => void> {
    client ??= await getMainchainClient(false);

    this.unsubscribeVault(args.vaultId);
    this.#vaultSubscriptionArgs.set(args.vaultId, args);

    await this.refreshVault(args, client);

    const bondLotsSubscription = await TreasuryBonds.subscribeBondLots(
      client,
      args.vaultId,
      args.accountId ?? args.operatorAddress,
      () => {
        void this.refreshVault(args, client);
      },
    );

    this.#vaultSubscriptions.set(args.vaultId, [bondLotsSubscription]);
    return () => this.unsubscribeVault(args.vaultId);
  }

  public async refreshVault(args: IVaultBondSubscription, client?: ArgonClient): Promise<void> {
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
    for (const unsubscribe of this.#vaultSubscriptions.get(vaultId) ?? []) {
      unsubscribe();
    }

    this.#vaultSubscriptions.delete(vaultId);
    this.#vaultSubscriptionArgs.delete(vaultId);
  }

  public unsubscribe(): void {
    for (const unsubscribe of this.#globalSubscriptions) {
      unsubscribe();
    }

    for (const vaultId of [...this.#vaultSubscriptions.keys()]) {
      this.unsubscribeVault(vaultId);
    }

    this.#globalSubscriptions.length = 0;
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

  private async refreshSubscribedVaults(client: ArgonClient): Promise<void> {
    await Promise.all(
      [...this.#vaultSubscriptionArgs.values()].map(args => {
        const nextArgs = args.frameId === undefined ? { ...args, frameId: this.data.currentFrameId } : args;
        return this.refreshVault(nextArgs, client);
      }),
    );
  }

  private refreshRuntimeSupport(client: ArgonClient): void {
    const bondFullCapacityPerFrame = TreasuryBonds.hasFullCapacityPerFrame(client);
    TreasuryBonds.bondFullCapacityPerFrame = bondFullCapacityPerFrame;
    this.data.bondFullCapacityPerFrame = bondFullCapacityPerFrame;
  }
}
