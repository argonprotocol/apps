import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/Db.ts';
import { TreasuryInviteService } from '../src/TreasuryInviteService.ts';

describe('TreasuryInviteService', () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
  });

  it('does not leave an orphan user when invite codes collide', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'treasury-invite-service-')), 'router.sqlite'));
    db.migrate();

    const service = new TreasuryInviteService(db);
    service.createInvite({
      name: 'Casey',
      fromName: 'OperatorOne',
      inviteCode: 'shared-code',
      vaultId: 12,
      maxSatoshis: 25_000n,
      expiresAfterTicks: 60,
    });

    expect(() =>
      service.createInvite({
        name: 'Jordan',
        fromName: 'OperatorOne',
        inviteCode: 'shared-code',
        vaultId: 12,
        maxSatoshis: 30_000n,
        expiresAfterTicks: 60,
      }),
    ).toThrowError('This invite code is already in use.');

    expect(db.usersTable.fetchByRole('treasury_user')).toHaveLength(1);
    expect(db.userInvitesTable.fetchByRole('treasury_user')).toHaveLength(1);
  });

  it('requires a vault name when creating an invite', () => {
    db = new Db(Path.join(Fs.mkdtempSync(Path.join(os.tmpdir(), 'treasury-invite-service-')), 'router.sqlite'));
    db.migrate();

    const service = new TreasuryInviteService(db);

    expect(() =>
      service.createInvite({
        name: 'Casey',
        fromName: undefined as any,
        inviteCode: 'shared-code',
        vaultId: 12,
        maxSatoshis: 25_000n,
        expiresAfterTicks: 60,
      }),
    ).toThrowError('A vault name is required to create an invite.');

    expect(db.usersTable.fetchByRole('treasury_user')).toHaveLength(0);
    expect(db.userInvitesTable.fetchByRole('treasury_user')).toHaveLength(0);
  });
});
