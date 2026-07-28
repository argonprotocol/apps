import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type IActivateBitcoinLockCouponRequest,
  type IBitcoinLockCouponRecord,
  type IBitcoinLockCouponStatus,
  UserRole,
} from '@argonprotocol/apps-core';
import { type BotServer, Db as BotDb, startServer as startBotServer, type Bot } from '@argonprotocol/apps-bot';
import type { IRouterAuthSessionResponse } from '@argonprotocol/apps-router';
import { Db as RouterDb } from '../../router/src/Db.ts';
import { RouterServer } from '../../router/src/RouterServer.ts';
import { ServerAuthClient } from '../lib/ServerAuthClient.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

describe('member restore handshake integration', () => {
  const tempDirs: string[] = [];
  const botServers: BotServer[] = [];
  const botDbs: BotDb[] = [];
  const routerServers: RouterServer[] = [];
  const routerDbs: RouterDb[] = [];

  afterEach(async () => {
    await Promise.all(routerServers.splice(0).map(server => server.close().catch(() => undefined)));
    await Promise.all(botServers.splice(0).map(server => server.close().catch(() => undefined)));
    routerDbs.splice(0).forEach(db => db.close());
    botDbs.splice(0).forEach(db => db.close());
    await Promise.all(tempDirs.splice(0).map(dir => Fs.promises.rm(dir, { recursive: true, force: true })));
  });

  it('negotiates upstream and downstream restoration through the signed member login', async () => {
    const operatorWalletKeys = createMockWalletKeys('//RestoreOperator');
    const memberWalletKeys = createMockWalletKeys('//RestoreMember');
    const restoreKey = `0x${'42'.repeat(32)}`;
    const source = await startUpstream('source', operatorWalletKeys.operationalAddress, restoreKey);
    let operatorHost = source.operatorHost;

    const member = source.routerDb.usersTable.insertUser({
      role: UserRole.Member,
      name: 'Casey',
    });
    const invite = source.routerDb.userInvitesTable.insertInvite(member.id, 'member-invite-1', 'Operator One');
    source.botDb.bitcoinLockCouponsTable.insertCoupon({
      userId: invite.id,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 60,
    });

    const claimed = await UpstreamOperatorClient.claimInvite({
      operatorHost,
      inviteCode: invite.inviteCode,
      defaultAccountKeypair: await memberWalletKeys.getLiquidLockingKeypair(),
      authKeypair: await memberWalletKeys.getUpstreamOperatorAuthKeypair(),
    });
    let restorePackage: string | undefined = claimed.restorePackage;
    let downstreamCoupons: IBitcoinLockCouponStatus[] = [];
    let downstreamRestore: IRouterAuthSessionResponse['restore'];
    const applyRestoreResult = (restore: NonNullable<IRouterAuthSessionResponse['restore']>) => {
      downstreamRestore = restore;
      restorePackage = restore.restorePackage;
      downstreamCoupons = restore.bitcoinLockCoupons;
    };
    let serverAuthClient = new ServerAuthClient(() => memberWalletKeys, {
      getRestorePackage: () => restorePackage,
      applyRestoreResult,
    });
    let upstreamOperatorClient = new UpstreamOperatorClient(serverAuthClient, () => operatorHost);

    await source.routerServer.close();
    routerServers.splice(routerServers.indexOf(source.routerServer), 1);
    source.routerDb.close();
    routerDbs.splice(routerDbs.indexOf(source.routerDb), 1);
    await source.botServer.close();
    botServers.splice(botServers.indexOf(source.botServer), 1);
    source.botDb.close();
    botDbs.splice(botDbs.indexOf(source.botDb), 1);

    const recovered = await startUpstream('recovered', operatorWalletKeys.operationalAddress, restoreKey);
    operatorHost = recovered.operatorHost;

    await expect(upstreamOperatorClient.getMemberInvite()).resolves.toMatchObject({
      name: 'Casey',
      fromName: 'Operator One',
    });
    expect(downstreamCoupons).toHaveLength(1);
    expect(downstreamRestore).toMatchObject({
      fromName: 'Operator One',
      operatorAccountId: operatorWalletKeys.operationalAddress,
    });
    expect(recovered.routerDb.userInvitesTable.fetchByDefaultAccountId(claimed.invite.defaultAccountId!)).toMatchObject(
      {
        name: 'Casey',
        fromName: 'Operator One',
      },
    );
    expect(recovered.botDb.bitcoinLockCouponsTable.fetchAll()).toHaveLength(1);

    restorePackage = undefined;
    downstreamCoupons = [];
    downstreamRestore = undefined;
    serverAuthClient = new ServerAuthClient(() => memberWalletKeys, {
      getRestorePackage: () => restorePackage,
      applyRestoreResult,
    });
    upstreamOperatorClient = new UpstreamOperatorClient(serverAuthClient, () => operatorHost);

    await expect(upstreamOperatorClient.getMemberInvite()).resolves.toMatchObject({
      name: 'Casey',
      fromName: 'Operator One',
    });
    expect(restorePackage).toBeTruthy();
    expect(downstreamCoupons).toHaveLength(1);
  });

  async function startUpstream(
    name: string,
    adminOperatorAccountId: string,
    restoreKey: string,
  ): Promise<{
    botDb: BotDb;
    botServer: BotServer;
    routerDb: RouterDb;
    routerServer: RouterServer;
    operatorHost: string;
  }> {
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), `restore-handshake-${name}-`));
    tempDirs.push(tempDir);

    const botDb = new BotDb(Path.join(tempDir, 'bot'));
    botDb.migrate();
    botDbs.push(botDb);
    const relayService = {
      activateLatestCoupon: async (request: IActivateBitcoinLockCouponRequest) => {
        const coupon = botDb.bitcoinLockCouponsTable.fetchLatestByUserId(request.userId);
        if (!coupon) throw new Error('Bitcoin lock coupon not found.');

        return toCouponStatus(botDb.bitcoinLockCouponsTable.activateCoupon(coupon.id, request.accountId, 1_000)!);
      },
      getBitcoinLockCouponsByUserId: async (userId: number) => {
        return botDb.bitcoinLockCouponsTable.fetchByUserId(userId).map(toCouponStatus);
      },
    };
    const botServer = startBotServer(
      {
        db: botDb,
        relayService,
        ethereumGatewayProverService: {},
        state: async () => ({}),
        getHistoryForFrame: async () => ({}),
        getMiningFrameDetail: async () => ({}),
        storage: {
          bidsFile: () => ({ get: async () => ({}) }),
          earningsFile: () => ({ get: async () => ({}) }),
        },
      } as unknown as Bot,
      0,
    );
    await botServer.waitForListening();
    botServers.push(botServer);

    const routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
    routerDb.migrate();
    routerDbs.push(routerDb);
    const botAddress = botServer.getAddress();
    const routerServer = new RouterServer({
      db: routerDb,
      botInternalUrl: `http://${botAddress.host}:${botAddress.port}`,
      port: 0,
      auth: {
        adminOperatorAccountId,
        restoreKey,
      },
    });
    routerServer.start();
    await routerServer.waitForListening();
    routerServers.push(routerServer);

    const routerAddress = routerServer.getAddress();
    return {
      botDb,
      botServer,
      routerDb,
      routerServer,
      operatorHost: `http://${routerAddress.host}:${routerAddress.port}`,
    };
  }
});

function toCouponStatus(coupon: IBitcoinLockCouponRecord): IBitcoinLockCouponStatus {
  return {
    coupon,
    status: 'Open',
  };
}
