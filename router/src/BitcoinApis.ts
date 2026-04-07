import type { IBitcoinBlockNumbers } from './interfaces/IBitcoinBlockNumbers';
import type { IBlockchainInfo } from './interfaces/IBlockchainInfo';
import { callBitcoinRpc, getRoundedPercent, readTextFileOrDefault } from './utils';
import type { IBlockNumbers } from './interfaces/IBlockNumbers';
import type { IBitcoinBlockMeta } from './interfaces/IBitcoinBlocksMeta';
import { BITCOIN_CHAIN, LOGS_DIR } from './env';

let cache: null | {
  latestBlocks: IBitcoinBlockNumbers & IBlockchainInfo;
  timestamp: number;
} = null;

export class BitcoinApis {
  static dataPullProgressFilePath = `${LOGS_DIR}/step-BitcoinInstall.progress-pull-bitcoin-data.json`;
  static buildBitcoinProgressFilePath = `${LOGS_DIR}/step-BitcoinInstall.progress-build-bitcoin-node.json`;

  public static async blockchainInfo(): Promise<IBlockchainInfo> {
    return callBitcoinRpc('getblockchaininfo');
  }

  public static async dockerPercentComplete(): Promise<number> {
    const percents = await Promise.all([
      readTextFileOrDefault(this.dataPullProgressFilePath),
      readTextFileOrDefault(this.buildBitcoinProgressFilePath),
    ]);

    const sum = percents.reduce((acc, val) => {
      const value = Number(val.trim());
      if (!value) {
        return acc;
      }
      return acc + value;
    }, 0);
    return getRoundedPercent(sum / (percents.length * 100));
  }

  public static async latestBlocks(): Promise<IBlockNumbers & IBlockchainInfo> {
    const now = Date.now();
    if (cache && now - cache.timestamp < 2000) {
      return cache.latestBlocks;
    }

    const blockchainInfo = await this.blockchainInfo();

    let mainNodeBlockNumber = 0;
    if (BITCOIN_CHAIN === 'mainnet') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch('https://blockchain.info/latestblock', {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      if (!response.ok) {
        throw new Error(`Blockchain.info responded with ${response.status}`);
      }
      const data = (await response.json()) as { block_index: number };
      mainNodeBlockNumber = data.block_index;
    } else {
      const peerinfo = await callBitcoinRpc<{ startingheight: number }[]>('getpeerinfo');
      for (const peer of peerinfo) {
        mainNodeBlockNumber = Math.max(peer.startingheight, mainNodeBlockNumber);
      }
    }
    const latestBlocks: IBitcoinBlockNumbers & IBlockchainInfo = {
      localNodeBlockNumber: blockchainInfo.blocks,
      mainNodeBlockNumber,
      localNodeBlockTime: blockchainInfo.time,
      ...blockchainInfo,
      softforks: [],
      bip9_softforks: {},
    };
    cache = { latestBlocks, timestamp: now };
    return latestBlocks;
  }

  public static async syncStatus(): Promise<{ syncPercent: number } & IBlockNumbers> {
    let dockerPercent = await this.dockerPercentComplete().catch(() => 0);
    const { localNodeBlockNumber, mainNodeBlockNumber, initialblockdownload, blocks, headers } =
      await this.latestBlocks().catch(() => ({
        localNodeBlockNumber: 0,
        mainNodeBlockNumber: 0,
        initialblockdownload: true,
        blocks: 0,
        headers: 0,
      }));
    // if we have any blocks, docker is definitely done
    if (localNodeBlockNumber > 0) {
      dockerPercent = 100;
    }

    const blockSyncPercent = mainNodeBlockNumber ? getRoundedPercent(localNodeBlockNumber / mainNodeBlockNumber) : 0;
    const localSyncedInfo = await callBitcoinRpc<Record<string, { synced: boolean; best_block_height: number }>>(
      'getindexinfo',
    ).catch(() => ({
      na: { synced: false, best_block_height: 0 },
    }));
    const indexesSynced =
      Object.values(localSyncedInfo).every(index => index.synced && index.best_block_height === localNodeBlockNumber) &&
      Object.keys(localSyncedInfo).length > 0;

    let syncPercent = getRoundedPercent((dockerPercent * 0.7 + blockSyncPercent * 0.3) / 100, 1);

    const isTrulyComplete =
      indexesSynced && !initialblockdownload && blocks === headers && localNodeBlockNumber >= mainNodeBlockNumber;
    // if we're not all the way synced, don't report 100%
    if (syncPercent >= 100 && !isTrulyComplete) {
      syncPercent = 99.9;
    }
    return {
      syncPercent,
      mainNodeBlockNumber,
      localNodeBlockNumber,
      // bitcoinNode: { indexinfo: localSyncedInfo, initialblockdownload, blocks, headers },
    };
  }

  public static async recentBlocks(blockCount: number): Promise<IBitcoinBlockMeta[]> {
    const blockcount = await callBitcoinRpc<number>('getblockcount');
    const hashes = await Promise.all(
      Array.from({ length: blockCount }, (_, i) => callBitcoinRpc<string>('getblockhash', blockcount - i)),
    );
    const blocks = await Promise.all(
      hashes.map(h => callBitcoinRpc<IBitcoinBlockMeta & { tx: string[] }>('getblock', h, 1)),
    );
    return blocks.map(({ tx, ...block }: IBitcoinBlockMeta & { tx: string[] }) => block);
  }
}
