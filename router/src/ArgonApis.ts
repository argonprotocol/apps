import type { IBlockNumbers } from './interfaces/IBlockNumbers';
import { LOCAL_NODE_URL, LOGS_DIR, MAIN_NODE_URL } from './env';
import { callArgonRpc, getRoundedPercent, readTextFileOrDefault } from './utils';

// Returned by the custom system_syncStatus RPC in mainchain/node/src/rpc.rs.
interface IArgonNodeSyncStatus {
  startingBlock: number;
  currentBlock: number;
  state: 'idle' | 'downloading' | 'importing';
  targetBlock?: number | null;
  bestSeenBlock?: number | null;
  numPeers: number;
  stateSync?: {
    percentage: number;
    phase: 'downloadingState' | 'importingState';
  } | null;
  warpSync?: {
    phase: string;
  } | null;
}

// Fast sync spends roughly two-thirds of its time downloading headers and one-third syncing state.
const HEADER_SYNC_PERCENT = (2 / 3) * 100;
const STATE_DOWNLOAD_COMPLETE_PERCENT = 98;
const STATE_IMPORT_PERCENT = 99;

let cache: null | {
  latestBlocks: IBlockNumbers;
  timestamp: number;
} = null;

export class ArgonApis {
  static buildProgressFilePath = `${LOGS_DIR}/step-ArgonInstall.progress-pull-argon-miner.json`;

  public static async dockerPercentComplete(): Promise<number> {
    const percentComplete = await readTextFileOrDefault(this.buildProgressFilePath);

    const percent = Number(percentComplete.trim());
    if (!percent) {
      return percent;
    }
    return getRoundedPercent(percent / 100);
  }

  public static async latestBlocks(): Promise<IBlockNumbers> {
    if (!LOCAL_NODE_URL || !MAIN_NODE_URL) {
      throw new Error('ARGON_LOCAL_NODE and ARGON_ARCHIVE_NODE must be set');
    }

    const now = Date.now();
    if (cache && now - cache.timestamp < 2000) {
      return cache.latestBlocks;
    }
    const [localNodeBlockNumber, mainNodeBlockNumber] = await Promise.all([
      this.getBlockNumber(LOCAL_NODE_URL),
      this.getBlockNumber(MAIN_NODE_URL),
    ]);
    cache = { latestBlocks: { localNodeBlockNumber, mainNodeBlockNumber }, timestamp: now };
    return cache.latestBlocks;
  }

  public static async isComplete(): Promise<boolean | { error: string }> {
    if (!LOCAL_NODE_URL) {
      throw new Error('ARGON_LOCAL_NODE must be set');
    }

    const version = await callArgonRpc<{ specVersion: number }>(LOCAL_NODE_URL, 'state_getRuntimeVersion');

    if (version.result?.specVersion !== undefined) {
      const syncResponse = await callArgonRpc<{ isSyncing: boolean; peers: number }>(LOCAL_NODE_URL, 'system_health');
      return syncResponse.result?.isSyncing === false;
    }
    if (version.error?.code === 4003) return false;

    const response = { error: 'Unexpected response from node' };
    if (typeof version === 'object') {
      Object.assign(response, { rawResponse: version });
    }
    return response;
  }

