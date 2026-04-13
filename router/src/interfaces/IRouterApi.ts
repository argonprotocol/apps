import type { IBitcoinLockCouponStatus, IBitcoinLockRelayRequest } from './IBitcoinLockRelay.js';
import type { ITreasuryUserInvite } from './ITreasuryUserInvite.js';

export type IInitializeBitcoinLockRequest = IBitcoinLockRelayRequest;

export interface ITreasuryUserInviteCreateRequest {
  name: string;
  fromName: string;
  inviteCode: string;
  vaultId: number;
  maxSatoshis: bigint;
  expiresAfterTicks: number;
}

export interface IOpenTreasuryInviteRequest {
  accountId: string;
}

export interface IRouterErrorResponse {
  error: string;
}

export interface ICreateTreasuryInviteResponse {
  invite: ITreasuryUserInvite;
}

export interface IListTreasuryInvitesResponse {
  invites: ITreasuryUserInvite[];
}

export interface IListTreasuryMembersResponse {
  members: ITreasuryUserInvite[];
}

export interface IListBitcoinLockCouponsResponse {
  bitcoinLockCoupons: IBitcoinLockCouponStatus[];
}

export interface IOpenTreasuryInviteResponse {
  fromName: string;
  invite: ITreasuryUserInvite;
}

export interface IBitcoinLockStatusResponse {
  bitcoinLock: IBitcoinLockCouponStatus;
}
