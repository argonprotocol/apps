export interface ICapitalInvite {
  id: number;
  name: string;
  inviteCode: string;
  vaultId: number;
  couponTxId: number;
  couponMaxSatoshis: bigint;
  couponExpiresAt: Date;
  lastClickedAt: Date | null;
  registeredAppAt: Date | null;
}
