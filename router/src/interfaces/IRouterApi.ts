import type { IProfileRecord } from '../db/ProfileTable.ts';
import type { IBitcoinLockCouponStatus, IBitcoinLockRelayRequest } from './IBitcoinLockRelay.js';
import type { ITreasuryUserInvite } from './ITreasuryUserInvite.js';
import type { ITreasuryUserInviteSummary } from './ITreasuryUserInviteSummary.js';
import type { ITreasuryUserMember } from './ITreasuryUserMember.js';

export type IRouterProfile = IProfileRecord;
export type IRouterProfileUpdateRequest = Partial<IRouterProfile>;
export type IInitializeBitcoinLockRequest = IBitcoinLockRelayRequest;

export interface ITreasuryUserInviteCreateRequest {
  name: string;
  inviteCode: string;
  offerCode: string;
  maxSatoshis: bigint;
  expiresAfterTicks: number;
  offerToken: string;
}

export interface IOpenTreasuryInviteRequest {
  accountAddress: string;
}

export interface IRouterErrorResponse {
  error: string;
}

export interface IRouterProfileResponse {
  profile: IRouterProfile;
}

export interface ICreateTreasuryInviteResponse {
  invite: ITreasuryUserInvite;
}

export interface IListTreasuryInvitesResponse {
  invites: ITreasuryUserInviteSummary[];
}

export interface IListTreasuryMembersResponse {
  members: ITreasuryUserMember[];
}

export interface IListBitcoinLockCouponStatusesResponse {
  bitcoinLocks: IBitcoinLockCouponStatus[];
}

export interface IOpenTreasuryInviteResponse {
  fromName: string;
  invite: ITreasuryUserInvite;
}

export interface IBitcoinLockStatusResponse {
  bitcoinLock: IBitcoinLockCouponStatus;
}
