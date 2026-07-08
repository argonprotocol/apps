import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signRouterAuthChallenge, UserRole } from '@argonprotocol/apps-core';
import { Keyring } from '@argonprotocol/mainchain';
import { Db } from '../src/Db.ts';
import { RouterAuthService } from '../src/RouterAuthService.ts';

describe('RouterAuthService', () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
  });

  it('creates admin sessions from valid challenge signatures', () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const service = createAuthService(operator.address);
    const challenge = service.createChallenge(operator.address, UserRole.AdminOperator);
    const signature = signRouterAuthChallenge(operator, challenge);

    const session = service.createSession({ ...challenge, signature });

    expect(session.sessionId).toBeTruthy();
    expect(session.accountId).toBe(operator.address);
    expect(session.role).toBe(UserRole.AdminOperator);
  });

  it('creates member sessions from claimed invite auth accounts', () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');
    const service = createAuthService(operator.address);

    const user = db!.usersTable.insertUser({
      role: UserRole.Member,
      name: 'Casey',
    });
    const invite = db!.userInvitesTable.insertInvite(user.id, 'member-invite-1', 'Operator One');
    db!.userInvitesTable.claimInvite(invite.id, member.address, memberAuth.address);

    const challenge = service.createChallenge(memberAuth.address, UserRole.Member);
    const signature = signRouterAuthChallenge(memberAuth, challenge);
    const session = service.createSession({ ...challenge, signature });

    expect(session.accountId).toBe(member.address);
    expect(session.role).toBe(UserRole.Member);
  });

  it('rejects challenge signatures from the wrong key', () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const wrongOperator = new Keyring({ type: 'sr25519' }).addFromUri('//WrongRouterOperator');
    const service = createAuthService(operator.address);
    const challenge = service.createChallenge(operator.address, UserRole.AdminOperator);
    const signature = signRouterAuthChallenge(wrongOperator, challenge);

    expect(() => service.createSession({ ...challenge, signature })).toThrowError('Login signature is invalid.');
  });

  it('rejects member challenges for unclaimed auth accounts', () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const service = createAuthService(operator.address);

    expect(() => service.createChallenge(member.address, UserRole.Member)).toThrowError(
      'This auth account is not allowed to access the router.',
    );
  });

  function createAuthService(adminOperatorAccountId: string): RouterAuthService {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-auth-service-test-'));
    db = new Db(Path.join(tempDir, 'router.sqlite'));
    db.migrate();

    return new RouterAuthService({
      db,
      adminOperatorAccountId,
      sessionTtlSeconds: 60,
    });
  }
});
