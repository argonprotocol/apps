import * as Fs from 'node:fs';
import * as Http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOperationalAccessProof,
  JsonExt,
  NetworkConfig,
  signRouterAuthAccountBinding,
  signRouterAuthChallenge,
  UserRole,
  type IEthereumGatewayCatchUpResponse,
  type IEthereumGatewayRelayStatus,
  type RouterAuthRole,
} from '@argonprotocol/apps-core';
import { getOfflineRegistry, Keyring, type KeyringPair } from '@argonprotocol/mainchain';
import { Db as RouterDb } from '../src/Db.ts';
import { RouterServer } from '../src/RouterServer.ts';
import type {
  IBitcoinLockCouponStatus,
  IInviteResponse,
  IListBitcoinLockCouponsResponse,
  IListInvitesResponse,
  IOpenInviteResponse,
  IPreviewInviteResponse,
  IRouterAuthSessionResponse,
} from '../src/interfaces/index.ts';
import type { IRouterAuthServiceOptions } from '../src/RouterAuthService.ts';

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

  it('rolls back invite rows when coupon creation fails', async () => {
    routerDb = createDb('router-server-create-rollback-');

    const started = await startRouterServer(routerDb, request => {
      if (request.method === 'POST' && request.path === '/bitcoin-lock-coupons') {
        return {
          status: 500,
          body: { error: 'Bot coupon creation failed.' },
        };
      }

      return {
        status: 404,
        body: { error: 'Not Found' },
      };
    });
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await requestJson(started.routerAddress, '/invites/create', {
      name: 'Casey',
      fromName: 'Operator One',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAfterTicks: 60,
    });

    expect(response.status).toBe(500);
    expect(listMemberInvites(routerDb)).toEqual([]);
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

    const coupon = createCouponStatus({
      userId: newerInvite.id,
      offerCode: 'offer-code-2',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
    });

    const started = await startRouterServer(routerDb, request => {
      if (request.method === 'GET' && request.path === '/bitcoin-lock-coupons') {
        return {
          status: 200,
          body: [coupon],
        };
      }

      return {
        status: 404,
        body: { error: 'Not Found' },
      };
    });
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await fetch(`http://${started.routerAddress.host}:${started.routerAddress.port}/invites`);
    expect(response.status).toBe(200);

    const body = JsonExt.parse<IListInvitesResponse>(await response.text());
    expect(body.invites.map(x => x.inviteCode)).toEqual([newerInvite.inviteCode, olderInvite.inviteCode]);
    expect(body.invites[0].vaultId).toBeUndefined();
    expect(body.invites[0].bitcoinLockCoupon).toEqual(coupon);
    expect(body.invites[1].bitcoinLockCoupon).toBeUndefined();
  });

  it('loads vault bonds once and reuses each member bitcoin state when listing invite progress', async () => {
    routerDb = createDb('router-server-list-invite-progress-');

    const memberOne = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMemberOne');
    const memberTwo = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMemberTwo');
    const inviteOne = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    const inviteTwo = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-2',
      name: 'Riley',
      fromName: 'Operator One',
    });
    routerDb.userInvitesTable.claimInvite(inviteOne.id, memberOne.address, memberOne.address);
    routerDb.userInvitesTable.claimInvite(inviteTwo.id, memberTwo.address, memberTwo.address);

    const coupons = [
      createCouponStatus({
        userId: inviteOne.id,
        offerCode: 'offer-code-1',
        vaultId: 12,
        maxSatoshis: 25_000n,
        estimatedGiftUsd: 16.25,
        btcPctFee: 2.5,
      }),
      createCouponStatus({
        userId: inviteTwo.id,
        offerCode: 'offer-code-2',
        vaultId: 12,
        maxSatoshis: 25_000n,
        estimatedGiftUsd: 16.25,
        btcPctFee: 2.5,
      }),
    ];
    const registry = getOfflineRegistry();
    const bondLots = new Map([
      [
        1,
        registry.createType('PalletTreasuryBondLot', {
          owner: memberOne.address,
          program: { Vault: { vaultId: 12, sharingPercent: 0, bonusPercent: 0 } },
          bonds: 3,
        }),
      ],
      [
        2,
        registry.createType('PalletTreasuryBondLot', {
          owner: memberTwo.address,
          program: { Vault: { vaultId: 12, sharingPercent: 0, bonusPercent: 0 } },
          bonds: 5,
        }),
      ],
    ]);
    const bondLotsByVault = vi.fn().mockResolvedValue([
      { bondLotId: registry.createType('u64', 1) },
      { bondLotId: registry.createType('u64', 2) },
    ]);
    const bondLotIdsByAccount = vi.fn(async (accountId: string) => {
      const id = accountId === memberOne.address ? 1 : 2;
      return [{ args: [null, registry.createType('u64', id)] }];
    });
    const utxoIdsByOwnerAccount = vi.fn(async (accountId: string) => {
      const id = accountId === memberOne.address ? 101 : 102;
      return [{ args: [null, registry.createType('u64', id)] }];
    });
    mainchainMocks.getClient.mockResolvedValue({
      disconnect: vi.fn().mockResolvedValue(undefined),
      consts: {
        operationalAccounts: {
          minimumBitcoin: registry.createType('u128', 1),
          minimumBonds: registry.createType('u128', 1),
          minimumUniswapTransfer: registry.createType('u128', 1),
          operationalMinimumUniswapTransfer: registry.createType('u128', 1),
          operationalMinimumVaultSecuritization: registry.createType('u128', 1),
          miningSeatsForOperational: registry.createType('u32', 2),
        },
      },
      query: {
        operationalAccounts: {
          operationalAccountBySubAccount: {
            multi: vi.fn(async (accountIds: string[]) => accountIds.map(() => ({ isSome: false }))),
          },
        },
        treasury: {
          bondLotsByVault,
          bondLotIdsByAccount: { keys: bondLotIdsByAccount },
          bondLotById: {
            multi: vi.fn(async (ids: number[]) => {
              return ids.map(id => ({
                isSome: true,
                unwrap: () => bondLots.get(id),
              }));
            }),
          },
        },
        bitcoinLocks: {
          utxoIdsByOwnerAccount: { keys: utxoIdsByOwnerAccount },
          locksByUtxoId: {
            multi: vi.fn(async (ids: number[]) => {
              return ids.map(id => ({
                isSome: true,
                unwrap: () => ({
                  vaultId: registry.createType('u32', 12),
                  liquidityPromised: registry.createType('u128', id === 101 ? 7 : 11),
                  isFunded: { toJSON: () => true },
                }),
              }));
            }),
          },
        },
        crosschainTransfer: {
          transferTotalsByAccount: vi.fn().mockResolvedValue({
            microgonsIn: registry.createType('u128', 1),
          }),
        },
      },
    });

    const started = await startRouterServer(
      routerDb,
      request => {
        if (request.method === 'GET' && request.path === '/bitcoin-lock-coupons') {
          return { status: 200, body: coupons };
        }

        return { status: 404, body: { error: 'Not Found' } };
      },
      { mainNodeUrl: 'ws://mainchain.test' },
    );
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await fetch(`http://${started.routerAddress.host}:${started.routerAddress.port}/invites`);
    expect(response.status).toBe(200);

    const body = JsonExt.parse<IListInvitesResponse>(await response.text());
    const invitesByCode = new Map(body.invites.map(invite => [invite.inviteCode, invite]));
    expect(invitesByCode.get(inviteOne.inviteCode)?.vaultContribution).toEqual({
      bitcoinAmount: 7n,
      bondAmount: 3n * 1_000_000n,
    });
    expect(invitesByCode.get(inviteTwo.inviteCode)?.vaultContribution).toEqual({
      bitcoinAmount: 11n,
      bondAmount: 5n * 1_000_000n,
    });
    expect(bondLotsByVault).toHaveBeenCalledTimes(1);
    expect(bondLotIdsByAccount).toHaveBeenCalledTimes(2);
    expect(utxoIdsByOwnerAccount).toHaveBeenCalledTimes(2);
  });

  it('regenerates an expired invite in place', async () => {
    routerDb = createDb('router-server-regenerate-invite-');

    const invite = insertMemberInvite(routerDb, {
      inviteCode: 'member-invite-1',
      name: 'Casey',
      fromName: 'Operator One',
    });
    const expiredCoupon = {
      ...createCouponStatus({
        userId: invite.id,
        offerCode: 'expired-offer-code',
        vaultId: 12,
        maxSatoshis: 25_000n,
        estimatedGiftUsd: 16.25,
        btcPctFee: 2.5,
      }),
      status: 'Expired' as const,
    };
    let replacementCouponUserId: number | undefined;

    const started = await startRouterServer(routerDb, request => {
      if (request.method === 'GET' && request.path === '/bitcoin-lock-coupons') {
        return { status: 200, body: [expiredCoupon] };
      }
      if (request.method === 'POST' && request.path === '/bitcoin-lock-coupons') {
        const body = request.body as { userId: number };
        replacementCouponUserId = body.userId;
        return {
          status: 200,
          body: createCouponStatus({
            userId: body.userId,
            offerCode: 'replacement-offer-code',
            vaultId: 12,
            maxSatoshis: 25_000n,
            estimatedGiftUsd: 16.25,
            btcPctFee: 2.5,
          }),
        };
      }

      return { status: 404, body: { error: 'Not Found' } };
    });
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await requestJson(
      started.routerAddress,
      `/invites/${invite.inviteCode}/regenerate`,
      {
        vaultId: 12,
        maxSatoshis: 25_000n,
        estimatedGiftUsd: 16.25,
        btcPctFee: 2.5,
        expiresAfterTicks: 60,
      },
    );
    expect(response.status).toBe(200);

    const regeneratedInvite = JsonExt.parse<IInviteResponse>(await response.text()).invite;
    expect(regeneratedInvite.id).toBe(invite.id);
    expect(regeneratedInvite.name).toBe(invite.name);
    expect(regeneratedInvite.inviteCode).not.toBe(invite.inviteCode);
    expect(regeneratedInvite.bitcoinLockCoupon?.coupon.offerCode).toBe('replacement-offer-code');
    expect(replacementCouponUserId).toBe(invite.id);
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
    const createdAt = new Date('2026-06-20T12:00:00.000Z');
    const coupon = createCouponStatus({
      userId: invite.id,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      createdAt,
    });

    const started = await startRouterServer(routerDb, request => {
      if (request.method === 'GET' && request.path === `/bitcoin-lock-coupons/by-user/${invite.id}`) {
        return {
          status: 200,
          body: [coupon],
        };
      }

      return {
        status: 404,
        body: { error: 'Not Found' },
      };
    });
    routerServer = started.routerServer;
    botServer = started.botServer;

    const response = await fetch(
      `http://${started.routerAddress.host}:${started.routerAddress.port}/invites/${encodeURIComponent(invite.inviteCode)}/preview`,
    );
    expect(response.status).toBe(200);

    const body = JsonExt.parse<IPreviewInviteResponse>(await response.text());
    expect(body).toEqual({
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
      expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
      fromName: 'Operator One',
    });
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
    const activatedCoupon = createCouponStatus({
      userId: invite.id,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
    });

    const started = await startRouterServer(routerDb, request => {
      if (request.method === 'POST' && request.path === '/bitcoin-lock-coupons/activate') {
        return {
          status: 200,
          body: activatedCoupon,
        };
      }

      return {
        status: 404,
        body: { error: 'Not Found' },
      };
    }, {
      adminOperatorAccountId: operator.address,
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
    expect(body.referrer).toBe(operator.address);
    expect(body.invite.defaultAccountId).toBe(member.address);
    expect(body.invite.operationalAccountId).toBeFalsy();
    expect(body.invite.accessProof).toBeUndefined();
    expect(body.invite.authAccountId).toBe(memberAuth.address);
    expect(body.invite.vaultId).toBe(12);
    expect(body.invite.bitcoinLockCoupon).toEqual(activatedCoupon);

    const claimedInvite = routerDb.userInvitesTable.fetchByCode(invite.inviteCode);
    expect(claimedInvite?.defaultAccountId).toBe(member.address);
    expect(claimedInvite?.operationalAccountId).toBeFalsy();
    expect(claimedInvite?.authAccountId).toBe(memberAuth.address);
    expect(claimedInvite?.lastClickedAt).toBeTruthy();
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
      withSessionId(`http://${started.routerAddress.host}:${started.routerAddress.port}/auth/verify/admin`, session.sessionId),
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
      withSessionId(`http://${started.routerAddress.host}:${started.routerAddress.port}/auth/verify/substrate`, session.sessionId),
    );
    expect(substrateVerifyResponse.status).toBe(204);
    expect(substrateVerifyResponse.headers.get('x-user-id')).toBe(member.address);
    expect(substrateVerifyResponse.headers.get('x-user-role')).toBe(UserRole.Member);

    const memberVerifyResponse = await fetch(
      withSessionId(`http://${started.routerAddress.host}:${started.routerAddress.port}/auth/verify/member`, session.sessionId),
    );
    expect(memberVerifyResponse.status).toBe(204);

    const adminVerifyResponse = await fetch(
      withSessionId(`http://${started.routerAddress.host}:${started.routerAddress.port}/auth/verify/admin`, session.sessionId),
    );
    expect(adminVerifyResponse.status).toBe(403);

    const listResponse = await fetch(
      withSessionId(`http://${started.routerAddress.host}:${started.routerAddress.port}/invites`, session.sessionId),
    );
    expect(listResponse.status).toBe(403);
  });

  it('requires a matching member session for member coupon routes', async () => {
    routerDb = createDb('router-server-member-coupon-auth-');

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

    const listedCoupon = createCouponStatus({
      userId: invite.id,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 25_000n,
      estimatedGiftUsd: 16.25,
      btcPctFee: 2.5,
    });
    const initializedCoupon = createCouponStatus({
      userId: invite.id,
      offerCode: 'offer-code-1',
      vaultId: 12,
      maxSatoshis: 10_000n,
      estimatedGiftUsd: 6.5,
      btcPctFee: 2.5,
    });

    const started = await startRouterServer(
      routerDb,
      request => {
        if (request.method === 'GET' && request.path === `/bitcoin-lock-coupons/by-user/${invite.id}`) {
          return {
            status: 200,
            body: [listedCoupon],
          };
        }
        if (request.method === 'POST' && request.path === '/bitcoin-lock-coupons/initialize') {
          return {
            status: 200,
            body: initializedCoupon,
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

    const { session } = await login(started.routerAddress, member, UserRole.Member, memberAuth);
    const { session: otherSession } = await login(
      started.routerAddress,
      otherMember,
      UserRole.Member,
      otherMemberAuth,
    );

    const listUrl = `http://${started.routerAddress.host}:${started.routerAddress.port}/invites/me/bitcoin-lock-coupons`;
    const unauthenticatedListResponse = await fetch(listUrl);
    expect(unauthenticatedListResponse.status).toBe(401);

    const authenticatedListResponse = await fetch(withSessionId(listUrl, session.sessionId));
    expect(authenticatedListResponse.status).toBe(200);
    expect(JsonExt.parse<IListBitcoinLockCouponsResponse>(await authenticatedListResponse.text())).toEqual({
      bitcoinLockCoupons: [listedCoupon],
    });

    const initializePath = '/bitcoin-lock-coupons/offer-code-1/initialize';
    const initializeBody = {
      requestedSatoshis: 10_000n,
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
    expect(JsonExt.parse(await authenticatedInitializeResponse.text())).toEqual({
      bitcoinLock: initializedCoupon,
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

    const loadOperationalAccounts = vi.fn(async (accountIds: string[]) => {
      return accountIds.map((accountId, index) => ({
        isSome: index === 0 && accountId === operator.address,
        unwrap: () => ({
          availableAccessCodes: {
            toNumber: () => 1,
          },
        }),
      }));
    });
    mainchainMocks.getClient.mockResolvedValue({
      disconnect: vi.fn().mockResolvedValue(undefined),
      query: {
        operationalAccounts: {
          operationalAccountBySubAccount: {
            multi: vi.fn().mockResolvedValue([{ isSome: false }]),
          },
          operationalAccounts: {
            multi: loadOperationalAccounts,
          },
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
      withSessionId(`http://${started.routerAddress.host}:${started.routerAddress.port}/invites/me`, memberSession.sessionId),
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
      body: JsonExt.stringify(
        createRequestOperationsUpgradeBody(member, memberAuth, operationalAccount),
      ),
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
      body: JsonExt.stringify(
        createRequestOperationsUpgradeBody(member, memberAuth, operationalAccount),
      ),
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
    expect(loadOperationalAccounts).toHaveBeenCalledWith([operator.address]);
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
      withSessionId(`http://${started.routerAddress.host}:${started.routerAddress.port}/ethereum-relay-status`, adminSession.sessionId),
    );
    expect(adminStatusResponse.status).toBe(200);
    expect(JsonExt.parse(await adminStatusResponse.text())).toEqual(relayStatus);

    const memberStatusResponse = await fetch(
      withSessionId(`http://${started.routerAddress.host}:${started.routerAddress.port}/ethereum-relay-status`, memberSession.sessionId),
    );
    expect(memberStatusResponse.status).toBe(200);
    expect(JsonExt.parse(await memberStatusResponse.text())).toEqual(relayStatus);

    const relayBody = {
      sourceChain: 'Ethereum',
      throughGatewayActivityNonce: 7n,
    };

    const unauthenticatedRequestResponse = await requestJson(started.routerAddress, '/ethereum-relay-request', relayBody);
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
  options?: IRouterAuthServiceOptions & { mainNodeUrl?: string },
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
): Promise<{ session: IRouterAuthSessionResponse }> {
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
  return { session };
}

function createOpenInviteBody(
  inviteCode: string,
  member: KeyringPair,
  authAccount: KeyringPair,
) {
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

function createRequestOperationsUpgradeBody(member: KeyringPair, authAccount: KeyringPair, operationalAccount: KeyringPair) {
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

function createCouponStatus(args: {
  userId: number;
  offerCode: string;
  vaultId: number;
  maxSatoshis: bigint;
  estimatedGiftUsd: number;
  btcPctFee: number;
  createdAt?: Date;
}): IBitcoinLockCouponStatus {
  const createdAt = args.createdAt ?? new Date('2026-06-20T12:00:00.000Z');

  return {
    coupon: {
      id: 1,
      userId: args.userId,
      offerCode: args.offerCode,
      vaultId: args.vaultId,
      maxSatoshis: args.maxSatoshis,
      estimatedGiftUsd: args.estimatedGiftUsd,
      btcPctFee: args.btcPctFee,
      expiresAfterTicks: 60,
      createdAt,
      updatedAt: createdAt,
    },
    status: 'Open',
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

function withSessionId(path: string, sessionId: string): string {
  const url = new URL(path, 'http://localhost');
  url.searchParams.set('sessionId', sessionId);

  if (path.startsWith('http')) {
    return url.toString();
  }

  return `${url.pathname}${url.search}`;
}
