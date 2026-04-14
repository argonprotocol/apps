import { hexToU8a, Keyring, mnemonicGenerate, u8aToHex } from '@argonprotocol/mainchain';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
import type { UserRole } from './UserRole.js';

const INVITE_OPEN_DOMAIN = 'argon_invite_open_v1';

export class InviteCodes {
  public static create(): { inviteSecret: string; inviteCode: string } {
    const inviteSecret = mnemonicGenerate();

    return {
      inviteSecret,
      inviteCode: this.getCode(inviteSecret),
    };
  }

  public static getCode(inviteSecret: string): string {
    const pair = new Keyring({ type: 'sr25519' }).addFromMnemonic(inviteSecret);
    return u8aToHex(pair.publicKey);
  }

  public static signOpen(inviteSecret: string, role: UserRole, accountId: string): string {
    const pair = new Keyring({ type: 'sr25519' }).addFromMnemonic(inviteSecret);
    return u8aToHex(pair.sign(this.getOpenPayloadHash(role, accountId)));
  }

  public static verifyOpen(args: {
    inviteCode: string;
    role: UserRole;
    accountId: string;
    signature: string;
  }): boolean {
    return signatureVerify(
      this.getOpenPayloadHash(args.role, args.accountId),
      hexToU8a(args.signature),
      hexToU8a(args.inviteCode),
    ).isValid;
  }

  private static getOpenPayloadHash(role: UserRole, accountId: string): Uint8Array {
    return blake2AsU8a(stringToU8a(`${INVITE_OPEN_DOMAIN}:${role}:${accountId}`), 256);
  }
}
