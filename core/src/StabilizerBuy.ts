import type { LiveQueryRecord } from '@argonprotocol/runtime-client';
import { runtimeClient, toPlain } from '@argonprotocol/runtime-client';
import { encodeAddress, type SignedBlock } from '@argonprotocol/mainchain';
import { toArgonAccountIdHex } from './Ethereum.js';
import { GenericCall } from '@polkadot/types/generic';
import { Vec } from '@polkadot/types-codec';
import type { ArgonClient, ArgonCurrentQueryClient } from './MainchainClients.js';
import type { PreviousRuntimeSpec } from './runtimeCompatibility.js';
import type BigNumber from 'bignumber.js';
import { bigNumberToBigInt } from './utils.js';
import { maxUint128 } from 'viem';

type Purchase = NonNullable<LiveQueryRecord<'stabilizerBuys', 'buysByAccountAndFrame'>>;
type Auction = NonNullable<LiveQueryRecord<'stabilizerBuys', 'auctions'>>;
type LiquidRepayment = NonNullable<LiveQueryRecord<'stabilizerBuys', 'liquidRepaysByAccountAndGatewayNonce'>>;

export interface IStabilizerBuyBid {
  ownerAccount: string;
  latestBid: number;
  matchingBasis: bigint;
  requestedReward: bigint;
  fundingEstimate: bigint;
}

export class StabilizerBuysUnavailableError extends Error {
  constructor() {
    super('Stabilizer Buys requires an Argon runtime upgrade.');
    this.name = 'StabilizerBuysUnavailableError';
  }
}

/** One account's held principal and requested reward in an admission-frame auction. */
export class StabilizerBuy {
  constructor(
    public readonly admissionFrame: number,
    public readonly purchase: Purchase,
    public readonly auction: Auction,
    public readonly liquidRepayments: readonly LiquidRepayment[] = [],
  ) {}

  /** Origin-preserving bids retain their frames even when dispatch failed without BidSubmitted. */
  public static getBidAdmissionFrames(call: SignedBlock['block']['extrinsics'][number]['method']): number[] {
    if (call.section === 'stabilizerBuys' && call.method === 'bid') return [toPlain(call.args[0], 'number') as number];

    // Utility batches preserve the signer. Proxy and sudo calls can bid for another account.
    if (call.section !== 'utility' || !['batch', 'batchAll', 'forceBatch'].includes(call.method)) return [];

    const frames: number[] = [];
    for (const arg of call.args) {
      if (arg instanceof GenericCall) {
        frames.push(...this.getBidAdmissionFrames(arg));
        continue;
      }
      if (!(arg instanceof Vec)) continue;
      for (const nested of arg) {
        if (nested instanceof GenericCall) frames.push(...this.getBidAdmissionFrames(nested));
      }
    }

    return frames;
  }

  public static async getForAccount(client: ArgonCurrentQueryClient, account: string) {
    const entriesQuery = client.query.stabilizerBuys.buysByAccountAndFrame.entries(account);
    if (!entriesQuery) throw new StabilizerBuysUnavailableError();

    const [entries, buys, repaymentEntries] = await Promise.all([
      entriesQuery,
      client.query.stabilizerBuys.payoutStateByAccount(account),
      client.query.stabilizerBuys.liquidRepaysByAccountAndGatewayNonce.entries(account),
    ]);
    if (!buys) throw new StabilizerBuysUnavailableError();

    const liquidRepayments = (repaymentEntries ?? []).flatMap(([, repayment]) => (repayment ? [repayment] : []));

    const positions: StabilizerBuy[] = [];
    for (const [key, purchase] of entries) {
      if (!purchase) continue;

      // AmountRankId stores the frame as eight big-endian bytes, exposed as hex by the native client.
      const admissionFrame = Number(BigInt(key.args[1]));
      const auction = await client.query.stabilizerBuys.auctions(admissionFrame);
      if (!auction) throw new Error(`Purchase auction ${admissionFrame} is unavailable; retry the refresh.`);

      const repayments = liquidRepayments.filter(repayment => repayment.admissionFrame === admissionFrame);
      positions.push(new StabilizerBuy(admissionFrame, purchase, auction, repayments));
    }

    positions.sort((a, b) => b.admissionFrame - a.admissionFrame);
    return { ...buys, positions };
  }

