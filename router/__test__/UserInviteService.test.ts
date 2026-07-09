import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOperationalAccessProof, signRouterAuthAccountBinding, UserRole } from '@argonprotocol/apps-core';
import { Keyring, type ArgonClient, type KeyringPair } from '@argonprotocol/mainchain';
import { Db } from '../src/Db.ts';
import { UserInviteService } from '../src/UserInviteService.ts';

describe('UserInviteService', () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
  });

  it('retries invite code collisions without creating extra rows', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-collision-')), 'router.sqlite'));
    db.migrate();

    const firstService = new UserInviteService(db, {
      createInviteCode: () => 'member-invite-1',
    });
    const secondIds = ['member-invite-1', 'member-invite-2'];
    const secondService = new UserInviteService(db, {
      createInviteCode: () => secondIds.shift() ?? 'member-invite-fallback',
    });

    const firstInvite = firstService.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });
    const secondInvite = secondService.createInvite({
      name: 'Riley',
      fromName: 'Operator One',
    });

    expect(firstInvite.inviteCode).toBe('member-invite-1');
    expect(secondInvite.inviteCode).toBe('member-invite-2');
    expect(db.userInvitesTable.fetchByRole(UserRole.Member)).toHaveLength(2);
    expect(db.usersTable.fetchByRole(UserRole.Member)).toHaveLength(2);
  });

  it('claims an invite, updates auth binding, and keeps the same member account', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-claim-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db, {
      createInviteCode: () => 'member-invite-1',
    });
    const invite = service.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');

    const claimed = service.claimInvite(createClaimInviteArgs(invite.inviteCode, member, memberAuth));
    expect(claimed?.defaultAccountId).toBe(member.address);
    expect(claimed?.authAccountId).toBe(memberAuth.address);
    expect(claimed?.lastClickedAt).toBeTruthy();

    const replacementAuth = member.derive('//replacement-downstream-auth');
    const rebound = service.claimInvite(createClaimInviteArgs(invite.inviteCode, member, replacementAuth));

    expect(rebound?.defaultAccountId).toBe(member.address);
    expect(rebound?.authAccountId).toBe(replacementAuth.address);
  });

  it('rejects claims from a different member once an invite is bound', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-different-member-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db, {
      createInviteCode: () => 'member-invite-1',
    });
    const invite = service.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const otherMember = new Keyring({ type: 'sr25519' }).addFromUri('//OtherInviteMember');

    service.claimInvite(createClaimInviteArgs(invite.inviteCode, member, member.derive('//downstream-auth')));

    expect(() =>
      service.claimInvite(
        createClaimInviteArgs(invite.inviteCode, otherMember, otherMember.derive('//downstream-auth')),
      ),
    ).toThrowError('This invite is already claimed by a different account.');
  });

  it('rejects reusing a member account on a different invite', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-account-reuse-')), 'router.sqlite'));
    db.migrate();

    const ids = ['member-invite-1', 'member-invite-2'];
    const service = new UserInviteService(db, {
      createInviteCode: () => ids.shift() ?? 'member-invite-fallback',
    });
    const firstInvite = service.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });
    const secondInvite = service.createInvite({
      name: 'Riley',
      fromName: 'Operator One',
    });
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');

    service.claimInvite(createClaimInviteArgs(firstInvite.inviteCode, member, member.derive('//downstream-auth')));

    expect(() =>
      service.claimInvite(
        createClaimInviteArgs(secondInvite.inviteCode, member, member.derive('//other-downstream-auth')),
      ),
    ).toThrowError('This account is already linked to a different invite.');
  });

  it('rejects reusing an auth account on a different invite', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-auth-reuse-')), 'router.sqlite'));
    db.migrate();

    const ids = ['member-invite-1', 'member-invite-2'];
    const service = new UserInviteService(db, {
      createInviteCode: () => ids.shift() ?? 'member-invite-fallback',
    });
    const firstInvite = service.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });
    const secondInvite = service.createInvite({
      name: 'Riley',
      fromName: 'Operator One',
    });
    const firstMember = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const secondMember = new Keyring({ type: 'sr25519' }).addFromUri('//OtherInviteMember');
    const sharedAuth = firstMember.derive('//shared-downstream-auth');

    service.claimInvite(createClaimInviteArgs(firstInvite.inviteCode, firstMember, sharedAuth));

    expect(() =>
      service.claimInvite(createClaimInviteArgs(secondInvite.inviteCode, secondMember, sharedAuth)),
    ).toThrowError('This auth account is already linked to a different invite.');
  });

  it('rejects reusing an operational account on a different invite upgrade request', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-operational-reuse-')), 'router.sqlite'));
    db.migrate();

    const ids = ['member-invite-1', 'member-invite-2'];
    const service = new UserInviteService(db, {
      createInviteCode: () => ids.shift() ?? 'member-invite-fallback',
    });
    const firstInvite = service.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });
    const secondInvite = service.createInvite({
      name: 'Riley',
      fromName: 'Operator One',
    });
    const firstMember = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const secondMember = new Keyring({ type: 'sr25519' }).addFromUri('//OtherInviteMember');
    const sharedOperationalAccount = firstMember.derive('//shared-operational');

    const firstMemberAuth = firstMember.derive('//downstream-auth');
    const secondMemberAuth = secondMember.derive('//downstream-auth');

    service.claimInvite(createClaimInviteArgs(firstInvite.inviteCode, firstMember, firstMemberAuth));
    service.claimInvite(createClaimInviteArgs(secondInvite.inviteCode, secondMember, secondMemberAuth));

    service.requestOperationsUpgrade(
      createRequestOperationsUpgradeArgs(firstMember, firstMemberAuth, sharedOperationalAccount),
    );

    expect(() =>
      service.requestOperationsUpgrade(
        createRequestOperationsUpgradeArgs(secondMember, secondMemberAuth, sharedOperationalAccount),
      ),
    ).toThrowError('This operational account is already linked to a different invite.');
  });

  it('requires a valid account signature for auth binding', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-binding-signature-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db, {
      createInviteCode: () => 'member-invite-1',
    });
    const invite = service.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');
    const claimArgs = createClaimInviteArgs(invite.inviteCode, member, memberAuth);
    claimArgs.authBindingSignature = signRouterAuthAccountBinding(memberAuth, claimArgs.authBinding);

    expect(() => service.claimInvite(claimArgs)).toThrowError('The auth binding signature is invalid.');
  });

  it('requires an unexpired auth binding', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-binding-expired-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db, {
      createInviteCode: () => 'member-invite-1',
    });
    const invite = service.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');

    expect(() =>
      service.claimInvite(createClaimInviteArgs(invite.inviteCode, member, memberAuth, Date.now() - 1_000)),
    ).toThrowError('The auth binding signature has expired.');
  });

  it('records an operations upgrade request only once per member', async () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-upgrade-request-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db, {
      createInviteCode: () => 'member-invite-1',
    });
    const invite = service.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');
    const operationalAccount = member.derive('//operational');

    service.claimInvite(createClaimInviteArgs(invite.inviteCode, member, memberAuth));

    const firstRequest = service.requestOperationsUpgrade(
      createRequestOperationsUpgradeArgs(member, memberAuth, operationalAccount),
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    const secondRequest = service.requestOperationsUpgrade(
      createRequestOperationsUpgradeArgs(member, memberAuth, operationalAccount),
    );

    expect(firstRequest.operationsUpgradeRequestedAt).toBeTruthy();
    expect(firstRequest.operationalAccountId).toBe(operationalAccount.address);
    expect(secondRequest.operationsUpgradeRequestedAt?.toISOString()).toBe(
      firstRequest.operationsUpgradeRequestedAt?.toISOString(),
    );
    expect(secondRequest.operationsUpgradedAt).toBeFalsy();
  });

  it('marks an invite as upgraded to operations', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-mark-upgraded-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db, {
      createInviteCode: () => 'member-invite-1',
    });
    const invite = service.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });
    const upstreamOperator = new Keyring({ type: 'sr25519' }).addFromUri('//UpstreamOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');
    const operationalAccount = member.derive('//operational');

    service.claimInvite(createClaimInviteArgs(invite.inviteCode, member, memberAuth));
    service.requestOperationsUpgrade(
      createRequestOperationsUpgradeArgs(member, memberAuth, operationalAccount),
    );

    const upgradedInvite = service.markOperationsUpgraded(
      invite.inviteCode,
      createOperationalAccessProof(upstreamOperator, operationalAccount.address),
    );

    expect(upgradedInvite?.operationsUpgradeRequestedAt).toBeTruthy();
    expect(upgradedInvite?.operationalAccountId).toBe(operationalAccount.address);
    expect(upgradedInvite?.operationsUpgradedAt).toBeTruthy();
    expect(upgradedInvite?.operationsAccessProofSignature).toBeTruthy();
  });

  it('migrates missing operational account ids from chain data', async () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'invite-service-heal-operational-account-')), 'router.sqlite'));
    db.migrate();

    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');
    const operationalAccount = member.derive('//operational');
    const service = new UserInviteService(db, {
      createInviteCode: () => 'member-invite-1',
    });
    const invite = service.createInvite({
      name: 'Casey',
      fromName: 'Operator One',
    });

    service.claimInvite(createClaimInviteArgs(invite.inviteCode, member, memberAuth));
    await service.migrateMissingOperationalAccountIds({
      query: {
        operationalAccounts: {
          operationalAccountBySubAccount: {
            multi: async () => [
              {
                isSome: true,
                unwrap: () => operationalAccount.address,
              },
            ],
          },
        },
      },
    } as unknown as ArgonClient);

    expect(db.userInvitesTable.fetchById(invite.id)?.operationalAccountId).toBe(operationalAccount.address);
  });
});

function createClaimInviteArgs(
  inviteCode: string,
  member: KeyringPair,
  authAccount: KeyringPair,
  expiresAt = Date.now() + 60_000,
) {
  const authBinding = {
    inviteCode,
    accountId: member.address,
    authAccountId: authAccount.address,
    expiresAt,
  };

  return {
    inviteCode,
    defaultAccountId: member.address,
    authBinding,
    authBindingSignature: signRouterAuthAccountBinding(member, authBinding),
  };
}

function createRequestOperationsUpgradeArgs(member: KeyringPair, authAccount: KeyringPair, operationalAccount: KeyringPair, expiresAt = Date.now() + 60_000) {
  const authBinding = {
    accountId: member.address,
    operationalAccountId: operationalAccount.address,
    authAccountId: authAccount.address,
    expiresAt,
  };

  return {
    defaultAccountId: member.address,
    authBinding,
    authBindingSignature: signRouterAuthAccountBinding(member, authBinding),
  };
}
