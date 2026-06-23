import type { IRouterAuthChallenge, RouterAuthRole, UserRole } from '@argonprotocol/apps-core';
import type { IBitcoinLockCouponStatus, IBitcoinLockRelayRequest } from './IBitcoinLockRelay.js';
import type { IOperationalUserInvite, ITreasuryUserInvite } from './ITreasuryUserInvite.js';

export type IInitializeBitcoinLockRequest = IBitcoinLockRelayRequest;
export type InviteRole = UserRole;

export interface ITreasuryUserInviteCreateRequest {
  name: string;
  fromName: string;
  inviteCode: string;
  inviteEnvelope: string;
  vaultId: number;
  maxSatoshis: bigint;
  estimatedGiftUsd: number;
  btcPctFee?: number;
  expiresAfterTicks: number;
}

export interface IOperationalUserInviteCreateRequest {
  name: string;
  fromName: string;
  inviteCode: string;
  inviteEnvelope: string;
  sponsor: string;
  expiresAtFrame: number;
  sponsorSignature: string;
}

export interface IOperationalUserInviteRegenerateRequest {
  inviteCode: string;
  inviteEnvelope: string;
}

export interface IUserInviteOpenRequest {
  accountId: string;
  authAccountId: string;
  authBindingExpiresAt: number;
  authBindingSignature: string;
  inviteSignature: string;
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

export type IOpenTreasuryInviteRequest = IUserInviteOpenRequest;
export interface IOpenOperationalInviteRequest extends IUserInviteOpenRequest {
  sponsor: string;
  expiresAtFrame: number;
  sponsorSignature: string;
}

export interface IRouterErrorResponse {
  error: string;
  code?: string;
}

export interface ICreateTreasuryInviteResponse {
  invite: ITreasuryUserInvite;
}

export interface IListTreasuryInvitesResponse {
  invites: ITreasuryUserInvite[];
}

export interface IPreviewTreasuryInviteResponse {
  maxSatoshis: bigint;
  estimatedGiftUsd: number;
  btcPctFee: number;
  expiresAt: Date;
  fromName: string;
}

export interface IPreviewOperationalInviteResponse {
  fromName: string;
  expiresAt: Date;
}

export interface ICreateOperationalInviteResponse {
  invite: IOperationalUserInvite;
}

export interface IListOperationalInvitesResponse {
  invites: IOperationalUserInvite[];
}

export interface IListBitcoinLockCouponsResponse {
  bitcoinLockCoupons: IBitcoinLockCouponStatus[];
}

export interface IOpenTreasuryInviteResponse {
  fromName: string;
  invite: ITreasuryUserInvite;
}

export interface IOpenOperationalInviteResponse {
  fromName: string;
  invite: IOperationalUserInvite;
}

export interface IBitcoinLockStatusResponse {
  bitcoinLock: IBitcoinLockCouponStatus;
}
