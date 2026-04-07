import { TreasuryUserTable } from './TreasuryUserTable.ts';
import type { ITreasuryInvite } from './interfaces/ITreasuryInvite.ts';
import type { ITreasuryMember } from './interfaces/ITreasuryMember.ts';

export class TreasuryUsers {
  public static createUser(payload: any) {
    return TreasuryUserTable.insert({
      name: payload.name,
      inviteCode: payload.inviteCode ?? null,
      vaultId: payload.vaultId,
      couponTxId: payload.couponTxId ?? null,
      couponPublicKey: payload.couponPublicKey,
      couponPrivateKey: payload.couponPrivateKey ?? null,
      couponMaxSatoshis: payload.couponMaxSatoshis,
      couponExpirationFrame: payload.couponExpirationFrame ?? null,
      couponExpiresAt: payload.couponExpiresAt ?? null,
      firstClickedAt: payload.firstClickedAt ?? null,
      lastClickedAt: payload.lastClickedAt ?? null,
      registeredAppAt: payload.registeredAppAt ?? null,
      lockedBitcoinAt: payload.lockedBitcoinAt ?? null,
      appLastSeenAt: payload.appLastSeenAt ?? null,
    });
  }

  public static fetchMembers() {
    return TreasuryUserTable.fetchMembers().map(user => {
      return this.extractMemberFromUser(user)!;
    });
  }

  public static fetchInvites(): ITreasuryInvite[] {
    return TreasuryUserTable.fetchInvites().map(user => {
      return this.extractInviteFromUser(user)!;
    });
  }

  public static fetchInviteByCode(inviteCode: string): ITreasuryInvite | null {
    const user = TreasuryUserTable.fetchInviteByCode(inviteCode);
    return user ? this.extractInviteFromUser(user) : null;
  }

  public static setClickedAt(inviteCode: string): ITreasuryInvite | null {
    const user = TreasuryUserTable.setClickedAt(inviteCode);
    return this.extractInviteFromUser(user);
  }

  public static setRegisteredAppAt(inviteCode: string): ITreasuryMember | null {
    const user = TreasuryUserTable.setRegisteredAppAt(inviteCode);
    return this.extractMemberFromUser(user);
  }

  private static extractMemberFromUser(user: any): ITreasuryMember | null {
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      inviteCode: user.inviteCode,
      vaultId: user.vaultId,
      couponTxId: user.couponTxId,
      couponMaxSatoshis: user.couponMaxSatoshis,
      couponExpiresAt: user.couponExpiresAt,
      registeredAppAt: user.registeredAppAt,
      appLastSeenAt: user.appLastSeenAt,
    };
  }

  private static extractInviteFromUser(user: any): ITreasuryInvite | null {
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      inviteCode: user.inviteCode,
      vaultId: user.vaultId,
      couponTxId: user.couponTxId,
      couponMaxSatoshis: user.couponMaxSatoshis,
      couponExpiresAt: user.couponExpiresAt,
      lastClickedAt: user.lastClickedAt,
      registeredAppAt: user.registeredAppAt,
    };
  }
}
