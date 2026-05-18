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

  it('creates sessions from valid challenge signatures', () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const service = createAuthService(operator.address);
    const challenge = service.createChallenge(operator.address, UserRole.AdminOperator);
    const signature = signRouterAuthChallenge(operator, challenge);

    const session = service.createSession({ ...challenge, signature });

    expect(session.sessionId).toBeTruthy();
    expect(session.accountId).toBe(operator.address);
    expect(session.role).toBe(UserRole.AdminOperator);
  });

  it('rejects challenge signatures from the wrong key', () => {
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const wrongOperator = new Keyring({ type: 'sr25519' }).addFromUri('//WrongRouterOperator');
    const service = createAuthService(operator.address);
    const challenge = service.createChallenge(operator.address, UserRole.AdminOperator);
    const signature = signRouterAuthChallenge(wrongOperator, challenge);

    expect(() => service.createSession({ ...challenge, signature })).toThrowError('Login signature is invalid.');
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
