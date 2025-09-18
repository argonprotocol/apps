import type { IBitcoinBlockMeta } from '@argonprotocol/commander-core';
import { requireEnv } from './utils.js';

export interface IBlockNumbers {
  localNode: number;
  mainNode: number;
}

interface ILatestBlocks {
  mainNodeBlockNumber: number;
  localNodeBlockNumber: number;
}

interface IBitcoinLatestBlocks extends ILatestBlocks {
  localNodeBlockTime: number;
}

const statusApi = requireEnv('STATUS_URL');

export class Dockers {
  static async getArgonBlockNumbers(): Promise<IBlockNumbers> {
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
  static async isArgonMinerReady(): Promise<boolean> {
    try {
      const result = await fetch(`${statusApi}/argon/iscomplete`).then(res => res.text());
      return result === 'true';
    } catch (e) {
      console.error('isArgonMinerReady Error:', e);
      return false;
    }
  }

  static async getBitcoinBlockNumbers(): Promise<IBlockNumbers & { localNodeBlockTime: number }> {
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

  static async getBitcoinLatestBlocks(): Promise<IBitcoinBlockMeta[]> {
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
