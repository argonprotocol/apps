import {
  AccountActivityKind,
  StabilizerBuy,
  type BlockWatch,
  type IBlockHeaderInfo,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import type { HistoricalEvent } from '@argonprotocol/runtime-client';
import { findAddressActivity } from '../IndexerClient.ts';
import {
  StabilizerBuyStatus,
  type IStabilizerBuyHistory,
  type IStabilizerBuyRecord,
} from '../../interfaces/IStabilizerBuyPurchase.ts';

/** Historical import stays detached until the domain commits the complete account backfill. */
export async function recoverStabilizerBuyHistory({
  blockWatch,
  accountId,
  afterBlock,
  toBlock,
}: {
  blockWatch: BlockWatch;
  accountId: string;
  afterBlock: number;
  toBlock: number;
}): Promise<{ records: IStabilizerBuyHistory; throughBlock: number; definitionVersion: number }> {
  const activity = await findAddressActivity(accountId, {
    afterBlock,
    toBlock,
    activityMask: AccountActivityKind.StabilizerBuy | AccountActivityKind.Fee,
  });
  if (activity.definitionVersion < 5)
    throw new Error('Upgrade the indexer to restore Stabilizer Buys history (activity definition 5).');

  const gap = activity.coverage.gaps[0];
  if (gap)
    throw new Error(
      `Stabilizer Buys history is unavailable from block ${gap.fromBlock} to ${gap.toBlock}: ${gap.reason}`,
    );
  if (activity.asOfBlock < toBlock) throw new Error('The indexer is still catching up; retry Stabilizer Buys history.');

  const records: IStabilizerBuyHistory = { buys: [], frameRewards: [], payouts: [], repayments: [] };
  for (const indexedBlock of activity.blocks) {
    if (indexedBlock.blockNumber > toBlock) continue;

    await blockWatch.withBackgroundArchiveRead(async () => {
      const block = await blockWatch.getHeader(indexedBlock.blockNumber);
      if (block.blockHash.toLowerCase() !== indexedBlock.blockHash.toLowerCase())
        throw new Error('Stabilizer Buys history block hash mismatch.');

      const snapshot = await blockWatch.getEventsWithSpec(block);
      if (snapshot.specVersion !== indexedBlock.specVersion)
        throw new Error('Stabilizer Buys history runtime mismatch.');

      const facts = await readStabilizerBuyHistoryBlock(accountId, block, snapshot.events, blockWatch);
      records.buys.push(...facts.buys);
      records.frameRewards.push(...facts.frameRewards);
      records.payouts.push(...facts.payouts);
      records.repayments!.push(...(facts.repayments ?? []));
    });
  }

  return { records, throughBlock: toBlock, definitionVersion: activity.definitionVersion };
}

/** Both live collection and recovery translate events into the same durable financial facts. */
export async function readStabilizerBuyHistoryBlock(
  accountId: string,
  block: IBlockHeaderInfo,
  events: readonly RuntimeSystemEventRecord[],
  blockWatch: BlockWatch,
): Promise<IStabilizerBuyHistory> {
  const records: IStabilizerBuyHistory = { buys: [], frameRewards: [], payouts: [], repayments: [] };
  const frames = new Map<number, IStabilizerBuyHistory['frameRewards'][number]>();
  const admissions = new Map<
    number | undefined,
    Extract<HistoricalEvent, { method: 'PurchaseRecorded' | 'PurchaseIneligible' }>
  >();
  const ineligiblePurchases = new Map<number | undefined, Extract<HistoricalEvent, { method: 'PurchaseIneligible' }>>();
  const invalidRepayments = new Set<bigint>();
  const admissionFailures = new Map<bigint, NonNullable<IStabilizerBuyRecord['purchaseAdmissionFailure']>>();
  const ownersByExtrinsic = new Map<
    number | undefined,
    Set<IStabilizerBuyHistory['frameRewards'][number] | IStabilizerBuyRecord>
  >();
  const getFrame = (admissionFrame: number) => {
    let frame = frames.get(admissionFrame);
    if (!frame) {
      frame = {
        ownerAccount: accountId,
        admissionFrame,
        bidFees: [],
        createdAt: new Date(block.blockTime),
        updatedAt: new Date(block.blockTime),
      };
      frames.set(admissionFrame, frame);
    }

    return frame;
  };

  for (const [eventIndex, { event, phase }] of events.entries()) {
    const location = {
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      blockTime: block.blockTime,
      eventIndex,
    };
    const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : undefined;
    const owners =
      ownersByExtrinsic.get(extrinsicIndex) ??
      new Set<IStabilizerBuyHistory['frameRewards'][number] | IStabilizerBuyRecord>();

    if (event.section === 'stabilizerBuys' && 'account' in event.data && event.data.account === accountId) {
      switch (event.method) {
        case 'PurchaseRecorded':
          admissions.set(extrinsicIndex, event);
          getFrame(event.data.admissionFrame);
          break;
        case 'PurchaseIneligible':
          ineligiblePurchases.set(extrinsicIndex, event);
          break;
        case 'LiquidRepaymentInvalid':
          invalidRepayments.add(event.data.gatewayActivityNonce);
          break;
        case 'LiquidRepaymentCompleted': {
          const { account: _account, ...repayment } = event.data;
          records.repayments!.push({ ...repayment, ...location });
          break;
        }
        case 'LiquidRepaymentRewardAwarded': {
          const { account: _account, ...reward } = event.data;
          const rewards = getFrame(reward.admissionFrame);
          rewards.repaymentRewards ??= [];
          rewards.repaymentRewards.push({ ...reward, ...location });
          break;
        }
        case 'BidSubmitted': {
          const { account: _account, ...bid } = event.data;
          const rewards = getFrame(bid.admissionFrame);
          rewards.bidEvent = { ...bid, ...location };
          owners.add(getFrame(bid.admissionFrame));
          break;
        }
        case 'RewardAwarded': {
          const { account: _account, ...reward } = event.data;
          const rewards = getFrame(reward.admissionFrame);
          rewards.rewardAward = { ...reward, ...location };
          rewards.awardedReward = reward.amount;
          rewards.maturesAtFrame = reward.maturesAtFrame;
          break;
        }
        case 'PayoutCompleted': {
          const { account: _account, ...payout } = event.data;
          records.payouts.push({ ...payout, ...location });
          break;
        }
      }
    }
    if (event.section === 'crosschainTransfer' && 'account' in event.data && event.data.account === accountId) {
      if (event.method === 'LiquidRepaymentUnauthorized') invalidRepayments.add(event.data.gatewayActivityNonce);
      if (event.method === 'UniswapPurchaseAdmissionFailed') {
        const { account: _account, ...failure } = event.data;
        admissionFailures.set(failure.gatewayActivityNonce, { ...failure, ...location });
      }
    }
    if (
      event.section === 'crosschainTransfer' &&
      event.method === 'TransferToArgonFromSwapSettled' &&
      event.data.transfer.to === accountId
    ) {
      const admission = admissions.get(extrinsicIndex);
      const ineligible = ineligiblePurchases.get(extrinsicIndex);
      const { sourceChain, transfer } = event.data;
      const failure = admissionFailures.get(transfer.gatewayActivityNonce);
      const id = `${sourceChain.type}:${transfer.gatewayActivityNonce}`;
      const buy: IStabilizerBuyRecord = {
        id,
        gatewayTransferId: id,
        ownerAccount: accountId,
        createdAt: new Date(block.blockTime),
        updatedAt: new Date(block.blockTime),
        status: StabilizerBuyStatus.Complete,
        principal: transfer.amount,
        argonPurchaseEvent: event.data,
        purchaseArgonRecognitionBlockNumber: block.blockNumber,
        purchaseArgonRecognitionBlockHash: block.blockHash,
        purchaseArgonRecognitionBlockTime: new Date(block.blockTime),
        purchaseArgonRecognitionEventIndex: eventIndex,
        argonFees: [],
      };

      if (admission?.method === 'PurchaseRecorded') {
        buy.admissionFrame = admission.data.admissionFrame;
        buy.matchingBasis = admission.data.matchingBasis;
        buy.status = StabilizerBuyStatus.WaitingForPrincipalReleaseOnArgon;
        const repayLiquidId = event.data.purchase.repayLiquidId;
        if (
          repayLiquidId !== undefined &&
          repayLiquidId !== null &&
          !invalidRepayments.has(transfer.gatewayActivityNonce)
        )
          buy.repayLiquidId = repayLiquidId;
      }
      if (ineligible) buy.ineligibleReason = ineligible.data.reason.type;
      if (failure) buy.purchaseAdmissionFailure = failure;

      admissions.delete(extrinsicIndex);
      ineligiblePurchases.delete(extrinsicIndex);

      records.buys.push(buy);
      owners.add(buy);
    }

    ownersByExtrinsic.set(extrinsicIndex, owners);
  }

  const hasAccountFee = events.some(
    ({ event }) =>
      event.section === 'transactionPayment' && event.method === 'TransactionFeePaid' && event.data.who === accountId,
  );
  const signedBlock = hasAccountFee ? await blockWatch.getBlock(block) : undefined;
  for (const [eventIndex, { event, phase }] of events.entries()) {
    if (event.section !== 'transactionPayment' || event.method !== 'TransactionFeePaid') continue;
    if (event.data.who !== accountId || phase.type !== 'ApplyExtrinsic') continue;

    const call = signedBlock?.block.extrinsics[phase.value]?.method;
    const owners =
      ownersByExtrinsic.get(phase.value) ??
      new Set<IStabilizerBuyHistory['frameRewards'][number] | IStabilizerBuyRecord>();
    for (const frame of call ? StabilizerBuy.getBidAdmissionFrames(call) : []) {
      owners.add(getFrame(frame));
    }

    const isAmbiguous =
      owners.size !== 1 || !call || (call.section !== 'stabilizerBuys' && call.section !== 'crosschainTransfer');
    const fee = {
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      blockTime: block.blockTime,
      eventIndex,
      amount: event.data.actualFee,
      isAmbiguous,
    };

    for (const owner of owners) {
      if ('argonFees' in owner) owner.argonFees.push(fee);
      else owner.bidFees!.push(fee);
    }
  }

  records.frameRewards = [...frames.values()];
  return records;
}
