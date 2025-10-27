import * as Vue from 'vue';
import { defineStore } from 'pinia';
import dayjs, { extend as dayJsExtend, Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import { type ArgonClient } from '@argonprotocol/apps-core';
import { getMining, getMainchainClient } from './mainchain.ts';
import { getAuthorFromHeader, Header } from '@argonprotocol/mainchain';

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

  async function fetchBlock(client: ArgonClient, header: Header) {
    const author = getAuthorFromHeader(client, header);
    const clientAt = await client.at(header.hash);
    const events = await clientAt.query.system.events();
    let microgons = 0n;
    let micronots = 0n;
    events.find(({ event }: { event: any }) => {
      if (client.events.blockRewards.RewardCreated.is(event)) {
        for (const x of event.data.rewards) {
          if (x.rewardType.isMiner) {
            microgons += x.argons.toBigInt();
            micronots += x.ownership.toBigInt();
          }
        }
        return true;
      }
    });
    const timestamp = (await clientAt.query.timestamp.now()).toNumber();
    const newBlock: IBlock = {
      number: header.number.toNumber(),
      hash: header.hash.toHex(),
      author: author ?? '',
      microgons,
      micronots,
      timestamp: dayjs.utc(timestamp),
    };

    return newBlock;
  }

  async function fetchBlocks(lastBlockNumber: number | null, maxBlockCount: number) {
    const client = await getMainchainClient(true);
    const blocks: IBlock[] = [];

    if (lastBlockNumber === null) {
      const latestBlock = await client.rpc.chain.getHeader();
      lastBlockNumber = latestBlock.number.toNumber();
    }

    let blockNumber = lastBlockNumber;
    while (blocks.length < maxBlockCount) {
      const blockHash = await client.rpc.chain.getBlockHash(blockNumber);
      if (!blockHash) break;
      const header = await client.rpc.chain.getHeader(blockHash);
      const block = await fetchBlock(client, header);
      blocks.push(block);
      blockNumber--;
    }

    return blocks;
  }

  async function subscribeToBlocks(onBlock: (block: IBlock) => void) {
    const client = await getMainchainClient(false);

    // Subscribe to new blocks
    return await client.rpc.chain.subscribeNewHeads(async header => {
      const blockHash = header.hash;
      const block = await fetchBlock(client, header);
      onBlock(block);
    });
  }

  async function updateActiveMiningSeatCount() {
    const mainchain = getMining();
    activeMiningSeatCount.value = await mainchain.getActiveMinersCount();
  }

  async function updateAggregateBidCosts() {
    aggregatedBidCosts.value = await getMining().getAggregateBidCosts();
  }

  async function updateAggregateBlockRewards() {
    aggregatedBlockRewards.value = await getMining().getAggregateBlockRewards();
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