  public static async syncStatus(): Promise<{ syncPercent: number } & IBlockNumbers> {
    const response = LOCAL_NODE_URL
      ? await callArgonRpc<IArgonNodeSyncStatus>(LOCAL_NODE_URL, 'system_syncStatus').catch(() => null)
      : null;
    const nodeSyncStatus = response?.result;

    let localNodeBlockNumber = nodeSyncStatus?.currentBlock ?? 0;
    let mainNodeBlockNumber = nodeSyncStatus?.currentBlock ?? 0;
    const hasActiveStateSync = Boolean(nodeSyncStatus?.stateSync);
    const hasActiveWarpSync = Boolean(nodeSyncStatus?.warpSync && nodeSyncStatus.warpSync.phase !== 'complete');
    if (nodeSyncStatus && (nodeSyncStatus.state !== 'idle' || hasActiveStateSync || hasActiveWarpSync)) {
      mainNodeBlockNumber = nodeSyncStatus.targetBlock ?? nodeSyncStatus.bestSeenBlock ?? localNodeBlockNumber;
    }
    let nodeSyncPercent = 0;

    if (nodeSyncStatus) {
      const stateSync = nodeSyncStatus.stateSync;
      const warpPhase = nodeSyncStatus.warpSync?.phase;

      if (stateSync?.phase === 'downloadingState') {
        const stateDownloadPercent = Math.min(Math.max(stateSync.percentage, 0), 100);
        const stateDownloadSpan = STATE_DOWNLOAD_COMPLETE_PERCENT - HEADER_SYNC_PERCENT;
        nodeSyncPercent = HEADER_SYNC_PERCENT + (stateDownloadPercent / 100) * stateDownloadSpan;
      } else if (stateSync?.phase === 'importingState' || warpPhase === 'importingState') {
        nodeSyncPercent = STATE_IMPORT_PERCENT;
      } else if (warpPhase === 'complete') {
        nodeSyncPercent = 100;
      } else if (warpPhase === 'downloadingState') {
        nodeSyncPercent = HEADER_SYNC_PERCENT;
      } else if (!warpPhase || warpPhase === 'downloadingBlocks') {
        const isIdleWithBlocks = localNodeBlockNumber > 0 && nodeSyncStatus.state === 'idle';
        let idleNodeCanComplete = isIdleWithBlocks && nodeSyncStatus.numPeers > 0;
        if (isIdleWithBlocks && !idleNodeCanComplete && MAIN_NODE_URL) {
          mainNodeBlockNumber = await this.getBlockNumber(MAIN_NODE_URL).catch(() => 0);
          idleNodeCanComplete = mainNodeBlockNumber > 0 && localNodeBlockNumber >= mainNodeBlockNumber;
        }

        const blocksToSync = mainNodeBlockNumber - nodeSyncStatus.startingBlock;
        const blocksSynced = Math.max(localNodeBlockNumber - nodeSyncStatus.startingBlock, 0);

        if (idleNodeCanComplete) {
          nodeSyncPercent = 100;
        } else if (blocksToSync > 0) {
          const headerDownloadRatio = Math.min(blocksSynced / blocksToSync, 1);
          nodeSyncPercent = headerDownloadRatio * HEADER_SYNC_PERCENT;
        }
      }
    } else {
      const latestBlocks = await this.latestBlocks().catch(() => ({
        localNodeBlockNumber: 0,
        mainNodeBlockNumber: 0,
      }));
      localNodeBlockNumber = latestBlocks.localNodeBlockNumber;
      mainNodeBlockNumber = latestBlocks.mainNodeBlockNumber;
      nodeSyncPercent = mainNodeBlockNumber ? getRoundedPercent(localNodeBlockNumber / mainNodeBlockNumber) : 0;
    }

    const dockerPercent = localNodeBlockNumber > 0 ? 100 : await this.dockerPercentComplete().catch(() => 0);

    let syncPercent = getRoundedPercent((dockerPercent * 0.2 + nodeSyncPercent * 0.8) / 100, 1);
    // if we're not all the way synced, don't report 100%
    if (syncPercent >= 100) {
      if (localNodeBlockNumber < mainNodeBlockNumber) {
        syncPercent = 99.9;
      } else {
        const complete = await this.isComplete().catch(() => false);
        if (complete !== true) syncPercent = 99.9;
      }
    }
    return { syncPercent, mainNodeBlockNumber, localNodeBlockNumber };
  }

  public static async getBlockNumber(url: string): Promise<number> {
    const header = await callArgonRpc<{ number: string }>(url, 'chain_getHeader');
    // header.number is hex string, convert to number
    if (header.result?.number) {
      return parseInt(header.result.number, 16);
    }
    throw new Error(`Invalid getBlockNumber response from node: ${JSON.stringify(header)}`);
  }
}
