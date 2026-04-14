import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InviteCodes, UserRole } from '@argonprotocol/apps-core';
import { Db } from '../src/Db.ts';
import { UserInviteService } from '../src/UserInviteService.ts';

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

  it('binds an invite to the opened account and rejects a different account', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'operational-invite-open-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db);
    const { inviteSecret, inviteCode } = InviteCodes.create();
    const accountId = '5F3sa2TJAWMqDhXG6jhV4N8ko9G4vYQ1N1gH1mLNz5nKfY7Y';
    service.createInvite(UserRole.OperationalPartner, {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode,
    });

    const opened = service.openInvite(
      UserRole.OperationalPartner,
      inviteCode,
      accountId,
      InviteCodes.signOpen(inviteSecret, UserRole.OperationalPartner, accountId),
    );
    expect(opened?.accountId).toBe(accountId);
    expect(opened?.lastClickedAt).toBeTruthy();

    expect(() =>
      service.openInvite(
        UserRole.OperationalPartner,
        inviteCode,
        '5DAAnrj7VHTz5b2f4m65tQ6X3YfK6Y8sQw1bS8vW6oQ6mG7R',
        InviteCodes.signOpen(
          inviteSecret,
          UserRole.OperationalPartner,
          '5DAAnrj7VHTz5b2f4m65tQ6X3YfK6Y8sQw1bS8vW6oQ6mG7R',
        ),
      ),
    ).toThrowError('This invite is already claimed by a different account.');
  });

  it('requires a valid invite signature to open an invite', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'operational-invite-proof-')), 'router.sqlite'));
    db.migrate();

    const service = new UserInviteService(db);
    const { inviteCode } = InviteCodes.create();
    const { inviteSecret: wrongInviteSecret } = InviteCodes.create();
    const accountId = '5F3sa2TJAWMqDhXG6jhV4N8ko9G4vYQ1N1gH1mLNz5nKfY7Y';

    service.createInvite(UserRole.OperationalPartner, {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode,
    });

    expect(() =>
      service.openInvite(
        UserRole.OperationalPartner,
        inviteCode,
        accountId,
        InviteCodes.signOpen(wrongInviteSecret, UserRole.OperationalPartner, accountId),
      ),
    ).toThrowError('The invite signature is invalid.');
  });
});
