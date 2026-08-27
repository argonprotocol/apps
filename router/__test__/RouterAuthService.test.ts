import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ArgonClient,
  type IBitcoinLockCouponRecord,
  type IBitcoinLockCouponUseRecord,
  signRouterAuthAccountBinding,
  signRouterAuthChallenge,
  UserRole,
} from '@argonprotocol/apps-core';
import { Keyring } from '@argonprotocol/mainchain';
import { BitcoinLockCouponService } from '../src/BitcoinLockCouponService.ts';
import { BotUpstreamClient } from '../src/BotUpstreamClient.ts';
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

  it('verifies member credentials before restoring and reconciling coupon uses', async () => {
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
      feeCreditMicrogons: 1_000n,
      expiresAfterTicks: 60,
      accountId: member.address,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const couponUse: IBitcoinLockCouponUseRecord = {
      id: 7,
      couponId: coupon.id,
      requestId: 'lock-1',
      status: 'Finalized',
      feeCreditMicrogons: 400n,
      requestedSatoshis: 10_000n,
      ownerAccountId: member.address,
      ownerBitcoinPubkey: '0x1234',
      microgonsAtTargetPerBtc: 75_000_000n,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const unsignedPreparedUse: IBitcoinLockCouponUseRecord = {
      ...couponUse,
      id: 8,
      requestId: 'lock-2',
      status: 'Prepared',
    };
    const signedPreparedUse: IBitcoinLockCouponUseRecord = {
      ...couponUse,
      id: 9,
      requestId: 'lock-3',
      status: 'Prepared',
      feeCreditMicrogons: 300n,
      feeCoupon: {
        feeDiscount: 300n,
        securitizationSpaceToUnreserve: 0n,
        expiresAtFrame: 1_000n,
        nonce: 1n,
        signature: '0xsignature',
      },
    };
    const restorePackage = originalRestore.createPackage(claimedInvite, {
      coupon,
      uses: [couponUse, unsignedPreparedUse, signedPreparedUse],
      status: 'Open',
    });
    const { auth: recoveredService } = createAuthService(operator.address, restoreKey);
    db!.bitcoinLockCouponsTable.failUnsignedPreparedUses();

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
    expect(db!.bitcoinLockCouponsTable.fetchByOfferCode(coupon.offerCode)).toBeNull();

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
    const restoredCoupon = db!.bitcoinLockCouponsTable.fetchByOfferCode(coupon.offerCode)!;
    expect(restoredCoupon).toMatchObject({
      userId: invite.id,
      accountId: member.address,
      offerCode: coupon.offerCode,
    });
    expect(db!.bitcoinLockCouponsTable.fetchUsesByCouponId(restoredCoupon.id)).toMatchObject([
      {
        requestId: couponUse.requestId,
        status: 'Finalized',
        feeCreditMicrogons: 400n,
      },
      {
        requestId: unsignedPreparedUse.requestId,
        status: 'Failed',
        feeCreditMicrogons: 400n,
      },
      {
        requestId: signedPreparedUse.requestId,
        status: 'Prepared',
        feeCreditMicrogons: 300n,
        feeCoupon: { nonce: 1n },
      },
    ]);

    const couponService = new BitcoinLockCouponService({
      db: db!,
      botClient: new BotUpstreamClient('http://127.0.0.1:1'),
      getMainchainClient: async () =>
        ({
          rpc: { chain: { getFinalizedHead: async () => '0xfinalized' } },
          at: async () => ({
            query: {
              bitcoinLocks: {
                lastFeeCouponNonceByVaultAndAccount: async () => 1n,
              },
              miningSlot: { nextFrameId: async () => 2 },
            },
          }),
        }) as unknown as ArgonClient,
    });
    await couponService.reconcile();

    await expect(couponService.getByOfferCode(coupon.offerCode)).resolves.toMatchObject({
      status: 'Open',
      originalFeeCreditMicrogons: 1_000n,
      usedFeeCreditMicrogons: 700n,
      pendingFeeCreditMicrogons: 0n,
      remainingFeeCreditMicrogons: 300n,
      uses: [
        { requestId: couponUse.requestId, status: 'Finalized' },
        { requestId: unsignedPreparedUse.requestId, status: 'Failed' },
        { requestId: signedPreparedUse.requestId, status: 'Finalized' },
      ],
    });
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
      coupon: {
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
      },
      status: 'Open',
    });

    const { auth: recoveredService } = createAuthService(operator.address, restoreKey);
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
    expect(db!.bitcoinLockCouponsTable.fetchByOfferCode('offer-code-1')).toBeNull();
  });

  it('accepts version two packages through signed member recovery', async () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//RestoreV2Member');
    const memberAuth = member.derive('//upstream-operator-auth');
    const restoreKey = `0x${'42'.repeat(32)}`;
    const versionTwoRestorePackage =
      'AAECAwQFBgcICQoLfvznuMNfm2TzJH4h_f82Xl__qxiCc5nLev0CHaskjNN21ejPFBIY26YQYXJs-PU6W85Zb9erUT1J6Jmn4jbEzrQGwyFkuBswPULCrrngo7PXhULeJ3qfV2PMYVflkF8ZGpNByigFfZW3CGjHH9C8t0MD5wmpNWbSv3cu4HJZm7PxhXgD0tNvLh6C4ZuCQdbTaZH8T6xMeYT0a2QB9atSIFMNRimWL7kIhK1zJijxOfnhAAXksVxaiZMdFIS6N3M93CUtiZKUQJqAmpmyrmACBeEKhs6DY48-eC6-TCMWfdtXCD2xZuf2Y92bm4t4V2EX6oOkAI49TI06_zqzrBkEyT4IFFejvHqKmmJuTMQ446FThU2eu6_5yuDOKsUHFfblWgGiFs389j0LRACw_xdpVg5VtI9BHkhUbIrBEeIX1IO5SAACkJV54ry-ggKFji1HYKU1GJUVcnRTSV0awHdGB0LG7WEqzV_F2jNyRivYGGGyaSS2QKP_mUtn58hD5B9W8EkAfRHl6kjy90_ObkvO6lg7ByVfj1dpkR6nS69bmWzLJpz4IKd09x5HOeUcJxsdxvsaJ--kBiqqgOSc0dTT4PhS3LtF4QutjKRjNALuXBjxqbneTBgEkq-gTlGaCWUpYLWvVhI21z7CcyJNkgG-_gMwgNZp1_jOOb4EZOw4FzpfrQpoboJLAag';
    const { auth } = createAuthService(operator.address, restoreKey);

    const challenge = auth.createChallenge(memberAuth.address, UserRole.Member, {
      restorePackageRequired: true,
    });
    const accountBinding = {
      accountId: member.address,
      authAccountId: memberAuth.address,
      expiresAt: challenge.expiresAt,
    };
    await auth.createSession({
      ...challenge,
      restorePackage: versionTwoRestorePackage,
      accountBinding: {
        ...accountBinding,
        signature: signRouterAuthAccountBinding(member, accountBinding),
      },
      signature: signRouterAuthChallenge(memberAuth, challenge),
    });

    expect(db!.userInvitesTable.fetchByCode('legacy-v2-invite-code')).toMatchObject({
      name: 'Legacy V2 Member',
      fromName: 'Legacy V2 Operator',
      defaultAccountId: member.address,
    });
    const restoredCoupon = db!.bitcoinLockCouponsTable.fetchByOfferCode('legacy-v2-offer');
    expect(restoredCoupon).toMatchObject({
      accountId: member.address,
      maxSatoshis: 25_000n,
      feeCreditMicrogons: 0n,
    });
    expect(db!.bitcoinLockCouponsTable.fetchUsesByCouponId(restoredCoupon!.id)).toEqual([]);
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
  ): { auth: RouterAuthService; memberRestore: MemberRestoreService } {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-auth-service-test-'));
    db = new Db(Path.join(tempDir, 'router.sqlite'));
    dbs.push(db);
    db.migrate();

    const memberRestore = new MemberRestoreService({ db, restoreKey });
    const auth = new RouterAuthService({
      db,
      adminOperatorAccountId,
      sessionTtlSeconds: 60,
      memberRestore,
    });

    return { auth, memberRestore };
  }
});
