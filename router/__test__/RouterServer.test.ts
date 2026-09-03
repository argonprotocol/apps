import * as Fs from 'node:fs';
import * as Http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationalAccessProof,
  JsonExt,
  MiningFrames,
  NetworkConfig,
  signRouterAuthAccountBinding,
  signRouterAuthChallenge,
  UserRole,
  type IEthereumGatewayCatchUpResponse,
  type IEthereumGatewayRelayStatus,
  type RouterAuthRole,
  BitcoinLock,
} from '@argonprotocol/apps-core';
import { Keyring, PriceIndex, type KeyringPair } from '@argonprotocol/mainchain';
import { Db as RouterDb } from '../src/Db.ts';
import { RouterServer } from '../src/RouterServer.ts';
import type { IRouterAuthServiceOptions } from '../src/RouterAuthService.ts';
import type {
  IBitcoinLockCouponStatus,
  IBitcoinLockStatusResponse,
  IInitializeBitcoinLockResponse,
  IInviteResponse,
  IListBitcoinLockCouponsResponse,
  IListInvitesResponse,
  IOpenInviteResponse,
  IPreviewInviteResponse,
  IRouterAuthChallengeRequest,
  IRouterAuthSessionResponse,
} from '../src/interfaces/index.ts';

const mainchainMocks = vi.hoisted(() => ({
  getClient: vi.fn(),
}));

vi.mock('@argonprotocol/mainchain', async importOriginal => ({
  ...(await importOriginal()),
  getClient: mainchainMocks.getClient,
}));

NetworkConfig.setNetwork('dev-docker');

type IRouterAddress = {
  host: string;
  port: number;
};

type BotRequest = {
  method: string;
  path: string;
  body: unknown;
};

type BotResponse = {
  status: number;
  body: unknown;
};

