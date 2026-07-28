import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type IBitcoinLockCouponRecord, JsonExt, UserRole } from '@argonprotocol/apps-core';
import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import type { IUserInviteRecord } from './db/UserInvitesTable.ts';

const RESTORE_PACKAGE_AAD = Buffer.from('argon-router-restore-v1');
const RESTORE_PACKAGE_NONCE_BYTES = 12;
const RESTORE_PACKAGE_TAG_BYTES = 16;

type IRestorePackagePayload = {
  version: 1;
  member: Pick<IUserInviteRecord, 'id' | 'name' | 'fromName' | 'inviteCode'> & {
    defaultAccountId: string;
  };
  bitcoinLockCoupon?: IBitcoinLockCouponRecord;
};

export class MemberRestoreService {
  private readonly db: Db;
  private readonly restoreKey?: Buffer;
  private readonly restoreBitcoinLockCoupon?: (coupon: IBitcoinLockCouponRecord) => Promise<void>;

  constructor(options: {
    db: Db;
    restoreKey?: string;
    restoreBitcoinLockCoupon?: (coupon: IBitcoinLockCouponRecord) => Promise<void>;
  }) {
    this.db = options.db;
    this.restoreKey = decodeRestoreKey(options.restoreKey);
    this.restoreBitcoinLockCoupon = options.restoreBitcoinLockCoupon;
  }

  public get isEnabled(): boolean {
    return !!this.restoreKey;
  }

  public isPackageRequired(authAccountId: string): boolean {
    if (!this.isEnabled) return false;

    const user = this.db.usersTable.fetchByAuthAccountId(authAccountId, UserRole.Member);
    return !user || !this.db.userInvitesTable.fetchById(user.id);
  }

  public async restoreAuthenticatedMember(args: {
    authAccountId: string;
    restorePackage?: string;
    packageRequired: boolean;
  }): Promise<boolean> {
    const existingUser = this.db.usersTable.fetchByAuthAccountId(args.authAccountId, UserRole.Member) ?? undefined;
    const existingInvite = existingUser
      ? (this.db.userInvitesTable.fetchById(existingUser.id) ?? undefined)
      : undefined;
    if (args.packageRequired && !args.restorePackage) {
      throw new RouterError('The router no longer recognizes this member and requires its restore package.', 403);
    }

    const payload = args.restorePackage ? this.validatePackage(args.restorePackage, args.authAccountId) : undefined;
    if (
      payload &&
      existingUser &&
      (payload.member.id !== existingUser.id || payload.member.defaultAccountId !== existingUser.accountId)
    ) {
      throw new RouterError('Restore package does not match the current member.', 403);
    }
    if ((!existingUser || !existingInvite) && !payload) {
      throw new RouterError('This auth account is not allowed to access the router.', 403);
    }
    if (!payload) return false;

    this.assertNoMemberRestoreConflict(payload, args.authAccountId);

    if (payload.bitcoinLockCoupon) {
      if (!this.restoreBitcoinLockCoupon) {
        throw new RouterError('Bitcoin lock coupon restoration is not configured.', 503);
      }

      await this.restoreBitcoinLockCoupon(payload.bitcoinLockCoupon);
    }
    this.db.transaction(() => this.restoreMember(payload, args.authAccountId));
    return true;
  }

  public createPackage(invite: IUserInviteRecord, bitcoinLockCoupon?: IBitcoinLockCouponRecord): string {
    if (!this.restoreKey || !invite.defaultAccountId || !invite.authAccountId) {
      throw new RouterError('Router member restore is not configured for this member.', 503);
    }
    if (
      bitcoinLockCoupon &&
      (bitcoinLockCoupon.userId !== invite.id || bitcoinLockCoupon.accountId !== invite.defaultAccountId)
    ) {
      throw new RouterError('Bitcoin lock coupon does not match this member.', 409);
    }

    return sealPackage(
      {
        version: 1,
        member: {
          id: invite.id,
          name: invite.name,
          fromName: invite.fromName,
          inviteCode: invite.inviteCode,
          defaultAccountId: invite.defaultAccountId,
        },
        ...(bitcoinLockCoupon ? { bitcoinLockCoupon } : {}),
      },
      this.restoreKey,
      invite.authAccountId,
    );
  }

