import { Accountset, type IMiningIndex, type ISubaccountMiner } from './Accountset.js';
import { GenericEvent } from '@argonprotocol/mainchain';
import { MiningFrames } from './MiningFrames.js';

export class AccountMiners {
  private trackedAccountsByAddress: {
    [address: string]: {
      startingFrameId: number;
      subaccountIndex: number;
    };
  } = {};

  constructor(
    private accountset: Accountset,
    registeredMiners: (ISubaccountMiner & { seat: IMiningIndex })[],
  ) {
    for (const miner of registeredMiners) {
      this.trackedAccountsByAddress[miner.address] = {
        startingFrameId: miner.seat.startingFrameId,
        subaccountIndex: miner.subaccountIndex,
      };
    }
  }

  public async onBlock(digests: { author: string; tick: number }, events: GenericEvent[]) {
    const { author, tick } = digests;

    const client = this.accountset.client;
    const currentFrameId = MiningFrames.getForTick(tick);
    let newMiners: { frameId: number; addresses: string[] } | undefined;
    const dataByCohort: {
      duringFrameId: number;
      [cohortStartingFrameId: number]: {
        argonsMinted: bigint;
        argonsMined: bigint;
        argonotsMined: bigint;
      };
    } = { duringFrameId: currentFrameId };
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

          const entry = this.trackedAccountsByAddress[author];
          if (entry) {
            dataByCohort[entry.startingFrameId] ??= {
              argonsMinted: 0n,
              argonsMined: 0n,
              argonotsMined: 0n,
            };
            dataByCohort[entry.startingFrameId].argonotsMined += ownership.toBigInt();
            dataByCohort[entry.startingFrameId].argonsMined += argons.toBigInt();
          }
        }
      }
      if (client.events.mint.MiningMint.is(event)) {
        const { perMiner } = event.data;
        const amountPerMiner = perMiner.toBigInt();
        if (amountPerMiner > 0n) {
          for (const [_address, info] of Object.entries(this.trackedAccountsByAddress)) {
            const { startingFrameId } = info;
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
      this.newCohortMiners(newMiners.frameId, newMiners.addresses);
    }
    return dataByCohort;
  }

  private newCohortMiners(frameId: number, addresses: string[]) {
    for (const [address, info] of Object.entries(this.trackedAccountsByAddress)) {
      if (info.startingFrameId === frameId - 10) {
        delete this.trackedAccountsByAddress[address];
      }
    }
    for (const address of addresses) {
      const entry = this.accountset.subAccountsByAddress[address];
      if (entry) {
        this.trackedAccountsByAddress[address] = {
          startingFrameId: frameId,
          subaccountIndex: entry.index,
        };
      }
    }
  }
}
