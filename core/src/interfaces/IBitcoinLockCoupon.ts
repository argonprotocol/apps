export type BitcoinLockFeeCoupon = {
  feeDiscount: bigint;
  securitizationSpaceToUnreserve: bigint;
  expiresAtFrame: bigint;
  nonce: bigint;
  signature: string;
};

export type BitcoinLockCouponUseStatus = 'Prepared' | 'Submitted' | 'InBlock' | 'Finalized' | 'Failed';
export type BitcoinLockCouponStatus = 'Open' | 'Expired' | 'Used' | BitcoinLockCouponUseStatus;

export interface IBitcoinLockCouponRecord {
  id: number;
  userId: number;
  sequence: number;
  offerCode: string;
  vaultId: number;
  maxSatoshis: bigint;
  estimatedGiftUsd: number;
  btcPctFee: number;
  feeCreditMicrogons?: bigint;
  expiresAfterTicks: number;
  expirationTick?: number;
  accountId?: string;
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

export interface IBitcoinLockCouponRequest {
  requestId?: string;
  feeCouponNonce?: bigint;
  requestedSatoshis: bigint;
  ownerAccountId: string;
  ownerBitcoinPubkey: string;
  microgonsAtTargetPerBtc?: bigint;
  feeCreditMicrogons?: bigint;
}

export interface IBitcoinLockCouponStatus {
  coupon: IBitcoinLockCouponRecord;
  uses?: IBitcoinLockCouponUseRecord[];
  originalFeeCreditMicrogons?: bigint;
  usedFeeCreditMicrogons?: bigint;
  pendingFeeCreditMicrogons?: bigint;
  remainingFeeCreditMicrogons?: bigint;
  status: BitcoinLockCouponStatus;
  expiresAt?: Date;
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
