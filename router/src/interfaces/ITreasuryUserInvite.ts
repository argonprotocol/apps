import type { IUserInviteRecord } from '../db/UserInvitesTable.ts';
import type { IBitcoinLockCouponStatus } from './IBitcoinLockRelay.js';

export type ITreasuryUserInvite = IUserInviteRecord & {
  vaultId?: number;
  bitcoinLockCoupon?: IBitcoinLockCouponStatus;
};
