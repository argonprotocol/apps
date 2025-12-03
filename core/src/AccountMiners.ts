import { Accountset, type IMiningIndex, type ISubaccountMiner } from './Accountset.js';
import { GenericEvent } from '@argonprotocol/mainchain';
import type { IBlock } from './interfaces/index.ts';

interface IMinerStartingFrameInfo {
  [address: string]: number;
}
export class AccountMiners {
  private startingFrameIdByAddress: IMinerStartingFrameInfo = {};

  private startingFrameIdsByBlock: {
    [blockNumber: number]: IMinerStartingFrameInfo;
  } = {};

  private currentBlockNumber: number = 0;

  constructor(
    private accountset: Accountset,
    registeredMiners: (ISubaccountMiner & { seat: IMiningIndex })[],
  ) {
    for (const miner of registeredMiners) {
      this.startingFrameIdByAddress[miner.address] = miner.seat.startingFrameId;
    }
  }

  public async onBlock(blockInfo: IBlock, events: GenericEvent[]) {
    const { author, number: blockNumber } = blockInfo;
    if (blockNumber < this.currentBlockNumber) {
      const previousStartingFrameIds = this.startingFrameIdsByBlock[blockNumber - 1];
      if (previousStartingFrameIds) {
        this.startingFrameIdByAddress = previousStartingFrameIds;
      }
    }

    const client = this.accountset.client;
    let newMiners: { frameId: number; addresses: string[] } | undefined;
    const dataByCohort: {
      [cohortStartingFrameId: number]: {
        argonsMinted: bigint;
        argonsMined: bigint;
        argonotsMined: bigint;
      };
    } = {};
    for (const event of events) {
      if (client.events.miningSlot.NewMiners.is(event)) {
        newMiners = {
          frameId: event.data.frameId.toNumber(),
          addresses: event.data.newMiners.map(x => x.accountId.toHuman()),
        };
      }
      if (client.events.blockRewards.RewardCreated.is(event)) {
        const { rewards } = event.data;
        for (const reward of rewards) {
          const { argons, ownership } = reward;

          const startingFrameId = this.startingFrameIdByAddress[author];
          if (startingFrameId) {
            dataByCohort[startingFrameId] ??= {
              argonsMinted: 0n,
              argonsMined: 0n,
              argonotsMined: 0n,
            };
            dataByCohort[startingFrameId].argonotsMined += ownership.toBigInt();
            dataByCohort[startingFrameId].argonsMined += argons.toBigInt();
          }
        }
      }
      if (client.events.mint.MiningMint.is(event)) {
        const { perMiner } = event.data;
        const amountPerMiner = perMiner.toBigInt();
        if (amountPerMiner > 0n) {
          for (const [_address, startingFrameId] of Object.entries(this.startingFrameIdByAddress)) {
            dataByCohort[startingFrameId] ??= {
              argonsMinted: 0n,
              argonsMined: 0n,
              argonotsMined: 0n,
            };
            dataByCohort[startingFrameId].argonsMinted += amountPerMiner;
          }
        }
      }
    }
    if (newMiners) {
      for (const [address, startingFrameId] of Object.entries(this.startingFrameIdByAddress)) {
        if (startingFrameId === newMiners.frameId - 10) {
          delete this.startingFrameIdByAddress[address];
        }
      }
      for (const address of newMiners.addresses) {
        if (this.accountset.subAccountsByAddress[address]) {
          this.startingFrameIdByAddress[address] = newMiners.frameId;
        }
      }
    }
    this.startingFrameIdsByBlock[blockNumber] = { ...this.startingFrameIdByAddress };
    // only keep latest 10 blocks to save memory
    const keys = Object.keys(this.startingFrameIdsByBlock).map(x => parseInt(x, 10));
    for (const key of keys) {
      if (key < blockNumber - 10 || key > blockNumber) {
        delete this.startingFrameIdsByBlock[key];
      }
    }

    this.currentBlockNumber = blockNumber;
    return dataByCohort;
  }
}
