import * as Fs from 'node:fs';
import * as Http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonExt } from '@argonprotocol/apps-core';
import { Db as RouterDb } from '../src/Db.ts';
import { RouterServer } from '../src/RouterServer.ts';
import { TreasuryInviteService } from '../src/TreasuryInviteService.ts';

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

    botServer = Http.createServer((_, res) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JsonExt.stringify({ error: 'Bot coupon creation failed.' }));
    });
    await new Promise<void>(resolve => botServer!.listen(0, resolve));
    const botAddress = botServer.address() as AddressInfo;

    routerServer = new RouterServer({
      db: routerDb,
      inviteService: new TreasuryInviteService(routerDb),
      botInternalUrl: `http://127.0.0.1:${botAddress.port}`,
      port: 0,
    });
    routerServer.start();
    await routerServer.waitForListening();

    const routerAddress = routerServer.getAddress();
    const response = await fetch(`http://${routerAddress.host}:${routerAddress.port}/treasury-users/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JsonExt.stringify({
        name: 'Casey',
        fromName: 'OperatorOne',
        inviteCode: 'duplicate-safe-code',
        vaultId: 12,
        maxSatoshis: 25_000n,
        expiresAfterTicks: 60,
      }),
    });

    expect(response.status).toBe(500);
    expect(routerDb.userInvitesTable.fetchByCode('duplicate-safe-code')).toBeNull();
    expect(routerDb.usersTable.fetchByRole('treasury_user')).toEqual([]);
  });
});
