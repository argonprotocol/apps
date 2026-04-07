import type { IBlockNumbers } from './interfaces/IBlockNumbers';
import { LOCAL_NODE_URL, LOGS_DIR, MAIN_NODE_URL } from './env';
import { callArgonRpc, getRoundedPercent, readTextFileOrDefault } from './utils';

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
    let dockerPercent = await this.dockerPercentComplete().catch(() => 0);
    const { localNodeBlockNumber, mainNodeBlockNumber } = await this.latestBlocks().catch(() => ({
      localNodeBlockNumber: 0,
      mainNodeBlockNumber: 0,
    }));
    // if we have any blocks, docker is definitely done
    if (localNodeBlockNumber > 0) {
      dockerPercent = 100;
    }

    const blockSyncPercent = mainNodeBlockNumber ? getRoundedPercent(localNodeBlockNumber / mainNodeBlockNumber) : 0;
    let syncPercent = getRoundedPercent((dockerPercent * 0.2 + blockSyncPercent * 0.8) / 100, 1);
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
    url = url.replace('ws://', 'http://').replace('wss://', 'https://');
    const header = await callArgonRpc<{ number: string }>(url, 'chain_getHeader');
    // header.number is hex string, convert to number
    if (header.result?.number) {
      return parseInt(header.result.number, 16);
    }
    throw new Error(`Invalid getBlockNumber response from node: ${JSON.stringify(header)}`);
  }
}
