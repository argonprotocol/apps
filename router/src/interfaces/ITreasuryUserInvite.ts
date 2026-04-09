import type { IBitcoinLockCouponRecord } from '../db/BitcoinLockCouponsTable.ts';
import type { IUserInviteRecord } from '../db/UserInvitesTable.ts';

export type ITreasuryUserInvite = Pick<
  IUserInviteRecord,
  'id' | 'name' | 'inviteCode' | 'firstClickedAt' | 'lastClickedAt' | 'accountAddress' | 'createdAt'
> &
  Pick<
    IBitcoinLockCouponRecord,
    'offerCode' | 'vaultId' | 'maxSatoshis' | 'expiresAfterTicks' | 'offerToken' | 'expirationTick' | 'expiresAt'
  >;
