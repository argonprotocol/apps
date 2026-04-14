import * as Fs from 'node:fs';
import * as Http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InviteCodes, JsonExt, UserRole } from '@argonprotocol/apps-core';
import { Db as RouterDb } from '../src/Db.ts';
import { RouterServer } from '../src/RouterServer.ts';

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

    const createResponse = await requestJson(routerAddress, '/operational-users/create', {
      name: 'Casey',
      fromName: 'Operator One',
      inviteCode,
    });

    expect(createResponse.status).toBe(200);

    const openResponse = await requestJson(
      routerAddress,
      `/operational-users/${encodeURIComponent(inviteCode)}/open`,
      {
        accountId: '5F3sa2TJAWMqDhXG6jhV4N8ko9G4vYQ1N1gH1mLNz5nKfY7Y',
        inviteSignature: InviteCodes.signOpen(
          inviteSecret,
          UserRole.OperationalPartner,
          '5F3sa2TJAWMqDhXG6jhV4N8ko9G4vYQ1N1gH1mLNz5nKfY7Y',
        ),
      },
    );
    expect(openResponse.status).toBe(200);

    const invite = routerDb.userInvitesTable.fetchByCode(inviteCode, UserRole.OperationalPartner);
    expect(invite?.lastClickedAt).toBeTruthy();
    expect(invite?.accountId).toBe('5F3sa2TJAWMqDhXG6jhV4N8ko9G4vYQ1N1gH1mLNz5nKfY7Y');
  });
});

async function startRouterServer(
  db: RouterDb,
  botResponse: { status: number; body: unknown },
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
  });
  routerServer.start();
  await routerServer.waitForListening();

  return {
    routerAddress: routerServer.getAddress(),
    routerServer,
    botServer,
  };
}

function requestJson(routerAddress: IRouterAddress, path: string, body: unknown): Promise<Response> {
  return fetch(`http://${routerAddress.host}:${routerAddress.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JsonExt.stringify(body),
  });
}
