import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BlockWatch,
  createOperationalAccessProof,
  decryptBootstrapRecovery,
  encryptBootstrapRecovery,
  type IActivateBitcoinLockCouponRequest,
  type IBitcoinLockCouponRecord,
  type IBitcoinLockCouponStatus,
  getBootstrapEndpointPubkey,
  JsonExt,
  MainchainClients,
  MICROGONS_PER_ARGON,
  NetworkConfig,
  UserRole,
} from '@argonprotocol/apps-core';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import { type ArgonClient, TxSubmitter, u8aToHex } from '@argonprotocol/mainchain';
import { sudo, teardown } from '@argonprotocol/testing';
import { type BotServer, Db as BotDb, startServer as startBotServer, type Bot } from '@argonprotocol/apps-bot';
import type { IInviteResponse, IRouterAuthSessionResponse } from '@argonprotocol/apps-router';
import { Db as RouterDb } from '../../router/src/Db.ts';
import { RouterServer } from '../../router/src/RouterServer.ts';
import { BootstrapRecovery, BootstrapRecoveryContext } from '../lib/BootstrapRecovery.ts';
import { type MemberAuthState, ServerAuthClient } from '../lib/ServerAuthClient.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { createTestDb } from './helpers/db.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { setMainchainClients } from '../stores/mainchain.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('member auth handshake integration', { timeout: 240_000 }, () => {
  const tempDirs: string[] = [];
  const botServers: BotServer[] = [];
  const botDbs: BotDb[] = [];
  const routerServers: RouterServer[] = [];
  const routerDbs: RouterDb[] = [];
  let client: ArgonClient;
  let clients: MainchainClients;
  let blockWatch: BlockWatch;
  let transactionTracker: TransactionTracker;
  let transactionDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename));
    clients = new MainchainClients(network.archiveUrl);
    setMainchainClients(clients);
    NetworkConfig.setNetwork('dev-docker');
    client = await clients.get(false);
    blockWatch = new BlockWatch(clients);
    transactionDb = await createTestDb();
    transactionTracker = new TransactionTracker(Promise.resolve(transactionDb), blockWatch);
    await transactionTracker.load();
  }, 120_000);

  afterAll(async () => {
    blockWatch?.destroy();
    await transactionDb?.close();
    await clients?.disconnect();
    await teardown();
  });

  afterEach(async () => {
    await Promise.all(routerServers.splice(0).map(server => server.close().catch(() => undefined)));
    await Promise.all(botServers.splice(0).map(server => server.close().catch(() => undefined)));
    routerDbs.splice(0).forEach(db => db.close());
    botDbs.splice(0).forEach(db => db.close());
    await Promise.all(tempDirs.splice(0).map(dir => Fs.promises.rm(dir, { recursive: true, force: true })));
  });

  it('restores upstream state and refreshes downstream recovery through the signed member login', async () => {
    const operatorWalletKeys = createMockWalletKeys('//RestoreOperator');
    const memberWalletKeys = createMockWalletKeys('//RestoreMember');
    const restoreKey = `0x${'42'.repeat(32)}`;
    const bootstrapEndpointSecret = await operatorWalletKeys.getOwnServerBootstrapEndpointSecret();
    const defaultAccountKeypair = await memberWalletKeys.getLiquidLockingKeypair();
    await sudoFundWallet({
      client,
      address: operatorWalletKeys.defaultArgonAddress,
      microgons: 10n * BigInt(MICROGONS_PER_ARGON),
      micronots: 0n,
    });
    await sudoFundWallet({
      client,
      address: defaultAccountKeypair.address,
      microgons: 10n * BigInt(MICROGONS_PER_ARGON),
      micronots: 0n,
    });

    const operationalAccountStorageKey = client.query.operationalAccounts.operationalAccounts.key(
      operatorWalletKeys.operationalAddress,
    );
    const operationalAccount = client.createType('PalletOperationalAccountsOperationalAccount', {
      vaultAccount: operatorWalletKeys.vaultingAddress,
      miningAccount: operatorWalletKeys.miningBotAddress,
      encryptionPubkey: new Uint8Array(32),
      upstreamAccount: null,
      uniswapArgonTransfersInAmount: 0n,
      accountBitcoinAmount: 0n,
      accountVaultBondAmount: 0n,
      vaultCreated: true,
      vaultBitcoinAccrual: 0n,
      vaultBitcoinAppliedTotal: 0n,
      miningSeatAccrual: 0,
      miningSeatAppliedTotal: 0,
      operationalCertificationsCount: 0,
      accessCodePending: false,
      availableAccessCodes: 1,
      rewardsEarnedCount: 0,
      rewardsEarnedAmount: 0n,
      rewardsCollectedAmount: 0n,
      isOperationallyCertified: true,
    });
    const operationalAccountResult = await new TxSubmitter(
      client,
      client.tx.sudo.sudo(client.tx.system.setStorage([[operationalAccountStorageKey, operationalAccount.toHex()]])),
      sudo(),
    ).submit({ useLatestNonce: true });
    await operationalAccountResult.waitForInFirstBlock;

    const source = await startUpstream(
      'source',
      operatorWalletKeys.operationalAddress,
      restoreKey,
      bootstrapEndpointSecret,
    );
    const operatorRecovery = new BootstrapRecovery(operatorWalletKeys);
    const memberRecovery = new BootstrapRecovery(memberWalletKeys);
    const sourceUrl = new URL(source.operatorHost);
    await operatorRecovery.publishRecovery({
      client,
      transactionTracker,
      context: BootstrapRecoveryContext.OwnServer,
      bootstrapEndpointSecret,
      bootstrapEndpointIndex: 0,
      ssh: {
        user: 'dev',
        port: 22,
      },
    });
    await expect(operatorRecovery.recoverEndpoint(client, BootstrapRecoveryContext.OwnServer)).resolves.toBeUndefined();
    await operatorRecovery.publishEndpoint({
      client,
      transactionTracker,
      host: sourceUrl.hostname,
      port: Number(sourceUrl.port),
      bootstrapEndpointSecret,
    });
    const bootstrapEndpointPubkey = getBootstrapEndpointPubkey(bootstrapEndpointSecret);
    const endpointOwner = await client.query.bootstrap.endpointOwnerByPubkey(bootstrapEndpointPubkey);
    expect(endpointOwner.unwrap().toString()).toBe(operatorWalletKeys.defaultArgonAddress);
    await expect(operatorRecovery.recoverEndpoint(client, BootstrapRecoveryContext.OwnServer)).resolves.toMatchObject({
      host: sourceUrl.hostname,
      port: Number(sourceUrl.port),
      bootstrapEndpointSecret,
      bootstrapEndpointIndex: 0,
      ssh: {
        user: 'dev',
        port: 22,
      },
    });
    let cachedOperatorHost = source.operatorHost;

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
      operatorHost: source.operatorHost,
      inviteCode: invite.inviteCode,
      defaultAccountKeypair,
      authKeypair: await memberWalletKeys.getUpstreamOperatorAuthKeypair(),
    });
    let restorePackage:
      | Pick<NonNullable<IRouterAuthSessionResponse['restore']>, 'restorePackage' | 'restorePackageRevision'>
      | undefined;
    let cachedBootstrapRecovery: Uint8Array | undefined;
    let downstreamCoupons: IBitcoinLockCouponStatus[] = [];
    let downstreamRestore: IRouterAuthSessionResponse['restore'];
    const upstreamRecoverySeed = await memberWalletKeys.getUpstreamEndpointRecoverySeed();
    const applyRestoreResult = (restore: NonNullable<IRouterAuthSessionResponse['restore']>) => {
      downstreamRestore = restore;
      restorePackage = {
        restorePackage: restore.restorePackage,
        restorePackageRevision: restore.restorePackageRevision,
      };
      downstreamCoupons = restore.bitcoinLockCoupons;
    };
    const memberAuthState: MemberAuthState = {
      getRestorePackage: () => restorePackage,
      getBootstrapEndpointPubkey: async () => {
        if (!cachedBootstrapRecovery) return;

        const recovery = await decryptBootstrapRecovery(cachedBootstrapRecovery, upstreamRecoverySeed);
        return u8aToHex(getBootstrapEndpointPubkey(recovery.endpointSecret));
      },
      applyBootstrapEndpointSecret: async secret => {
        cachedBootstrapRecovery = await encryptBootstrapRecovery(
          {
            version: 1,
            endpointSecret: secret,
          },
          upstreamRecoverySeed,
        );
        await memberRecovery.publishRecovery({
          client,
          transactionTracker,
          context: BootstrapRecoveryContext.Upstream,
          encryptedRecovery: cachedBootstrapRecovery,
        });
      },
      applyRestoreResult,
    };
    const recoverOperatorHost = async () => {
      const endpoint = await memberRecovery.recoverEndpoint(client, BootstrapRecoveryContext.Upstream);
      if (!endpoint) return;

      cachedOperatorHost = `http://${endpoint.host}:${endpoint.port}`;
      return cachedOperatorHost;
    };
    let serverAuthClient = new ServerAuthClient(() => memberWalletKeys, memberAuthState);
    let upstreamOperatorClient = new UpstreamOperatorClient(
      serverAuthClient,
      () => cachedOperatorHost,
      recoverOperatorHost,
    );
    await serverAuthClient.getMemberSessionId(source.operatorHost);
    expect(restorePackage).toBeTruthy();
    const claimedInvite = source.routerDb.userInvitesTable.fetchById(invite.id)!;
    const invitationAt = claimedInvite.createdAt;
    const acceptedAt = claimedInvite.firstClickedAt!;
    const initialRestorePackageRevision = restorePackage!.restorePackageRevision;
    expect(initialRestorePackageRevision).toBe('2.0');
    await expect(decryptBootstrapRecovery(cachedBootstrapRecovery!, upstreamRecoverySeed)).resolves.toMatchObject({
      endpointSecret: bootstrapEndpointSecret,
    });

    const operationsUpgradeRequestedAt = await upstreamOperatorClient.requestOperationsUpgrade({
      defaultAccountKeypair,
      operationalAccountId: memberWalletKeys.operationalAddress,
      authKeypair: await memberWalletKeys.getUpstreamOperatorAuthKeypair(),
    });
    await serverAuthClient.invalidateMemberSessionId(source.operatorHost);
    await serverAuthClient.getMemberSessionId(source.operatorHost);
    expect(restorePackage!.restorePackageRevision).toBe('2.1');
    expect(downstreamRestore?.hasOperationsAccess).toBe(false);

    const operatorAuthClient = new ServerAuthClient(() => operatorWalletKeys);
    const operatorSessionId = await operatorAuthClient.getAdminOperatorSessionId(source.operatorHost);
    const accessProof = createOperationalAccessProof(
      await operatorWalletKeys.getOperationalKeypair(),
      memberWalletKeys.operationalAddress,
    );
    const approvalResponse = await fetch(
      `${source.operatorHost}/invites/${invite.inviteCode}/mark-operations-upgraded?sessionId=${operatorSessionId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JsonExt.stringify({ signature: accessProof.signature }),
      },
    );
    expect(approvalResponse.status).toBe(200);
    const approvedInvite = JsonExt.parse<IInviteResponse>(await approvalResponse.text()).invite;
    const operationsUpgradedAt = approvedInvite.operationsUpgradedAt!;

    const requestedRestorePackageRevision = restorePackage!.restorePackageRevision;
    await serverAuthClient.invalidateMemberSessionId(source.operatorHost);
    await serverAuthClient.getMemberSessionId(source.operatorHost);
    expect(requestedRestorePackageRevision).toBe('2.1');
    expect(restorePackage!.restorePackageRevision).toBe('2.2');
    expect(downstreamRestore?.hasOperationsAccess).toBe(true);

    await source.routerServer.close();
    routerServers.splice(routerServers.indexOf(source.routerServer), 1);
    source.routerDb.close();
    routerDbs.splice(routerDbs.indexOf(source.routerDb), 1);
    await source.botServer.close();
    botServers.splice(botServers.indexOf(source.botServer), 1);
    source.botDb.close();
    botDbs.splice(botDbs.indexOf(source.botDb), 1);

    const recovered = await startUpstream(
      'recovered',
      operatorWalletKeys.operationalAddress,
      restoreKey,
      bootstrapEndpointSecret,
    );
    const recoveredUrl = new URL(recovered.operatorHost);
    await operatorRecovery.publishEndpoint({
      client,
      transactionTracker,
      bootstrapEndpointSecret,
      host: recoveredUrl.hostname,
      port: Number(recoveredUrl.port),
    });

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
        createdAt: invitationAt,
        firstClickedAt: acceptedAt,
        operationalAccountId: memberWalletKeys.operationalAddress,
        operationsUpgradeRequestedAt,
        operationsUpgradedAt,
        operationsAccessProofSignature: accessProof.signature,
      },
    );
    expect(recovered.botDb.bitcoinLockCouponsTable.fetchAll()).toHaveLength(1);
    expect(downstreamRestore?.hasOperationsAccess).toBe(true);

    restorePackage = undefined;
    cachedBootstrapRecovery = undefined;
    downstreamCoupons = [];
    serverAuthClient = new ServerAuthClient(() => memberWalletKeys, memberAuthState);
    cachedOperatorHost = recovered.operatorHost;
    upstreamOperatorClient = new UpstreamOperatorClient(
      serverAuthClient,
      () => cachedOperatorHost,
      recoverOperatorHost,
    );

    await expect(upstreamOperatorClient.getMemberInvite()).resolves.toMatchObject({
      name: 'Casey',
      fromName: 'Operator One',
    });
    expect(restorePackage).toBeTruthy();
    await expect(decryptBootstrapRecovery(cachedBootstrapRecovery!, upstreamRecoverySeed)).resolves.toMatchObject({
      endpointSecret: bootstrapEndpointSecret,
    });
    expect(downstreamCoupons).toHaveLength(1);
  });

  async function startUpstream(
    name: string,
    adminOperatorAccountId: string,
    restoreKey: string,
    bootstrapEndpointSecret: string,
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
      mainNodeUrl: clients.archiveUrl,
      port: 0,
      auth: {
        adminOperatorAccountId,
        restoreKey,
        bootstrapEndpointSecret,
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
