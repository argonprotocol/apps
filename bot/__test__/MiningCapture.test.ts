import fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ArgonApi, ArgonClient, MainchainClients, MiningFrames } from '@argonprotocol/apps-core';
import { Accountset, NetworkConfig } from '@argonprotocol/apps-core';
import { getOfflineRegistry, Keyring, type GenericEvent } from '@argonprotocol/mainchain';
import { getTypeDef } from '@polkadot/types-create';
import { getHistoricalEventFieldAlternatives, toHistoricalEvent } from '@argonprotocol/runtime-client/events';
import type { RuntimeSystemEventRecord } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { MiningCapture } from '../src/MiningCapture.ts';
import { Storage } from '../src/Storage.ts';

const dataDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it.each(['funding-account', 'proxy-account'])(
  'captures completed bids and fees paid by %s without historical bid lists',
  async feePayer => {
    NetworkConfig.setNetwork('dev-docker');
    const dataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'block-sync-bids-'));
    dataDirs.push(dataDir);
    const storage = new Storage(dataDir);
    const accountset = {
      subAccountsByAddress: { 'our-miner': { index: 3 } },
      fundingAccountId: 'funding-account',
      txSubmitterPair: { address: 'proxy-account' },
      loadRegisteredMiners: async () => [],
    } as unknown as Accountset;
    const miningFrames = {
      currentFrameId: 8,
      getTickStart: () => 100,
      getFrameRewardTicksRemaining: () => 100,
      waitForFrameId: async () => undefined,
    } as unknown as MiningFrames;
    const mainchainClients = { events: { on: () => () => undefined } } as unknown as MainchainClients;
    const capture = new MiningCapture(accountset, storage, mainchainClients, miningFrames);
    vi.spyOn(capture['mining'], 'fetchMicrogonsPerBlockForMiner').mockResolvedValue(30n);

    vi.spyOn(capture['currency'], 'fetchMainchainRates').mockResolvedValue({ USD: 1n, BTC: 1n, ARGNOT: 2n } as any);

    const bidsForNextSlotCohort = vi.fn(async () => [{ accountId: 'our-miner', bid: 120n, bidAtTick: 121 }]);
    const api = {
      query: {
        miningSlot: {
          bidsForNextSlotCohort,
          historicalBidsPerSlot: async () => [{ bidsCount: 0 }, { bidsCount: 5 }],
          activeMinersCount: async () => 10,
          argonotsPerMiningSeat: async () => 20n,
        },
      },
    } as unknown as ArgonApi;
    await capture.restore(api);
    const events = [
      {
        phase: { type: 'ApplyExtrinsic', value: 0 },
        event: {
          section: 'transactionPayment',
          method: 'TransactionFeePaid',
          data: { who: feePayer, actualFee: 12_345n, tip: 0n },
        },
      },
      {
        phase: { type: 'ApplyExtrinsic', value: 0 },
        event: { section: 'miningSlot', method: 'SlotBidderAdded', data: { accountId: 'our-miner' } },
      },
      {
        phase: { type: 'Finalization' },
        event: {
          section: 'miningSlot',
          method: 'NewMiners',
          data: { frameId: 4, newMiners: [{ accountId: 'our-miner', bid: 100n, bidAtTick: 110, argonots: 10n }] },
        },
      },
    ] as unknown as RuntimeSystemEventRecord[];

    const result = await capture.processBlock(
      { number: 120, hash: '0x123', author: 'our-miner', tick: 120, frameId: 4, isNewFrame: true },
      { api, events },
    );

    expect(result).toEqual({ hasMiningBids: true, hasMiningSeats: true });
    expect(bidsForNextSlotCohort).not.toHaveBeenCalled();
    expect(await storage.bidsFile(3, 4).get()).toMatchObject({
      seatCountWon: 1,
      microgonsBidTotal: 100n,
      micronotsStakedPerSeat: 10n,
      transactionFeesByBlock: { 120: 12_345n },
    });
    expect((await storage.miningFrameFile(3).get()).totalBidCount).toBe(5);
    expect((await storage.miningFrameFile(3).get()).winningBids[0].micronotsStakedPerSeat).toBe(10n);

    miningFrames.currentFrameId = 4;
    await capture.processBlock(
      { number: 121, hash: '0x124', author: 'another-miner', tick: 121, frameId: 4, isNewFrame: false },
      { api, events: [] },
    );
    expect(bidsForNextSlotCohort).not.toHaveBeenCalled();
    expect(await storage.bidsFile(4, 5).get()).toMatchObject({
      lastBlockNumber: 121,
      biddingFrameRewardTicksRemaining: 100,
    });

    // Removing the activation block makes its auction unavailable until the replacement is captured.
    await capture.rewindAfter({ blockNumber: 119, frameId: 3, tick: 119 });
    expect((await storage.bidsFile(3, 4).get()).lastBlockNumber).toBe(0);
    expect((await storage.miningFrameFile(3).get()).winningBids).toEqual([]);
    await storage.close();

    const restartedStorage = new Storage(dataDir);
    const replacementCapture = new MiningCapture(accountset, restartedStorage, mainchainClients, miningFrames);
    vi.spyOn(replacementCapture['mining'], 'fetchMicrogonsPerBlockForMiner').mockResolvedValue(30n);
    vi.spyOn(replacementCapture['currency'], 'fetchMainchainRates').mockResolvedValue({
      USD: 1n,
      BTC: 1n,
      ARGNOT: 2n,
    } as any);
    await replacementCapture.restore(api);
    const replacementEvents = [
      {
        phase: { type: 'Finalization' },
        event: {
          section: 'miningSlot',
          method: 'NewMiners',
          data: { frameId: 4, newMiners: [{ accountId: 'our-miner', bid: 80n, bidAtTick: 111, argonots: 15n }] },
        },
      },
    ] as unknown as RuntimeSystemEventRecord[];
    await replacementCapture.processBlock(
      { number: 121, hash: 'replacement', author: 'another-miner', tick: 121, frameId: 4, isNewFrame: true },
      { api, events: replacementEvents },
    );
    expect(await restartedStorage.bidsFile(3, 4).get()).toMatchObject({
      lastBlockNumber: 121,
      seatCountWon: 1,
      microgonsBidTotal: 80n,
      micronotsStakedPerSeat: 15n,
      transactionFeesByBlock: {},
    });
    expect((await restartedStorage.miningFrameFile(3).get()).winningBids[0]).toMatchObject({
      address: 'our-miner',
      microgonsPerSeat: 80n,
      micronotsStakedPerSeat: 15n,
    });
    await restartedStorage.close();
  },
);

