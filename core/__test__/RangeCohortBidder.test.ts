import { afterEach, expect, it, vi } from 'vitest';
import { Keyring, mnemonicGenerate, hexToU8a, getOfflineRegistry } from '@argonprotocol/mainchain';
import { runtimeClient } from '@argonprotocol/runtime-client';
import {
  Accountset,
  type ArgonClient,
  BlockWatch,
  CohortBidder,
  createTypedEventEmitter,
  type IBlockHeaderInfo,
  type MainchainClients,
  MiningFrames,
  NetworkConfig,
  RangeCohortBidder,
  TxResult,
  TxSubmitter,
} from '../src/index.ts';

afterEach(() => vi.restoreAllMocks());

it.for([
  { available: 24_000n, fee: 1_000n },
  { available: 110_000n, fee: 10_000n },
])('raises an affordable standing ceiling with $available remaining before fees', async ({ available, fee }) => {
  const { bidder, accountset, blockWatch } = createReceiptScenario();
  const registry = getOfflineRegistry();
  const accounts = accountset.getAccountsInRange([0, 1]).map(account => ({ ...account, isRebid: false }));
  Object.assign(bidder, { subaccounts: accounts, nextCohortSize: 10, minIncrement: 10_000n });
  bidder.options.maxBid = 200_000n;
  for (const [index, account] of accounts.entries()) {
    bidder.myAddresses.add(account.address);
    bidder.currentBids.bids.push({
      address: account.address,
      bidMicrogons: 10_000n,
      micronotsStaked: 10_000n,
      bidAtTick: 100,
      maxMicrogons: index === 0 ? 100_000n : 190_000n,
      fundedMaxMicrogons: index === 0 ? 100_000n : 190_000n,
    });
  }

  // Preserve both existing ceilings and ED before funding any increases or fees.
  const pallet = registry.metadata.pallets.find(entry => entry.name.eq('MiningSlot'))!;
  const bidMeta = registry.lookup
    .getSiType(pallet.calls.unwrap().type)
    .def.asVariant.variants.find(entry => entry.name.eq('bid'))!;
  const api = runtimeClient({
    registry,
    genesisHash: registry.createType('H256', `0x${'00'.repeat(32)}`),
    consts: { balances: { existentialDeposit: 10_000n } },
    tx: { miningSlot: { bid: { meta: bidMeta } } },
    query: {
      system: {
        account: async () =>
          registry.createType('FrameSystemAccountInfo', { providers: 1, data: { free: 280_000n + available } }),
      },
      ownership: { account: async () => registry.createType('PalletBalancesAccountData', { free: 0n }) },
    },
  });
  Object.assign(accountset, { client: api });
  const submitter = new TxSubmitter(
    api as unknown as ArgonClient,
    registry.createType('Extrinsic') as never,
    accountset.txSubmitterPair,
  );
  vi.spyOn(submitter, 'feeEstimate').mockResolvedValue(fee);
  vi.spyOn(accountset, 'createMiningBidTx').mockResolvedValue(submitter);
  vi.spyOn(accountset, 'createMiningBidMaxTx').mockResolvedValue(submitter);

  // @ts-expect-error exercise the real budget decision with only chain reads and fee estimation mocked
  await bidder.planBid(blockHeader(100), bidder.options, api);
  expect(bidder.nextBid?.subaccounts).toEqual([accounts[1].address]);
  expect(bidder.nextBid?.microgonsPerSeat).toBe(10_000n);
  blockWatch.destroy();
});

it('keeps the fixed bidder until the upgraded runtime activates range bidding for the next auction', async () => {
  const { bidder, accountset, blockWatch } = createReceiptScenario();
  const registry = getOfflineRegistry();
  const api = { query: { miningSlot: {} } };
  Object.assign(accountset, { client: runtimeClient(api) });
  const options = { minBid: 10_000n, maxBid: 1_000_000n, bidDelay: 0, bidIncrement: 10_000n };
  const original = await CohortBidder.create(accountset, bidder.miningFrames, 10, bidder.subaccounts, options);
  Object.assign(api, {
    query: { miningSlot: { auctionRulesStartAt: async () => registry.createType('u64', 11) } },
  });
  const current = await CohortBidder.create(accountset, bidder.miningFrames, 10, bidder.subaccounts, options);
  const next = await CohortBidder.create(accountset, bidder.miningFrames, 11, bidder.subaccounts, options);

  expect(original).toBeInstanceOf(CohortBidder);
  expect(current).toBeInstanceOf(CohortBidder);
  expect(current.cohortStartingFrameId).toBe(10);
  expect(next).toBeInstanceOf(RangeCohortBidder);
  expect(next.cohortStartingFrameId).toBe(11);
  blockWatch.destroy();
});

