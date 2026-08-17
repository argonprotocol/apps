import type { BitcoinLockFeeCoupon } from '@argonprotocol/mainchain';

export type BitcoinLockRelayStatus = 'Submitted' | 'InBlock' | 'Finalized' | 'Failed';
export type BitcoinLockCouponUseStatus = 'Prepared' | BitcoinLockRelayStatus;
export type BitcoinLockCouponStatus = 'Open' | 'Expired' | 'Used' | BitcoinLockCouponUseStatus;

export interface IBitcoinLockCouponRecord {
  id: number;
  userId: number;
  sequence: number;
  offerCode: string;
  vaultId: number;
  // Retained for older apps and recovery packages that describe a one-lock gift.
  maxSatoshis: bigint;
  // Retained for older apps that displayed the gift as a fiat estimate.
  estimatedGiftUsd: number;
  // Retained for older delegated-initialization coupons.
  btcPctFee: number;
  feeCreditMicrogons?: bigint;
  expiresAfterTicks: number;
  expirationTick?: number;
  accountId?: string;
  // Retained while older delegated-initialization recovery packages remain readable.
  feeCoupon?: BitcoinLockFeeCoupon;
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBitcoinLockCouponUseRecord {
  id: number;
  couponId: number;
  requestId: string;
  status: BitcoinLockCouponUseStatus;
  feeCreditMicrogons: bigint;
  requestedSatoshis: bigint;
  ownerAccountId: string;
  ownerBitcoinPubkey: string;
  microgonsAtTargetPerBtc: bigint;
  feeCoupon?: BitcoinLockFeeCoupon;
  relay?: IBitcoinLockRelayRecord;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBitcoinLockRelayRecord {
  id: number;
  requestId: string;
  status: BitcoinLockRelayStatus;
  requestedSatoshis: bigint;
  securitizationUsedMicrogons: bigint;
  ownerAccountId: string;
  ownerBitcoinPubkey: string;
  microgonsAtTargetPerBtc: bigint;
  error: string | null;
  delegateAddress: string;
  extrinsicHash: string;
  extrinsicMethodJson: any;
  txNonce: number;
  txSubmittedAtBlockHeight: number;
  txSubmittedAtTime: Date;
  txExpiresAtBlockHeight: number;
  txInBlockHeight: number | null;
  txInBlockHash: string | null;
  txFinalizedHeight: number | null;
  txFeePlusTip: bigint | null;
  txTip: bigint | null;
  utxoId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateBitcoinLockCouponRequest {
  userId: number;
  vaultId: number;
  maxSatoshis: bigint;
  estimatedGiftUsd: number;
  feeCreditMicrogons?: bigint;
  btcPctFee?: number;
  expiresAfterTicks: number;
}

export interface IActivateBitcoinLockCouponRequest {
  userId: number;
  accountId: string;
}

export interface IBitcoinLockRelayRequest {
  requestId?: string;
  feeCouponNonce?: bigint;
  requestedSatoshis: bigint;
  ownerAccountId: string;
  ownerBitcoinPubkey: string;
  microgonsAtTargetPerBtc?: bigint;
  feeCreditMicrogons?: bigint;
  execution?: 'FeeCoupon';
}

export interface IBitcoinLockCouponStatus {
  coupon: IBitcoinLockCouponRecord;
  relay?: IBitcoinLockRelayRecord;
  uses?: IBitcoinLockCouponUseRecord[];
  originalFeeCreditMicrogons?: bigint;
  usedFeeCreditMicrogons?: bigint;
  pendingFeeCreditMicrogons?: bigint;
  remainingFeeCreditMicrogons?: bigint;
  status: BitcoinLockCouponStatus;
  expiresAt?: Date;
}

export interface IBitcoinLockRelayJobRequest extends IBitcoinLockRelayRequest {
  requestId: string;
  vaultId: number;
  microgonsAtTargetPerBtc: bigint;
}

export interface ISignBitcoinLockFeeCouponRequest {
  vaultId: number;
  beneficiary: string;
  feeCouponNonce?: bigint;
  requestedSatoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  feeDiscountMicrogons: bigint;
  expiresAfterTicks: number;
}
