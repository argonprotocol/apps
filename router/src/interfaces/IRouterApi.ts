import type { IRouterAuthChallenge, RouterAuthRole, UserRole, IOperationalAccessProof  } from '@argonprotocol/apps-core';
import type { IBitcoinLockCouponStatus, IBitcoinLockRelayRequest } from './IBitcoinLockRelay.js';
import type { ITreasuryUserInvite } from './ITreasuryUserInvite.js';

export type IInitializeBitcoinLockRequest = IBitcoinLockRelayRequest;
export type InviteRole = UserRole;

export interface ICreateInviteRequest {
  name: string;
  fromName: string;
  vaultId: number;
  maxSatoshis: bigint;
  estimatedGiftUsd: number;
  btcPctFee?: number;
  expiresAfterTicks: number;
}

export interface IOpenInviteRequest {
  defaultAccountId: string;
  authAccountId: string;
  authBindingExpiresAt: number;
  authBindingSignature: string;
}

export interface IRequestOperationsUpgradeRequest {
  operationalAccountId: string;
  authBindingExpiresAt: number;
  authBindingSignature: string;
}

export interface IRequestOperationsUpgradeResponse {
  operationsUpgradeRequestedAt: Date;
}

export interface IMarkOperationsUpgradedRequest {
  signature: IOperationalAccessProof['signature'];
}

export interface IRouterAuthChallengeRequest {
  authAccountId: string;
  role?: RouterAuthRole;
}

export interface IRouterAuthSessionRequest extends IRouterAuthChallenge {
  signature: string;
}

export interface IRouterAuthSessionResponse {
  sessionId: string;
  expiresAt: string;
  accountId: string;
  role: RouterAuthRole;
}

export interface IRouterErrorResponse {
  error: string;
  code?: string;
}

export interface IInviteResponse {
  invite: ITreasuryUserInvite;
}

export interface IListInvitesResponse {
  invites: ITreasuryUserInvite[];
}

export interface IPreviewInviteResponse {
  maxSatoshis: bigint;
  estimatedGiftUsd: number;
  btcPctFee: number;
  expiresAt: Date;
  fromName: string;
}

export interface IListBitcoinLockCouponsResponse {
  bitcoinLockCoupons: IBitcoinLockCouponStatus[];
}

export interface IOpenInviteResponse {
  fromName: string;
  referrer: string;
  invite: ITreasuryUserInvite;
}

export interface IBitcoinLockStatusResponse {
  bitcoinLock: IBitcoinLockCouponStatus;
}