describe('RouterServer', () => {
  let routerServer: RouterServer | undefined;
  let routerDb: RouterDb | undefined;
  let botServer: Http.Server | undefined;

  afterEach(async () => {
    await routerServer?.close().catch(() => undefined);
    routerDb?.close();
    await new Promise<void>(resolve => botServer?.close(() => resolve()) ?? resolve());
    mainchainMocks.getClient.mockReset();
  });

  it('publicly exposes the bot sync status', async () => {
    routerDb = createDb('router-server-bot-sync-status-');
    const botSyncStatus = {
      isReady: false,
      isSyncing: true,
      syncProgress: 42.5,
    };
    const handleBotRequest = vi.fn(() => ({ status: 200, body: botSyncStatus }));
    const started = await startRouterServer(routerDb, handleBotRequest);
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await fetch(`http://${started.routerAddress.host}:${started.routerAddress.port}/bot-sync-status`);

    expect(response.status).toBe(200);
    expect(JsonExt.parse(await response.text())).toEqual(botSyncStatus);
    expect(handleBotRequest).toHaveBeenCalledWith({ method: 'GET', path: '/sync-status', body: undefined });
  });

  it('validates invite payload before creating an invite', async () => {
    routerDb = createDb('router-server-create-validation-');

    const started = await startRouterServer(routerDb, () => ({
      status: 200,
      body: { status: 'ok' },
    }));
    routerServer = started.routerServer;
    botServer = started.botServer;

    const invalidVaultResponse = await requestJson(started.routerAddress, '/invites/create', {
      name: 'Casey',
      fromName: 'Operator One',
      vaultId: 0,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      expiresAfterTicks: 60,
    });
    expect(invalidVaultResponse.status).toBe(400);
    expect(await invalidVaultResponse.text()).toContain('A vault is required to create an invite.');

    const invalidExpiryResponse = await requestJson(started.routerAddress, '/invites/create', {
      name: 'Casey',
      fromName: 'Operator One',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      expiresAfterTicks: 0,
    });
    expect(invalidExpiryResponse.status).toBe(400);
    expect(await invalidExpiryResponse.text()).toContain('Invite expiry must be greater than zero.');

    const invalidEstimatedGiftUsdResponse = await requestJson(started.routerAddress, '/invites/create', {
      name: 'Casey',
      fromName: 'Operator One',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: -1,
      expiresAfterTicks: 60,
    });
    expect(invalidEstimatedGiftUsdResponse.status).toBe(400);
    expect(await invalidEstimatedGiftUsdResponse.text()).toContain(
      'Estimated gift USD must be a valid non-negative number.',
    );

    const invalidBtcPctFeeResponse = await requestJson(started.routerAddress, '/invites/create', {
      name: 'Casey',
      fromName: 'Operator One',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: -1,
      expiresAfterTicks: 60,
    });
    expect(invalidBtcPctFeeResponse.status).toBe(400);
    expect(await invalidBtcPctFeeResponse.text()).toContain('BTC percent fee must be a valid non-negative number.');
    expect(listMemberInvites(routerDb)).toEqual([]);
  });

  it('lists unified invites with their latest bitcoin coupon', async () => {
    routerDb = createDb('router-server-list-invites-');

    const olderInvite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    const newerInvite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-2',
      name: 'Riley',
      fromName: 'Operator One',
    });

    const coupon = insertCoupon(routerDb, {
      userId: newerInvite.id,
      offerCode: 'offer-code-2',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
    });

    const started = await startRouterServer(routerDb, () => ({ status: 404, body: { error: 'Not Found' } }));
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await fetch(`http://${started.routerAddress.host}:${started.routerAddress.port}/invites`);
    expect(response.status).toBe(200);

    const body = JsonExt.parse<IListInvitesResponse>(await response.text());
    expect(body.invites.map(x => x.inviteCode)).toEqual([newerInvite.inviteCode, olderInvite.inviteCode]);
    expect(body.invites[0].vaultId).toBeUndefined();
    expect(body.invites[0].bitcoinLockCoupon).toEqual({ coupon, status: 'Open' });
    expect(body.invites[1].bitcoinLockCoupon).toBeUndefined();
  });

  it('recovers downstream coupon polling after the initial mainchain connection fails', async () => {
    routerDb = createDb('router-server-mainchain-recovery-');
    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    insertCoupon(routerDb, {
      userId: invite.id,
      offerCode: 'legacy-offer',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      accountId: 'member-account',
    });

    mainchainMocks.getClient
      .mockRejectedValueOnce(new Error('Mainchain is offline'))
      .mockResolvedValue({ disconnect: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(PriceIndex.prototype, 'load').mockImplementation(async function (this: PriceIndex) {
      return this;
    });
    vi.spyOn(BitcoinLock, 'calculateRedemptionAmountFromSatoshis').mockReturnValue(4_000_000n);

    const started = await startRouterServer(routerDb, () => ({ status: 200, body: [] }), {
      mainNodeUrl: 'ws://mainchain.test',
    });
    routerServer = started.routerServer;
    botServer = started.botServer;

    await vi.waitFor(() => expect(mainchainMocks.getClient).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      const response = await fetch(
        `http://${started.routerAddress.host}:${started.routerAddress.port}/bitcoin-lock-coupons/legacy-offer`,
      );
      const body = JsonExt.parse<IBitcoinLockStatusResponse>(await response.text());
      expect(body.bitcoinLock).toMatchObject({
        coupon: { offerCode: 'legacy-offer', feeCreditMicrogons: 100_000n },
        remainingFeeCreditMicrogons: 100_000n,
        status: 'Open',
      });
    });
  });

  it('lists only invite and coupon metadata', async () => {
    routerDb = createDb('router-server-list-invite-metadata-');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Member One',
      fromName: 'Operator One',
    });
    routerDb.userInvitesTable.claimInvite(invite.id, member.address, member.address);
    const coupon = insertCoupon(routerDb, {
      userId: invite.id,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
    });

    const started = await startRouterServer(routerDb, () => ({ status: 404, body: { error: 'Not Found' } }), {
      mainNodeUrl: 'ws://mainchain.test',
    });
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await fetch(`http://${started.routerAddress.host}:${started.routerAddress.port}/invites`);
    expect(response.status).toBe(200);

    const body = JsonExt.parse<IListInvitesResponse>(await response.text());
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({
      inviteCode: invite.inviteCode,
      defaultAccountId: member.address,
      bitcoinLockCoupon: {
        coupon: {
          offerCode: coupon.offerCode,
          vaultId: coupon.vaultId,
        },
        status: 'Open',
      },
    });
    expect(body.invites[0].certificationProgress).toBeUndefined();
    expect(body.invites[0].vaultContribution).toBeUndefined();
  });

  it('regenerates an expired invite in place', async () => {
    routerDb = createDb('router-server-regenerate-invite-');

    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    insertCoupon(routerDb, {
      userId: invite.id,
      offerCode: 'expired-offer-code',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expirationTick: 1,
    });

    const started = await startRouterServer(routerDb, () => ({ status: 404, body: { error: 'Not Found' } }));
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await requestJson(started.routerAddress, `/invites/${invite.inviteCode}/regenerate`, {
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 60,
    });
    expect(response.status).toBe(200);

    const regeneratedInvite = JsonExt.parse<IInviteResponse>(await response.text()).invite;
    expect(regeneratedInvite.id).toBe(invite.id);
    expect(regeneratedInvite.name).toBe(invite.name);
    expect(regeneratedInvite.inviteCode).not.toBe(invite.inviteCode);
    expect(regeneratedInvite.bitcoinLockCoupon?.coupon.offerCode).not.toBe('expired-offer-code');
    expect(regeneratedInvite.bitcoinLockCoupon?.coupon.userId).toBe(invite.id);
    expect(routerDb.userInvitesTable.fetchByCode(invite.inviteCode)).toBeNull();
    expect(routerDb.userInvitesTable.fetchByCode(regeneratedInvite.inviteCode)?.id).toBe(invite.id);
    expect(listMemberInvites(routerDb)).toHaveLength(1);
  });

  it('previews invite coupon details', async () => {
    routerDb = createDb('router-server-preview-invite-');

    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    insertCoupon(routerDb, {
      userId: invite.id,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 420,
    });
    const requestedAt = Date.now();

    const started = await startRouterServer(routerDb, () => ({ status: 404, body: { error: 'Not Found' } }));
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await fetch(
      `http://${started.routerAddress.host}:${started.routerAddress.port}/invites/${encodeURIComponent(invite.inviteCode)}/preview`,
    );
    expect(response.status).toBe(200);

    const body = JsonExt.parse<IPreviewInviteResponse>(await response.text());
    expect(body).toMatchObject({
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 420,
      fromName: 'Operator One',
    });
    const previewDuration = 420 * NetworkConfig.tickMillis;
    expect(body.expiresAt.getTime()).toBeGreaterThanOrEqual(requestedAt + previewDuration);
    expect(body.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + previewDuration);
  });

  it('opens an invite using auth account binding and activates the coupon', async () => {
    routerDb = createDb('router-server-open-invite-');

    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');
    const coupon = insertCoupon(routerDb, {
      userId: invite.id,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
    });

    const started = await startRouterServer(routerDb, () => ({ status: 404, body: { error: 'Not Found' } }), {
      adminOperatorAccountId: operator.address,
      restoreKey: `0x${'42'.repeat(32)}`,
    });
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await requestJson(
      started.routerAddress,
      `/invites/${encodeURIComponent(invite.inviteCode)}/open`,
      createOpenInviteBody(invite.inviteCode, member, memberAuth),
    );
    expect(response.status).toBe(200);

    const body = JsonExt.parse<IOpenInviteResponse>(await response.text());
    expect(body.fromName).toBe('Operator One');
    expect(body.operatorAccountId).toBe(operator.address);
    expect(body.referrer).toBe(operator.address);
    expect(body.invite.defaultAccountId).toBe(member.address);
    expect(body.invite.operationalAccountId).toBeFalsy();
    expect(body.invite.accessProof).toBeUndefined();
    expect(body.invite.authAccountId).toBe(memberAuth.address);
    expect(body.invite.vaultId).toBe(12);
    expect(body.invite.bitcoinLockCoupon?.coupon).toEqual({
      ...coupon,
      accountId: member.address,
      expirationTick: body.invite.bitcoinLockCoupon?.coupon.expirationTick,
      updatedAt: body.invite.bitcoinLockCoupon?.coupon.updatedAt,
    });
    expect(body.invite.bitcoinLockCoupon?.status).toBe('Open');

    const claimedInvite = routerDb.userInvitesTable.fetchByCode(invite.inviteCode);
    expect(claimedInvite?.defaultAccountId).toBe(member.address);
    expect(claimedInvite?.operationalAccountId).toBeFalsy();
    expect(claimedInvite?.authAccountId).toBe(memberAuth.address);
    expect(claimedInvite?.lastClickedAt).toBeTruthy();
  });

  it('returns a refreshed member backup only after its revision changes', async () => {
    routerDb = createDb('router-server-refresh-member-package-');

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//upstream-operator-auth');
    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    routerDb.userInvitesTable.claimInvite(invite.id, member.address, memberAuth.address);

    const started = await startRouterServer(routerDb, () => ({ status: 404, body: { error: 'Not Found' } }), {
      adminOperatorAccountId: operator.address,
      restoreKey: `0x${'42'.repeat(32)}`,
    });
    routerServer = started.routerServer;
    botServer = started.botServer;

    const { session } = await login(started.routerAddress, member, UserRole.Member, memberAuth);
    const initialRevision = session.restore?.restorePackageRevision;

    expect(initialRevision).toBe('3.0.0');
    expect(session.restore?.restorePackage).toBeTruthy();

    const current = await login(started.routerAddress, member, UserRole.Member, memberAuth, {
      restorePackageRevision: initialRevision,
    });
    expect(current.session.restore).toBeUndefined();

    const previousClientWithPackage = await login(started.routerAddress, member, UserRole.Member, memberAuth, {
      hasRestorePackage: true,
    });
    expect(previousClientWithPackage.session.restore).toBeUndefined();

    const previousClientWithoutPackage = await login(started.routerAddress, member, UserRole.Member, memberAuth, {
      hasRestorePackage: false,
    });
    expect(previousClientWithoutPackage.session.restore?.restorePackage).toBeTruthy();

    routerDb.userInvitesTable.requestOperationsUpgrade(invite.id);

    const changed = await login(started.routerAddress, member, UserRole.Member, memberAuth, {
      restorePackageRevision: initialRevision,
    });
    const requestedRevision = changed.session.restore?.restorePackageRevision;
    expect(requestedRevision).toBe('3.1.0');

    const unchangedRequest = await login(started.routerAddress, member, UserRole.Member, memberAuth, {
      restorePackageRevision: requestedRevision,
    });
    expect(unchangedRequest.session.restore).toBeUndefined();
  });

  it('refreshes a member backup from router state while the bot is unavailable', async () => {
    routerDb = createDb('router-server-member-package-refresh-retry-');

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//upstream-operator-auth');
    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    routerDb.userInvitesTable.claimInvite(invite.id, member.address, memberAuth.address);
    const coupon = insertCoupon(routerDb, {
      userId: invite.id,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      accountId: member.address,
      expirationTick: MiningFrames.calculateCurrentTickFromSystemTime() + 60,
    });

    const started = await startRouterServer(routerDb, () => ({ status: 503, body: { error: 'Bot is restarting.' } }), {
      adminOperatorAccountId: operator.address,
      restoreKey: `0x${'42'.repeat(32)}`,
    });
    routerServer = started.routerServer;
    botServer = started.botServer;

    const { session } = await login(started.routerAddress, member, UserRole.Member, memberAuth);

    expect(session.sessionId).toBeTruthy();
    expect(session.restore?.restorePackage).toBeTruthy();
    expect(session.restore?.bitcoinLockCoupons[0].coupon).toEqual(coupon);
  });

  it('requires admin operator auth for invite management routes when auth is configured', async () => {
    routerDb = createDb('router-server-admin-auth-');

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const started = await startRouterServer(
      routerDb,
      () => ({
        status: 200,
        body: [],
      }),
      {
        adminOperatorAccountId: operator.address,
        sessionTtlSeconds: 60,
      },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;

    const unauthenticatedResponse = await requestJson(started.routerAddress, '/invites/create', {
      name: 'Casey',
      fromName: 'Operator One',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      expiresAfterTicks: 60,
    });
    expect(unauthenticatedResponse.status).toBe(401);

    const { session } = await login(started.routerAddress, operator);
    const authenticatedResponse = await fetch(
      withSessionId(`http://${started.routerAddress.host}:${started.routerAddress.port}/invites`, session.sessionId),
    );
    expect(authenticatedResponse.status).toBe(200);

    const verifyResponse = await fetch(
      withSessionId(
        `http://${started.routerAddress.host}:${started.routerAddress.port}/auth/verify/admin`,
        session.sessionId,
      ),
    );
    expect(verifyResponse.status).toBe(204);
    expect(verifyResponse.headers.get('x-user-id')).toBe(operator.address);
    expect(verifyResponse.headers.get('x-user-role')).toBe(UserRole.AdminOperator);
  });

  it('accepts claimed members at member verifier routes without granting admin access', async () => {
    routerDb = createDb('router-server-member-auth-');

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');
    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    routerDb.userInvitesTable.claimInvite(invite.id, member.address, memberAuth.address);

    const started = await startRouterServer(
      routerDb,
      () => ({
        status: 200,
        body: [],
      }),
      {
        adminOperatorAccountId: operator.address,
        sessionTtlSeconds: 60,
      },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;

    const { session } = await login(started.routerAddress, member, UserRole.Member, memberAuth);
    const substrateVerifyResponse = await fetch(
      withSessionId(
        `http://${started.routerAddress.host}:${started.routerAddress.port}/auth/verify/substrate`,
        session.sessionId,
      ),
    );
    expect(substrateVerifyResponse.status).toBe(204);
    expect(substrateVerifyResponse.headers.get('x-user-id')).toBe(member.address);
    expect(substrateVerifyResponse.headers.get('x-user-role')).toBe(UserRole.Member);

    const memberVerifyResponse = await fetch(
      withSessionId(
        `http://${started.routerAddress.host}:${started.routerAddress.port}/auth/verify/member`,
        session.sessionId,
      ),
    );
    expect(memberVerifyResponse.status).toBe(204);

    const adminVerifyResponse = await fetch(
      withSessionId(
        `http://${started.routerAddress.host}:${started.routerAddress.port}/auth/verify/admin`,
        session.sessionId,
      ),
    );
    expect(adminVerifyResponse.status).toBe(403);

    const listResponse = await fetch(
      withSessionId(`http://${started.routerAddress.host}:${started.routerAddress.port}/invites`, session.sessionId),
    );
    expect(listResponse.status).toBe(403);
  });

  it('requires a matching member session for member coupon routes', async () => {
    routerDb = createDb('router-server-member-coupon-auth-');

    mainchainMocks.getClient.mockRejectedValue(new Error('Mainchain is not needed before initialization'));

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const otherMember = new Keyring({ type: 'sr25519' }).addFromUri('//OtherInviteMember');
    const memberAuth = member.derive('//downstream-auth');
    const otherMemberAuth = otherMember.derive('//downstream-auth');
    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    routerDb.userInvitesTable.claimInvite(invite.id, member.address, memberAuth.address);

    const otherInvite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-2',
      name: 'Riley',
      fromName: 'Operator One',
    });
    routerDb.userInvitesTable.claimInvite(otherInvite.id, otherMember.address, otherMemberAuth.address);

    const listedCoupon = insertCoupon(routerDb, {
      userId: invite.id,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      accountId: member.address,
      expirationTick: MiningFrames.calculateCurrentTickFromSystemTime() + 60,
    });

    const started = await startRouterServer(
      routerDb,
      request => {
        if (request.method === 'POST' && request.path === '/bitcoin-lock-fee-coupons/sign') {
          const body = request.body as {
            vaultId: number;
            beneficiary: string;
            requestedSatoshis: bigint;
            microgonsAtTargetPerBtc: bigint;
            feeDiscountMicrogons: bigint;
          };
          return {
            status: 200,
            body: {
              feeDiscount: body.feeDiscountMicrogons,
              securitizationSpaceToUnreserve: 0n,
              expiresAtFrame: 100n,
              nonce: 1n,
              signature: '0xsignature',
            },
          };
        }

        return {
          status: 404,
          body: { error: 'Not Found' },
        };
      },
      {
        adminOperatorAccountId: operator.address,
        sessionTtlSeconds: 60,
        mainNodeUrl: 'ws://mainchain.test',
      },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;

    const { session } = await login(started.routerAddress, member, UserRole.Member, memberAuth);
    const { session: otherSession } = await login(started.routerAddress, otherMember, UserRole.Member, otherMemberAuth);

    const listUrl = `http://${started.routerAddress.host}:${started.routerAddress.port}/invites/me/bitcoin-lock-coupons`;
    const unauthenticatedListResponse = await fetch(listUrl);
    expect(unauthenticatedListResponse.status).toBe(401);

    const authenticatedListResponse = await fetch(withSessionId(listUrl, session.sessionId));
    expect(authenticatedListResponse.status).toBe(200);
    expect(JsonExt.parse<IListBitcoinLockCouponsResponse>(await authenticatedListResponse.text())).toEqual({
      bitcoinLockCoupons: [
        {
          coupon: listedCoupon,
          status: 'Open',
          expiresAt: expect.any(Date),
        },
      ],
    });

    insertCoupon(routerDb, {
      userId: invite.id,
      offerCode: 'fee-credit-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      feeCreditMicrogons: 1_000n,
      accountId: member.address,
      expirationTick: MiningFrames.calculateCurrentTickFromSystemTime() + 60,
    });
    const initializePath = '/bitcoin-lock-coupons/fee-credit-1/initialize';
    const initializeBody = {
      requestId: 'lock-2',
      requestedSatoshis: 10_000n,
      feeCreditMicrogons: 400n,
      ownerAccountId: member.address,
      ownerBitcoinPubkey: '03b28f34af9b5e623aa640f82bf9f09ffcc287d5826ac7ef84b96eddb71543fdae',
      microgonsAtTargetPerBtc: 125_000_000n,
    };

    const unauthenticatedInitializeResponse = await requestJson(started.routerAddress, initializePath, initializeBody);
    expect(unauthenticatedInitializeResponse.status).toBe(401);

    const mismatchedInitializeResponse = await requestJson(
      started.routerAddress,
      withSessionId(initializePath, otherSession.sessionId),
      initializeBody,
    );
    expect(mismatchedInitializeResponse.status).toBe(403);

    const authenticatedInitializeResponse = await requestJson(
      started.routerAddress,
      withSessionId(initializePath, session.sessionId),
      initializeBody,
    );
    expect(authenticatedInitializeResponse.status).toBe(200);
    const signedCoupon = JsonExt.parse<IInitializeBitcoinLockResponse>(await authenticatedInitializeResponse.text());
    expect(signedCoupon.execution).toMatchObject({
      type: 'FeeCoupon',
      requestId: 'lock-2',
      feeCoupon: {
        feeDiscount: 400n,
      },
    });
    expect(signedCoupon.bitcoinLock).toMatchObject({
      status: 'Prepared',
      originalFeeCreditMicrogons: 1_000n,
      pendingFeeCreditMicrogons: 400n,
      remainingFeeCreditMicrogons: 600n,
    });
  });

  it('lets a member request an operations upgrade once and lets the operator mark it complete', async () => {
    routerDb = createDb('router-server-operations-upgrade-request-');

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const memberAuth = member.derive('//downstream-auth');
    const operationalAccount = member.derive('//operational');
    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    routerDb.userInvitesTable.claimInvite(invite.id, member.address, memberAuth.address);

    const loadOperationalAccount = vi.fn(async (accountId: string) =>
      accountId === operator.address ? { availableAccessCodes: 1 } : null,
    );
    mainchainMocks.getClient.mockResolvedValue({
      disconnect: vi.fn().mockResolvedValue(undefined),
      query: {
        operationalAccounts: {
          operationalAccountBySubAccount: {
            multi: vi.fn().mockResolvedValue([{ isSome: false }]),
          },
          operationalAccounts: loadOperationalAccount,
        },
      },
    });

    const started = await startRouterServer(
      routerDb,
      () => ({
        status: 200,
        body: [],
      }),
      {
        adminOperatorAccountId: operator.address,
        sessionTtlSeconds: 60,
        mainNodeUrl: 'ws://mainchain.test',
      },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;

    const { session: adminSession } = await login(started.routerAddress, operator);
    const { session: memberSession } = await login(started.routerAddress, member, UserRole.Member, memberAuth);

    const inviteResponse = await fetch(
      withSessionId(
        `http://${started.routerAddress.host}:${started.routerAddress.port}/invites/me`,
        memberSession.sessionId,
      ),
    );
    expect(inviteResponse.status).toBe(200);
    expect(JsonExt.parse<IInviteResponse>(await inviteResponse.text()).invite.inviteCode).toBe(invite.inviteCode);

    const requestUpgradeUrl = withSessionId(
      `http://${started.routerAddress.host}:${started.routerAddress.port}/invites/me/request-operations-upgrade`,
      memberSession.sessionId,
    );
    const firstUpgradeRequest = await fetch(requestUpgradeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JsonExt.stringify(createRequestOperationsUpgradeBody(member, memberAuth, operationalAccount)),
    });
    expect(firstUpgradeRequest.status).toBe(200);
    const firstUpgradeBody = JsonExt.parse<{ operationsUpgradeRequestedAt: Date }>(await firstUpgradeRequest.text());
    expect(firstUpgradeBody.operationsUpgradeRequestedAt).toBeTruthy();

    const firstInviteState = routerDb.userInvitesTable.fetchByCode(invite.inviteCode)!;
    expect(firstInviteState.operationalAccountId).toBe(operationalAccount.address);
    expect(firstInviteState.operationsUpgradeRequestedAt?.toISOString()).toBe(
      firstUpgradeBody.operationsUpgradeRequestedAt.toISOString(),
    );
    expect(firstInviteState.operationsUpgradedAt).toBeFalsy();

    const secondUpgradeRequest = await fetch(requestUpgradeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JsonExt.stringify(createRequestOperationsUpgradeBody(member, memberAuth, operationalAccount)),
    });
    expect(secondUpgradeRequest.status).toBe(200);
    const secondUpgradeBody = JsonExt.parse<{ operationsUpgradeRequestedAt: Date }>(await secondUpgradeRequest.text());

    const secondInviteState = routerDb.userInvitesTable.fetchByCode(invite.inviteCode)!;
    expect(secondUpgradeBody.operationsUpgradeRequestedAt.toISOString()).toBe(
      firstUpgradeBody.operationsUpgradeRequestedAt.toISOString(),
    );
    expect(secondInviteState.operationsUpgradeRequestedAt?.toISOString()).toBe(
      firstUpgradeBody.operationsUpgradeRequestedAt.toISOString(),
    );

    const accessProof = createOperationalAccessProof(operator, operationalAccount.address);
    const markUpgradedResponse = await fetch(
      withSessionId(
        `http://${started.routerAddress.host}:${started.routerAddress.port}/invites/${encodeURIComponent(invite.inviteCode)}/mark-operations-upgraded`,
        adminSession.sessionId,
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JsonExt.stringify({
          signature: accessProof.signature,
        }),
      },
    );
    expect(markUpgradedResponse.status).toBe(200);
    const upgradedInvite = JsonExt.parse<IInviteResponse>(await markUpgradedResponse.text()).invite;
    expect(upgradedInvite.operationsUpgradeRequestedAt).toBeTruthy();
    expect(upgradedInvite.operationsUpgradedAt).toBeTruthy();
    expect(upgradedInvite.accessProof).toEqual(accessProof);

    const storedInvite = routerDb.userInvitesTable.fetchByCode(invite.inviteCode);
    expect(storedInvite?.operationsUpgradeRequestedAt).toBeTruthy();
    expect(storedInvite?.operationsUpgradedAt).toBeTruthy();
    expect(storedInvite?.operationsAccessProofSignature).toBe(accessProof.signature);
    expect(loadOperationalAccount).toHaveBeenCalledWith(operator.address);
  });

  it('allows both admin and member sessions to access Ethereum relay routes', async () => {
    routerDb = createDb('router-server-ethereum-relay-auth-');

    const operator = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const member = new Keyring({ type: 'sr25519' }).addFromUri('//RelayMember');
    const memberAuth = member.derive('//downstream-auth');
    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Relay Member',
      fromName: 'Operator One',
    });
    routerDb.userInvitesTable.claimInvite(invite.id, member.address, memberAuth.address);

    const relayStatus: IEthereumGatewayRelayStatus = {
      isReady: false,
      reason: 'Vault delegate cannot afford Ethereum gateway relay.',
    };
    const relayCatchUp: IEthereumGatewayCatchUpResponse = {
      outcome: 'Submitted',
      delegateAddress: '5RelayDelegate',
      argonTxHash: '0xrelaytx',
      extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
      txNonce: 3,
      txSubmittedAtBlockHeight: 44,
      txSubmittedAtTime: new Date('2026-05-13T16:00:00.000Z'),
      estimatedFee: 5n,
      throughGatewayActivityNonce: 7n,
    };

    const started = await startRouterServer(
      routerDb,
      request => {
        if (request.method === 'GET' && request.path === '/ethereum-relay-status') {
          return {
            status: 200,
            body: relayStatus,
          };
        }
        if (request.method === 'POST' && request.path === '/ethereum-relay-request') {
          return {
            status: 200,
            body: relayCatchUp,
          };
        }

        return {
          status: 404,
          body: { error: 'Not Found' },
        };
      },
      {
        adminOperatorAccountId: operator.address,
        sessionTtlSeconds: 60,
      },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;

    const { session: adminSession } = await login(started.routerAddress, operator);
    const { session: memberSession } = await login(started.routerAddress, member, UserRole.Member, memberAuth);

    const unauthenticatedStatusResponse = await fetch(
      `http://${started.routerAddress.host}:${started.routerAddress.port}/ethereum-relay-status`,
    );
    expect(unauthenticatedStatusResponse.status).toBe(401);

    const adminStatusResponse = await fetch(
      withSessionId(
        `http://${started.routerAddress.host}:${started.routerAddress.port}/ethereum-relay-status`,
        adminSession.sessionId,
      ),
    );
    expect(adminStatusResponse.status).toBe(200);
    expect(JsonExt.parse(await adminStatusResponse.text())).toEqual(relayStatus);

    const memberStatusResponse = await fetch(
      withSessionId(
        `http://${started.routerAddress.host}:${started.routerAddress.port}/ethereum-relay-status`,
        memberSession.sessionId,
      ),
    );
    expect(memberStatusResponse.status).toBe(200);
    expect(JsonExt.parse(await memberStatusResponse.text())).toEqual(relayStatus);

    const relayBody = {
      sourceChain: 'Ethereum',
      throughGatewayActivityNonce: 7n,
    };

    const unauthenticatedRequestResponse = await requestJson(
      started.routerAddress,
      '/ethereum-relay-request',
      relayBody,
    );
    expect(unauthenticatedRequestResponse.status).toBe(401);

    const adminRequestResponse = await requestJson(
      started.routerAddress,
      withSessionId('/ethereum-relay-request', adminSession.sessionId),
      relayBody,
    );
    expect(adminRequestResponse.status).toBe(200);
    expect(JsonExt.parse(await adminRequestResponse.text())).toEqual(relayCatchUp);

    const memberRequestResponse = await requestJson(
      started.routerAddress,
      withSessionId('/ethereum-relay-request', memberSession.sessionId),
      relayBody,
    );
    expect(memberRequestResponse.status).toBe(200);
    expect(JsonExt.parse(await memberRequestResponse.text())).toEqual(relayCatchUp);
  });
});

