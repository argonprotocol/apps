import * as Fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BitcoinLock, Vault } from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import {
  BlockWatch,
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
import { setMainchainClients } from '../stores/mainchain.ts';
import { SERVER_ENV_VARS } from '../lib/Env.ts';
import { ServerApiClient } from '../lib/ServerApiClient.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import {
  cleanupBitcoinLocksClientHarness,
  cleanupBitcoinLocksHarness,
  createBitcoinLocksClientHarness,
  createBitcoinLocksHarness,
} from './helpers/bitcoinLocksHarness.ts';
import type Bot from '../../bot/src/Bot.ts';
import { startServer as startBotServer, type BotServer } from '../../bot/src/server.ts';
import { BitcoinLockRelayService } from '../../bot/src/BitcoinLockRelayService.ts';
import { Db as BotDb } from '../../bot/src/Db.ts';
import { BitcoinLockCoupons } from '../../router/src/BitcoinLockCoupons.ts';
import { Db as RouterDb } from '../../router/src/Db.ts';
import { RouterServer } from '../../router/src/RouterServer.ts';
import { TreasuryInviteService } from '../../router/src/TreasuryInviteService.ts';

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

  it('tracks the invite lifecycle across the operator api, relay flow, and local lock state', async () => {
    const operatorHarness = await createBitcoinLocksHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
    });
    const treasuryHarness = await createBitcoinLocksClientHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
    });
    const previousRouterPort = SERVER_ENV_VARS.ROUTER_PORT;
    const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), 'treasury-app-invite-'));

    let relayBlockWatch: BlockWatch | undefined;
    let relayService: BitcoinLockRelayService | undefined;
    let botServer: BotServer | undefined;
    let botDb: BotDb | undefined;
    let routerDb: RouterDb | undefined;
    let routerServer: RouterServer | undefined;

    try {
      const operatorVault = operatorHarness.myVault.createdVault!;
      const delegateKeypair = await operatorHarness.walletKeys.getVaultDelegateKeypair();
      const delegateSetupTx = await operatorHarness.myVault.ensureDelegatedBitcoinSigner();
      await delegateSetupTx?.txResult.waitForFinalizedBlock;

      await waitFor(45e3, 'bitcoin lock delegate ready', async () => {
        const client = await operatorHarness.clients.get(false);
        const vault = await Vault.get(client, operatorVault.vaultId);
        if (!vault) return;
        if (vault.bitcoinLockDelegateAccount !== delegateKeypair.address) return;

        const delegateBalance = await client.query.system
          .account(delegateKeypair.address)
          .then(x => x.data.free.toBigInt());
        if (delegateBalance < 100_000n) return;

        return true;
      });

      botDb = new BotDb(Path.join(tempDir, 'bot'));
      botDb.migrate();
      relayBlockWatch = new BlockWatch(operatorHarness.clients);
      relayService = new BitcoinLockRelayService(
        botDb,
        operatorHarness.clients,
        relayBlockWatch,
        operatorHarness.walletKeys.vaultingAddress,
        delegateKeypair,
      );
      const activeRelayService = relayService;
      const botApi = {
        isReady: true,
        state: async () => ({ isReady: true }) as unknown as IBotState,
        getHistoryForFrame: async () => ({ activities: [] }),
        getMiningFrameDetail: async () =>
          ({
            frameId: 0,
            totalBidCount: 0,
            winningBids: [],
            slots: [],
          }) satisfies IMiningFrameDetail,
        initializeBitcoinLockCoupon: async request => await activeRelayService.queueRelay(request),
        getBitcoinLockStatus: async offerCode => await activeRelayService.getBitcoinLockStatus(offerCode),
        getBitcoinLockStatuses: async () => await activeRelayService.getLatestBitcoinLockStatuses(),
      } satisfies Pick<
        Bot,
        | 'isReady'
        | 'state'
        | 'getHistoryForFrame'
        | 'getMiningFrameDetail'
        | 'initializeBitcoinLockCoupon'
        | 'getBitcoinLockStatus'
        | 'getBitcoinLockStatuses'
      >;
      botServer = startBotServer(botApi as unknown as Bot, 0);
      await botServer.waitForListening();

      routerDb = new RouterDb(Path.join(tempDir, 'router.sqlite'));
      routerDb.migrate();
      routerDb.profileTable.save({ name: 'Operator One' });

      const botAddress = botServer.getAddress();
      routerServer = new RouterServer({
        db: routerDb,
        inviteService: new TreasuryInviteService(routerDb, operatorHarness.walletKeys.vaultingAddress),
        botInternalUrl: `http://${botAddress.host}:${botAddress.port}`,
        port: 0,
        localNodeUrl: network.archiveUrl,
        mainNodeUrl: network.archiveUrl,
      });
      routerServer.start();
      await routerServer.waitForListening();

      const routerAddress = routerServer.getAddress();
      const operatorHost = `${routerAddress.host}:${routerAddress.port}`;
      SERVER_ENV_VARS.ROUTER_PORT = String(routerAddress.port);

      const initialUtxoIds = new Set(Object.keys(treasuryHarness.bitcoinLocks.data.locksByUtxoId).map(Number));
      const targetLiquidity = operatorVault.availableBitcoinSpace() / 4n;
      const requestedSatoshis = await treasuryHarness.bitcoinLocks.satoshisForArgonLiquidity(targetLiquidity);
      const accountAddress = treasuryHarness.walletKeys.liquidLockingAddress;
      const inviteCode = 'treasury-app-flow';
      const offerCode = 'treasury-app-flow-offer';
      const offerToken = BitcoinLockCoupons.createToken(
        {
          vaultId: operatorVault.vaultId,
          maxSatoshis: requestedSatoshis + 5_000n,
          expiresAfterTicks: 240,
          code: offerCode,
        },
        await operatorHarness.walletKeys.getVaultingKeypair(),
      );

      // Operator issues the invite and should see it tracked immediately in the router api.
      const createdInvite = await ServerApiClient.createTreasuryAppInvite(routerAddress.host, {
        name: 'Casey',
        inviteCode,
        offerCode,
        maxSatoshis: requestedSatoshis + 5_000n,
        expiresAfterTicks: 240,
        offerToken,
      });
      expect(createdInvite.offerToken).toBe(offerToken);

      const issuedInvite = (await ServerApiClient.getTreasuryAppInvites(routerAddress.host)).find(
        x => x.inviteCode === inviteCode,
      );
      expect(issuedInvite?.lastClickedAt).toBeFalsy();

      // Opening the invite should update click tracking on the operator api.
      // The operator overlays do not auto-poll today, so this test re-fetches the api directly after each step.
      const openedInvite = await UpstreamOperatorClient.openTreasuryAppInvite(operatorHost, inviteCode, accountAddress);
      expect(openedInvite.fromName).toBe('Operator One');
      expect(openedInvite.invite.expirationTick).toBeGreaterThan(0);
      expect(openedInvite.invite.accountAddress).toBe(accountAddress);
      expect(routerDb.userInvitesTable.fetchByCode(inviteCode)?.accountAddress).toBe(accountAddress);

      await expect(
        UpstreamOperatorClient.openTreasuryAppInvite(
          operatorHost,
          inviteCode,
          operatorHarness.walletKeys.liquidLockingAddress,
        ),
      ).rejects.toThrow('already claimed by a different account');

      const clickedInvite = await waitFor(30e3, 'router invite click tracked', async () => {
        const invite = (await ServerApiClient.getTreasuryAppInvites(routerAddress.host)).find(
          x => x.inviteCode === inviteCode,
        );
        if (!invite?.lastClickedAt) return;
        return invite;
      });
      expect(clickedInvite.lastClickedAt).toBeTruthy();

      const clickedMember = await waitFor(30e3, 'router member click tracked', async () => {
        const member = (await ServerApiClient.getTreasuryAppMembers(routerAddress.host)).find(x => x.name === 'Casey');
        if (!member?.lastClickedAt) return;
        return member;
      });
      expect(clickedMember.lastClickedAt).toBeTruthy();

      await expect(
        UpstreamOperatorClient.initializeBitcoinLock(operatorHost, openedInvite.invite.offerCode, {
          offerToken: openedInvite.invite.offerToken,
          ownerAccountAddress: operatorHarness.walletKeys.liquidLockingAddress,
          ownerBitcoinPubkey: '02deadbeef',
          requestedSatoshis,
          microgonsPerBtc: treasuryHarness.currency.priceIndex.getBtcMicrogonPrice(SATOSHIS_PER_BITCOIN),
        }),
      ).rejects.toThrow('claimed by a different account');

      // The treasury app user requests relay-backed lock creation.
      const { txInfo } = await treasuryHarness.bitcoinLocks.initializeLock({
        satoshis: requestedSatoshis,
        vault: operatorVault,
        operatorCoupon: {
          vaultId: operatorVault.vaultId,
          inviteCode,
          offerCode: openedInvite.invite.offerCode,
          operatorHost,
          accountAddress,
          couponToken: openedInvite.invite.offerToken,
        },
      });
      expect(txInfo).toBeUndefined();

      const pendingLock = await waitFor(30e3, 'coupon relay pending lock', () => {
        return treasuryHarness.bitcoinLocks.data.pendingLocks.find(
          lock => lock.relayMetadataJson?.inviteCode === inviteCode,
        );
      });
      expect(pendingLock.relayMetadataJson?.operatorHost).toBe(operatorHost);
      expect(pendingLock.relayMetadataJson?.offerCode).toBe(openedInvite.invite.offerCode);

      const progressedPendingLock = await waitFor(45e3, 'relay progress reflected in local pending lock', () => {
        const lock = treasuryHarness.bitcoinLocks.data.pendingLocks.find(x => x.uuid === pendingLock.uuid);
        if (!lock?.relayMetadataJson?.status) return;
        if (!['Submitted', 'InBlock', 'Finalized'].includes(lock.relayMetadataJson.status)) return;
        return lock;
      });
      expect(progressedPendingLock.relayMetadataJson?.status).toBeTruthy();

      const inBlockRelay = await waitFor(45e3, 'public relay in block', async () => {
        const relay = await UpstreamOperatorClient.getBitcoinLockStatus(operatorHost, openedInvite.invite.offerCode);
        if (!['InBlock', 'Finalized'].includes(relay.status)) return;
        if (relay.expiresAtBlockHeight == null || relay.submittedAtBlockHeight == null) return;
        return relay;
      });
      expect(inBlockRelay.expiresAtBlockHeight).toBeGreaterThan(inBlockRelay.submittedAtBlockHeight!);

      const publicRelayResponse = await fetch(
        `http://${operatorHost}/bitcoin-lock-coupons/${encodeURIComponent(openedInvite.invite.offerCode)}`,
      );
      expect(publicRelayResponse.ok).toBe(true);
      const publicRelayBody = JsonExt.parse<{ bitcoinLock: Record<string, unknown> }>(await publicRelayResponse.text());
      expect(publicRelayBody.bitcoinLock.offerCode).toBe(openedInvite.invite.offerCode);
      expect(publicRelayBody.bitcoinLock.status).toBeTruthy();

      // The treasury app should finalize the new lock and retain coupon relay metadata.
      const finalizedLock = await waitFor(120e3, 'coupon relay lock finalized', async () => {
        const lock = Object.values(treasuryHarness.bitcoinLocks.data.locksByUtxoId)
          .filter(record => record.utxoId && !initialUtxoIds.has(record.utxoId))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
        if (!lock) return;
        if (lock.status !== BitcoinLockStatus.LockPendingFunding) return;
        if (lock.relayMetadataJson?.offerCode !== openedInvite.invite.offerCode) return;

        const chainLock = await BitcoinLock.get(await treasuryHarness.clients.get(false), lock.utxoId!);
        if (!chainLock) return;

        return lock;
      });
      expect(finalizedLock.satoshis).toBe(requestedSatoshis);
      expect(finalizedLock.lockDetails.utxoId).toBe(finalizedLock.utxoId);
      expect(finalizedLock.relayMetadataJson?.offerCode).toBe(openedInvite.invite.offerCode);
    } finally {
      SERVER_ENV_VARS.ROUTER_PORT = previousRouterPort;
      await routerServer?.close().catch(() => undefined);
      routerDb?.close();
      await botServer?.close().catch(() => undefined);
      await relayService?.shutdown().catch(() => undefined);
      relayBlockWatch?.stop();
      botDb?.close();
      await Fs.promises.rm(tempDir, { recursive: true, force: true });
      await cleanupBitcoinLocksHarness(operatorHarness);
      await cleanupBitcoinLocksClientHarness(treasuryHarness);
    }
  });
});
