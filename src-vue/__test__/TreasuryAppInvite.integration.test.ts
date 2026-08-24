import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BitcoinLock, Vault } from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import {
  bigIntMax,
  type IBotState,
  type IMiningFrameDetail,
  JsonExt,
  MainchainClients,
  NetworkConfig,
  SATOSHIS_PER_BITCOIN,
} from '@argonprotocol/apps-core';
import {
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { ServerAuthClient } from '../lib/ServerAuthClient.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import type { ICreateInviteRequest, IInviteResponse, IListInvitesResponse } from '@argonprotocol/apps-router';
import {
  cleanupBitcoinLocksClientHarness,
  cleanupBitcoinLocksHarness,
  createBitcoinLocksClientHarness,
  createBitcoinLocksHarness,
  walletFundingMicrogons,
} from './helpers/bitcoinLocksHarness.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import {
  BitcoinLockFeeCouponService,
  type Bot,
  type BotServer,
  DelegateSubmitLane,
  startServer as startBotServer,
} from '@argonprotocol/apps-bot';
import { Db as RouterDb } from '../../router/src/Db.ts';
import { RouterServer } from '../../router/src/RouterServer.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

let clients: MainchainClients;
let network: StartedArgonTestNetwork;
let previousComposeProjectName: string | undefined;

afterAll(async () => {
  vi.restoreAllMocks();
  if (previousComposeProjectName === undefined) {
    delete process.env.COMPOSE_PROJECT_NAME;
  } else {
    process.env.COMPOSE_PROJECT_NAME = previousComposeProjectName;
  }
  await teardown();
});