  private validatePackage(restorePackage: string, authAccountId: string): IRestorePackagePayload {
    if (!this.restoreKey) {
      throw new RouterError('Router member restore is not configured.', 503);
    }

    const payload = unsealPackage(restorePackage, this.restoreKey, authAccountId);
    const member = payload.member;
    if (
      payload.version !== 1 ||
      !member ||
      !member.id ||
      !member.name ||
      !member.fromName ||
      !member.inviteCode ||
      !member.defaultAccountId
    ) {
      throw new RouterError('Restore package does not match this member.', 403);
    }
    if (
      payload.bitcoinLockCoupon &&
      (payload.bitcoinLockCoupon.userId !== member.id ||
        payload.bitcoinLockCoupon.accountId !== member.defaultAccountId)
    ) {
      throw new RouterError('Restore package contains inconsistent coupon details.', 403);
    }

    return payload;
  }

  private assertNoMemberRestoreConflict(payload: IRestorePackagePayload, authAccountId: string): void {
    const member = payload.member;
    const existingUser = this.db.usersTable.fetchByAuthAccountId(authAccountId, UserRole.Member);
    if (existingUser) {
      if (existingUser.id !== member.id || existingUser.accountId !== member.defaultAccountId) {
        throw new RouterError('Restore package conflicts with an existing member.', 409);
      }
      const existingInvite = this.db.userInvitesTable.fetchById(existingUser.id);
      if (existingInvite) {
        return;
      }
      if (this.db.userInvitesTable.fetchByCode(member.inviteCode)) {
        throw new RouterError('Restore package conflicts with an existing member.', 409);
      }

      return;
    }

    if (
      this.db.usersTable.fetchById(member.id) ||
      this.db.usersTable.fetchByAccountId(member.defaultAccountId) ||
      this.db.userInvitesTable.fetchByCode(member.inviteCode)
    ) {
      throw new RouterError('Restore package conflicts with an existing member.', 409);
    }
  }

  private restoreMember(payload: IRestorePackagePayload, authAccountId: string): void {
    this.assertNoMemberRestoreConflict(payload, authAccountId);

    const member = payload.member;
    const existingUser = this.db.usersTable.fetchByAuthAccountId(authAccountId, UserRole.Member);
    if (existingUser) {
      if (this.db.userInvitesTable.fetchById(existingUser.id)) {
        return;
      }

      this.db.userInvitesTable.restoreClaimedInvite({
        userId: member.id,
        inviteCode: member.inviteCode,
        fromName: member.fromName,
      });
      return;
    }

    this.db.usersTable.restoreClaimedUser({
      id: member.id,
      role: UserRole.Member,
      name: member.name,
      accountId: member.defaultAccountId,
      authAccountId,
    });
    this.db.userInvitesTable.restoreClaimedInvite({
      userId: member.id,
      inviteCode: member.inviteCode,
      fromName: member.fromName,
    });
  }
}

function decodeRestoreKey(value?: string): Buffer | undefined {
  if (!value) return;

  const normalized = value.trim().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    throw new Error('ROUTER_RESTORE_KEY must be a 32-byte hex value.');
  }

  return Buffer.from(normalized, 'hex');
}

function sealPackage(payload: IRestorePackagePayload, key: Buffer, authAccountId: string): string {
  const nonce = randomBytes(RESTORE_PACKAGE_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(getPackageAad(authAccountId));

  const ciphertext = Buffer.concat([cipher.update(JsonExt.stringify(payload), 'utf8'), cipher.final()]);

  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
}

function unsealPackage(restorePackage: string, key: Buffer, authAccountId: string): IRestorePackagePayload {
  try {
    const encrypted = Buffer.from(restorePackage, 'base64url');
    if (encrypted.length <= RESTORE_PACKAGE_NONCE_BYTES + RESTORE_PACKAGE_TAG_BYTES) {
      throw new Error('Restore package is too short.');
    }

    const nonce = encrypted.subarray(0, RESTORE_PACKAGE_NONCE_BYTES);
    const tag = encrypted.subarray(encrypted.length - RESTORE_PACKAGE_TAG_BYTES);
    const ciphertext = encrypted.subarray(RESTORE_PACKAGE_NONCE_BYTES, encrypted.length - RESTORE_PACKAGE_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(getPackageAad(authAccountId));
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JsonExt.parse<IRestorePackagePayload>(plaintext);
  } catch {
    throw new RouterError('Restore package is invalid.', 403);
  }
}

function getPackageAad(authAccountId: string): Buffer {
  return Buffer.concat([RESTORE_PACKAGE_AAD, Buffer.from([0]), Buffer.from(authAccountId)]);
}
