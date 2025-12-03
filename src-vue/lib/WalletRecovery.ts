import { IMiningAccountPreviousHistoryBid, IMiningAccountPreviousHistoryRecord } from '../interfaces/IConfig.ts';
import IVaultingRules from '../interfaces/IVaultingRules.ts';
import { ArgonClient, FrameIterator, MainchainClients, MiningFrames } from '@argonprotocol/apps-core';
import { MyVault } from './MyVault.ts';
import { WalletKeys } from './WalletKeys.ts';
import { WalletBalances } from './WalletBalances.ts';

export type WalletRecoveryFn = WalletRecovery['findHistory'];

export class WalletRecovery {
  constructor(
    private readonly myVault: MyVault,
    private readonly walletKeys: WalletKeys,
    private readonly walletBalances: WalletBalances,
    private readonly clients: MainchainClients,
    private readonly miningFrames: MiningFrames,
  ) {}

  public async findHistory(onLoadHistoryProgress?: (loadPct: number) => void): Promise<{
    miningHistory?: IMiningAccountPreviousHistoryRecord[];
    vaultingRules?: IVaultingRules;
  }> {
    const walletBalances = this.walletBalances;
    await walletBalances.load();
    await this.miningFrames.load();

    const hasVaultHistory = walletBalances.vaultingWallet.hasValue();
    const hasMiningHistory = walletBalances.miningWallet.hasValue();

    let vaultProgress = hasVaultHistory ? 0 : 100;
    let miningProgress = hasMiningHistory ? 0 : 100;
    onLoadHistoryProgress?.(0);
    const onProgress = (source: 'miner' | 'vault', progressPct: number) => {
      if (source === 'miner') miningProgress = progressPct;
      else vaultProgress = progressPct;
      onLoadHistoryProgress?.(Math.round(100 * ((vaultProgress + miningProgress) / 2)) / 100);
    };

    let miningHistoryPromise: Promise<IMiningAccountPreviousHistoryRecord[] | undefined> = Promise.resolve(undefined);
    if (hasMiningHistory) {
      const liveClient = await this.clients.archiveClientPromise;
      miningHistoryPromise = this.loadMiningHistory(liveClient, pct => onProgress('miner', pct));
    }

    let vaultingHistoryPromise: Promise<IVaultingRules | undefined> = Promise.resolve(undefined);
    if (hasVaultHistory) {
      await this.myVault.load();
      vaultingHistoryPromise = this.myVault.recoverAccountVault({
        onProgress: pct => onProgress('vault', pct),
      });
    }
    const [miningHistory, vaultingRules] = await Promise.all([miningHistoryPromise, vaultingHistoryPromise]);
    onLoadHistoryProgress?.(100);
    return {
      miningHistory,
      vaultingRules,
    };
  }

  private async loadMiningHistory(
    liveClient: ArgonClient,
    onProgress: (progressPct: number) => void,
  ): Promise<IMiningAccountPreviousHistoryRecord[] | undefined> {
    const dataByFrameId: Record<string, IMiningAccountPreviousHistoryRecord> = {};

    const accountSubaccounts = await this.walletKeys.getMiningSubaccounts();

    const currentFrameBids: IMiningAccountPreviousHistoryBid[] = [];
    const latestFrameId = await liveClient.query.miningSlot.nextFrameId().then(x => x.toNumber() - 1);
    const earliestPossibleFrameId = this.miningFrames.earliestWithSpec(140);

    const bidsRaw = await liveClient.query.miningSlot.bidsForNextSlotCohort();
    for (const [bidPosition, bidRaw] of bidsRaw.entries()) {
      const address = bidRaw.accountId.toHuman();
      const isOurAccount = !!accountSubaccounts[address];
      if (!isOurAccount) continue;

      currentFrameBids.push({
        bidPosition,
        microgonsBid: bidRaw.bid.toBigInt(),
        micronotsStaked: bidRaw.argonots.toBigInt(),
      });
    }

    const framesToProcess = latestFrameId - earliestPossibleFrameId;
    await new FrameIterator(this.clients, this.miningFrames).iterateFramesByEpoch(
      async (frameId, firstBlockMeta, api, abortController) => {
        if (firstBlockMeta.specVersion < 140) {
          console.log(`[MiningHistory] Reached spec version < 140 at frame ${frameId}, stopping history load`);
          return abortController.abort();
        }
        console.log(`[MiningHistory] Loading frame ${frameId} (oldest ${earliestPossibleFrameId})`);
        const minersByCohort = await api.query.miningSlot.minersByCohort.entries();
        for (const [frameIdRaw, seatsInFrame] of minersByCohort) {
          const frameId = frameIdRaw.args[0].toNumber();
          for (const [seatPosition, seatRaw] of seatsInFrame.entries()) {
            const address = seatRaw.accountId.toHuman();
            const isOurAccount = !!accountSubaccounts[address];
            if (!isOurAccount) continue;
            dataByFrameId[frameId] ??= { frameId, seats: [], bids: [] };
            dataByFrameId[frameId].seats.push({
              seatPosition,
              microgonsBid: seatRaw.bid.toBigInt(),
              micronotsStaked: seatRaw.argonots.toBigInt(),
            });
          }
        }
        const framesProcessed = latestFrameId - frameId;
        const progress = Math.max((100 * framesProcessed) / framesToProcess, 0);
        onProgress(progress);
        console.log(`[MiningHistory] Progress: ${progress}`);
        if (frameId < earliestPossibleFrameId) {
          abortController.abort();
        }
      },
    );
    if (currentFrameBids.length) {
      dataByFrameId[latestFrameId] ??= { frameId: latestFrameId, seats: [], bids: [] };
      dataByFrameId[latestFrameId].bids = currentFrameBids;
    }
    console.log('[MiningHistory] Finished loading history', dataByFrameId);

    onProgress(100);

    const miningHistory = Object.values(dataByFrameId);
    if (miningHistory.length) {
      return miningHistory;
    }
  }
}