describe.skipIf(skipE2E).sequential('Treasury app invite flow integration', { timeout: 240e3 }, () => {
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    network = await startArgonTestNetwork(Path.basename(import.meta.filename), {
      profiles: ['bob', 'price-oracle'],
      chainStartTimeoutMs: 120_000,
      chainStartPollMs: 250,
    });

    clients = new MainchainClients(network.archiveUrl);
    setMainchainClients(clients);
    NetworkConfig.setNetwork('dev-docker');
    previousComposeProjectName = process.env.COMPOSE_PROJECT_NAME;
    process.env.COMPOSE_PROJECT_NAME = network.composeEnv.COMPOSE_PROJECT_NAME;

    await waitFor(
      90e3,
      'price oracle update',
      async () => {
        const client = await clients.get(false);
        const current = await client.query.priceIndex.current();
        const priceIndex = current.toJSON() as {
          btcUsdPrice?: string;
          argonUsdPrice?: string;
          tick?: string | number;
        };
        if (!priceIndex.btcUsdPrice || BigInt(priceIndex.btcUsdPrice) <= 0n) return;
        if (!priceIndex.argonUsdPrice || BigInt(priceIndex.argonUsdPrice) <= 0n) return;
        if (priceIndex.tick == null || BigInt(priceIndex.tick) <= 0n) return;
        return true;
      },
      { pollMs: 1e3 },
    );
  }, 240e3);

  it('tracks reusable fee coupons across the operator api, runtime, and local lock state', async () => {
    const operatorHarness = await createBitcoinLocksHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
    });
    let operatorHost = '';
    const operatorServerAuthClient = new ServerAuthClient(() => operatorHarness.walletKeys);
    const treasuryWalletKeys = createMockWalletKeys();
    const treasuryServerAuthClient = new ServerAuthClient(() => treasuryWalletKeys);
    const treasuryHarness = await createBitcoinLocksClientHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
      walletKeys: treasuryWalletKeys,
      upstreamOperatorClient: new UpstreamOperatorClient(treasuryServerAuthClient, () => operatorHost || undefined),
    });
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'treasury-app-invite-'));

    let bitcoinLockFeeCouponService: BitcoinLockFeeCouponService | undefined;
    let botServer: BotServer | undefined;
    let routerDb: RouterDb | undefined;
    let routerServer: RouterServer | undefined;

    try {
      const operatorVault = operatorHarness.myVault.createdVault!;
      const expectedFromName = 'OperatorOne';
      const delegateKeypair = await operatorHarness.walletKeys.getVaultDelegateKeypair();

      const delegateSetupTx = await operatorHarness.myVault.ensureVaultDelegateReady();
      await delegateSetupTx?.txResult.waitForFinalizedBlock;

      await waitFor(45e3, 'bitcoin lock delegate ready', async () => {
        const client = await operatorHarness.clients.get(false);
        const vault = await Vault.get(client, operatorVault.vaultId);
        if (!vault) return;
        if (vault.delegateAccountId !== delegateKeypair.address) return;

        const delegateBalance = await client.query.system
          .account(delegateKeypair.address)
          .then(x => x.data.free.toBigInt());
        if (delegateBalance < 100_000n) return;

        return true;
      });

      const submitLane = new DelegateSubmitLane(delegateKeypair);
      submitLane.client = await operatorHarness.clients.get(false);
      bitcoinLockFeeCouponService = new BitcoinLockFeeCouponService(
        operatorHarness.clients,
        operatorHarness.walletKeys.vaultingAddress,
        submitLane,
      );
      const botApi = {
        isReady: true,
        bitcoinLockFeeCouponService,
        state: async () => ({ isReady: true }) as unknown as IBotState,
        getHistoryForFrame: async () => ({ activities: [] }),
        getMiningFrameDetail: async () =>
          ({
            frameId: 0,
            totalBidCount: 0,
            winningBids: [],
            slots: [],
          }) satisfies IMiningFrameDetail,
      } satisfies Pick<
        Bot,
        'isReady' | 'bitcoinLockFeeCouponService' | 'state' | 'getHistoryForFrame' | 'getMiningFrameDetail'
      >;
      botServer = startBotServer(botApi as unknown as Bot, 0);
      await botServer.waitForListening();

      routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
      routerDb.migrate();

      const botAddress = botServer.getAddress();
      routerServer = new RouterServer({
        db: routerDb,
        botInternalUrl: `http://${botAddress.host}:${botAddress.port}`,
        port: 0,
        localNodeUrl: network.archiveUrl,
        mainNodeUrl: network.archiveUrl,
        auth: {
          adminOperatorAccountId: operatorHarness.walletKeys.operationalAddress,
          restoreKey: await operatorHarness.walletKeys.getRouterRestoreSealingKey(),
        },
      });
      routerServer.start();
      await routerServer.waitForListening();

      const routerAddress = routerServer.getAddress();
      operatorHost = `http://${routerAddress.host}:${routerAddress.port}`;

      const giftLiquidity = operatorVault.availableBitcoinSpace() / 4n;
      const requestedLiquidity = giftLiquidity / 2n;
      const maxSatoshis = await treasuryHarness.bitcoinLocks.satoshisForArgonLiquidity(giftLiquidity);
      const requestedSatoshis = await treasuryHarness.bitcoinLocks.satoshisForArgonLiquidity(requestedLiquidity);
      const feeCreditMicrogons = bigIntMax(
        operatorVault.calculateBitcoinFee(giftLiquidity) - operatorVault.terms.bitcoinBaseFee,
        0n,
      );
      const defaultAccountId = treasuryHarness.walletKeys.liquidLockingAddress;

      await sudoFundWallet({
        address: defaultAccountId,
        microgons: walletFundingMicrogons,
        micronots: 0n,
        archiveUrl: network.archiveUrl,
      });

      // Operator issues the invite and should see it tracked immediately in the router api.
      const createdInvite = await createTreasuryAppInvite(operatorHost, operatorServerAuthClient, {
        name: 'Casey',
        fromName: expectedFromName,
        vaultId: operatorVault.vaultId,
        maxSatoshis,
        estimatedGiftUsd: 125,
        feeCreditMicrogons,
        btcPctFee: 2.5,
        expiresAfterTicks: 240,
      });
      expect(createdInvite.bitcoinLockCoupon?.coupon.offerCode).toBeTruthy();

      const issuedInvite = (await getTreasuryAppInvites(operatorHost, operatorServerAuthClient)).find(
        x => x.inviteCode === createdInvite.inviteCode,
      );
      expect(issuedInvite?.lastClickedAt).toBeFalsy();

      // Claiming the invite should update click tracking on the operator api.
      // The operator overlays do not auto-poll today, so this test re-fetches the api directly after each step.
      const claimedInvite = await UpstreamOperatorClient.claimInvite({
        operatorHost,
        inviteCode: createdInvite.inviteCode,
        defaultAccountKeypair: await treasuryHarness.walletKeys.getLiquidLockingKeypair(),
        authKeypair: await treasuryHarness.walletKeys.getUpstreamOperatorAuthKeypair(),
      });
      const coupon = claimedInvite.invite.bitcoinLockCoupon!;
      expect(claimedInvite.fromName).toBe(expectedFromName);
      expect(claimedInvite.operatorAccountId).toBe(operatorHarness.walletKeys.operationalAddress);
      expect(coupon.coupon.expirationTick).toBeGreaterThan(0);
      expect(coupon.remainingFeeCreditMicrogons).toBe(feeCreditMicrogons);
      expect(claimedInvite.invite.defaultAccountId).toBe(defaultAccountId);
      expect(claimedInvite.invite.authAccountId).toBe(
        (await treasuryHarness.walletKeys.getUpstreamOperatorAuthKeypair()).address,
      );
      expect(routerDb.userInvitesTable.fetchByCode(createdInvite.inviteCode)?.defaultAccountId).toBe(defaultAccountId);
      expect(routerDb.userInvitesTable.fetchByCode(createdInvite.inviteCode)?.authAccountId).toBe(
        claimedInvite.invite.authAccountId,
      );

      await expect(
        UpstreamOperatorClient.claimInvite({
          operatorHost,
          inviteCode: createdInvite.inviteCode,
          defaultAccountKeypair: await operatorHarness.walletKeys.getLiquidLockingKeypair(),
          authKeypair: await operatorHarness.walletKeys.getUpstreamOperatorAuthKeypair(),
        }),
      ).rejects.toThrow('already claimed by a different account');

      const clickedInvite = await waitFor(30e3, 'router invite click tracked', async () => {
        const invite = (await getTreasuryAppInvites(operatorHost, operatorServerAuthClient)).find(
          x => x.inviteCode === createdInvite.inviteCode,
        );
        if (!invite?.lastClickedAt) return;
        return invite;
      });
      expect(clickedInvite.lastClickedAt).toBeTruthy();

      await expect(
        new UpstreamOperatorClient(treasuryServerAuthClient, () => operatorHost).initializeBitcoinLock(
          coupon.coupon.offerCode,
          {
            ownerAccountId: operatorHarness.walletKeys.liquidLockingAddress,
            ownerBitcoinPubkey: '02deadbeef',
            requestedSatoshis,
            microgonsAtTargetPerBtc:
              treasuryHarness.currency.priceIndex.getSatoshiPriceInTargetMicrogons(SATOSHIS_PER_BITCOIN),
          },
        ),
      ).rejects.toThrow('Forbidden');

      // The member submits directly with a beneficiary-specific coupon signed by the bot.
      const firstInitialization = await treasuryHarness.bitcoinLocks.initializeLock({
        satoshis: requestedSatoshis,
        vault: operatorVault,
        operatorCoupon: {
          vaultId: operatorVault.vaultId,
          offerCode: coupon.coupon.offerCode,
          accountId: defaultAccountId,
          remainingFeeCreditMicrogons: coupon.remainingFeeCreditMicrogons,
        },
      });
      expect(firstInitialization.txInfo).toBeDefined();
      await firstInitialization.txInfo!.txResult.waitForFinalizedBlock;
      await firstInitialization.txInfo!.waitForPostProcessing;

      const firstLock = await waitForCouponLock(treasuryHarness, firstInitialization.pendingLock.uuid);
      const afterFirstUse = await waitForCouponUses(operatorHost, coupon.coupon.offerCode, 1);
      const firstUse = afterFirstUse.uses![0];

      expect(firstUse).toMatchObject({
        status: 'Finalized',
        requestedSatoshis,
        ownerAccountId: defaultAccountId,
      });
      expect(firstUse.microgonsAtTargetPerBtc).toBeGreaterThan(0n);
      expect(firstUse.feeCoupon).toMatchObject({
        nonce: 1n,
      });
      expect(firstUse.feeCoupon).not.toHaveProperty('beneficiary');
      expect(firstUse.feeCoupon).not.toHaveProperty('requestedSatoshis');
      expect(firstUse.feeCoupon).not.toHaveProperty('microgonsAtTargetPerBtc');
      expect(afterFirstUse).toMatchObject({
        status: 'Open',
        originalFeeCreditMicrogons: feeCreditMicrogons,
        usedFeeCreditMicrogons: firstUse.feeCreditMicrogons,
        pendingFeeCreditMicrogons: 0n,
        remainingFeeCreditMicrogons: feeCreditMicrogons - firstUse.feeCreditMicrogons,
      });
      expect(firstLock.satoshis).toBe(requestedSatoshis);

      const secondInitialization = await treasuryHarness.bitcoinLocks.initializeLock({
        satoshis: requestedSatoshis,
        vault: operatorVault,
        operatorCoupon: {
          vaultId: operatorVault.vaultId,
          offerCode: coupon.coupon.offerCode,
          accountId: defaultAccountId,
          remainingFeeCreditMicrogons: afterFirstUse.remainingFeeCreditMicrogons,
        },
      });
      expect(secondInitialization.txInfo).toBeDefined();
      await secondInitialization.txInfo!.txResult.waitForFinalizedBlock;
      await secondInitialization.txInfo!.waitForPostProcessing;

      const secondLock = await waitForCouponLock(treasuryHarness, secondInitialization.pendingLock.uuid);
      const afterSecondUse = await waitForCouponUses(operatorHost, coupon.coupon.offerCode, 2);
      const totalUsedFeeCredit = afterSecondUse.uses!.reduce((total, use) => total + use.feeCreditMicrogons, 0n);
      expect(afterSecondUse.uses?.map(use => use.status)).toEqual(['Finalized', 'Finalized']);
      expect(afterSecondUse.uses?.map(use => use.feeCoupon?.nonce)).toEqual([1n, 2n]);
      expect(afterSecondUse).toMatchObject({
        originalFeeCreditMicrogons: feeCreditMicrogons,
        usedFeeCreditMicrogons: totalUsedFeeCredit,
        pendingFeeCreditMicrogons: 0n,
        remainingFeeCreditMicrogons: feeCreditMicrogons - totalUsedFeeCredit,
      });
      expect(secondLock.utxoId).not.toBe(firstLock.utxoId);

      const chainClient = await treasuryHarness.clients.get(false);
      const lastNonce = await chainClient.query.bitcoinLocks.lastFeeCouponNonceByVaultAndAccount(
        operatorVault.vaultId,
        defaultAccountId,
      );
      expect(lastNonce.unwrap().toBigInt()).toBe(2n);
    } finally {
      await routerServer?.close().catch(() => undefined);
      routerDb?.close();
      await botServer?.close().catch(() => undefined);
      await Fs.promises.rm(tempDir, { recursive: true, force: true });
      await cleanupBitcoinLocksHarness(operatorHarness);
      await cleanupBitcoinLocksClientHarness(treasuryHarness);
    }
  });
});