it('waits three blocks from canonical commitment inclusion, including a reorg during signing', async () => {
  const { bidder, accountset, blockWatch } = createReceiptScenario();
  const registry = getOfflineRegistry();
  const pallet = registry.metadata.pallets.find(entry => entry.name.eq('MiningSlot'))!;
  const bidMeta = registry.lookup
    .getSiType(pallet.calls.unwrap().type)
    .def.asVariant.variants.find(entry => entry.name.eq('bid'))!;
  let canonicalInclusion = 100;
  let maxHash = '';
  const client = runtimeClient({
    registry,
    genesisHash: registry.createType('H256', `0x${'00'.repeat(32)}`),
    consts: { miningSlot: { bidRevealBlocks: 5 } },
    tx: { miningSlot: { bid: { meta: bidMeta } } },
    query: {
      miningSlot: {
        pendingBids: {
          multi: async () => [
            registry.createType('Option<PalletMiningSlotPendingBid>', {
              block: canonicalInclusion,
              frame: 10,
              funding: accountset.fundingAccountId,
              miner: bidder.subaccounts[0].address,
              bid: 10_000n,
              maxHash,
            }),
          ],
        },
      },
    },
    at: async () => client,
  }) as unknown as ArgonClient;
  blockWatch.subscriptionClient = client;
  Object.assign(accountset, { client });
  maxHash = accountset.miningBidCommitment({
    address: bidder.subaccounts[0].address,
    bidAmount: 10_000n,
    maxBid: 1_000_000n,
    frameId: 10,
  }).maxHash;

  const submitter = new TxSubmitter(client, registry.createType('Extrinsic') as never, accountset.txSubmitterPair);
  vi.spyOn(accountset, 'createMiningBidMaxTx').mockResolvedValue(submitter);
  let reorgDuringSigning = true;
  vi.spyOn(submitter, 'signMortal').mockImplementation(async () => {
    if (reorgDuringSigning) {
      canonicalInclusion = 102;
      blockWatch.latestHeaders.push(blockHeader(104));
      reorgDuringSigning = false;
    }
    return { signedTx: submitter.tx, birthBlock: 96, deathBlock: 108, tip: 0n };
  });
  const submittedAt: number[] = [];
  const result = receipt(0);
  vi.spyOn(submitter, 'submitSigned').mockImplementation(async () => {
    submittedAt.push(blockWatch.bestBlockHeader.blockNumber);
    return result;
  });

  try {
    blockWatch.latestHeaders.push(blockHeader(103));
    const original = (await client.query.miningSlot.pendingBids.multi([bidder.subaccounts[0].address]))!.filter(
      bid => bid !== null,
    );
    // @ts-expect-error exercise the reveal decision with signing and chain RPC as external boundaries
    await bidder.revealMaxima(original, blockWatch.bestBlockHeader);
    expect(submittedAt).toEqual([]);

    const moved = (await client.query.miningSlot.pendingBids.multi([bidder.subaccounts[0].address]))!.filter(
      bid => bid !== null,
    );
    // @ts-expect-error the replacement inclusion is only two blocks old
    await bidder.revealMaxima(moved, blockWatch.bestBlockHeader);
    expect(submittedAt).toEqual([]);

    blockWatch.latestHeaders.push(blockHeader(105));
    // @ts-expect-error the canonical inclusion has now aged three blocks
    await bidder.revealMaxima(moved, blockWatch.bestBlockHeader);
    expect(submittedAt).toEqual([105]);
  } finally {
    result.submissionError = new Error('Test transaction transport closed');
    await bidder.stop(false);
    blockWatch.destroy();
  }
});

it('preserves each bidder’s finalized winner scope when other miners share the funding account', async () => {
  const { bidder, blockWatch, accountset } = createReceiptScenario();
  const managedAddress = bidder.subaccounts[0].address;
  const otherAddress = new Keyring({ type: 'sr25519' }).addFromUri('//Bob').address;
  const registry = getOfflineRegistry();
  const winners = registry.createType(
    'Vec<ArgonPrimitivesBlockSealMiningRegistration>',
    [managedAddress, otherAddress].map(accountId => ({
      accountId,
      externalFundingAccount: accountset.fundingAccountId,
      bid: 10_000n,
      argonots: 10_000n,
    })),
  );
  const header = { ...blockHeader(110), frameId: 10, isFinalized: true };
  blockWatch.latestHeaders = [header];
  blockWatch.subscriptionClient = runtimeClient({
    query: {},
    rpc: { chain: { getFinalizedHead: async () => header.blockHash } },
    at: async () => ({ query: { miningSlot: { minersByCohort: async () => winners } } }),
  }) as unknown as ArgonClient;

  const rangeWinners = await bidder.stop(true);
  expect(rangeWinners.map(winner => winner.address)).toEqual([managedAddress]);

  const fixedPrice = new CohortBidder(accountset, bidder.miningFrames, 10, bidder.subaccounts, {
    minBid: 10_000n,
    maxBid: 1_000_000n,
    bidDelay: 1,
    bidIncrement: 10_000n,
  });
  const fixedPriceWinners = await fixedPrice.stop(true);
  expect(fixedPriceWinners.map(winner => winner.address)).toEqual([managedAddress, otherAddress]);
  blockWatch.destroy();
});

