import * as Fs from 'node:fs';
import * as Http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InviteCodes,
  JsonExt,
  type RouterAuthRole,
  signRouterAuthAccountBinding,
  signRouterAuthChallenge,
  UserRole,
} from '@argonprotocol/apps-core';
import { Keyring, type KeyringPair } from '@argonprotocol/mainchain';
import { Db as RouterDb } from '../src/Db.ts';
import { RouterServer } from '../src/RouterServer.ts';
import type { IRouterAuthSessionResponse } from '../src/interfaces/index.ts';
import type { IRouterAuthServiceOptions } from '../src/RouterAuthService.ts';

type IRouterAddress = {
  host: string;
  port: number;
};

describe('RouterServer', () => {
  let routerServer: RouterServer | undefined;
  let routerDb: RouterDb | undefined;
  let botServer: Http.Server | undefined;

  afterEach(async () => {
    await routerServer?.close().catch(() => undefined);
    routerDb?.close();
    await new Promise<void>(resolve => botServer?.close(() => resolve()) ?? resolve());
  });

  it('rolls back invite rows when coupon creation fails', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-server-test-'));
    routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();

    const started = await startRouterServer(routerDb, {
      status: 500,
      body: { error: 'Bot coupon creation failed.' },
    });
    routerServer = started.routerServer;
    botServer = started.botServer;
    const { routerAddress } = started;
    const { inviteCode } = InviteCodes.create();
    const response = await requestJson(routerAddress, '/treasury-users/create', {
      name: 'Casey',
      fromName: 'OperatorOne',
      inviteCode,
      vaultId: 12,
      maxSatoshis: 25_000n,
      expiresAfterTicks: 60,
    });

    expect(response.status).toBe(500);
    expect(routerDb.userInvitesTable.fetchByCode(inviteCode)).toBeNull();
    expect(routerDb.usersTable.fetchByRole(UserRole.TreasuryUser)).toEqual([]);
  });

  it('validates treasury invite payload before creating an invite', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-server-treasury-validation-test-'));
    routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();

    const started = await startRouterServer(routerDb, {
      status: 200,
      body: { status: 'ok' },
    });
    routerServer = started.routerServer;
    botServer = started.botServer;
    const { routerAddress } = started;
    const { inviteCode } = InviteCodes.create();

    const invalidVaultResponse = await requestJson(routerAddress, '/treasury-users/create', {
      name: 'Casey',
      fromName: 'OperatorOne',
      inviteCode,
      vaultId: 0,
      maxSatoshis: 25_000n,
      expiresAfterTicks: 60,
    });
    expect(invalidVaultResponse.status).toBe(400);
    expect(await invalidVaultResponse.text()).toContain('A vault is required to create an invite.');

    const invalidExpiryResponse = await requestJson(routerAddress, '/treasury-users/create', {
      name: 'Casey',
      fromName: 'OperatorOne',
      inviteCode,
      vaultId: 12,
      maxSatoshis: 25_000n,
      expiresAfterTicks: 0,
    });
    expect(invalidExpiryResponse.status).toBe(400);
    expect(await invalidExpiryResponse.text()).toContain('Invite expiry must be greater than zero.');
    expect(routerDb.usersTable.fetchByRole(UserRole.TreasuryUser)).toEqual([]);
  });

  it('tracks operational invite open state', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-server-operational-test-'));
    routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();

    const started = await startRouterServer(routerDb, {
      status: 200,
      body: { status: 'ok' },
    });
    routerServer = started.routerServer;
    botServer = started.botServer;
    const { routerAddress } = started;
    const { inviteSecret, inviteCode } = InviteCodes.create();
    const operationalUser = new Keyring({ type: 'sr25519' }).addFromUri('//OperationalUser');
    const authAccount = operationalUser.derive('//upstream-operator-auth');

    const createResponse = await requestJson(routerAddress, '/operational-users/create', {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode,
    });

    expect(createResponse.status).toBe(200);

    const openResponse = await requestJson(routerAddress, `/operational-users/${encodeURIComponent(inviteCode)}/open`, {
      ...createOpenInviteBody(UserRole.OperationalPartner, inviteCode, inviteSecret, operationalUser, authAccount),
    });
    expect(openResponse.status).toBe(200);

    const invite = routerDb.userInvitesTable.fetchByCode(inviteCode, UserRole.OperationalPartner);
    expect(invite?.lastClickedAt).toBeTruthy();
    expect(invite?.accountId).toBe(operationalUser.address);
    expect(invite?.authAccountId).toBe(authAccount.address);
  });

  it('requires admin operator auth for management routes when auth is configured', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-server-auth-test-'));
    routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const started = await startRouterServer(
      routerDb,
      {
        status: 200,
        body: { status: 'ok' },
      },
      {
        adminOperatorAccountId: operator.address,
        sessionTtlSeconds: 60,
      },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;
    const { routerAddress } = started;

    const { inviteCode } = InviteCodes.create();
    const unauthenticatedResponse = await requestJson(routerAddress, '/operational-users/create', {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode,
    });
    expect(unauthenticatedResponse.status).toBe(401);

    const { cookie, session, setCookie } = await login(routerAddress, operator);
    expect(session).not.toHaveProperty('sessionId');
    expect(setCookie).toContain('HttpOnly');

    const authenticatedResponse = await requestJson(
      routerAddress,
      '/operational-users/create',
      {
        name: 'Casey',
        fromName: 'Operator One',
        inviteCode,
      },
      {
        Cookie: cookie,
      },
    );
    expect(authenticatedResponse.status).toBe(200);

    const verifyResponse = await fetch(`http://${routerAddress.host}:${routerAddress.port}/auth/verify/admin`, {
      headers: { Cookie: cookie },
    });
    expect(verifyResponse.status).toBe(204);
    expect(verifyResponse.headers.get('x-user-id')).toBe(operator.address);
    expect(verifyResponse.headers.get('x-user-role')).toBe(UserRole.AdminOperator);
  });

  it('keeps router sessions valid across router restarts', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-server-session-restart-test-'));
    routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const auth = {
      adminOperatorAccountId: operator.address,
      sessionTtlSeconds: 60,
    };
    const started = await startRouterServer(
      routerDb,
      {
        status: 200,
        body: { status: 'ok' },
      },
      auth,
    );
    routerServer = started.routerServer;
    botServer = started.botServer;

    const { cookie } = await login(started.routerAddress, operator);
    await routerServer.close();
    routerServer = undefined;
    await new Promise<void>(resolve => botServer?.close(() => resolve()) ?? resolve());
    botServer = undefined;

    const restarted = await startRouterServer(
      routerDb,
      {
        status: 200,
        body: { status: 'ok' },
      },
      auth,
    );
    routerServer = restarted.routerServer;
    botServer = restarted.botServer;

    const verifyResponse = await fetch(
      `http://${restarted.routerAddress.host}:${restarted.routerAddress.port}/auth/verify/admin`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(verifyResponse.status).toBe(204);
    expect(verifyResponse.headers.get('x-user-id')).toBe(operator.address);
    expect(verifyResponse.headers.get('x-user-role')).toBe(UserRole.AdminOperator);
  });

  it('prunes inactive router sessions on startup', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-server-session-startup-prune-test-'));
    routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const now = Date.now();
    const adminUser = routerDb.usersTable.insertUser({
      role: UserRole.AdminOperator,
      name: 'Admin Operator',
    });
    routerDb.usersTable.claimAccount(adminUser.id, operator.address, operator.address);

    routerDb.sessionsTable.insertSession({
      sessionId: 'expired-session-id',
      userId: adminUser.id,
      expiresAt: new Date(now - 1_000),
    });
    const revokedSession = routerDb.sessionsTable.insertSession({
      sessionId: 'revoked-session-id',
      userId: adminUser.id,
      expiresAt: new Date(now + 60_000),
    });
    routerDb.sessionsTable.revoke(revokedSession.id, new Date(now - 1_000));
    routerDb.sessionsTable.insertSession({
      sessionId: 'active-session-id',
      userId: adminUser.id,
      expiresAt: new Date(now + 60_000),
    });

    const started = await startRouterServer(
      routerDb,
      {
        status: 200,
        body: { status: 'ok' },
      },
      {
        adminOperatorAccountId: operator.address,
        sessionTtlSeconds: 60,
      },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;

    expect(routerDb.sessionsTable.fetchBySessionId('expired-session-id')).toBeNull();
    expect(routerDb.sessionsTable.fetchBySessionId('revoked-session-id')).toBeNull();
    expect(routerDb.sessionsTable.fetchBySessionId('active-session-id')?.userId).toBe(adminUser.id);
  });

  it('accepts claimed treasury users at the router verifier without granting management access', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-server-treasury-auth-test-'));
    routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const treasuryUser = new Keyring({ type: 'sr25519' }).addFromUri('//TreasuryUser');
    const treasuryAuth = treasuryUser.derive('//upstream-operator-auth');
    const started = await startRouterServer(
      routerDb,
      {
        status: 200,
        body: { status: 'ok' },
      },
      {
        adminOperatorAccountId: operator.address,
        sessionTtlSeconds: 60,
      },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;
    const { routerAddress } = started;
    const { inviteCode } = InviteCodes.create();
    const user = routerDb.usersTable.insertUser({
      role: UserRole.TreasuryUser,
      name: 'Casey',
    });
    routerDb.userInvitesTable.insertInvite(user.id, inviteCode, 'Operator One');
    routerDb.userInvitesTable.claimInvite(user.id, treasuryUser.address, treasuryAuth.address);

    const { cookie } = await login(routerAddress, treasuryUser, UserRole.TreasuryUser, treasuryAuth);
    const verifyResponse = await fetch(`http://${routerAddress.host}:${routerAddress.port}/auth/verify/substrate`, {
      headers: { Cookie: cookie },
    });
    expect(verifyResponse.status).toBe(204);
    expect(verifyResponse.headers.get('x-user-id')).toBe(treasuryUser.address);
    expect(verifyResponse.headers.get('x-user-role')).toBe(UserRole.TreasuryUser);

    const treasuryCouponVerifyResponse = await fetch(
      `http://${routerAddress.host}:${routerAddress.port}/auth/verify/treasury-coupon`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(treasuryCouponVerifyResponse.status).toBe(204);

    const botVerifyResponse = await fetch(`http://${routerAddress.host}:${routerAddress.port}/auth/verify/bot`, {
      headers: { Cookie: cookie },
    });
    expect(botVerifyResponse.status).toBe(403);

    const operationalVerifyResponse = await fetch(
      `http://${routerAddress.host}:${routerAddress.port}/auth/verify/operational`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(operationalVerifyResponse.status).toBe(403);

    const managementResponse = await requestJson(
      routerAddress,
      '/operational-users/create',
      {
        name: 'Riley',
        fromName: 'Operator One',
        inviteCode: InviteCodes.create().inviteCode,
      },
      {
        Cookie: cookie,
      },
    );
    expect(managementResponse.status).toBe(403);
  });

  it('requires matching treasury sessions for treasury coupon routes', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-server-treasury-coupon-auth-test-'));
    routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const treasuryUser = new Keyring({ type: 'sr25519' }).addFromUri('//TreasuryUser');
    const otherTreasuryUser = new Keyring({ type: 'sr25519' }).addFromUri('//OtherTreasuryUser');
    const treasuryAuth = treasuryUser.derive('//upstream-operator-auth');
    const otherTreasuryAuth = otherTreasuryUser.derive('//upstream-operator-auth');
    const started = await startRouterServer(
      routerDb,
      {
        status: 200,
        body: [],
      },
      {
        adminOperatorAccountId: operator.address,
        sessionTtlSeconds: 60,
      },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;
    const { routerAddress } = started;

    const user = routerDb.usersTable.insertUser({
      role: UserRole.TreasuryUser,
      name: 'Casey',
    });
    routerDb.userInvitesTable.insertInvite(user.id, InviteCodes.create().inviteCode, 'Operator One');
    routerDb.userInvitesTable.claimInvite(user.id, treasuryUser.address, treasuryAuth.address);

    const otherUser = routerDb.usersTable.insertUser({
      role: UserRole.TreasuryUser,
      name: 'Riley',
    });
    routerDb.userInvitesTable.insertInvite(otherUser.id, InviteCodes.create().inviteCode, 'Operator One');
    routerDb.userInvitesTable.claimInvite(otherUser.id, otherTreasuryUser.address, otherTreasuryAuth.address);

    const { cookie } = await login(routerAddress, treasuryUser, UserRole.TreasuryUser, treasuryAuth);
    const { cookie: otherCookie } = await login(
      routerAddress,
      otherTreasuryUser,
      UserRole.TreasuryUser,
      otherTreasuryAuth,
    );

    const listUrl = `http://${routerAddress.host}:${routerAddress.port}/treasury-users/${encodeURIComponent(treasuryUser.address)}/bitcoin-lock-coupons`;
    const unauthenticatedListResponse = await fetch(listUrl);
    expect(unauthenticatedListResponse.status).toBe(401);

    const mismatchedListResponse = await fetch(listUrl, {
      headers: { Cookie: otherCookie },
    });
    expect(mismatchedListResponse.status).toBe(403);

    const authenticatedListResponse = await fetch(listUrl, {
      headers: { Cookie: cookie },
    });
    expect(authenticatedListResponse.status).toBe(200);

    const initializePath = '/bitcoin-lock-coupons/offer-code/initialize';
    const initializeBody = {
      requestedSatoshis: 10_000n,
      ownerAccountId: treasuryUser.address,
      ownerBitcoinPubkey: '03b28f34af9b5e623aa640f82bf9f09ffcc287d5826ac7ef84b96eddb71543fdae',
      microgonsPerBtc: 125_000_000n,
    };

    const unauthenticatedInitializeResponse = await requestJson(routerAddress, initializePath, initializeBody);
    expect(unauthenticatedInitializeResponse.status).toBe(401);

    const mismatchedInitializeResponse = await requestJson(routerAddress, initializePath, initializeBody, {
      Cookie: otherCookie,
    });
    expect(mismatchedInitializeResponse.status).toBe(403);

    const authenticatedInitializeResponse = await requestJson(routerAddress, initializePath, initializeBody, {
      Cookie: cookie,
    });
    expect(authenticatedInitializeResponse.status).toBe(200);
  });

  it('accepts claimed operational users without granting treasury or bot access', async () => {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'router-server-operational-auth-test-'));
    routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const operationalUser = new Keyring({ type: 'sr25519' }).addFromUri('//OperationalUser');
    const operationalAuth = operationalUser.derive('//upstream-operator-auth');
    const started = await startRouterServer(
      routerDb,
      {
        status: 200,
        body: { status: 'ok' },
      },
      {
        adminOperatorAccountId: operator.address,
        sessionTtlSeconds: 60,
      },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;
    const { routerAddress } = started;
    const { inviteCode } = InviteCodes.create();
    const user = routerDb.usersTable.insertUser({
      role: UserRole.OperationalPartner,
      name: 'Riley',
    });
    routerDb.userInvitesTable.insertInvite(user.id, inviteCode, 'Operator One');
    routerDb.userInvitesTable.claimInvite(user.id, operationalUser.address, operationalAuth.address);

    const { cookie } = await login(routerAddress, operationalUser, UserRole.OperationalPartner, operationalAuth);
    const substrateVerifyResponse = await fetch(
      `http://${routerAddress.host}:${routerAddress.port}/auth/verify/substrate`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(substrateVerifyResponse.status).toBe(204);

    const operationalVerifyResponse = await fetch(
      `http://${routerAddress.host}:${routerAddress.port}/auth/verify/operational`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(operationalVerifyResponse.status).toBe(204);

    const treasuryCouponVerifyResponse = await fetch(
      `http://${routerAddress.host}:${routerAddress.port}/auth/verify/treasury-coupon`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(treasuryCouponVerifyResponse.status).toBe(403);

    const botVerifyResponse = await fetch(`http://${routerAddress.host}:${routerAddress.port}/auth/verify/bot`, {
      headers: { Cookie: cookie },
    });
    expect(botVerifyResponse.status).toBe(403);
  });
});

async function startRouterServer(
  db: RouterDb,
  botResponse: { status: number; body: unknown },
  auth?: IRouterAuthServiceOptions,
): Promise<{ routerAddress: IRouterAddress; routerServer: RouterServer; botServer: Http.Server }> {
  const botServer = Http.createServer((_, res) => {
    res.statusCode = botResponse.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JsonExt.stringify(botResponse.body));
  });
  await new Promise<void>(resolve => botServer.listen(0, resolve));
  const botAddress = botServer.address() as AddressInfo;

  const routerServer = new RouterServer({
    db,
    botInternalUrl: `http://127.0.0.1:${botAddress.port}`,
    port: 0,
    auth,
  });
  routerServer.start();
  await routerServer.waitForListening();

  return {
    routerAddress: routerServer.getAddress(),
    routerServer,
    botServer,
  };
}

async function login(
  routerAddress: IRouterAddress,
  account: KeyringPair,
  role: RouterAuthRole = UserRole.AdminOperator,
  authAccount?: KeyringPair,
): Promise<{ session: IRouterAuthSessionResponse; cookie: string; setCookie: string }> {
  const baseUrl = `http://${routerAddress.host}:${routerAddress.port}`;
  const challengeResponse = await fetch(`${baseUrl}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JsonExt.stringify({
      role,
      authAccountId: (authAccount ?? account).address,
    }),
  });
  const challenge = JsonExt.parse<{
    role: RouterAuthRole;
    authAccountId: string;
    nonce: string;
    expiresAt: number;
  }>(await challengeResponse.text());
  const signature = signRouterAuthChallenge(authAccount ?? account, challenge);
  const sessionResponse = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JsonExt.stringify({ ...challenge, signature }),
  });
  const session = JsonExt.parse<IRouterAuthSessionResponse>(await sessionResponse.text());
  const setCookie = sessionResponse.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('Router auth session did not set a cookie.');
  }

  return { session, cookie: setCookie.split(';')[0], setCookie };
}

function createOpenInviteBody(
  role: RouterAuthRole,
  inviteCode: string,
  inviteSecret: string,
  account: KeyringPair,
  authAccount: KeyringPair,
) {
  const authBindingExpiresAt = Date.now() + 60_000;
  const binding = {
    role,
    accountId: account.address,
    authAccountId: authAccount.address,
    inviteCode,
    expiresAt: authBindingExpiresAt,
  };

  return {
    accountId: account.address,
    authAccountId: authAccount.address,
    authBindingExpiresAt,
    authBindingSignature: signRouterAuthAccountBinding(account, binding),
    inviteSignature: InviteCodes.signOpen(inviteSecret, role, account.address),
  };
}

function requestJson(
  routerAddress: IRouterAddress,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://${routerAddress.host}:${routerAddress.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JsonExt.stringify(body),
  });
}