async function waitForCouponLock(harness: Awaited<ReturnType<typeof createBitcoinLocksClientHarness>>, uuid: string) {
  return await waitFor(120e3, 'fee coupon lock finalized', async () => {
    const lock = Object.values(harness.bitcoinLocks.data.locksByUtxoId).find(record => record.uuid === uuid);
    if (!lock?.utxoId || lock.status !== BitcoinLockStatus.LockPendingFunding) return;
    if (!(await BitcoinLock.get(await harness.clients.get(false), lock.utxoId))) return;
    return lock;
  });
}

async function waitForCouponUses(operatorHost: string, offerCode: string, expectedUses: number) {
  return await waitFor(45e3, 'fee coupon use finalized', async () => {
    const status = await UpstreamOperatorClient.getBitcoinLockStatus(operatorHost, offerCode);
    if (status.uses?.length !== expectedUses) return;
    if (status.uses.some(use => use.status !== 'Finalized')) return;
    return status;
  });
}

async function createTreasuryAppInvite(
  operatorHost: string,
  serverAuthClient: ServerAuthClient,
  payload: ICreateInviteRequest,
) {
  const body = await routerRequest<IInviteResponse>(operatorHost, serverAuthClient, '/invites/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JsonExt.stringify(payload),
  });
  return body.invite;
}

async function getTreasuryAppInvites(operatorHost: string, serverAuthClient: ServerAuthClient) {
  const body = await routerRequest<IListInvitesResponse>(operatorHost, serverAuthClient, '/invites');
  return body.invites;
}

async function routerRequest<T>(
  operatorHost: string,
  serverAuthClient: ServerAuthClient,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const sessionId = await serverAuthClient.getAdminOperatorSessionId(operatorHost);
  const url = new URL(`${operatorHost}${path}`);
  url.searchParams.set('sessionId', sessionId);

  const response = await fetch(url, init);
  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(rawBody || `Router request failed (${response.status})`);
  }

  return JsonExt.parse<T>(rawBody);
}