function createDb(prefix: string): RouterDb {
  const tempDir = Fs.mkdtempSync(Path.join(os.tmpdir(), prefix));
  const db = new RouterDb(Path.join(tempDir, 'router.sqlite'));
  db.migrate();
  return db;
}

async function startRouterServer(
  db: RouterDb,
  handleBotRequest: (request: BotRequest) => BotResponse | Promise<BotResponse>,
  options?: Omit<IRouterAuthServiceOptions, 'db' | 'memberRestore'> & {
    restoreKey?: string;
    mainNodeUrl?: string;
  },
): Promise<{ routerAddress: IRouterAddress; routerServer: RouterServer; botServer: Http.Server }> {
  const { mainNodeUrl, ...auth } = options ?? {};
  const botServer = Http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JsonExt.parse(rawBody) : undefined;
    const response = await handleBotRequest({
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      body,
    });

    res.statusCode = response.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JsonExt.stringify(response.body));
  });
  await new Promise<void>(resolve => botServer.listen(0, resolve));
  const botAddress = botServer.address() as AddressInfo;

  const routerServer = new RouterServer({
    db,
    botInternalUrl: `http://127.0.0.1:${botAddress.port}`,
    port: 0,
    auth: options ? auth : undefined,
    mainNodeUrl,
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
  restore?: Pick<IRouterAuthChallengeRequest, 'restorePackageRevision' | 'hasRestorePackage'>,
): Promise<{ session: IRouterAuthSessionResponse }> {
  const baseUrl = `http://${routerAddress.host}:${routerAddress.port}`;
  const challengeRequest: IRouterAuthChallengeRequest = {
    role,
    authAccountId: (authAccount ?? account).address,
  };
  Object.assign(challengeRequest, restore);
  const challengeResponse = await fetch(`${baseUrl}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JsonExt.stringify(challengeRequest),
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
  return { session };
}

function createOpenInviteBody(inviteCode: string, member: KeyringPair, authAccount: KeyringPair) {
  const authBindingExpiresAt = Date.now() + 60_000;
  const binding = {
    inviteCode,
    accountId: member.address,
    authAccountId: authAccount.address,
    expiresAt: authBindingExpiresAt,
  };

  return {
    defaultAccountId: member.address,
    authAccountId: authAccount.address,
    authBindingExpiresAt,
    authBindingSignature: signRouterAuthAccountBinding(member, binding),
  };
}

function createRequestOperationsUpgradeBody(
  member: KeyringPair,
  authAccount: KeyringPair,
  operationalAccount: KeyringPair,
) {
  const authBindingExpiresAt = Date.now() + 60_000;
  const binding = {
    accountId: member.address,
    operationalAccountId: operationalAccount.address,
    authAccountId: authAccount.address,
    expiresAt: authBindingExpiresAt,
  };

  return {
    operationalAccountId: operationalAccount.address,
    authBindingExpiresAt,
    authBindingSignature: signRouterAuthAccountBinding(member, binding),
  };
}

function insertMemberInvite(
  db: RouterDb,
  args: {
    inviteCode: string;
    name: string;
    fromName: string;
  },
) {
  const user = db.usersTable.insertUser({
    role: UserRole.Member,
    name: args.name,
  });

  return db.userInvitesTable.insertInvite(user.id, args.inviteCode, args.fromName);
}

function listMemberInvites(db: RouterDb) {
  return db.userInvitesTable.fetchByRole(UserRole.Member);
}

function insertCoupon(
  db: RouterDb,
  args: {
    userId: number;
    offerCode: string;
    vaultId: number;
    maxSatoshis: bigint;
    estimatedGiftUsd: number;
    btcPctFee: number;
    feeCreditMicrogons?: bigint;
    expiresAfterTicks?: number;
    expirationTick?: number;
    accountId?: string;
    createdAt?: Date;
  },
): IBitcoinLockCouponStatus['coupon'] {
  const createdAt = args.createdAt ?? new Date('2026-06-20T12:00:00.000Z');
  const coupon = db.bitcoinLockCouponsTable.restore({
    ...args,
    sequence: 1,
    expiresAfterTicks: args.expiresAfterTicks ?? 60,
    createdAt,
    updatedAt: createdAt,
  });
  return coupon;
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

function withSessionId(path: string, sessionId: string): string {
  const url = new URL(path, 'http://localhost');
  url.searchParams.set('sessionId', sessionId);

  if (path.startsWith('http')) {
    return url.toString();
  }

  return `${url.pathname}${url.search}`;
}
