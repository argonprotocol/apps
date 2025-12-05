import type { MainchainClients } from './MainchainClients.js';
import { type ApiDecoration } from '@argonprotocol/mainchain';
import { MiningFrames } from './MiningFrames.js';

export type { ApiDecoration };

export type ICallbackFirstBlockMeta = {
  specVersion: number;
  blockNumber: number;
  blockHash: string;
  blockTick: number;
};

export type ICallbackForFrame<T> = (
  frameId: number,
  firstBlockMeta: ICallbackFirstBlockMeta,
  api: ApiDecoration<'promise'>,
  abortController: AbortController,
) => Promise<T>;

export class FrameIterator {
  constructor(
    public readonly clients: MainchainClients,
    private readonly miningFrames: MiningFrames,
    private name: string = 'FrameIterator',
  ) {}

  public async iterateFramesByEpoch(callback: ICallbackForFrame<void>): Promise<void> {
    const abortController = new AbortController();
    await this.miningFrames.load();

    let frameId = this.miningFrames.currentFrameId;
    do {
      const { firstBlockSpecVersion, firstBlockNumber, firstBlockHash, firstBlockTick } =
        this.miningFrames.frameHistory[frameId];
      if (firstBlockHash) {
        console.log(`[${this.name}] Exploring epoch frame ${frameId} (blockNumber = ${firstBlockNumber})`);
        const meta = {
          specVersion: firstBlockSpecVersion!,
          blockNumber: firstBlockNumber!,
          blockHash: firstBlockHash,
          blockTick: firstBlockTick!,
        };
        const api = await this.miningFrames.clientAt({ blockHash: firstBlockHash, blockNumber: firstBlockNumber! });
        await callback(frameId, meta, api, abortController);
      }

      frameId -= 10;
      if (abortController.signal.aborted || frameId <= 1) {
        let message = `[${this.name}] Aborting iteration as requested at frame ${frameId}`;
        if (frameId <= 1) message = `[${this.name}] Aborting iteration at frame 1`;
        console.log(message);
        break; // Stop processing if the abort signal is triggered
      }
    } while (frameId >= 0);
  }

  public async iterateFramesLimited<T>(callback: ICallbackForFrame<T>): Promise<T[]> {
    const abortController = new AbortController();
    await this.miningFrames.load();
    const results: T[] = [];

    const frameIds = this.miningFrames.frameIds;
    frameIds.sort((a, b) => b - a); // Descending order
    for (const frameId of frameIds) {
      const { firstBlockSpecVersion, firstBlockNumber, firstBlockHash, firstBlockTick } =
        this.miningFrames.frameHistory[frameId];
      if (firstBlockHash) {
        console.log(`[${this.name}] Exploring frame ${frameId} (blockNumber = ${firstBlockNumber})`);

        const firstBlockMeta = {
          specVersion: firstBlockSpecVersion!,
          blockNumber: firstBlockNumber!,
          blockHash: firstBlockHash,
          blockTick: firstBlockTick!,
        };
        const api = await this.miningFrames.clientAt({
          blockHash: firstBlockHash,
          blockNumber: firstBlockNumber!,
        });
        const result = await callback(frameId, firstBlockMeta, api, abortController);
        results.push(result);
      }
      if (abortController.signal.aborted || frameId <= 1) {
        let message = `[${this.name}] Aborting iteration as requested at frame ${frameId}`;
        if (frameId <= 1) message = `[${this.name}] Aborting iteration at frame 1`;
        console.log(message);
        break; // Stop processing if the abort signal is triggered
      }
    }

    return results;
  }

  public async iterateFramesAll<T>(callback: ICallbackForFrame<T>): Promise<T[]> {
    return this.iterateFramesLimited<T>(callback);
  }
}
