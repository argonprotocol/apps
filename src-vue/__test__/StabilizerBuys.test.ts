import { maxUint128, toHex } from 'viem';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import { createTypedEventEmitter, type BlockWatch, type IBlockHeaderInfo } from '@argonprotocol/apps-core';
import { decorateStorage, decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { Metadata } from '@polkadot/types';
import { computed, reactive } from 'vue';
import { expect, it, vi } from 'vitest';
import { StabilizerBuys } from '../lib/StabilizerBuys.ts';
import { createTestDb } from './helpers/db.ts';

it('preserves the published purchase snapshot through a failed refresh and updates mounted consumers on retry', async () => {
  const registry = getOfflineRegistry();
  const metadata = new Metadata(registry, { metadata: { V16: registry.metadata } });
  const storage = decorateStorage(registry, metadata.asLatest, metadata.version);
  const calls = decorateExtrinsics(registry, metadata.asLatest, metadata.version);
  const account = registry.createType('AccountId32', new Uint8Array(32).fill(17));
  const key = registry.createType('StorageKey', [
    storage.stabilizerBuys.buysByAccountAndFrame,
    [account, '0x000000000000000c'],
  ]);
  const events = createTypedEventEmitter<{ finalized: (blocks: [IBlockHeaderInfo]) => void }>();
  const block = { blockNumber: 10, blockHash: '0x10', blockTime: 1_700_000_000_000, tick: 100 } as IBlockHeaderInfo;
  let failure = false;
  let principal = 100_000_000n;
  let payableReward = 37n;
  let nextFrameId = 14;
  let maturesAtFrame = 42;
  let bidPercent = 33;
  let budget = 1_000n;
  let hasPurchase = true;
  let bidsUnavailable = false;
  let allocationDue = false;
  const api = {
    registry,
    query: {
      miningSlot: { nextFrameId: async () => registry.createType('u64', nextFrameId) },
      stabilizerBuys: {
        bidsByAuction: Object.assign(() => undefined, {
          entries: async () => {
            if (bidsUnavailable) throw new Error('Bid RPC unavailable');
            if (allocationDue) return [];
            const bidKey = registry.createType('StorageKey', [
              storage.stabilizerBuys.bidsByAuction,
              [
                12,
                [bidPercent, { descendingAmount: toHex(maxUint128 - 75n, { size: 16 }), orderedId: account.toHex() }],
              ],
            ]);
            return [[bidKey, registry.createType('Null')]];
          },
        }),
        buysByAccountAndFrame: Object.assign(() => undefined, {
          entries: async () => {
            if (!hasPurchase) return [];

            return [
              [
                key,
                registry.createType('Option<PalletStabilizerBuysAccountFrameBuys>', {
                  pendingLiquidRepays: 0n,
                  liquidRepaymentRewardRate: null,
                  principal,
                  capturedDiscount: 101,
                  bidRate: bidPercent,
                  positiveBidCount: 1,
                }),
              ],
            ];
          },
        }),
        auctions: async (frame: number) => {
          if (frame === 999) return registry.createType('Option<PalletStabilizerBuysAuction>');
          return registry.createType('Option<PalletStabilizerBuysAuction>', {
            matchingRate: 750_000,
            totalMatchingBasis: 75,
            budget,
            remainingBudget: allocationDue ? 0 : budget,
            remainingMatchingBasis: allocationDue ? 0 : 75,
            maturesAtFrame,
          });
        },
        payoutStateByAccount: async () =>
          registry.createType('PalletStabilizerBuysAccountPayoutState', {
            payableReward,
            nextPayoutFrame: null,
          }),
      },
    },
  };
  const blockWatch = {
    start: async () => undefined,
    finalizedBlockHeader: block,
    events,
    getApi: async () => {
      if (failure) throw new Error('Snapshot RPC unavailable');
      return api;
    },
  } as unknown as BlockWatch;
  blockWatch.getEvents = async header => {
    if (header.blockNumber !== 13) return [];
    return [
      {
        event: {
          section: 'transactionPayment',
          method: 'TransactionFeePaid',
          data: { who: account.toString(), actualFee: 1_000n, tip: 0n },
        },
        phase: { type: 'ApplyExtrinsic', value: 0 },
        topics: [],
      },
    ];
  };
  blockWatch.getBlock = async () =>
    registry.createType('SignedBlock', {
      block: { extrinsics: [registry.createType('Extrinsic', { method: calls.stabilizerBuys.bid(999, 25) })] },
    });
  const db = createTestDb();
  const buys = new StabilizerBuys(blockWatch, account.toString(), db);
  let restarted: StabilizerBuys | undefined;
  buys.data = reactive(buys.data) as StabilizerBuys['data'];
  const visiblePrincipal = computed(() => buys.heldPrincipal);
  const visibleRequestedReward = computed(() =>
    buys.data.frameRewards.reduce((sum, rewards) => sum + (rewards.requestedReward ?? 0n), 0n),
  );

  try {
    failure = true;
    const startup = buys.start();
    void buys.start();
    await vi.waitFor(() => expect(buys.data.error).toBe('Snapshot RPC unavailable'));
    expect(buys.data.isLoaded).toBe(false);
    failure = false;
    await startup;
    expect(visiblePrincipal.value).toBe(100_000_000n);
    expect(visibleRequestedReward.value).toBe(24n);
    expect(buys.data.frameRewards[0]).toMatchObject({ bidCount: 1, latestBid: 33, requestedReward: 24n });
    expect(buys.data.payableReward).toBe(37n);
    expect(buys.data.currentFrameId).toBe(13);
    expect(buys.data.positions[0].isBiddingOpen(buys.data.currentFrameId)).toBe(true);

    failure = true;
    events.emit('finalized', [{ ...block, blockNumber: 11 }]);
    await vi.waitFor(() => expect(buys.data.error).toBe('Snapshot RPC unavailable'));
    expect(visiblePrincipal.value).toBe(100_000_000n);
    expect(buys.data.payableReward).toBe(37n);
    expect(buys.data.isLoaded).toBe(true);
    expect(buys.data.blockNumber).toBe(10);

    failure = false;
    principal = 200_000_000n;
    payableReward = 0n;
    events.emit('finalized', [{ ...block, blockNumber: 12 }]);
    await vi.waitFor(() => expect(buys.data.blockNumber).toBe(12));
    expect(visiblePrincipal.value).toBe(200_000_000n);
    expect(buys.data.payableReward).toBe(0n);
    expect(buys.data.error).toBeUndefined();

    principal = 1n;
    await buys.refresh(block);
    expect(visiblePrincipal.value).toBe(200_000_000n);
    expect(buys.data.blockNumber).toBe(12);

    nextFrameId = 15;
    maturesAtFrame = 42;
    bidPercent = 22;
    budget = 999n;
    await buys.refresh({ ...block, blockNumber: 13, tick: 101 });
    expect(buys.data.auctionsByFrame[12]).toBeDefined();
    expect(buys.data.auctionsByFrame[12].auction.budget).toBe(999n);
    expect(buys.data.auctionsByFrame[12].bids[0].latestBid).toBe(22);
    expect(buys.data.positions[0].isBiddingOpen(buys.data.currentFrameId)).toBe(false);
    expect(buys.data.frameRewards.find(rewards => rewards.admissionFrame === 999)?.bidFees[0].amount).toBe(1_000n);

    bidsUnavailable = true;
    await buys.refresh({ ...block, blockNumber: 14, tick: 102 });
    expect(buys.data.blockNumber).toBe(14);
    expect(buys.data.auctionsByFrame[12].bids[0].latestBid).toBe(22);
    expect(buys.data.auctionsByFrame[999]).toBeUndefined();
    await buys.close();

    // A fresh observer can read closed standings even after the principal has left native storage.
    bidsUnavailable = false;
    hasPurchase = false;
    restarted = new StabilizerBuys(blockWatch, account.toString(), db);
    await restarted.refresh({ ...block, blockNumber: 15, tick: 150 });
    expect(restarted.data.positions).toEqual([]);
    expect(restarted.data.auctionsByFrame[12].auction.budget).toBe(999n);
    expect(restarted.data.auctionsByFrame[12].bids[0].latestBid).toBe(22);

    nextFrameId = 43;
    allocationDue = true;
    await restarted.refresh({ ...block, blockNumber: 16, tick: 151 });
    expect(restarted.data.auctionsByFrame[12].bids).toEqual([]);
    expect(restarted.data.auctionsByFrame[12].auction).toMatchObject({ remainingBudget: 0n });
  } finally {
    await buys.close();
    await restarted?.close();
  }
});

it('shows an upgrade requirement for an absent pallet and becomes available after the runtime changes', async () => {
  const registry = getOfflineRegistry();
  const block = { blockNumber: 10, blockHash: '0x10', tick: 100 } as IBlockHeaderInfo;
  const events = createTypedEventEmitter<{ finalized: (blocks: [IBlockHeaderInfo]) => void }>();
  let upgraded = false;
  const blockWatch = {
    start: async () => undefined,
    finalizedBlockHeader: block,
    events,
    getApi: async () => {
      const miningSlot = { nextFrameId: async () => registry.createType('u64', 14) };
      if (!upgraded) return { registry, query: { miningSlot } };

      return {
        registry,
        query: {
          miningSlot,
          stabilizerBuys: {
            buysByAccountAndFrame: Object.assign(() => undefined, { entries: async () => [] }),
            payoutStateByAccount: async () => registry.createType('PalletStabilizerBuysAccountPayoutState'),
          },
        },
      };
    },
  } as unknown as BlockWatch;
  blockWatch.getEvents = async () => [];
  const buys = new StabilizerBuys(blockWatch, registry.createType('AccountId32').toString(), createTestDb());

  try {
    await buys.load();
    expect(buys.data.isLoaded).toBe(true);
    expect(buys.data.isAvailable).toBe(false);
    expect(buys.data.error).toContain('runtime upgrade');

    upgraded = true;
    events.emit('finalized', [{ ...block, blockNumber: 11 }]);
    await vi.waitFor(() => expect(buys.data.isAvailable).toBe(true));
    expect(buys.data.positions).toEqual([]);
    expect(buys.data.error).toBeUndefined();
  } finally {
    await buys.close();
  }
});
