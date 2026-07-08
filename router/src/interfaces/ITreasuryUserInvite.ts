import type { ICertificationProgress } from '@argonprotocol/apps-core';
import type { IUserInviteRecord } from '../db/UserInvitesTable.ts';
import type { IBitcoinLockCouponStatus } from './IBitcoinLockRelay.js';

export type IUserInvite = IUserInviteRecord;

export type IOperationalUserInvite = IUserInvite;

export type ITreasuryUserInvite = IUserInvite & {
  vaultId?: number;
  bitcoinLockCoupon?: IBitcoinLockCouponStatus;
  certificationProgress?: ICertificationProgress;
};

export type IMemberInvite = ITreasuryUserInvite;