it('keeps a pending reveal in flight and permits replacement when its canonical inclusion is reorged', async () => {
  const { bidder, blockWatch, accountset } = createReceiptScenario();
  const registry = getOfflineRegistry();
  const client = runtimeClient({ registry, query: {} }) as unknown as ArgonClient;
  blockWatch.subscriptionClient = client;
  const extrinsic = registry.createType('Extrinsic');
  const pending = registry.createType('SignedBlock', { block: { header: { number: 103 }, extrinsics: [] } });
  const included = registry.createType('SignedBlock', {
    block: { header: { number: 104 }, extrinsics: [extrinsic] },
  });
  const reorged = registry.createType('SignedBlock', {
    block: { header: { number: 104, stateRoot: `0x${'11'.repeat(32)}` }, extrinsics: [] },
  });
  let currentBlock = included;
  vi.spyOn(blockWatch, 'getRpcClient').mockResolvedValue(client);
  vi.spyOn(blockWatch, 'getBlock').mockImplementation(async block => {
    if (block.blockNumber === 103) return pending;
    return currentBlock;
  });
  vi.spyOn(blockWatch, 'getEvents').mockResolvedValue([
    {
      phase: { type: 'ApplyExtrinsic', value: 0 },
      event: {
        section: 'transactionPayment',
        method: 'TransactionFeePaid',
        data: { who: accountset.fundingAccountId, actualFee: 100n, tip: 0n },
      },
      topics: [],
    },
  ]);
  const result = receipt(0);
  result.extrinsic.signedHash = extrinsic.hash.toHex();
  result.extrinsic.submittedAtBlockNumber = 103;
  Object.assign(bidder, { revealAttempt: { txResult: result, tip: 0n } });

  try {
    blockWatch.latestHeaders.push({ ...blockHeader(103), blockHash: pending.block.header.hash.toHex() });
    // @ts-expect-error exercise real receipt lookup with only block/event RPC boundaries mocked
    expect(await bidder.reconcileReveal(blockWatch.bestBlockHeader)).toBe(false);
    expect(result.blockNumber).toBeUndefined();

    blockWatch.latestHeaders.push({ ...blockHeader(104), blockHash: included.block.header.hash.toHex() });
    // @ts-expect-error canonical inclusion consumes the nonce without waiting for finalization
    expect(await bidder.reconcileReveal(blockWatch.bestBlockHeader)).toBe(true);
    expect(result.blockNumber).toBe(104);
    expect(result.finalFee).toBe(100n);
    expect(result.isFinalized).toBe(false);

    currentBlock = reorged;
    blockWatch.latestHeaders.pop();
    blockWatch.latestHeaders.push({ ...blockHeader(104), blockHash: reorged.block.header.hash.toHex() });
    // @ts-expect-error the missing canonical receipt now permits a nonce-aware replacement
    expect(await bidder.reconcileReveal(blockWatch.bestBlockHeader)).toBe(true);
    expect(result.isFinalized).toBe(false);
  } finally {
    blockWatch.destroy();
  }
});

it('publishes the finalized bid when its first inclusion header lookup fails', async () => {
  const { bidder, blockWatch, accountset, bid } = createReceiptScenario();
  const header = blockHeader(101);
  const getHeader = vi
    .spyOn(blockWatch, 'getHeader')
    .mockRejectedValueOnce(new Error('temporary RPC failure'))
    .mockResolvedValue(header);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const result = receipt(0);
  // @ts-expect-error exercise the real receipt observer at its external transaction boundary
  bidder.trackReceipt(result, 108, { ...bid, txResult: result, deathBlock: 108 });
  blockWatch.latestHeaders.push(header);
  await result.setSeenInBlock(accountset.client, {
    blockNumber: 101,
    blockHash: hexToU8a(header.blockHash),
    extrinsicIndex: 0,
    events: [],
  });
  await vi.waitFor(() => expect(getHeader).toHaveBeenCalledOnce());
  expect(bidder.lastBid).toBeUndefined();

  await result.setFinalized(accountset.client);
  await vi.waitFor(() => expect(bidder.lastBid?.isFinalized).toBe(true));
  expect(bidder.lastBid).toMatchObject({ submittedAtTick: 100, microgonsPerSeat: 10_000n, seats: 1, seatsWon: 0 });
  await bidder.stop(false);
  blockWatch.destroy();
});

