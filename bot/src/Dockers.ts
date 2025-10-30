import type { IBitcoinBlockMeta, IBitcoinLatestBlocks, IBlockNumbers, ILatestBlocks } from '@argonprotocol/apps-core';
import { requireEnv } from './utils.js';

const statusApi = requireEnv('STATUS_URL');

export class Dockers {
  public static async getArgonBlockNumbers(): Promise<IBlockNumbers> {
    try {
      const result = await fetch(`${statusApi}/argon/latestblocks`).then(res => res.json());
      const { localNodeBlockNumber, mainNodeBlockNumber } = result as ILatestBlocks;
      return {
        localNode: localNodeBlockNumber,
        mainNode: mainNodeBlockNumber,
      };
    } catch (e) {
      console.error('getArgonBlockNumbers Error:', e);
      return { localNode: 0, mainNode: 0 };
    }
  }

  public static async isArgonMinerReady(): Promise<boolean> {
    try {
      const result = await fetch(`${statusApi}/argon/iscomplete`).then(res => res.text());
      return result === 'true';
    } catch (e) {
      console.error('isArgonMinerReady Error:', e);
      return false;
    }
  }

  public static async getBitcoinBlockNumbers(): Promise<IBlockNumbers & { localNodeBlockTime: number }> {
    try {
      const result = await fetch(`${statusApi}/bitcoin/latestblocks`).then(
        res => res.json() as Promise<IBitcoinLatestBlocks>,
      );

      const { localNodeBlockNumber, mainNodeBlockNumber, localNodeBlockTime } = result;
      return {
        localNode: localNodeBlockNumber,
        mainNode: mainNodeBlockNumber,
        localNodeBlockTime: localNodeBlockTime,
      };
    } catch (e) {
      console.error('getBitcoinBlockNumbers Error:', e);
      return { localNode: 0, mainNode: 0, localNodeBlockTime: 0 };
    }
  }

  public static async getBitcoinLatestBlocks(): Promise<IBitcoinBlockMeta[]> {
    try {
      return await fetch(`${statusApi}/bitcoin/recentblocks?blockCount=10`).then(
        res => res.json() as Promise<IBitcoinBlockMeta[]>,
      );
    } catch (e) {
      console.error('getBitcoinLatestBlocks Error:', e);
      return [];
    }
  }
}
