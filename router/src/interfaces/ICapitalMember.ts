export interface ICapitalMember {
  id: number;
  name: string;
  inviteCode: string;
  vaultId: number;
  couponTxId: number;
  couponMaxSatoshis: bigint;
  couponExpiresAt: Date;
  registeredAppAt: Date;
  appLastSeenAt: Date;
}