  public static async getBids(client: ArgonCurrentQueryClient, admissionFrame: number) {
    const entries = await client.query.stabilizerBuys.bidsByAuction.entries(BigInt(admissionFrame));
    if (!entries) throw new StabilizerBuysUnavailableError();

    return entries.map(([key]) => {
      const [rate, amountRank] = key.args[1];
      return {
        ownerAccount: encodeAddress(amountRank.orderedId),
        latestBid: rate.times(100).toNumber(),
        matchingBasis: maxUint128 - BigInt(amountRank.descendingAmount),
      };
    });
  }

  /** Inclusion consumes matching basis independently of the money paid at each bid's rate. */
  public static allocateBids(
    bids: Pick<IStabilizerBuyBid, 'ownerAccount' | 'latestBid' | 'matchingBasis'>[],
    auction: Auction,
    auctionInclusionPercent: BigNumber,
  ): IStabilizerBuyBid[] {
    const ranked = [...bids].sort((a, b) => {
      if (a.latestBid === 0 && b.latestBid !== 0) return 1;
      if (b.latestBid === 0 && a.latestBid !== 0) return -1;
      if (a.latestBid !== b.latestBid) return a.latestBid - b.latestBid;
      if (a.matchingBasis !== b.matchingBasis) return a.matchingBasis > b.matchingBasis ? -1 : 1;
      return toArgonAccountIdHex(a.ownerAccount).localeCompare(toArgonAccountIdHex(b.ownerAccount));
    });

    let remainingBudget = auction.remainingBudget;
    let remainingMatchingBasis = auction.remainingMatchingBasis;
    const matchingBasisLimit = bigNumberToBigInt(auctionInclusionPercent.times(auction.totalMatchingBasis));
    return ranked.map(bid => {
      const requestedReward = (bid.matchingBasis * BigInt(bid.latestBid)) / 100n;
      if (bid.latestBid === 0) return { ...bid, requestedReward, fundingEstimate: 0n };

      const includedBasis = bid.matchingBasis < remainingMatchingBasis ? bid.matchingBasis : remainingMatchingBasis;
      remainingMatchingBasis -= includedBasis;

      const reward = (includedBasis * BigInt(bid.latestBid)) / 100n;
      let fundedReward = 0n;
      if (matchingBasisLimit > 0n) fundedReward = (reward * (auction.budget ?? 0n)) / matchingBasisLimit;
      const fundingEstimate = fundedReward < remainingBudget ? fundedReward : remainingBudget;
      remainingBudget -= fundingEstimate;
      return { ...bid, requestedReward, fundingEstimate };
    });
  }

  public static getBidAheadPercent(rankedBids: IStabilizerBuyBid[], ownerAccount: string) {
    const yourIndex = rankedBids.findIndex(bid => bid.ownerAccount === ownerAccount);
    if (yourIndex <= 0) return;

    const own = rankedBids[yourIndex];
    const ahead = rankedBids[yourIndex - 1];
    if (ahead.latestBid === 0) return;

    if (own.matchingBasis > ahead.matchingBasis) return ahead.latestBid;
    if (
      own.matchingBasis === ahead.matchingBasis &&
      toArgonAccountIdHex(own.ownerAccount).localeCompare(toArgonAccountIdHex(ahead.ownerAccount)) < 0
    )
      return ahead.latestBid;
    if (ahead.latestBid > 1) return ahead.latestBid - 1;
  }

  /** Queue absence after bidding closes establishes that allocation cannot award another bid. */
  public static async getSettledAuctions(client: ArgonCurrentQueryClient, admissionFrames: number[]) {
    if (!admissionFrames.length) return new Map<number, Auction>();

    const queuedQuery = client.query.stabilizerBuys.auctionAllocationQueue.keys();
    if (!queuedQuery) throw new StabilizerBuysUnavailableError();

    const [queued, auctions] = await Promise.all([
      queuedQuery,
      Promise.all(admissionFrames.map(async frame => client.query.stabilizerBuys.auctions(frame))),
    ]);
    const pendingFrames = new Set(queued.map(key => Number(BigInt(key.args[0].orderedId))));
    const settled = new Map<number, Auction>();
    for (const [index, auction] of auctions.entries()) {
      const frame = admissionFrames[index];
      if (!auction || pendingFrames.has(frame)) continue;
      settled.set(frame, auction);
    }

    return settled;
  }

