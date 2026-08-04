import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type IBitcoinLockCouponRecord,
  signRouterAuthAccountBinding,
  signRouterAuthChallenge,
  UserRole,
} from '@argonprotocol/apps-core';
import { Keyring } from '@argonprotocol/mainchain';
import { Db } from '../src/Db.ts';
import { MemberRestoreService } from '../src/MemberRestoreService.ts';
import { RouterAuthService } from '../src/RouterAuthService.ts';

describe('RouterAuthService', () => {
  let db: Db | undefined;
  const dbs: Db[] = [];

  afterEach(() => {
    for (const testDb of dbs.splice(0)) {
      testDb.close();
    }
    db = undefined;
  });

  it('creates admin sessions from valid challenge signatures', async () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const { auth: service } = createAuthService(operator.address);
    const challenge = service.createChallenge(operator.address, UserRole.AdminOperator);
    const signature = signRouterAuthChallenge(operator, challenge);

    const { session } = await service.createSession({ ...challenge, signature });

    expect(session.sessionId).toBeTruthy();
    expect(session.accountId).toBe(operator.address);
    expect(session.role).toBe(UserRole.AdminOperator);
  });

  it('creates member sessions from claimed invite auth accounts', async () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');
    const { auth: service, memberRestore } = createAuthService(operator.address, `0x${'42'.repeat(32)}`);

    const user = db!.usersTable.insertUser({
      role: UserRole.Member,
      name: 'Casey',
    });
    const invite = db!.userInvitesTable.insertInvite(user.id, 'member-invite-1', 'Operator One');
    db!.userInvitesTable.claimInvite(invite.id, member.address, memberAuth.address);

    const challenge = service.createChallenge(memberAuth.address, UserRole.Member);
    const signature = signRouterAuthChallenge(memberAuth, challenge);
    const { session } = await service.createSession({ ...challenge, signature });

    expect(session.accountId).toBe(member.address);
    expect(session.role).toBe(UserRole.Member);
    expect(memberRestore.isPackageRequired(memberAuth.address)).toBe(false);
  });

  it('rejects challenge signatures from the wrong key', async () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const wrongOperator = new Keyring({ type: 'sr25519' }).addFromUri('//WrongRouterOperator');
    const { auth: service } = createAuthService(operator.address);
    const challenge = service.createChallenge(operator.address, UserRole.AdminOperator);
    const signature = signRouterAuthChallenge(wrongOperator, challenge);

    await expect(service.createSession({ ...challenge, signature })).rejects.toThrowError(
      'Login signature is invalid.',
    );
  });

  it('rejects unclaimed member auth only after its challenge signature is verified', async () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const { auth: service } = createAuthService(operator.address);
    const challenge = service.createChallenge(member.address, UserRole.Member);

    await expect(
      service.createSession({
        ...challenge,
        signature: signRouterAuthChallenge(member, challenge),
      }),
    ).rejects.toThrowError('This auth account is not allowed to access the router.');
  });

  it('verifies the login and account binding before restoring a member', async () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//RestoreMember');
    const memberAuth = member.derive('//upstream-operator-auth');
    const restoreKey = `0x${'42'.repeat(32)}`;
    const { memberRestore: originalRestore } = createAuthService(operator.address, restoreKey);

    const user = db!.usersTable.insertUser({
      role: UserRole.Member,
      name: 'Casey',
    });
    const invite = db!.userInvitesTable.insertInvite(user.id, 'member-invite-1', 'Operator One');
    db!.userInvitesTable.claimInvite(invite.id, member.address, memberAuth.address);
    const claimedInvite = db!.userInvitesTable.fetchById(invite.id)!;
    const coupon: IBitcoinLockCouponRecord = {
      id: 11,
      userId: invite.id,
      sequence: 1,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 60,
      accountId: member.address,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const restorePackage = originalRestore.createPackage(claimedInvite, coupon);
    const restoreBitcoinLockCoupon = vi.fn(async () => {
      expect(db!.usersTable.fetchByAuthAccountId(memberAuth.address)).toBeNull();
    });
    const { auth: recoveredService } = createAuthService(operator.address, restoreKey, restoreBitcoinLockCoupon);

    const unsignedChallenge = recoveredService.createChallenge(memberAuth.address, UserRole.Member, {
      restorePackageRequired: true,
    });
    const wrongSigner = member.derive('//wrong-auth');
    await expect(
      recoveredService.createSession({
        ...unsignedChallenge,
        restorePackage,
        signature: signRouterAuthChallenge(wrongSigner, unsignedChallenge),
      }),
    ).rejects.toThrow('Login signature is invalid.');
    expect(db!.usersTable.fetchByAuthAccountId(memberAuth.address)).toBeNull();
    expect(restoreBitcoinLockCoupon).not.toHaveBeenCalled();

    const missingBindingChallenge = recoveredService.createChallenge(memberAuth.address, UserRole.Member, {
      restorePackageRequired: true,
    });
    await expect(
      recoveredService.createSession({
        ...missingBindingChallenge,
        restorePackage,
        signature: signRouterAuthChallenge(memberAuth, missingBindingChallenge),
      }),
    ).rejects.toThrow('The member account binding is required to restore this backup.');

    const challenge = recoveredService.createChallenge(memberAuth.address, UserRole.Member, {
      restorePackageRequired: true,
    });
    const accountBinding = {
      accountId: member.address,
      authAccountId: memberAuth.address,
      expiresAt: challenge.expiresAt,
    };
    await recoveredService.createSession({
      ...challenge,
      restorePackage,
      accountBinding: {
        ...accountBinding,
        signature: signRouterAuthAccountBinding(member, accountBinding),
      },
      signature: signRouterAuthChallenge(memberAuth, challenge),
    });
    expect(restoreBitcoinLockCoupon).toHaveBeenCalledOnce();
  });

  it('rejects router conflicts before restoring a coupon', async () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//RestoreMember');
    const memberAuth = member.derive('//upstream-operator-auth');
    const restoreKey = `0x${'42'.repeat(32)}`;
    const { memberRestore: originalRestore } = createAuthService(operator.address, restoreKey);

    const user = db!.usersTable.insertUser({
      role: UserRole.Member,
      name: 'Casey',
    });
    const invite = db!.userInvitesTable.insertInvite(user.id, 'member-invite-1', 'Operator One');
    db!.userInvitesTable.claimInvite(invite.id, member.address, memberAuth.address);
    const restorePackage = originalRestore.createPackage(db!.userInvitesTable.fetchById(invite.id)!, {
      id: 11,
      userId: invite.id,
      sequence: 1,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 60,
      accountId: member.address,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const restoreBitcoinLockCoupon = vi.fn().mockResolvedValue(undefined);
    const { auth: recoveredService } = createAuthService(operator.address, restoreKey, restoreBitcoinLockCoupon);
    db!.usersTable.insertUser({
      role: UserRole.Member,
      name: 'Conflicting Member',
    });

    const challenge = recoveredService.createChallenge(memberAuth.address, UserRole.Member, {
      restorePackageRequired: true,
    });
    const accountBinding = {
      accountId: member.address,
      authAccountId: memberAuth.address,
      expiresAt: challenge.expiresAt,
    };
    await expect(
      recoveredService.createSession({
        ...challenge,
        restorePackage,
        accountBinding: {
          ...accountBinding,
          signature: signRouterAuthAccountBinding(member, accountBinding),
        },
        signature: signRouterAuthChallenge(memberAuth, challenge),
      }),
    ).rejects.toThrow('Restore package conflicts with an existing member.');
    expect(restoreBitcoinLockCoupon).not.toHaveBeenCalled();
  });

  it('accepts the previous package format using the recovered user date and refreshes the next signed login', async () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const memberAuth = new Keyring({ type: 'sr25519' }).addFromUri('//LegacyMemberAuth');
    const restoreKey = `0x${'42'.repeat(32)}`;
    const legacyRestorePackage =
      'yerDW_cRdoQltNzAHN9Y_93rvAAWCot__gEafy2ywbfKrqgF0jUe3_R2W4Kf5DdqofrLuFOkGFxV7QbZnH7Xc2WwfuwcE_DDeeydwr0isZeW7Fns8cKxw2TpwXyN7mLR4Tv_UvSirIfS1dG7tWnZrMUCG7uP1fr0yY_GZ37eYdalNdCCVA0DaNxmtdRatSKBtSx0H8hTbcKNtS0DyAdnw90nnVuhD_614k600g_CSIo0bL41lwnugclJss4W';
    const { memberRestore, auth } = createAuthService(operator.address, restoreKey);

    await memberRestore.restoreAuthenticatedMember({
      authAccountId: memberAuth.address,
      restorePackage: legacyRestorePackage,
      packageRequired: true,
    });

    const restoredInvite = db!.userInvitesTable.fetchByCode('legacy-invite-code');
    const restoredUser = db!.usersTable.fetchById(restoredInvite!.id);
    expect(restoredInvite).toMatchObject({
      name: 'Legacy Member',
      fromName: 'Legacy Operator',
      defaultAccountId: 'legacy-default-account',
      createdAt: restoredUser!.createdAt,
      firstClickedAt: null,
      operationsUpgradeRequestedAt: null,
      operationsUpgradedAt: null,
    });

    const challenge = auth.createChallenge(memberAuth.address, UserRole.Member);
    const session = await auth.createSession({
      ...challenge,
      signature: signRouterAuthChallenge(memberAuth, challenge),
    });

    expect(session.refreshRestorePackage).toBe(true);
  });

  function createAuthService(
    adminOperatorAccountId: string,
    restoreKey?: string,
    restoreBitcoinLockCoupon?: (coupon: Omit<IBitcoinLockCouponRecord, 'id'>) => Promise<void>,
  ): { auth: RouterAuthService; memberRestore: MemberRestoreService } {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-auth-service-test-'));
    db = new Db(Path.join(tempDir, 'router.sqlite'));
    dbs.push(db);
    db.migrate();

    const memberRestore = new MemberRestoreService({
      db,
      restoreKey,
      restoreBitcoinLockCoupon,
    });
    const auth = new RouterAuthService({
      db,
      adminOperatorAccountId,
      sessionTtlSeconds: 60,
      memberRestore,
    });

    return { auth, memberRestore };
  }
});
