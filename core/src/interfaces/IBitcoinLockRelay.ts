export type BitcoinLockRelayStatus = 'Submitted' | 'InBlock' | 'Finalized' | 'Failed';
export type BitcoinLockCouponStatus = 'Open' | 'Expired' | BitcoinLockRelayStatus;

export interface IBitcoinLockCouponRecord {
  id: number;
  userId: number;
  offerCode: string;
  vaultId: number;
  maxSatoshis: bigint;
  expiresAfterTicks: number;
  expirationTick?: number;
  accountId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBitcoinLockRelayRecord {
  id: number;
  couponId: number;
  status: BitcoinLockRelayStatus;
  requestedSatoshis: bigint;
  securitizationUsedMicrogons: bigint;
  ownerAccountId: string;
  ownerBitcoinPubkey: string;
  microgonsPerBtc: bigint;
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
  expiresAfterTicks: number;
}

export interface IActivateBitcoinLockCouponRequest {
  userId: number;
  accountId: string;
}

export interface IBitcoinLockRelayRequest {
  requestedSatoshis: bigint;
  ownerAccountId: string;
  ownerBitcoinPubkey: string;
  microgonsPerBtc?: bigint;
}

export interface IBitcoinLockCouponStatus {
  coupon: IBitcoinLockCouponRecord;
  relay?: IBitcoinLockRelayRecord;
  status: BitcoinLockCouponStatus;
  expiresAt?: Date;
}

export interface IBitcoinLockRelayJobRequest extends IBitcoinLockRelayRequest {
  offerCode: string;
  microgonsPerBtc: bigint;
}
