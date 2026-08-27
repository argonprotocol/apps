import { IMiningAccountPreviousHistoryBid, IMiningAccountPreviousHistoryRecord } from '../interfaces/IConfig.ts';
import type { IVaultingRules } from '../interfaces/IVaultingRules.ts';
import {
  AccountActivityKind,
  ArgonClient,
  FrameIterator,
  MainchainClients,
  MiningFrames,
} from '@argonprotocol/apps-core';
import { MyVault } from './MyVault.ts';
import { WalletKeys } from './WalletKeys.ts';
import { WalletsForArgon } from './WalletsForArgon.ts';
import { findAddressActivity } from './IndexerClient.ts';

export type WalletRecoveryFn = WalletRecovery['findHistory'];

export class WalletRecovery {
  constructor(
    private readonly myVault: MyVault,
    private readonly walletKeys: WalletKeys,
    private readonly walletsForArgon: WalletsForArgon,
    private readonly clients: MainchainClients,
    private readonly miningFrames: MiningFrames,
  ) {}

  public async findHistory(onLoadHistoryProgress?: (loadPct: number) => void): Promise<{
    miningHistory?: IMiningAccountPreviousHistoryRecord[];
    vaultingRules?: IVaultingRules;
  }> {
    let lastReportedProgress = -1;
    const reportProgress = (progressPct: number) => {
      const clampedProgress = Math.min(100, Math.max(0, lastReportedProgress, progressPct));
      if (clampedProgress === lastReportedProgress) return;
      lastReportedProgress = clampedProgress;
      onLoadHistoryProgress?.(Math.round(clampedProgress * 100) / 100);
    };

    const walletsForArgon = this.walletsForArgon;
    reportProgress(0);
    await walletsForArgon.load();
    reportProgress(3);
    await this.miningFrames.load();
    reportProgress(5);

    const hasVaultHistory = walletsForArgon.defaultArgonWallet.hasValue();

    let miningProgress = 0;
    let vaultProgress = 0;
    const onProgress = (source: 'miner' | 'vault', progressPct: number) => {
      const clampedSourceProgress = Math.min(100, Math.max(0, progressPct));
      if (source === 'miner') miningProgress = clampedSourceProgress;
      else vaultProgress = clampedSourceProgress;

      // Mining is the only recovery task for wallets without vault history, so it
      // receives the entire recovery range instead of starting at an artificial 50%.
      const combinedProgress = hasVaultHistory ? miningProgress * 0.7 + vaultProgress * 0.3 : miningProgress;
      reportProgress(10 + combinedProgress * 0.9);
    };

    const liveClient = await this.clients.archiveClientPromise;
    reportProgress(10);
    const miningHistoryPromise = this.loadMiningHistory(liveClient, pct => onProgress('miner', pct));

    let vaultingHistoryPromise: Promise<IVaultingRules | undefined> = Promise.resolve(undefined);
    if (hasVaultHistory) {
      await this.myVault.load();
      vaultingHistoryPromise = this.myVault.recoverAccountVault({
        onProgress: pct => onProgress('vault', pct),
      });
    }
    const [miningHistory, vaultingRules] = await Promise.all([miningHistoryPromise, vaultingHistoryPromise]);
    reportProgress(100);
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
    onProgress(0);
    const miningActivity = await findAddressActivity(this.walletKeys.miningBotAddress, {
      activityMask: AccountActivityKind.MiningBid,
    });
    onProgress(10);
    if (miningActivity.coverage.gaps.length) {
      const firstGap = miningActivity.coverage.gaps[0];
      throw new Error(
        `Mining history index has a coverage gap from block ${firstGap.fromBlock.toLocaleString()} to ${firstGap.toBlock.toLocaleString()}: ${firstGap.reason}`,
      );
    }
    const minerFirstBidBlock = miningActivity.blocks.at(0)?.blockNumber ?? null;
    const accountSubaccounts = await this.walletKeys.getMiningBotSubaccounts();
    onProgress(15);

    const currentFrameBids: IMiningAccountPreviousHistoryBid[] = [];
    const latestFrameId = this.miningFrames.currentFrameId;
    const earliestFundingFrameId = minerFirstBidBlock
      ? await this.miningFrames.getForBlock(minerFirstBidBlock)
      : latestFrameId - 1;

    const bidsRaw = await liveClient.query.miningSlot.bidsForNextSlotCohort();
    for (const [bidPosition, bidRaw] of bidsRaw.entries()) {
      const address = bidRaw.accountId;
      const isOurAccount = !!accountSubaccounts[address];
      if (!isOurAccount) continue;

      currentFrameBids.push({
        bidPosition,
        microgonsBid: bidRaw.bid,
        micronotsStaked: bidRaw.argonots,
      });
    }
    onProgress(20);

    const epochFrameIdsToProcess: number[] = [];
    for (let frameId = latestFrameId; frameId >= earliestFundingFrameId && frameId > 1; frameId -= 10) {
      if (this.miningFrames.framesById[frameId]?.firstBlockHash) {
        epochFrameIdsToProcess.push(frameId);
      }
    }
    const totalEpochsToProcess = epochFrameIdsToProcess.length;
    let epochsProcessed = 0;
    await new FrameIterator(this.clients, this.miningFrames).iterateFramesByEpoch(
      async (frameId, firstBlockMeta, api, abortController) => {
        if (frameId < earliestFundingFrameId) {
          abortController.abort();
          return;
        }
        if (firstBlockMeta.specVersion < 140) {
          console.log(`[MiningHistory] Reached spec version < 140 at frame ${frameId}, stopping history load`);
          return abortController.abort();
        }
        console.log(`[MiningHistory] Loading frame ${frameId} (oldest ${earliestFundingFrameId})`);
        const minersByCohort = await api.query.miningSlot.minersByCohort.entries();
        if (!minersByCohort) return;
        for (const [frameIdRaw, seatsInFrame] of minersByCohort) {
          const frameId = frameIdRaw.args[0];
          for (const [seatPosition, seatRaw] of seatsInFrame.entries()) {
            const address = seatRaw.accountId;
            const isOurAccount =
              !!accountSubaccounts[address] || seatRaw.externalFundingAccount === this.walletKeys.miningBotAddress;
            if (!isOurAccount) continue;
            dataByFrameId[frameId] ??= { frameId, seats: [], bids: [] };
            dataByFrameId[frameId].seats.push({
              seatPosition,
              microgonsBid: seatRaw.bid,
              micronotsStaked: seatRaw.argonots,
            });
          }
        }
        epochsProcessed += 1;
        const progress = totalEpochsToProcess > 0 ? 20 + (80 * epochsProcessed) / totalEpochsToProcess : 100;
        onProgress(progress);
        console.log(`[MiningHistory] Progress: ${progress}`);
        if (epochsProcessed >= totalEpochsToProcess) {
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
