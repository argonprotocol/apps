export type BitcoinLockRelayStatus = 'Submitted' | 'InBlock' | 'Finalized' | 'Failed';

export interface IBitcoinLockRelayRequest {
  offerToken: string;
  requestedSatoshis: bigint;
  ownerAccountAddress: string;
  ownerBitcoinPubkey: string;
  microgonsPerBtc?: bigint;
}

export interface IBitcoinLockRelayJobRequest {
  offerCode: string;
  maxSatoshis: bigint;
  expirationTick: number;
  requestedSatoshis: bigint;
  ownerAccountAddress: string;
  ownerBitcoinPubkey: string;
  microgonsPerBtc: bigint;
}

export interface IBitcoinLockCouponStatus {
  offerCode: string;
  status: BitcoinLockRelayStatus;
  error?: string;
  delegateAddress?: string;
  extrinsicHash?: string;
  extrinsicMethodJson?: any;
  nonce?: number;
  submittedAtBlockHeight?: number;
  submittedAtTime?: Date;
  expiresAtBlockHeight?: number;
  inBlockHeight?: number;
  finalizedHeight?: number;
  txFeePlusTip?: bigint;
  utxoId?: number;
}

export interface IBitcoinLockRelayRecord extends IBitcoinLockCouponStatus {
  id: number;
  vaultId: number;
  maxSatoshis: bigint;
  expirationTick: number;
  requestedSatoshis: bigint;
  securitizationUsedMicrogons: bigint;
  ownerAccountAddress: string;
  ownerBitcoinPubkey: string;
  microgonsPerBtc: bigint;
  inBlockHash?: string | null;
  txTip?: bigint;
  createdAt: Date;
  updatedAt: Date;
}
