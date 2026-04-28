import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InviteCodes, signRouterAuthAccountBinding, UserRole } from '@argonprotocol/apps-core';
import { Keyring, type KeyringPair } from '@argonprotocol/mainchain';
import { Db } from '../src/Db.ts';
import { UserInviteService } from '../src/UserInviteService.ts';
import type { Role } from '../src/db/UsersTable.ts';

describe('UserInviteService operational invite behavior', () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
  });

  it('does not leave an orphan user when invite codes collide', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'operational-invite-service-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db);
    const { inviteCode } = InviteCodes.create();
    service.createInvite(UserRole.OperationalPartner, {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode,
    });

    expect(() =>
      service.createInvite(UserRole.OperationalPartner, {
        name: 'Jordan',
        fromName: 'Operator One',
        inviteCode,
      }),
    ).toThrowError('This invite code is already in use.');

    expect(db.usersTable.fetchByRole(UserRole.OperationalPartner)).toHaveLength(1);
    expect(db.userInvitesTable.fetchByRole(UserRole.OperationalPartner)).toHaveLength(1);
  });

  it('regenerates an unclicked invite code without creating another user', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'operational-invite-regenerate-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db);
    const original = InviteCodes.create();
    const replacement = InviteCodes.create();
    const invite = service.createInvite(UserRole.OperationalPartner, {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode: original.inviteCode,
    });

    const regenerated = service.regenerateInvite(UserRole.OperationalPartner, {
      inviteCode: original.inviteCode,
      newInviteCode: replacement.inviteCode,
    });

    expect(regenerated.id).toBe(invite.id);
    expect(regenerated.inviteCode).toBe(replacement.inviteCode);
    expect(db.userInvitesTable.fetchByCode(original.inviteCode)).toBeNull();
    expect(db.usersTable.fetchByRole(UserRole.OperationalPartner)).toHaveLength(1);
  });

  it('does not regenerate an invite after it has been opened', () => {
    db = new Db(
      Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'operational-invite-regenerate-opened-')), 'router.sqlite'),
    );
    db.migrate();

    const service = new UserInviteService(db);
    const { inviteSecret, inviteCode } = InviteCodes.create();
    const replacement = InviteCodes.create();
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//InviteUser');
    service.createInvite(UserRole.OperationalPartner, {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode,
    });
    service.claimInvite(
      createClaimInviteArgs(
        UserRole.OperationalPartner,
        inviteCode,
        inviteSecret,
        account,
        account.derive('//upstream-operator-auth'),
      ),
    );

    expect(() =>
      service.regenerateInvite(UserRole.OperationalPartner, {
        inviteCode,
        newInviteCode: replacement.inviteCode,
      }),
    ).toThrowError('This invite link has already been opened.');
  });

  it('binds an invite to the claiming account, allows auth rebinding, and rejects a different account', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'operational-invite-open-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db);
    const { inviteSecret, inviteCode } = InviteCodes.create();
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//InviteUser');
    const authAccount = account.derive('//upstream-operator-auth');
    service.createInvite(UserRole.OperationalPartner, {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode,
    });

    const claimed = service.claimInvite(
      createClaimInviteArgs(UserRole.OperationalPartner, inviteCode, inviteSecret, account, authAccount),
    );
    expect(claimed?.accountId).toBe(account.address);
    expect(claimed?.authAccountId).toBe(authAccount.address);
    expect(claimed?.lastClickedAt).toBeTruthy();

    const replacementAuthAccount = account.derive('//replacement-upstream-auth');
    const rebound = service.claimInvite(
      createClaimInviteArgs(UserRole.OperationalPartner, inviteCode, inviteSecret, account, replacementAuthAccount),
    );
    expect(rebound?.accountId).toBe(account.address);
    expect(rebound?.authAccountId).toBe(replacementAuthAccount.address);

    const otherAccount = new Keyring({ type: 'sr25519' }).addFromUri('//OtherInviteUser');
    expect(() =>
      service.claimInvite(
        createClaimInviteArgs(
          UserRole.OperationalPartner,
          inviteCode,
          inviteSecret,
          otherAccount,
          otherAccount.derive('//upstream-operator-auth'),
        ),
      ),
    ).toThrowError('This invite is already claimed by a different account.');
  });

  it('requires a valid invite signature to claim an invite', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'operational-invite-proof-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db);
    const { inviteCode } = InviteCodes.create();
    const { inviteSecret: wrongInviteSecret } = InviteCodes.create();
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//InviteUser');

    service.createInvite(UserRole.OperationalPartner, {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode,
    });

    expect(() =>
      service.claimInvite(
        createClaimInviteArgs(
          UserRole.OperationalPartner,
          inviteCode,
          wrongInviteSecret,
          account,
          account.derive('//upstream-operator-auth'),
        ),
      ),
    ).toThrowError('The invite signature is invalid.');
  });

  it('requires a wallet signature binding the auth account', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'operational-auth-binding-proof-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db);
    const { inviteSecret, inviteCode } = InviteCodes.create();
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//InviteUser');
    const authAccount = account.derive('//upstream-operator-auth');

    service.createInvite(UserRole.OperationalPartner, {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode,
    });

    const claimArgs = createClaimInviteArgs(
      UserRole.OperationalPartner,
      inviteCode,
      inviteSecret,
      account,
      authAccount,
    );
    claimArgs.authBindingSignature = signRouterAuthAccountBinding(authAccount, claimArgs.authBinding);

    expect(() => service.claimInvite(claimArgs)).toThrowError('The auth binding signature is invalid.');
  });
});

function createClaimInviteArgs(
  role: Role,
  inviteCode: string,
  inviteSecret: string,
  account: KeyringPair,
  authAccount: KeyringPair,
) {
  const authBinding = {
    role,
    inviteCode,
    accountId: account.address,
    authAccountId: authAccount.address,
    expiresAt: Date.now() + 60_000,
  };

  return {
    role,
    inviteCode,
    accountId: account.address,
    inviteSignature: InviteCodes.signOpen(inviteSecret, role, account.address),
    authBinding,
    authBindingSignature: signRouterAuthAccountBinding(account, authBinding),
  };
}
