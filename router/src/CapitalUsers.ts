import { CapitalUserTable } from './CapitalUserTable.ts';
import type { ICapitalInvite } from './interfaces/ICapitalInvite.ts';
import type { ICapitalMember } from './interfaces/ICapitalMember.ts';

export class CapitalUsers {
  public static createUser(payload: any) {
    console.log('Creating Capital User', payload);
    return CapitalUserTable.insert({
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
    return CapitalUserTable.fetchMembers();
  }

  public static fetchInvites(): ICapitalInvite[] {
    return CapitalUserTable.fetchInvites().map(invite => {
      return {
        id: invite.id,
        name: invite.name,
        inviteCode: invite.inviteCode,
        couponTxId: invite.couponTxId,
        couponMaxSatoshis: invite.couponMaxSatoshis,
        couponExpiresAt: invite.couponExpiresAt,
        lastClickedAt: invite.lastClickedAt,
        registeredAppAt: invite.registeredAppAt,
      } as ICapitalInvite;
    });
  }

  public static fetchInviteByCode(inviteCode: string): ICapitalInvite | null {
    const invite = CapitalUserTable.fetchInviteByCode(inviteCode);
    if (!invite) {
      return null;
    }

    return {
      id: invite.id,
      name: invite.name,
      inviteCode: invite.inviteCode,
      couponTxId: invite.couponTxId,
      couponMaxSatoshis: invite.couponMaxSatoshis,
      couponExpiresAt: invite.couponExpiresAt,
      lastClickedAt: invite.lastClickedAt,
      registeredAppAt: invite.registeredAppAt,
    } as ICapitalInvite;
  }

  public static setClickedAt(inviteCode: string): ICapitalInvite | null {
    const user = CapitalUserTable.setClickedAt(inviteCode);
    return this.extractInviteFromUser(user);
  }

  public static setRegisteredAppAt(inviteCode: string): ICapitalMember | null {
    const user = CapitalUserTable.setRegisteredAppAt(inviteCode);
    return this.extractMemberFromUser(user);
  }

  private static extractMemberFromUser(user: any): ICapitalMember | null {
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

  private static extractInviteFromUser(user: any): ICapitalInvite | null {
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
