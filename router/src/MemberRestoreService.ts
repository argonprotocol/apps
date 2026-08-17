import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  type IBitcoinLockCouponRecord,
  type IBitcoinLockCouponStatus,
  type IBitcoinLockCouponUseRecord,
  type IBitcoinLockRelayRecord,
  type IRouterAuthAccountBinding,
  JsonExt,
  UserRole,
  verifyRouterAuthAccountBinding,
} from '@argonprotocol/apps-core';
import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import type { IUserInviteRecord } from './db/UserInvitesTable.ts';

// Keep the encryption context stable so existing v1 packages remain readable; the payload carries its format version.
const RESTORE_PACKAGE_AAD = Buffer.from('argon-router-restore-v1');
const RESTORE_PACKAGE_NONCE_BYTES = 12;
const RESTORE_PACKAGE_TAG_BYTES = 16;

const RESTORE_PACKAGE_FORMAT_VERSION = 3;

type IRestoreMember = Pick<IUserInviteRecord, 'id' | 'name' | 'fromName' | 'inviteCode'> &
  Partial<
    Pick<
      IUserInviteRecord,
      | 'createdAt'
      | 'firstClickedAt'
      | 'operationsUpgradeRequestedAt'
      | 'operationsUpgradedAt'
      | 'operationsAccessProofSignature'
    >
  >;

type IRestorePackagePayload = {
  version: 3;
  member: IRestoreMember;
  bitcoinLockCoupon?: {
    coupon: Omit<IBitcoinLockCouponRecord, 'id' | 'userId' | 'accountId'>;
    relay?: IBitcoinLockRelayRecord;
    uses?: Omit<IBitcoinLockCouponUseRecord, 'id' | 'couponId'>[];
  };
};

type IVersionTwoRestorePackagePayload = {
  version: 2;
  member: IRestoreMember;
  bitcoinLockCoupon?: Omit<IBitcoinLockCouponRecord, 'id' | 'userId' | 'accountId'>;
};

type ILegacyRestorePackagePayload = {
  version: 1;
  member: IRestoreMember & {
    defaultAccountId: string;
    operationalAccountId?: string | null;
  };
  bitcoinLockCoupon?: IBitcoinLockCouponRecord;
};

export class MemberRestoreService {
  private readonly db: Db;
  private readonly restoreKey?: Buffer;