  public static async buildBidTx(args: {
    client: ArgonClient;
    account: string;
    admissionFrame: number;
    rewardPercent: number;
  }) {
    const { client, account, admissionFrame, rewardPercent } = args;
    const transactions = client.tx as typeof client.tx | PreviousRuntimeSpec.Transactions<'promise'>;
    if (!('stabilizerBuys' in transactions) || !transactions.stabilizerBuys?.bid) {
      throw new StabilizerBuysUnavailableError();
    }

    const header = await client.rpc.chain.getHeader();
    const snapshot = runtimeClient(await client.raw.at(header.hash));
    const nextFrameId = await snapshot.query.miningSlot.nextFrameId();
    if (nextFrameId === null)
      throw new Error('The current admission frame is unavailable; retry once the chain updates.');

    const { positions } = await StabilizerBuy.getForAccount(snapshot, account);
    const position = positions.find(position => position.admissionFrame === admissionFrame);
    if (!position) throw new Error('No held purchase exists for this account and admission frame.');

    const error = position.getBidError({
      currentFrameId: Math.max(0, nextFrameId - 1),
      rewardPercent,
      maxPositiveBids: client.consts.stabilizerBuys.maxPositiveBids,
    });
    if (error) throw new Error(error);

    return transactions.stabilizerBuys.bid(admissionFrame, rewardPercent);
  }

  /** Fee preview does not require a held purchase or an open bid window. */
  public static async estimateBidFee({
    client,
    account,
    admissionFrame,
    rewardPercent,
  }: Parameters<typeof StabilizerBuy.buildBidTx>[0]): Promise<bigint> {
    const transactions = client.tx as typeof client.tx | PreviousRuntimeSpec.Transactions<'promise'>;
    if (!('stabilizerBuys' in transactions) || !transactions.stabilizerBuys?.bid) {
      throw new StabilizerBuysUnavailableError();
    }

    const fee = await transactions.stabilizerBuys.bid(admissionFrame, rewardPercent).paymentInfo(account);
    return fee.partialFee.toBigInt();
  }

  public get matchingBasis(): bigint {
    return bigNumberToBigInt(this.auction.matchingRate.times(this.purchase.capturedDiscount));
  }

  public get heldPrincipal(): bigint {
    return this.purchase.principal + this.liquidRepayments.reduce((sum, repayment) => sum + repayment.microgons, 0n);
  }

  public get requestedReward(): bigint {
    return bigNumberToBigInt(this.purchase.bidRate.times(this.matchingBasis));
  }

  public isBiddingOpen(currentFrameId: number): boolean {
    return currentFrameId === this.admissionFrame + 1 && this.auction.budget !== null;
  }

  public getBidError(args: {
    currentFrameId: number;
    rewardPercent: number;
    maxPositiveBids: number;
  }): string | undefined {
    const { currentFrameId, rewardPercent, maxPositiveBids } = args;
    if (!Number.isInteger(rewardPercent) || rewardPercent < 0 || rewardPercent > 100) {
      return 'Choose a whole bonus percentage from 0 to 100.';
    }
    if (!this.isBiddingOpen(currentFrameId))
      return 'Bidding is open only in the frame after purchase admission, once funding is reserved.';
    if (rewardPercent === 0) return;
    if (this.purchase.bidRate.times(100).eq(rewardPercent))
      return 'Choose a different bonus percentage to revise your bid.';
    if ((this.matchingBasis * BigInt(rewardPercent)) / 100n === 0n) return 'This bonus bid rounds to zero microgons.';
    if (this.purchase.positiveBidCount >= maxPositiveBids)
      return `This auction allows ${maxPositiveBids} positive bids, including revisions. You can still opt out.`;
  }
}
