import * as Vue from 'vue';
import { defineStore } from 'pinia';
import dayjs, { Dayjs, extend as dayJsExtend } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getBlockWatch, getMining } from './mainchain.ts';
import { IBlockHeaderInfo } from '@argonprotocol/apps-core/src/BlockWatch.ts';

dayJsExtend(utc);
dayJsExtend(relativeTime);

export type IActiveBid = {
  cohortId: number;
  accountId: string;
  amount: number;
  submittedAt: Dayjs;
  isMine?: boolean;
};

export type IBlock = {
  number: number;
  hash: string;
  author: string;
  microgons: bigint;
  micronots: bigint;
  timestamp: Dayjs;
};

export const useBlockchainStore = defineStore('blockchain', () => {
  const activeMiningSeatCount = Vue.ref(0);
  const aggregatedBidCosts = Vue.ref(0n);
  const aggregatedBlockRewards = Vue.ref({ microgons: 0n, micronots: 0n });
  const blockWatch = getBlockWatch();

  const cachedBlockLoading = { hash: null } as unknown as IBlock;
  const cachedBlocks = Vue.ref<IBlock[]>([
    cachedBlockLoading,
    cachedBlockLoading,
    cachedBlockLoading,
    cachedBlockLoading,
    cachedBlockLoading,
    cachedBlockLoading,
    cachedBlockLoading,
    cachedBlockLoading,
    cachedBlockLoading,
  ]);

  async function fetchBlock(header: IBlockHeaderInfo): Promise<IBlock | undefined> {
    await blockWatch.start();
    const { author, blockNumber, blockHash, blockTime } = header;

    try {
      const clientAt = await blockWatch.getApi(header);
      const events = await clientAt.query.system.events();
      let microgons = 0n;
      let micronots = 0n;
      events.find(({ event }: { event: any }) => {
        if (clientAt.events.blockRewards.RewardCreated.is(event)) {
          for (const x of event.data.rewards) {
            if (x.rewardType.isMiner) {
              microgons += x.argons.toBigInt();
              micronots += x.ownership.toBigInt();
            }
          }
          return true;
        }
      });

      return {
        number: blockNumber,
        hash: blockHash,
        author: author ?? '',
        microgons,
        micronots,
        timestamp: dayjs.utc(blockTime),
      };
    } catch (error) {
      console.warn('[BlockchainStore] Failed to fetch block details, skipping block update', {
        blockNumber,
        blockHash,
        error,
      });
      return;
    }
  }

  async function fetchBlocks(lastBlockNumber: number | null, maxBlockCount: number) {
    const blocks: IBlock[] = [];
    await blockWatch.start();

    let blockNumber = lastBlockNumber ?? blockWatch.bestBlockHeader.blockNumber;
    while (blocks.length < maxBlockCount && blockNumber >= 0) {
      const headerInfo = await blockWatch.getHeader(blockNumber);
      const block = await fetchBlock(headerInfo);
      if (block) {
        blocks.push(block);
      }
      blockNumber--;
    }

    return blocks;
  }

  async function subscribeToBlocks(onBlock: (block: IBlock) => void) {
    await blockWatch.start();

    // Subscribe to new blocks
    for (const header of blockWatch.latestHeaders) {
      const block = await fetchBlock(header);
      if (block) {
        onBlock(block);
      }
    }

    return blockWatch.events.on('best-blocks', headers => {
      void (async () => {
        for (const header of headers) {
          const block = await fetchBlock(header);
          if (block) {
            onBlock(block);
          }
        }
      })().catch(error => {
        console.warn('[BlockchainStore] Failed to process best block update', error);
      });
    });
  }

  async function updateActiveMiningSeatCount() {
    const mainchain = getMining();
    activeMiningSeatCount.value = await mainchain.fetchActiveMinersCount();
  }

  async function updateAggregateBidCosts() {
    aggregatedBidCosts.value = await getMining().fetchAggregateBidCosts();
  }

  async function updateAggregateBlockRewards() {
    aggregatedBlockRewards.value = await getMining().fetchAggregateBlockRewards();
  }

  return {
    aggregatedBidCosts,
    aggregatedBlockRewards,
    activeMiningSeatCount,
    cachedBlocks,
    subscribeToBlocks,
    updateAggregateBidCosts,
    updateAggregateBlockRewards,
    updateActiveMiningSeatCount,
    fetchBlocks,
  };
});