  constructor(options: { db: Db; restoreKey?: string }) {
    this.db = options.db;
    this.restoreKey = decodeRestoreKey(options.restoreKey);
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
    accountBinding?: IRouterAuthAccountBinding & { signature: string };
  }): Promise<void> {
    const existingUser = this.db.usersTable.fetchByAuthAccountId(args.authAccountId, UserRole.Member) ?? undefined;
    const existingInvite = existingUser
      ? (this.db.userInvitesTable.fetchById(existingUser.id) ?? undefined)
      : undefined;
    if (args.packageRequired && !args.restorePackage) {
      throw new RouterError('The router no longer recognizes this member and requires its restore package.', 403);
    }

    const payload = args.restorePackage ? this.validatePackage(args.restorePackage, args.authAccountId) : undefined;
    if (!payload) {
      if (!existingUser || !existingInvite) {
        throw new RouterError('This auth account is not allowed to access the router.', 403);
      }
      return;
    }

    const memberAccounts = this.getMemberAccounts(payload, args);
    if (
      existingUser &&
      (payload.member.id !== existingUser.id || memberAccounts.accountId !== existingUser.accountId)
    ) {
      throw new RouterError('Restore package does not match the current member.', 403);
    }

    this.assertNoMemberRestoreConflict(payload, args.authAccountId, memberAccounts.accountId);

    this.db.transaction(() => {
      this.restoreMember(payload, args.authAccountId, memberAccounts);

      if (!payload.bitcoinLockCoupon) return;

      if (payload.version === 3) {
        const { coupon, relay } = payload.bitcoinLockCoupon;
        const restoredCoupon = this.db.bitcoinLockCouponsTable.restore({
          ...coupon,
          userId: payload.member.id,
          accountId: memberAccounts.accountId,
          relayRequestId: relay?.requestId,
          relay,
        });
        for (const use of payload.bitcoinLockCoupon.uses ?? []) {
          this.db.bitcoinLockCouponsTable.restoreUse(restoredCoupon.id, use);
        }
        return;
      }

      if (payload.version === 2) {
        this.db.bitcoinLockCouponsTable.restore({
          ...payload.bitcoinLockCoupon,
          userId: payload.member.id,
          accountId: memberAccounts.accountId,
        });
        return;
      }

      const { id: _id, userId: _userId, accountId: _accountId, ...coupon } = payload.bitcoinLockCoupon;
      this.db.bitcoinLockCouponsTable.restore({
        ...coupon,
        userId: payload.member.id,
        accountId: memberAccounts.accountId,
      });
    });
  }

  public getPackageRevision(authAccountId: string): string | undefined {
    const user = this.db.usersTable.fetchByAuthAccountId(authAccountId, UserRole.Member);
    const invite = user ? this.db.userInvitesTable.fetchById(user.id) : undefined;
    if (!invite) return;

    let operationsRevision = 0;
    if (invite.operationsUpgradeRequestedAt) operationsRevision = 1;
    if (invite.operationsUpgradedAt || invite.operationsAccessProofSignature) operationsRevision = 2;

    const coupon = this.db.bitcoinLockCouponsTable.fetchLatestByUserId(invite.id);
    return `${RESTORE_PACKAGE_FORMAT_VERSION}.${operationsRevision}.${coupon?.updatedAt.getTime() ?? 0}`;
  }

  public createPackage(invite: IUserInviteRecord, bitcoinLockCoupon?: IBitcoinLockCouponStatus): string {
    if (!this.restoreKey || !invite.defaultAccountId || !invite.authAccountId) {
      throw new RouterError('Router member restore is not configured for this member.', 503);
    }
    if (
      bitcoinLockCoupon &&
      (bitcoinLockCoupon.coupon.userId !== invite.id || bitcoinLockCoupon.coupon.accountId !== invite.defaultAccountId)
    ) {
      throw new RouterError('Bitcoin lock coupon does not match this member.', 409);
    }

    let coupon: IRestorePackagePayload['bitcoinLockCoupon'];
    if (bitcoinLockCoupon) {
      const { id: _id, userId: _userId, accountId: _accountId, ...couponDetails } = bitcoinLockCoupon.coupon;
      coupon = {
        coupon: couponDetails,
        relay: bitcoinLockCoupon.relay,
        uses: bitcoinLockCoupon.uses?.map(({ id: _id, couponId: _couponId, ...use }) => use),
      };
    }

    return sealPackage(
      {
        version: RESTORE_PACKAGE_FORMAT_VERSION,
        member: {
          id: invite.id,
          name: invite.name,
          fromName: invite.fromName,
          inviteCode: invite.inviteCode,
          createdAt: invite.createdAt,
          firstClickedAt: invite.firstClickedAt,
          operationsUpgradeRequestedAt: invite.operationsUpgradeRequestedAt,
          operationsUpgradedAt: invite.operationsUpgradedAt,
          operationsAccessProofSignature: invite.operationsAccessProofSignature,
        },
        ...(coupon ? { bitcoinLockCoupon: coupon } : {}),
      },
      this.restoreKey,
      invite.authAccountId,
    );
  }

  private validatePackage(
    restorePackage: string,
    authAccountId: string,
  ): IRestorePackagePayload | IVersionTwoRestorePackagePayload | ILegacyRestorePackagePayload {
    if (!this.restoreKey) {
      throw new RouterError('Router member restore is not configured.', 503);
    }

    const payload = unsealPackage(restorePackage, this.restoreKey, authAccountId);
    const member = payload.member;
    if (payload.version !== 1 && payload.version !== 2 && payload.version !== RESTORE_PACKAGE_FORMAT_VERSION) {
      throw new RouterError('Restore package does not match this member.', 403);
    }
    if (!member || !member.id || !member.name || !member.fromName || !member.inviteCode) {
      throw new RouterError('Restore package does not match this member.', 403);
    }
    if (payload.version === 1 && !payload.member.defaultAccountId) {
      throw new RouterError('Restore package does not match this member.', 403);
    }
    if (
      payload.version === 1 &&
      payload.bitcoinLockCoupon &&
      (payload.bitcoinLockCoupon.userId !== member.id ||
        payload.bitcoinLockCoupon.accountId !== payload.member.defaultAccountId)
    ) {
      throw new RouterError('Restore package contains inconsistent coupon details.', 403);
    }

    return payload;
  }

  private getMemberAccounts(
    payload: IRestorePackagePayload | IVersionTwoRestorePackagePayload | ILegacyRestorePackagePayload,
    args: {
      authAccountId: string;
      accountBinding?: IRouterAuthAccountBinding & { signature: string };
    },
  ): { accountId: string; operationalAccountId?: string | null } {
    if (payload.version === 1) {
      return {
        accountId: payload.member.defaultAccountId,
        operationalAccountId: payload.member.operationalAccountId,
      };
    }

    // Current packages omit account ids that the member wallet can prove again during recovery.
    const accountBinding = args.accountBinding;
    if (!accountBinding) {
      throw new RouterError('The member account binding is required to restore this backup.', 403);
    }
    if (
      accountBinding.authAccountId !== args.authAccountId ||
      accountBinding.expiresAt <= Date.now() ||
      !verifyRouterAuthAccountBinding(accountBinding, accountBinding.signature)
    ) {
      throw new RouterError('The member account binding is invalid.', 403);
    }

    const memberAccounts: { accountId: string; operationalAccountId?: string } = {
      accountId: accountBinding.accountId,
    };
    if (
      (payload.member.operationsUpgradeRequestedAt ||
        payload.member.operationsUpgradedAt ||
        payload.member.operationsAccessProofSignature) &&
      accountBinding.operationalAccountId
    ) {
      memberAccounts.operationalAccountId = accountBinding.operationalAccountId;
    }

    return memberAccounts;
  }

  private assertNoMemberRestoreConflict(
    payload: IRestorePackagePayload | IVersionTwoRestorePackagePayload | ILegacyRestorePackagePayload,
    authAccountId: string,
    accountId: string,
  ): void {
    const member = payload.member;
    const existingUser = this.db.usersTable.fetchByAuthAccountId(authAccountId, UserRole.Member);
    if (existingUser) {
      if (existingUser.id !== member.id || existingUser.accountId !== accountId) {
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
      this.db.usersTable.fetchByAccountId(accountId) ||
      this.db.userInvitesTable.fetchByCode(member.inviteCode)
    ) {
      throw new RouterError('Restore package conflicts with an existing member.', 409);
    }
  }

  private restoreMember(
    payload: IRestorePackagePayload | IVersionTwoRestorePackagePayload | ILegacyRestorePackagePayload,
    authAccountId: string,
    accounts: { accountId: string; operationalAccountId?: string | null },
  ): void {
    this.assertNoMemberRestoreConflict(payload, authAccountId, accounts.accountId);

    let member: IRestoreMember;
    if (payload.version === 1) {
      const {
        defaultAccountId: _defaultAccountId,
        operationalAccountId: _operationalAccountId,
        ...rest
      } = payload.member;
      member = rest;
    } else {
      member = payload.member;
    }

    const { id, name, ...invite } = member;
    const existingUser = this.db.usersTable.fetchByAuthAccountId(authAccountId, UserRole.Member);
    if (existingUser) {
      if (this.db.userInvitesTable.fetchById(existingUser.id)) {
        return;
      }

      this.db.userInvitesTable.restoreClaimedInvite({
        userId: id,
        ...invite,
        createdAt: invite.createdAt ?? existingUser.createdAt,
      });
      return;
    }

    const restoredUser = this.db.usersTable.restoreClaimedUser({
      id,
      role: UserRole.Member,
      name,
      accountId: accounts.accountId,
      authAccountId,
      operationalAccountId: accounts.operationalAccountId,
    });
    this.db.userInvitesTable.restoreClaimedInvite({
      userId: id,
      ...invite,
      createdAt: invite.createdAt ?? restoredUser.createdAt,
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

function unsealPackage(
  restorePackage: string,
  key: Buffer,
  authAccountId: string,
): IRestorePackagePayload | IVersionTwoRestorePackagePayload | ILegacyRestorePackagePayload {
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
    return JsonExt.parse<IRestorePackagePayload | IVersionTwoRestorePackagePayload | ILegacyRestorePackagePayload>(
      plaintext,
    );
  } catch {
    throw new RouterError('Restore package is invalid.', 403);
  }
}

function getPackageAad(authAccountId: string): Buffer {
  return Buffer.concat([RESTORE_PACKAGE_AAD, Buffer.from([0]), Buffer.from(authAccountId)]);
}
