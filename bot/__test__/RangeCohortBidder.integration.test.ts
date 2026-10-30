import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createKeyringPair, Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { SKIP_E2E } from '@argonprotocol/testing';
import {
  Accountset,
  type ArgonClient,
  getRange,
  MainchainClients,
  NetworkConfig,
  Mining,
  MiningFrames,
  RangeCohortBidder,
  TransactionEvents,
  type TxResult,
  TxSubmitter,
} from '@argonprotocol/apps-core';
import { integrationAccountUri } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import type { IBotActivityBidsSubmitted } from '@argonprotocol/apps-core/src/interfaces/IHistoryFile.ts';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import type { ICohortBidCapacity } from '@argonprotocol/apps-core/src/CohortBidderBase.ts';
import { History } from '../src/History.ts';
import { Storage } from '../src/Storage.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.ts';
import Path from 'node:path';
import { sudoSubmitAndFinalize } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';

describe.skipIf(SKIP_E2E)('Range cohort bidder', { tags: ['isolated-argon-network'] }, () => {
  const fundingAccount = new Keyring({ type: 'sr25519' }).addFromUri(
    integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'funded'),
  );
  const sessionMiniSecretOrMnemonic = mnemonicGenerate();
  const rivalAccount = fundingAccount.derive('//rival');
  const bidders: RangeCohortBidder[] = [];
  let network: Awaited<ReturnType<typeof startArgonTestNetwork>>;
  let clients: MainchainClients;
  let frames: MiningFrames;
  let client: ArgonClient;
  let accountset: Accountset;
  let rival: Accountset;

  beforeAll(async () => {
    // A finalized standing ceiling and a competing batch must fit within the same auction.
    network = await startArgonTestNetwork(`range-bidder-${randomUUID()}`, {
      ticksBetweenSlots: 30,
      profiles: ['bob', 'price-oracle'],
      registerTeardown: false,
    });
    clients = new MainchainClients(network.archiveUrl, () => false);
    client = await clients.get(false);
    NetworkConfig.setNetwork('dev-docker');
    await NetworkConfig.updateConfig(client);
    NetworkConfig.setRuntimeOverride('dev-docker', network.networkConfigOverride);
    await sudoFundWallet({
      client,
      address: fundingAccount.address,
      microgons: 500_000_000n,
      micronots: (await client.query.miningSlot.argonotsPerMiningSeat()) * BigInt(client.consts.mint.maxPossibleMiners),
    });
    frames = new MiningFrames(clients);
    accountset = new Accountset({
      client,
      txSubmitter: fundingAccount,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic,
    });

    if ('auctionRulesStartAt' in client.query.miningSlot) {
      rival = new Accountset({
        client,
        txSubmitter: rivalAccount,
        subaccountRange: getRange(0, 49),
        sessionMiniSecretOrMnemonic: mnemonicGenerate(),
      });
      await sudoFundWallet({
        client,
        address: rivalAccount.address,
        microgons: 100_000_000n,
        micronots:
          (await client.query.miningSlot.argonotsPerMiningSeat()) * BigInt(client.consts.mint.maxPossibleMiners),
      });
      await accountset.registerKeys(network.archiveUrl);
      await rival.registerKeys(network.archiveUrl);
      await frames.load();
    }
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await Promise.allSettled(bidders.map(bidder => bidder.stop(false)));
    await frames?.stop();
    await clients?.disconnect();
    await network?.stop();
  });

  it.for([
    { outcome: 'wins at the clearing price', rivalBid: 400_000n },
    { outcome: 'loses above its ceiling', rivalBid: 2_000_000n },
  ])('$outcome', { timeout: 180_000 }, async ({ rivalBid }, context) => {
    if (!('auctionRulesStartAt' in client.query.miningSlot)) context.skip();
    const frameId = await prepareNextAuction();
    const cohortSize = await client.query.miningSlot.nextCohortSize();
    expect(cohortSize).toBeGreaterThan(1);
    const seats = await accountset.getAvailableMinerAccounts(1);
    const rivalSeats = await rival.getAvailableMinerAccounts(cohortSize);
    expect(seats).toHaveLength(1);
    expect(rivalSeats).toHaveLength(cohortSize);

    expect(await Mining.usesRangeBidding(client, frameId)).toBe(true);

    const capacities: ICohortBidCapacity[] = [];
    const bidder = new RangeCohortBidder(
      accountset,
      frames,
      frameId,
      seats,
      { minBid: 10_000n, maxBid: 1_000_000n, tipPerTransaction: 600_000n },
      { onBidParamsAdjusted: capacity => capacities.push(capacity) },
    );
    bidders.push(bidder);

    // Reproduce an RPC response arriving after the next block. The previous bidder cancelled
    // these valid bids because the queried block was no longer the best block.
    const at = client.raw.at.bind(client.raw);
    const delayed = new WeakSet<object>();
    vi.spyOn(client.raw, 'at').mockImplementation(async (...args) => {
      const api = await at(...args);
      // Reusing a snapshot must not wrap its query again and stack additional block waits.
      if (!delayed.has(api)) {
        delayed.add(api);
        const nextFrameId = api.query.miningSlot.nextFrameId;
        vi.spyOn(api.query.miningSlot, 'nextFrameId').mockImplementation(async (...queryArgs) => {
          const height = frames.blockWatch.bestBlockHeader.blockNumber;
          const result = await nextFrameId(...queryArgs);
          // Delay delivery of the real response; keep the data from the originally queried block.
          await waitFor(10_000, 'canonical head to advance during preflight', () => {
            return frames.blockWatch.bestBlockHeader.blockNumber > height;
          });
          return result;
        });
      }
      return api;
    });

    await bidder.start();
    const established = await waitFor(45_000, 'finalized standing range ceiling', async () => {
      const hash = await client.rpc.chain.getFinalizedHead();
      const api = runtimeClient(await client.at(hash));
      const standing = await api.query.miningSlot.standingBids(seats[0].address);
      if (standing?.max !== 1_000_000n) return;
      const header = await client.rpc.chain.getHeader(hash);
      return { api, blockNumber: header.number.toNumber() };
    });

    // Once the ceiling is established, competition must change price without another bid from us.
    expect(await established.api.query.miningSlot.bidsForNextSlotCohort()).toMatchObject([
      { accountId: seats[0].address, bid: 10_000n },
    ]);
    expect(await established.api.query.miningSlot.standingBids(seats[0].address)).toMatchObject({
      max: 1_000_000n,
      fixed: false,
    });

    const challenge = await rival.createMiningBidTx({ bidAmount: rivalBid, frameId, subaccounts: rivalSeats });
    const challengeResult = await challenge.submit({ useLatestNonce: true, tip: 600_000n });
    await challengeResult.waitForFinalizedBlock;
    expect(challengeResult.extrinsicError).toBeUndefined();
    await waitFor(30_000, 'rival batch settlement', async () => {
      return (await client.query.miningSlot.pendingBids(rivalSeats[0].address)) === null;
    });

    const expectedPrice = rivalBid + client.consts.miningSlot.bidIncrements;
    if (rivalBid < bidder.options.maxBid) {
      await waitFor(30_000, 'published automatic price increase', () => {
        return (
          bidder.myWinningBids.length === seats.length &&
          bidder.myWinningBids.every(bid => bid.bidMicrogons === expectedPrice)
        );
      });
    } else {
      await waitFor(30_000, 'bidder to stop at its ceiling', () => {
        return capacities.some(capacity => capacity.maxSeats === 0 && capacity.reason === 'max-bid-too-low');
      });
    }

    const winners = await bidder.stop(true);
    const finalized = await client.at(await client.rpc.chain.getFinalizedHead());
    const cohort = await finalized.query.miningSlot.minersByCohort(frameId);
    let expectedMiners = rivalSeats.map(seat => seat.address);
    if (rivalBid < bidder.options.maxBid) {
      expectedMiners = [seats[0].address, ...rivalSeats.slice(0, cohortSize - 1).map(seat => seat.address)];
      expect(winners.map(winner => winner.address).sort()).toEqual(seats.map(seat => seat.address).sort());
      for (const winner of winners) expect(winner.bidMicrogons).toBe(expectedPrice);
    } else {
      expect(winners).toEqual([]);
    }
    expect(cohort?.map(miner => miner.accountId).sort()).toEqual(expectedMiners.sort());
    for (const miner of cohort ?? []) {
      if (bidder.myAddresses.has(miner.accountId)) expect(miner.bid).toBe(expectedPrice);
      else expect(miner.bid).toBe(rivalBid);
    }

    const finalizedHeight = frames.blockWatch.finalizedBlockHeader.blockNumber;
    const committedMiners: string[] = [];
    const revealedMiners: string[] = [];
    for (let height = established.blockNumber + 1; height <= finalizedHeight; height += 1) {
      const hash = await client.rpc.chain.getBlockHash(height);
      const api = await client.raw.at(hash);
      for (const { event } of await api.query.system.events()) {
        if (
          client.events.miningSlot.BidCommitted.is(event) &&
          bidder.myAddresses.has(event.data.accountId.toString())
        ) {
          committedMiners.push(event.data.accountId.toString());
        }
        if (client.events.miningSlot.BidRevealed.is(event) && bidder.myAddresses.has(event.data.accountId.toString())) {
          revealedMiners.push(event.data.accountId.toString());
        }
      }
    }
    expect(committedMiners).toEqual([]);
    expect(revealedMiners).toEqual([]);
  });

  it('raises a standing ceiling using existing stake and retains it when settings are lowered', async context => {
    if (!('auctionRulesStartAt' in client.query.miningSlot)) context.skip();
    // This account has no active seat, so mining rewards cannot replenish its zero free stake.
    const renewalFunding = fundingAccount.derive('//ceiling-update');
    const renewalAccountset = new Accountset({
      client,
      txSubmitter: renewalFunding,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic,
    });
    await sudoFundWallet({
      client,
      address: renewalFunding.address,
      microgons: 500_000_000n,
      micronots: (await client.query.miningSlot.argonotsPerMiningSeat()) * BigInt(client.consts.mint.maxPossibleMiners),
    });
    await renewalAccountset.registerKeys(network.archiveUrl);
    const frameId = await prepareNextAuction();
    const seats = await renewalAccountset.getAvailableMinerAccounts(1);
    expect(seats).toHaveLength(1);
    expect(await Mining.usesRangeBidding(client, frameId)).toBe(true);

    const directory = await mkdtemp(Path.join(tmpdir(), 'range-bid-renewal-'));
    const storage = new Storage(directory);
    const history = new History(storage, frameId);
    const callbacks = {
      loadBidMaxima: () => history.getBidMaxima(frameId),
      onBidMaximaPrepared: (maxima: Record<string, bigint>) => history.saveBidMaxima(frameId, maxima),
    };
    const initial = new RangeCohortBidder(
      renewalAccountset,
      frames,
      frameId,
      seats,
      {
        minBid: 10_000n,
        maxBid: 1_000_000n,
        tipPerTransaction: 600_000n,
      },
      callbacks,
    );
    bidders.push(initial);

    try {
      await initial.start();
      await waitFor(30_000, 'initial standing ceiling', async () => {
        return (await client.query.miningSlot.standingBids(seats[0].address))?.max === 1_000_000n;
      });
      await initial.stop(false);

      const maxBid = 1_500_000n;
      const commit = await renewalAccountset.createMiningBidTx({
        subaccounts: seats,
        frameId,
        bidAmount: 10_000n,
        maxBid,
      });
      const commitment = renewalAccountset.miningBidCommitment({
        address: seats[0].address,
        frameId,
        bidAmount: 10_000n,
        maxBid,
      });
      const reveal = await renewalAccountset.createMiningBidMaxTx({
        bids: [{ address: seats[0].address, maxBid, salt: commitment.salt }],
        frameId,
      });
      const tip = 600_000n;
      const fees = (await commit.feeEstimate(tip)) + (await reveal.feeEstimate(tip)) + 2n * tip;
      const currentBid = (await client.query.miningSlot.bidsForNextSlotCohort()).find(
        bid => bid.accountId === seats[0].address,
      )!;
      const staked = (await client.query.ownership.account(renewalFunding.address)).reserved;
      await sudoFundWallet({
        client,
        address: renewalFunding.address,
        microgons: maxBid - currentBid.bid + fees + client.consts.balances.existentialDeposit + 100_000n,
        micronots: 0n,
      });
      expect((await client.query.ownership.account(renewalFunding.address)).reserved).toBe(staked);

      const increased = new RangeCohortBidder(
        renewalAccountset,
        frames,
        frameId,
        seats,
        {
          minBid: 10_000n,
          maxBid,
          tipPerTransaction: tip,
        },
        callbacks,
      );
      bidders.push(increased);
      await increased.start();
      await waitFor(30_000, 'increased standing ceiling without new collateral', async () => {
        return (await client.query.miningSlot.standingBids(seats[0].address))?.max === maxBid;
      });
      expect((await client.query.ownership.account(renewalFunding.address)).free).toBe(0n);
      expect((await client.query.ownership.account(renewalFunding.address)).reserved).toBe(staked);
      expect((await history.getBidMaxima(frameId))[commitment.maxHash]).toBe(maxBid);
      await increased.stop(false);

      expect(await client.query.miningSlot.auctionAdmissionClosed()).toBe(false);
      const lowered = new RangeCohortBidder(
        renewalAccountset,
        frames,
        frameId,
        seats,
        {
          minBid: 10_000n,
          maxBid: 500_000n,
          tipPerTransaction: tip,
        },
        callbacks,
      );
      bidders.push(lowered);
      await lowered.start();
      const lowerStartedAt = lowered.latestBlockNumber;
      await waitFor(30_000, 'lowered settings to observe subsequent blocks', () => {
        return lowered.latestBlockNumber >= lowerStartedAt + 2;
      });
      const observedHash = await client.rpc.chain.getBlockHash(lowered.latestBlockNumber);
      const observed = runtimeClient(await client.at(observedHash));
      expect((await observed.query.miningSlot.standingBids(seats[0].address))?.max).toBe(maxBid);
      const winners = await lowered.stop(true);
      expect(lowered.bidsAttempted).toBe(0);
      expect(winners.map(winner => winner.address)).toEqual([seats[0].address]);
    } finally {
      await Promise.allSettled(bidders.map(bidder => bidder.stop(false)));
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it('reveals the original maximum after restart with a lower ceiling and no new seat goal', async context => {
    if (!('auctionRulesStartAt' in client.query.miningSlot)) context.skip();
    const frameId = await prepareNextAuction();
    if (!(await Mining.usesRangeBidding(client, frameId))) context.skip();

    const seats = await accountset.getAvailableMinerAccounts(5);
    expect(seats).toHaveLength(5);

    const directory = await mkdtemp(Path.join(tmpdir(), 'range-bid-restart-'));
    const storage = new Storage(directory);
    const history = new History(storage, frameId);
    const maxima: Record<string, bigint> = {};
    for (const { address } of seats) {
      const { maxHash } = accountset.miningBidCommitment({ address, frameId, bidAmount: 10_000n, maxBid: 1_000_000n });
      maxima[maxHash] = 1_000_000n;
    }
    await history.saveBidMaxima(frameId, maxima);
    let restoredStorage: Storage | undefined;

    try {
      const submission = await accountset.createMiningBidTx({
        bidAmount: 10_000n,
        maxBid: 1_000_000n,
        frameId,
        subaccounts: seats,
      });
      const commitment = await submission.submit({ useLatestNonce: true, tip: 600_000n });
      await commitment.waitForInFirstBlock;
      expect(commitment.extrinsicError).toBeUndefined();
      await storage.close();
      restoredStorage = new Storage(directory);
      const restoredHistory = new History(restoredStorage, frameId);

      const restarted = new Accountset({
        client,
        txSubmitter: fundingAccount,
        subaccountRange: getRange(0, 49),
        sessionMiniSecretOrMnemonic,
      });
      const bidder = new RangeCohortBidder(
        restarted,
        frames,
        frameId,
        [],
        { minBid: 10_000n, maxBid: 500_000n, maxSeats: 0, tipPerTransaction: 600_000n },
        { loadBidMaxima: () => restoredHistory.getBidMaxima(frameId) },
      );
      bidders.push(bidder);

      const starting = bidder.start();
      const closing = bidder.stop(true);
      await starting;
      const winners = await closing;
      const expectedMiners = seats.map(seat => seat.address).sort();
      expect(winners.map(winner => winner.address).sort()).toEqual(expectedMiners);

      const constants = client.consts.miningSlot;
      if (!('bidRevealBlocks' in constants)) throw new Error('Range bidding reveal window is unavailable');
      const revealBlocks = constants.bidRevealBlocks;
      const revealedMiners = new Set<string>();
      for (let height = commitment.blockNumber! + 1; height <= commitment.blockNumber! + revealBlocks; height += 1) {
        const hash = await client.rpc.chain.getBlockHash(height);
        const api = await client.raw.at(hash);
        const events = await api.query.system.events();
        for (const { event } of events) {
          if (client.events.miningSlot.BidRevealed.is(event)) {
            revealedMiners.add(event.data.accountId.toString());
            expect(height).toBeGreaterThanOrEqual(commitment.blockNumber! + 4);
          }
        }
      }
      expect([...revealedMiners].sort()).toEqual(expectedMiners);
      const settledHash = await client.rpc.chain.getBlockHash(commitment.blockNumber! + revealBlocks);
      const settled = runtimeClient(await client.at(settledHash));
      const standing = await settled.query.miningSlot.standingBids.multi(seats.map(seat => seat.address));
      for (const bid of standing ?? []) expect(bid?.max).toBe(1_000_000n);
      expect(bidder.bidsAttempted).toBe(0);
    } finally {
      await storage.close();
      await restoredStorage?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it('commits its ceiling in the first sponsored bid and accounts for both transaction fees', async context => {
    if (!('auctionRulesStartAt' in client.query.miningSlot)) context.skip();
    const proxyAccount = createKeyringPair({});
    const proxyAccountset = new Accountset({
      client,
      fundingAccountId: fundingAccount.address,
      isProxy: true,
      txSubmitter: proxyAccount,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic,
    });
    const setup = await proxyAccountset.planMiningBidProxySetup();
    if (setup.kind !== 'tx') throw new Error(`Expected proxy setup transaction, got ${setup.kind}`);
    const setupResult = await new TxSubmitter(client, setup.tx, fundingAccount).submit({ useLatestNonce: true });
    await setupResult.waitForFinalizedBlock;

    const frameId = await prepareNextAuction();
    if (!(await Mining.usesRangeBidding(client, frameId))) context.skip();

    const seats = await proxyAccountset.getAvailableMinerAccounts(5);
    expect(seats).toHaveLength(5);
    const submittedBids: IBotActivityBidsSubmitted[] = [];
    const bidder = new RangeCohortBidder(
      proxyAccountset,
      frames,
      frameId,
      seats,
      { minBid: 10_000n, maxBid: 1_000_000n, tipPerTransaction: 600_000n },
      { onBidsSubmitted: bid => submittedBids.push(bid) },
    );
    bidders.push(bidder);

    const startingBlock = (await client.rpc.chain.getHeader()).number.toNumber();
    await bidder.start();
    const commitment = await waitFor(30_000, 'proxy commitment submission', async () => bidder.pendingBidTxResult);
    const winners = await bidder.stop(true);
    expect(winners.map(winner => winner.address).sort()).toEqual(seats.map(seat => seat.address).sort());
    await commitment.waitForFinalizedBlock;

    const committedApi = runtimeClient(await client.at(commitment.blockHash!));
    const pending = await committedApi.query.miningSlot.pendingBids.multi(seats.map(seat => seat.address));
    expect(pending).toHaveLength(5);
    for (const [index, { address }] of seats.entries()) {
      expect(pending?.[index]).toMatchObject({
        miner: address,
        funding: fundingAccount.address,
        frame: frameId,
        bid: 10_000n,
        max: null,
        maxHash: proxyAccountset.miningBidCommitment({
          address,
          bidAmount: 10_000n,
          maxBid: 1_000_000n,
          frameId,
        }).maxHash,
      });
    }

    const constants = client.consts.miningSlot;
    if (!('bidRevealBlocks' in constants)) throw new Error('Range bidding reveal window is unavailable');
    const settlementHash = await client.rpc.chain.getBlockHash(commitment.blockNumber! + constants.bidRevealBlocks);
    const settlementApi = runtimeClient(await client.at(settlementHash));
    const standing = await settlementApi.query.miningSlot.standingBids.multi(seats.map(seat => seat.address));
    expect(standing).toHaveLength(5);
    for (const index of seats.keys()) {
      expect(standing?.[index]).toMatchObject({
        max: 1_000_000n,
        fixed: false,
        submittedAt: commitment.blockNumber,
      });
    }

    const finalizedHash = await client.rpc.chain.getFinalizedHead();
    const finalizedBlock = (await client.rpc.chain.getHeader(finalizedHash)).number.toNumber();
    const transactionFees: bigint[] = [];
    for (let height = startingBlock; height <= finalizedBlock; height += 1) {
      const hash = await client.rpc.chain.getBlockHash(height);
      const [block, api] = await Promise.all([client.rpc.chain.getBlock(hash), client.raw.at(hash)]);
      const events = await api.query.system.events();
      for (const { phase, event } of events) {
        if (!phase.isApplyExtrinsic) continue;
        const extrinsic = block.block.extrinsics[phase.asApplyExtrinsic.toNumber()];
        if (!extrinsic.isSigned || !extrinsic.signer.eq(proxyAccount.address)) continue;
        if (client.events.transactionPayment.TransactionFeePaid.is(event)) {
          expect(event.data.who.eq(fundingAccount.address)).toBe(true);
          transactionFees.push(event.data.actualFee.toBigInt());
        }
      }
    }

    expect(transactionFees).toHaveLength(2);
    expect(transactionFees.every(fee => fee <= 1_000_000n)).toBe(true);
    const totalFees = transactionFees.reduce((total, fee) => total + fee, 0n);
    expect(totalFees).toBeGreaterThan(1_000_000n);
    expect(bidder.txFees).toBe(totalFees);
    expect(submittedBids).toEqual([
      expect.objectContaining({ microgonsPerSeat: 10_000n, maxMicrogonsPerSeat: 1_000_000n, submittedCount: 5 }),
    ]);
    const proxyBalance = await client.query.system.account(proxyAccount.address);
    expect(proxyBalance.data.free).toBe(1_000_000n);
  }, 180_000);

  it('retries a failed sponsored reveal in the last legal block after funding arrives', async context => {
    if (!('auctionRulesStartAt' in client.query.miningSlot)) context.skip();
    const funding = fundingAccount.derive('//reveal-retry');
    const proxy = createKeyringPair({});
    const accounts = new Accountset({
      client,
      fundingAccountId: funding.address,
      isProxy: true,
      txSubmitter: proxy,
      subaccountRange: [0],
      sessionMiniSecretOrMnemonic,
    });
    await sudoFundWallet({
      client,
      address: funding.address,
      microgons: 50_000_000n,
      micronots: (await client.query.miningSlot.argonotsPerMiningSeat()) * BigInt(client.consts.mint.maxPossibleMiners),
    });
    await accounts.registerKeys(network.archiveUrl);
    const setup = await accounts.planMiningBidProxySetup();
    if (setup.kind !== 'tx') throw new Error(`Expected proxy setup transaction, got ${setup.kind}`);
    const setupResult = await new TxSubmitter(client, setup.tx, funding).submit({ useLatestNonce: true });
    await setupResult.waitForFinalizedBlock;

    // Both calls can pay their fees, but the first reveal's fee leaves less than its maximum.
    await sudoSubmitAndFinalize(client, client.tx.balances.forceSetBalance(funding.address, 6_000_000n));
    const frameId = await prepareNextAuction();
    const seats = await accounts.getAvailableMinerAccounts(1);
    expect(seats).toHaveLength(1);
    const submission = await accounts.createMiningBidTx({
      subaccounts: seats,
      frameId,
      bidAmount: 10_000n,
      maxBid: 5_000_000n,
    });
    const commitment = await submission.submit({ useLatestNonce: true, tip: 600_000n });
    await commitment.waitForInFirstBlock;
    expect(commitment.extrinsicError).toBeUndefined();
    const free = (await client.query.system.account(funding.address)).data.free;
    expect(free).toBeGreaterThan(5_000_000n);
    expect(free).toBeLessThan(5_600_000n);

    const constants = client.consts.miningSlot;
    if (!('bidRevealBlocks' in constants)) throw new Error('Range bidding reveal window is unavailable');
    const deadline = commitment.blockNumber! + constants.bidRevealBlocks;
    let refill: Promise<TxResult> | undefined;
    // Queue a lower-priority refill after broadcasting the first reveal: it executes after the failed call.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with its original receiver below
    const submitSigned = TxSubmitter.prototype.submitSigned;
    const observeSubmission = vi.spyOn(TxSubmitter.prototype, 'submitSigned').mockImplementation(async function (
      this: TxSubmitter,
      signedTx,
      options,
    ) {
      const result = await submitSigned.call(this, signedTx, options);
      if (this.address === proxy.address && !refill) {
        refill = new TxSubmitter(
          client,
          client.tx.balances.transferKeepAlive(funding.address, 10_000_000n),
          fundingAccount,
        ).submit({ useLatestNonce: true });
      }
      return result;
    });
    const bidder = new RangeCohortBidder(accounts, frames, frameId, seats, {
      minBid: 10_000n,
      maxBid: 5_000_000n,
      tipPerTransaction: 600_000n,
    });
    bidder.isBiddingOpen = false;
    bidders.push(bidder);

    try {
      await bidder.start();
      const settled = await waitFor(45_000, 'finalized reveal settlement', async () => {
        const hash = await client.rpc.chain.getFinalizedHead();
        if ((await client.rpc.chain.getHeader(hash)).number.toNumber() < deadline) return;
        return runtimeClient(await client.at(await client.rpc.chain.getBlockHash(deadline)));
      });
      const refillResult = await refill;
      expect(refillResult).toBeDefined();
      await refillResult!.waitForFinalizedBlock;
      expect(refillResult!.extrinsicError).toBeUndefined();
      expect(refillResult!.blockNumber).toBeLessThanOrEqual(deadline);

      const receipts = [];
      for (const height of [deadline - 1, deadline]) {
        const header = await frames.blockWatch.getHeader(height);
        const block = await frames.blockWatch.getBlock(header);
        for (const extrinsic of block.block.extrinsics) {
          if (!extrinsic.isSigned || !extrinsic.signer.eq(proxy.address)) continue;
          receipts.push(
            (await TransactionEvents.findByExtrinsicHashInBlock({
              blockWatch: frames.blockWatch,
              extrinsicHash: extrinsic.hash.toHex(),
              block: header,
            }))!,
          );
        }
      }
      expect(receipts[0]?.error?.errorCode).toBe('miningSlot.InsufficientFunds');
      expect(await settled.query.miningSlot.standingBids(seats[0].address)).toMatchObject({ max: 5_000_000n });
      expect(receipts).toHaveLength(2);
      expect(receipts[0].blockNumber).toBe(deadline - 1);
      expect(receipts[1].blockNumber).toBe(deadline);
      expect(receipts[1].error).toBeUndefined();

      expect(await settled.query.miningSlot.bidsForNextSlotCohort()).toMatchObject([
        { accountId: seats[0].address, bid: 10_000n },
      ]);
      const expectedFees = receipts.reduce((sum, receipt) => sum + receipt.fee, 0n);
      await waitFor(30_000, 'both finalized reveal fees', () => bidder.txFees === expectedFees);
    } finally {
      observeSubmission.mockRestore();
      await bidder.stop(false);
    }
  }, 180_000);

  async function prepareNextAuction() {
    const startingFrame = await client.query.miningSlot.nextFrameId();
    const frameId = await waitFor(120_000, 'next open auction', async () => {
      const header = frames.blockWatch.bestBlockHeader;
      const api = runtimeClient(await client.at(header.blockHash));
      const [frameId, open] = await Promise.all([
        api.query.miningSlot.nextFrameId(),
        api.query.miningSlot.isNextSlotBiddingOpen(),
      ]);
      if (frameId > startingFrame && open && header.frameId! + 1 === frameId) return frameId;
    });
    const requiredStake =
      (await client.query.miningSlot.argonotsPerMiningSeat()) * BigInt(client.consts.mint.maxPossibleMiners);
    const addresses = [fundingAccount.address, rivalAccount.address];
    const balances = await client.query.ownership.account.multi(addresses);
    const funding = [];
    for (const [index, address] of addresses.entries()) {
      if (balances[index].free < requiredStake)
        funding.push(client.tx.ownership.forceSetBalance(address, requiredStake));
    }
    if (funding.length) {
      const result = await sudoSubmitAndFinalize(client, client.tx.utility.batchAll(funding), { useLatestNonce: true });
      expect(result.extrinsicError).toBeUndefined();
    }
    return frameId;
  }
});
