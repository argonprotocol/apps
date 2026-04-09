import type { ITreasuryUserInvite } from './ITreasuryUserInvite.js';

export type ITreasuryUserMember = Pick<
  ITreasuryUserInvite,
  'id' | 'name' | 'offerCode' | 'maxSatoshis' | 'expiresAt' | 'lastClickedAt'
>;