it('keeps a newer included bid when an older bid finalizes in the same tick', async () => {
  const { bidder, blockWatch, accountset, bid } = createReceiptScenario();
  vi.spyOn(blockWatch, 'getHeader').mockImplementation(async block =>
    blockHeader(typeof block === 'number' ? block : block.blockNumber),
  );
  const first = receipt(0);
  // @ts-expect-error exercise the real receipt observer at its external transaction boundary
  bidder.trackReceipt(first, 108, { ...bid, txResult: first, deathBlock: 108 });
  blockWatch.latestHeaders.push(blockHeader(101));
  await first.setSeenInBlock(accountset.client, {
    blockNumber: 101,
    blockHash: hexToU8a(blockHeader(101).blockHash),
    extrinsicIndex: 0,
    events: [],
  });
  await vi.waitFor(() => expect(bidder.lastBid?.microgonsPerSeat).toBe(10_000n));

  const second = receipt(1);
  // @ts-expect-error exercise overlapping real receipt observers, with only header RPC mocked
  bidder.trackReceipt(second, 115, {
    txResult: second,
    deathBlock: 115,
    ...bid,
    subaccounts: [...bid.subaccounts],
    microgonsPerSeat: 20_000n,
  });
  blockWatch.latestHeaders.push(blockHeader(107));
  await second.setSeenInBlock(accountset.client, {
    blockNumber: 107,
    blockHash: hexToU8a(blockHeader(107).blockHash),
    extrinsicIndex: 0,
    events: [],
  });
  await vi.waitFor(() => expect(bidder.lastBid?.microgonsPerSeat).toBe(20_000n));
  await first.setFinalized(accountset.client);
  await new Promise(setImmediate);
  expect(bidder.lastBid).toMatchObject({ submittedAtTick: 100, microgonsPerSeat: 20_000n, isFinalized: false });

  await second.setFinalized(accountset.client);
  await vi.waitFor(() => expect(bidder.lastBid?.isFinalized).toBe(true));
  expect(bidder.lastBid?.microgonsPerSeat).toBe(20_000n);
  await bidder.stop(false);
  blockWatch.destroy();
});

it('clears its published pending bid when receipt reconciliation fails before finalization', async () => {
  const { bidder, blockWatch, accountset, bid } = createReceiptScenario();
  const header = blockHeader(101);
  vi.spyOn(blockWatch, 'getHeader').mockResolvedValue(header);
  const result = receipt(0);
  // @ts-expect-error exercise the real observer of the submitted transaction
  bidder.trackReceipt(result, 108, { ...bid, txResult: result, deathBlock: 108 });
  blockWatch.latestHeaders.push(header);
  await result.setSeenInBlock(accountset.client, {
    blockNumber: 101,
    blockHash: hexToU8a(header.blockHash),
    extrinsicIndex: 0,
    events: [],
  });
  await vi.waitFor(() => expect(bidder.lastBid?.isFinalized).toBe(false));

  result.submissionError = new Error('Recovered bid transaction was reorged before finalization');
  await vi.waitFor(() => expect(bidder.lastBid).toBeUndefined());
  await bidder.stop(false);
  blockWatch.destroy();
});

function createReceiptScenario() {
  NetworkConfig.setNetwork('dev-docker');
  const clients = { events: createTypedEventEmitter() } as MainchainClients;
  const blockWatch = new BlockWatch(clients);
  blockWatch.latestHeaders.push(blockHeader(100));
  const frames = new MiningFrames(clients, blockWatch);
  const accountset = new Accountset({
    client: blockWatch.subscriptionClient,
    txSubmitter: new Keyring({ type: 'sr25519' }).addFromUri('//Alice'),
    sessionMiniSecretOrMnemonic: mnemonicGenerate(),
  });
  const accounts = accountset.getAccountsInRange([0]).map(account => ({ ...account, isRebid: false }));
  const bidder = new RangeCohortBidder(accountset, frames, 10, accounts, { minBid: 10_000n, maxBid: 1_000_000n });
  const bid = {
    microgonsPerSeat: 10_000n,
    subaccounts: accounts.map(account => account.address),
    alreadyWinningSeats: 0,
    bidAtTick: 100,
    tip: 0n,
  };
  return { bidder, blockWatch, accountset, bid };
}

function receipt(nonce: number) {
  return new TxResult({
    signedHash: `0x${(nonce + 1).toString(16).padStart(64, '0')}`,
    method: {},
    submittedTime: new Date(0),
    submittedAtBlockNumber: 100,
    accountAddress: 'synthetic-signer',
    nonce,
  });
}

function blockHeader(blockNumber: number): IBlockHeaderInfo {
  return {
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    parentHash: `0x${'00'.repeat(32)}`,
    tick: 100,
    frameId: 9,
    frameRewardTicksRemaining: 20,
    isFinalized: false,
    blockTime: 100_000,
    author: '',
  };
}