it.each([117, 124, 125, 141, 159])(
  'restores runtime %s seats and keeps cohort mints separate through replay and file reload',
  async spec => {
    NetworkConfig.setNetwork('dev-docker');
    const dataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'mining-mints-'));
    dataDirs.push(dataDir);
    let storage = new Storage(dataDir);
    const funding = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
    const addresses = [0, 1, 2].map(index => Accountset.createMiningSubaccount(funding.address, index));
    const members = addresses.map((accountId, index) => ({
      accountId,
      externalFundingAccount: funding.address,
      bid: 1n,
      argonots: 1n,
      cohortId: BigInt(index < 2 ? 5 : 6),
      cohortFrameId: index < 2 ? 5 : 6,
    }));
    const api = {
      query: {
        blockRewards: { blockFees: async () => 7n },
        miningSlot: {
          minersByCohort: {
            entries: async () =>
              spec < 125
                ? null
                : [
                    [{ args: [5] }, members.slice(0, 2)],
                    [{ args: [6] }, members.slice(2)],
                  ],
          },
          nextFrameId: async () => (spec < 125 ? null : 7),
          ...(spec < 125
            ? {
                activeMinersByIndex: {
                  entries: async () => members.map((member, index) => [{ args: [index] }, member]),
                },
                nextCohortId: async () => 7,
              }
            : {}),
        },
      },
    } as unknown as ArgonApi;
    const accountset = new Accountset({
      txSubmitter: funding,
      client: api as unknown as ArgonClient,
      subaccountRange: [0, 1, 2],
    });
    const miningFrames = {
      getTickStart: () => 100,
      getFrameRewardTicksRemaining: () => 0,
      waitForFrameId: async () => undefined,
    } as unknown as MiningFrames;
    const capture = new MiningCapture(
      accountset,
      storage,
      { events: { on: () => () => undefined } } as unknown as MainchainClients,
      miningFrames,
    );
    vi.spyOn(capture['currency'], 'fetchMainchainRates').mockResolvedValue({ USD: 1n, BTC: 1n, ARGNOT: 2n } as any);
    await capture.restore(api);
    const block = { number: 70, hash: 'authored-mint', author: addresses[2], tick: 120, frameId: 7, isNewFrame: true };
    // Decode the real historical field types: amount changed from U256 to u128 at spec 141.
    const fields = getHistoricalEventFieldAlternatives(spec, 'mint', 'MiningMint')[0];
    const registry = getOfflineRegistry();
    const values = { amount: 100n, perMiner: 10n, argonCpi: -1n, liquidity: 1_000n };
    const mintData = registry.createType<GenericEvent['data']>(
      `(${Object.values(fields).join(',')})`,
      Object.keys(fields).map(name => values[name as keyof typeof values]),
    );
    Object.defineProperties(mintData, {
      names: { value: Object.keys(fields) },
      typeDef: { value: Object.values(fields).map(type => getTypeDef(type)) },
    });
    const mint = toHistoricalEvent({ section: 'mint', method: 'MiningMint', data: mintData });
    const events = [
      {
        phase: { type: 'Finalization' },
        event: mint,
      },
      {
        phase: { type: 'Finalization' },
        event: {
          section: 'blockRewards',
          method: 'RewardCreated',
          data: { rewards: [{ argons: 22n, ownership: 3n }] },
        },
      },
    ] as unknown as RuntimeSystemEventRecord[];
    try {
      await capture.processBlock(block, { api, events });
      expect((await storage.earningsFile(6).get()).earningsByBlock[70]).toMatchObject({
        authorCohortActivationFrameId: 6,
        microgonsMined: 22n,
        micronotsMined: 3n,
        microgonFeesCollected: 7n,
        microgonsMinted: 30n,
        microgonsMintedByCohort: { 5: 20n, 6: 10n },
      });

      await capture.processBlock(
        { ...block, hash: 'mint-only', author: 'another-miner' },
        { api, events: [events[0]] },
      );
      await storage.close();
      storage = new Storage(dataDir);
      expect((await storage.earningsFile(6).get()).earningsByBlock[70]).toMatchObject({
        blockHash: 'mint-only',
        microgonsMined: 0n,
        micronotsMined: 0n,
        microgonFeesCollected: 0n,
        microgonsMinted: 30n,
        microgonsMintedByCohort: { 5: 20n, 6: 10n },
      });
      await storage.close();
      await capture.processBlock({ ...block, hash: 'no-payout', author: 'another-miner' }, { api, events: [] });
      storage = new Storage(dataDir);
      expect((await storage.earningsFile(6).get()).earningsByBlock[70]).toBeUndefined();
    } finally {
      await storage.close();
    }
  },
);
