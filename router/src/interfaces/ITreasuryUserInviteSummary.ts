import type { ITreasuryUserInvite } from './ITreasuryUserInvite.js';

export type ITreasuryUserInviteSummary = Pick<
  ITreasuryUserInvite,
  'id' | 'name' | 'inviteCode' | 'offerCode' | 'maxSatoshis' | 'expiresAt' | 'lastClickedAt'
>;
