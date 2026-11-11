import type { EvmContracts } from '@argonprotocol/mainchain';
import type {
  IBlockHeaderInfo,
  IStabilizerBuyBid,
  IStabilizerBuyQuote,
  IStabilizerBuyPriceReference,
  StabilizerBuy,
} from '@argonprotocol/apps-core';
import type { HistoricalEvent } from '@argonprotocol/runtime-client';
import type { Hash } from 'viem';
export type { IStabilizerBuyQuote };

export enum StabilizerBuyStatus {
  SubmittingUsdcApprovalOnEthereum = 'SubmittingUsdcApprovalOnEthereum',
  ConfirmingUsdcApprovalOnEthereum = 'ConfirmingUsdcApprovalOnEthereum',
  SubmittingPurchaseOnEthereum = 'SubmittingPurchaseOnEthereum',
  ConfirmingPurchaseOnEthereum = 'ConfirmingPurchaseOnEthereum',
  WaitingForArgonRecognition = 'WaitingForArgonRecognition',
  WaitingForPrincipalReleaseOnArgon = 'WaitingForPrincipalReleaseOnArgon',
  Complete = 'Complete',
  Failed = 'Failed',
}

/** The durable buy survives Ethereum execution and later joins its admission-frame auction. */
export interface IStabilizerBuyRecord {
  id: string;
  gatewayTransferId?: string;
  ownerAccount: string;
  status: StabilizerBuyStatus;
  statusError?: string;
  createdAt: Date;
  updatedAt: Date;
  purchasedAt?: Date;

  ethereumQuote?: IStabilizerBuyQuote;
  ethereumMaxFeeWei?: bigint;
  ethereumTxHash?: Hash;
  ethereumSubmittedAt?: Date;
  ethereumFeeWei?: bigint;
  ethereumPrices?: IStabilizerBuyPriceReference;
  ethereumGatewayActivity?: EvmContracts.MintingGatewayTransferToArgonFromSwapStarted;
  purchaseEthereumBlockNumber?: number;
  purchaseEthereumBlockHash?: Hash;
  purchaseEthereumLogIndex?: number;
  ethereumConfirmedAt?: Date;

  usdcApprovalTxHash?: Hash;
  usdcApprovalSubmittedAt?: Date;
  usdcApprovalFeeWei?: bigint;
  usdcApprovalPrices?: IStabilizerBuyPriceReference;

  admissionFrame?: number;
  principal?: bigint;
  matchingBasis?: bigint;
  repayLiquidId?: number;
  liquidRepaymentEvent?: IStabilizerBuyLiquidRepayment;
  purchaseAdmissionFailure?: Omit<AdmissionFailureEvent['data'], 'account'> & IStabilizerBuyLocation;
  ineligibleReason?: IneligibleEvent['data']['reason']['type'];
  argonPurchaseEvent?: PurchaseEvent['data'];
  purchaseArgonRecognitionBlockNumber?: number;
  purchaseArgonRecognitionBlockHash?: string;
  purchaseArgonRecognitionBlockTime?: Date;
  purchaseArgonRecognitionEventIndex?: number;

  purchaseArgonReleaseBlockNumber?: number;
  purchaseArgonReleaseBlockHash?: string;
  purchaseArgonReleaseBlockTime?: Date;
  purchaseArgonReleaseEventIndex?: number;
  releasedPrincipal?: bigint;

  spentMicrogons?: bigint;
  ethereumFeeMicrogons?: bigint;
  /** Absent when approval costs are unknown. Zero means no approval was needed. */
  usdcApprovalFeeMicrogons?: bigint;
  argonFees: IStabilizerBuyFee[];
}

export type IStabilizerBuyPurchaseRecord = IStabilizerBuyRecord &
  Required<Pick<IStabilizerBuyRecord, 'ethereumQuote' | 'ethereumMaxFeeWei'>>;

export interface IStabilizerBuyLocation extends Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash' | 'blockTime'> {
  eventIndex: number;
}

type PurchaseEvent = Extract<HistoricalEvent, { method: 'TransferToArgonFromSwapSettled' }>;
type BidEvent = Extract<HistoricalEvent, { section: 'stabilizerBuys'; method: 'BidSubmitted' }>;
type RewardEvent = Extract<HistoricalEvent, { section: 'stabilizerBuys'; method: 'RewardAwarded' }>;
type IneligibleEvent = Extract<HistoricalEvent, { section: 'stabilizerBuys'; method: 'PurchaseIneligible' }>;
type PayoutEvent = Extract<HistoricalEvent, { section: 'stabilizerBuys'; method: 'PayoutCompleted' }>;
type AdmissionFailureEvent = Extract<
  HistoricalEvent,
  { section: 'crosschainTransfer'; method: 'UniswapPurchaseAdmissionFailed' }
>;
type LiquidRepaymentEvent = Extract<HistoricalEvent, { section: 'stabilizerBuys'; method: 'LiquidRepaymentCompleted' }>;
type LiquidRepaymentRewardEvent = Extract<
  HistoricalEvent,
  { section: 'stabilizerBuys'; method: 'LiquidRepaymentRewardAwarded' }
>;

export type IStabilizerBuyLiquidRepayment = Omit<LiquidRepaymentEvent['data'], 'account'> & IStabilizerBuyLocation;

export interface IStabilizerBuyFee extends IStabilizerBuyLocation {
  amount: bigint;
  isAmbiguous: boolean;
}

/** Bids and rewards belong to the account's whole admission-frame bucket. */
export interface IStabilizerBuyFrameRewards {
  ownerAccount: string;
  admissionFrame: number;
  bidCount: number;
  latestBid: number; // Whole reward percentage, matching the bid command.
  bidEvent?: Omit<BidEvent['data'], 'account'> & IStabilizerBuyLocation;
  lastUpdatedArgonBlock: number; // Current-query observation; history cannot replace a newer bid snapshot.
  requestedReward?: bigint;
  rewardAward?: Omit<RewardEvent['data'], 'account'> & IStabilizerBuyLocation;
  awardedReward?: bigint;
  maturesAtFrame?: number;
  paidReward: bigint;
  repaymentRewards?: (Omit<LiquidRepaymentRewardEvent['data'], 'account'> & IStabilizerBuyLocation)[];
  payout?: IStabilizerBuyLocation;
  bidFees: IStabilizerBuyFee[];
  createdAt: Date;
  updatedAt: Date;
}

export type IStabilizerBuyPayout = Omit<PayoutEvent['data'], 'account'> & IStabilizerBuyLocation;

export interface IStabilizerBuysRecord {
  buys: IStabilizerBuyRecord[];
  frameRewards: IStabilizerBuyFrameRewards[];
}

/** Payment events are transient inputs; their attributed results live on buys and frame rewards. */
export interface IStabilizerBuyHistory {
  buys: IStabilizerBuyRecord[];
  frameRewards: (Partial<IStabilizerBuyFrameRewards> & Pick<IStabilizerBuyFrameRewards, 'admissionFrame'>)[];
  payouts: IStabilizerBuyPayout[];
  repayments?: IStabilizerBuyLiquidRepayment[];
}

export type IStabilizerBuyOpportunity = { key: string; expiresAt?: number } & (
  | {
      type: 'buy';
      quote: IStabilizerBuyQuote;
      apy: number;
      discountPercent: number;
      observedAt: Date;
      expiresAt: number;
    }
  | { type: 'bid'; position: StabilizerBuy; bid?: IStabilizerBuyBid }
);
