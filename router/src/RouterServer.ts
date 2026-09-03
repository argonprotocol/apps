import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import {
  type ArgonClient,
  createArgonClient,
  JsonExt,
  NetworkConfig,
  UserRole,
  type IEthereumGatewayCatchUpRequest,
  type IEthereumGatewayCatchUpResponse,
  type IEthereumGatewayRelayStatus,
  getBootstrapEndpointPubkey,
} from '@argonprotocol/apps-core';
import { getClient, u8aToHex } from '@argonprotocol/mainchain';
import { ArgonApis } from './ArgonApis.ts';
import { BitcoinApis } from './BitcoinApis.ts';
import { BitcoinLockCouponService } from './BitcoinLockCouponService.ts';
import { BotUpstreamClient } from './BotUpstreamClient.ts';
import {
  ADMIN_OPERATOR_ACCOUNT_ID,
  BITCOIN_CONFIG,
  ROUTER_AUTH_SESSION_TTL_SECONDS,
  ROUTER_BOOTSTRAP_ENDPOINT_SECRET,
  ROUTER_RESTORE_KEY,
  SERVER_ROOT,
} from './env.ts';
import type { Db } from './Db.ts';
import { MemberRestoreService } from './MemberRestoreService.ts';
import { RouterError } from './RouterError.ts';
import { RouterAuthService, type IRouterAuthServiceOptions } from './RouterAuthService.ts';
import { UserInviteService } from './UserInviteService.ts';
import type { IUserInviteRecord } from './db/UserInvitesTable.ts';
import type {
  IBitcoinLockCouponRequest,
  IBitcoinLockCouponUseUpdateRequest,
  IBitcoinLockStatusResponse,
  ICreateInviteRequest,
  IInitializeBitcoinLockResponse,
  IUpdateBitcoinLockCouponExpirationRequest,
  IInviteResponse,
  IListBitcoinLockCouponsResponse,
  IListInvitesResponse,
  IMarkOperationsUpgradedRequest,
  IOpenInviteRequest,
  IOpenInviteResponse,
  IPreviewInviteResponse,
  IRegenerateInviteRequest,
  IRequestOperationsUpgradeRequest,
  IRequestOperationsUpgradeResponse,
  IRouterAuthChallengeRequest,
  IRouterAuthSessionRequest,
  IRouterAuthSessionResponse,
  IRouterErrorResponse,
} from './interfaces/index.ts';

type IRouterServerAuthOptions = Omit<IRouterAuthServiceOptions, 'db' | 'memberRestore'> & {
  restoreKey?: string;
  bootstrapEndpointSecret?: string;
};

interface IRouterServerOptions {
  db: Db;
  botInternalUrl: string;
  botDbPath?: string;
  port?: number | string;
  localNodeUrl?: string;
  mainNodeUrl?: string;
  auth?: IRouterServerAuthOptions;
}

export class RouterServer {
  private server!: Server;
  private readonly listeningPromise: Promise<void>;
  private mainchainClientPromise?: Promise<ArgonClient>;
  private resolveListening!: () => void;
  private rejectListening!: (error: Error) => void;

  constructor(private readonly options: IRouterServerOptions) {
    this.listeningPromise = new Promise<void>((resolve, reject) => {
      this.resolveListening = resolve;
      this.rejectListening = reject;
    });
  }

  public start(): void {
    const app = express();
    const { botInternalUrl, db } = this.options;
    const botClient = new BotUpstreamClient(botInternalUrl);
    const inviteService = new UserInviteService(db);
    const mainchainNodeUrl = this.options.mainNodeUrl ?? this.options.localNodeUrl;
    const adminOperatorAccountId =
      this.options.auth?.adminOperatorAccountId?.trim() || ADMIN_OPERATOR_ACCOUNT_ID?.trim();
    const {
      restoreKey = ROUTER_RESTORE_KEY,
      bootstrapEndpointSecret: configuredBootstrapEndpointSecret = ROUTER_BOOTSTRAP_ENDPOINT_SECRET,
      ...authOptions
    } = this.options.auth ?? {};
    const bootstrapEndpointSecret = configuredBootstrapEndpointSecret?.trim();
    const currentBootstrapEndpointPubkey = bootstrapEndpointSecret
      ? u8aToHex(getBootstrapEndpointPubkey(bootstrapEndpointSecret))
      : undefined;
    const getMainchainClient = async () => {
      if (!mainchainNodeUrl) {
        throw new RouterError('A mainchain node is required.', 503);
      }

      this.mainchainClientPromise ??= getClient(mainchainNodeUrl, { throwOnConnect: true })
        .then(createArgonClient)
        .catch(error => {
          this.mainchainClientPromise = undefined;
          throw error;
        });
      return await this.mainchainClientPromise;
    };
    const bitcoinLockCouponService = new BitcoinLockCouponService({
      db,
      botClient,
      getMainchainClient,
      legacyBotDbPath: this.options.botDbPath,
    });
    void bitcoinLockCouponService
      .reconcile()
      .catch(error => console.warn('[router] Unable to reconcile Bitcoin fee coupon uses.', error));
    const memberRestore = new MemberRestoreService({ db, restoreKey });
    const routerAuth = new RouterAuthService({
      db,
      sessionTtlSeconds: ROUTER_AUTH_SESSION_TTL_SECONDS ? Number(ROUTER_AUTH_SESSION_TTL_SECONDS) : undefined,
      ...authOptions,
      adminOperatorAccountId,
      memberRestore,
    });
    routerAuth.pruneInactiveSessions();

    const requireAdminOperatorAuth = routerAuth.requireAdminOperator();
    const toTreasuryUserInvite = (invite: IUserInviteRecord) => {
      const inviteRecord = { ...invite };
      delete inviteRecord.operationsAccessProofSignature;

      return {
        ...inviteRecord,
        accessProof: inviteService.getInviteAccessProof(invite, adminOperatorAccountId),
      };
    };

    app.use((req, res, next) => {
      const requestOrigin = req.headers.origin;
      res.setHeader('Access-Control-Allow-Origin', requestOrigin ?? '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (requestOrigin) {
        res.setHeader('Vary', 'Origin');
      }

      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }

      next();
    });

    app.get(
      '/',
      safeJsonRoute(async () => ({
        status: 'ok',
        localNodeUrl: this.options.localNodeUrl,
        mainNodeUrl: this.options.mainNodeUrl,
        bitcoinConfig: BITCOIN_CONFIG,
        serverRoot: SERVER_ROOT,
        authEnabled: routerAuth.isEnabled,
      })),
    );

    app.post(
      '/auth/challenge',
      express.text({ type: '*/*' }),
      safeJsonRoute(async req => {
        const { authAccountId, role, hasRestorePackage, restorePackageRevision, knownBootstrapEndpointPubkey } =
          requireBody<IRouterAuthChallengeRequest>(req);
        const restorePackageRequired = role === UserRole.Member && memberRestore.isPackageRequired(authAccountId);

        return routerAuth.createChallenge(authAccountId, role, {
          restorePackageRequired,
          hasRestorePackage,
          restorePackageRevision,
          bootstrapEndpointSecretRequired:
            role === UserRole.Member &&
            !!currentBootstrapEndpointPubkey &&
            currentBootstrapEndpointPubkey !== knownBootstrapEndpointPubkey,
        });
      }),
    );

    app.post(
      '/auth/login',
      express.text({ type: '*/*' }),
      safeJsonRoute<IRouterAuthSessionResponse>(async req => {
        const { session, refreshRestorePackage, includeBootstrapEndpointSecret } = await routerAuth.createSession(
          requireBody<IRouterAuthSessionRequest>(req),
        );
        if (includeBootstrapEndpointSecret && bootstrapEndpointSecret) {
          session.bootstrapEndpointSecret = bootstrapEndpointSecret;
        }
        if (session.role !== UserRole.Member || !memberRestore.isEnabled || !refreshRestorePackage) {
          return session;
        }

        const invite = db.userInvitesTable.fetchByDefaultAccountId(session.accountId, UserRole.Member);
        if (!invite) {
          throw new RouterError('Invite not found', 404);
        }

        try {
          const bitcoinLockCoupons = await bitcoinLockCouponService.getByUserId(invite.id);
          const bitcoinLockCoupon = bitcoinLockCoupons[0];
          const restorePackage = memberRestore.createPackage(invite, bitcoinLockCoupon);

          session.restore = {
            fromName: invite.fromName,
            operatorAccountId: adminOperatorAccountId!,
            restorePackage,
            restorePackageRevision: memberRestore.getPackageRevision(invite.authAccountId!)!,
            hasOperationsAccess: !!(invite.operationsUpgradedAt || invite.operationsAccessProofSignature),
            bitcoinLockCoupons,
          };
        } catch (error) {
          console.warn('[router] Unable to refresh the member restore package.', error);
        }

        return session;
      }),
    );

    app.get('/auth/verify/admin', (req, res) => {
      routerAuth.handleVerify(req, res, [UserRole.AdminOperator]);
    });

    app.get('/auth/verify/bot', (req, res) => {
      routerAuth.handleVerify(req, res, [UserRole.AdminOperator]);
    });

    app.get('/auth/verify/substrate', (req, res) => {
      routerAuth.handleVerify(req, res, [UserRole.AdminOperator, UserRole.Member]);
    });

    app.get('/auth/verify/member', (req, res) => {
      routerAuth.handleVerify(req, res, [UserRole.Member]);
    });

    app.get(
      '/argon/iscomplete',
      safeJsonRoute(async (_req, res) => {
        const response = await ArgonApis.isComplete();
        sendJson(res, response, typeof response === 'boolean' ? 200 : 500);
      }),
    );

    app.get(
      '/argon/latestblocks',
      safeJsonRoute(async () => ArgonApis.latestBlocks()),
    );
    app.get(
      '/argon/syncstatus',
      safeJsonRoute(async () => ArgonApis.syncStatus()),
    );
    app.get(
      '/bitcoin/getblockchaininfo',
      safeJsonRoute(async () => BitcoinApis.blockchainInfo()),
    );
    app.get(
      '/bitcoin/latestblocks',
      safeJsonRoute(async () => BitcoinApis.latestBlocks()),
    );
    app.get(
      '/bitcoin/syncstatus',
      safeJsonRoute(async () => BitcoinApis.syncStatus()),
    );
    app.get(
      '/bot-sync-status',
      safeJsonRoute(async () => botClient.getSyncStatus()),
    );
    app.get(
      '/bitcoin/recentblocks',
      safeJsonRoute(async req => {
        const requestedBlockCount = Number(String(req.query.blockCount ?? '10'));
        const blockCount = Number.isFinite(requestedBlockCount)
          ? Math.min(Math.max(Math.floor(requestedBlockCount), 1), 100)
          : 10;
        return BitcoinApis.recentBlocks(blockCount);
      }),
    );

    app.post(
      '/invites/create',
      requireAdminOperatorAuth,
      express.text({ type: '*/*' }),
      safeJsonRoute<IInviteResponse>(async req => {
        const body = requireBody<ICreateInviteRequest>(req);
        const btcPctFee = validateInviteCouponRequest(body);
        const { name, fromName, ...couponRequest } = body;

        const invite = inviteService.createInvite({
          name,
          fromName,
        });

        let bitcoinLockCoupon;
        try {
          bitcoinLockCoupon = await bitcoinLockCouponService.create({
            ...couponRequest,
            userId: invite.id,
            btcPctFee,
          });
        } catch (error) {
          try {
            inviteService.deleteInvitedUser(invite.id);
          } catch (cleanupError) {
            console.error('Failed to roll back invite after coupon creation error:', cleanupError);
          }

          throw error;
        }

        return {
          invite: {
            ...invite,
            vaultId: body.vaultId,
            bitcoinLockCoupon,
          },
        };
      }),
    );

    app.post(
      '/invites/:inviteCode/regenerate',
      requireAdminOperatorAuth,
      express.text({ type: '*/*' }),
      safeJsonRoute<IInviteResponse>(async req => {
        const body = requireBody<IRegenerateInviteRequest>(req);
        const btcPctFee = validateInviteCouponRequest(body);
        const inviteCode = req.params.inviteCode;
        const invite = db.userInvitesTable.fetchByCode(inviteCode, UserRole.Member);
        if (!invite) {
          throw new RouterError('Invite not found', 404);
        }

        const latestCoupon = (await bitcoinLockCouponService.getLatestByUserId()).get(invite.id);
        if (latestCoupon?.status !== 'Expired') {
          throw new RouterError('Only expired invites can be regenerated.', 409);
        }

        const regenerated = await inviteService.regenerateInvite({
          inviteCode,
          createReplacementCoupon: replacementInvite =>
            bitcoinLockCouponService.create({
              ...body,
              userId: replacementInvite.id,
              btcPctFee,
            }),
        });

        return {
          invite: {
            ...toTreasuryUserInvite(regenerated.invite),
            bitcoinLockCoupon: regenerated.coupon,
          },
        };
      }),
    );

    app.get(
      '/invites/:inviteCode/preview',
      safeJsonRoute<IPreviewInviteResponse>(async req => {
        const invite = db.userInvitesTable.fetchByCode(req.params.inviteCode, UserRole.Member);
        if (!invite) {
          throw new RouterError('Invite not found', 404);
        }
        if (invite.defaultAccountId) {
          throw new RouterError('This invite has already been used.', 409, 'ALREADY_USED');
        }

        const [bitcoinLockCoupon] = await bitcoinLockCouponService.getByUserId(invite.id);
        if (!bitcoinLockCoupon) {
          throw new RouterError('Bitcoin lock coupon not found.', 404);
        }

        const { coupon } = bitcoinLockCoupon;
        return {
          maxSatoshis: coupon.maxSatoshis,
          estimatedGiftUsd: coupon.estimatedGiftUsd,
          ...(coupon.feeCreditMicrogons != null ? { feeCreditMicrogons: coupon.feeCreditMicrogons } : {}),
          btcPctFee: coupon.btcPctFee,
          expiresAfterTicks: coupon.expiresAfterTicks,
          // Older invite pages require an absolute date; before acceptance this is the deadline if accepted now.
          expiresAt:
            bitcoinLockCoupon.expiresAt ?? new Date(Date.now() + coupon.expiresAfterTicks * NetworkConfig.tickMillis),
          fromName: invite.fromName,
        };
      }),
    );

    app.post(
      '/invites/:inviteCode/open',
      express.text({ type: '*/*' }),
      safeJsonRoute<IOpenInviteResponse>(async req => {
        if (!adminOperatorAccountId) {
          throw new RouterError('Router operator account is not configured.', 500);
        }

        const { defaultAccountId, authAccountId, authBindingExpiresAt, authBindingSignature } =
          requireBody<IOpenInviteRequest>(req);
        const inviteCode = req.params.inviteCode;

        const invite = inviteService.claimInvite({
          inviteCode,
          defaultAccountId,
          authBinding: {
            accountId: defaultAccountId,
            authAccountId,
            inviteCode,
            expiresAt: authBindingExpiresAt,
          },
          authBindingSignature,
        });
        if (!invite) {
          throw new RouterError('Invite not found', 404);
        }

        const bitcoinLockCoupon = await bitcoinLockCouponService.activateLatest(invite.id, defaultAccountId);

        return {
          fromName: invite.fromName,
          operatorAccountId: adminOperatorAccountId,
          referrer: adminOperatorAccountId,
          invite: {
            ...toTreasuryUserInvite(invite),
            vaultId: bitcoinLockCoupon.coupon.vaultId,
            bitcoinLockCoupon,
          },
        };
      }),
    );

    app.get(
      '/invites',
      requireAdminOperatorAuth,
      safeJsonRoute<IListInvitesResponse>(async () => {
        const couponsByUserId = await bitcoinLockCouponService.getLatestByUserId();
        const invites = db.userInvitesTable.fetchByRole(UserRole.Member);

        return {
          invites: invites.map(invite => ({
            ...toTreasuryUserInvite(invite),
            bitcoinLockCoupon: couponsByUserId.get(invite.id),
          })),
        };
      }),
    );

    app.get(
      '/invites/me',
      safeJsonRoute<IInviteResponse>(async req => {
        const session = routerAuth.requireMemberSession(req);
        const invite = db.userInvitesTable.fetchByDefaultAccountId(session.accountId, UserRole.Member);
        if (!invite) {
          throw new RouterError('Invite not found', 404);
        }

        return {
          invite: toTreasuryUserInvite(invite),
        };
      }),
    );

    app.post(
      '/invites/me/request-operations-upgrade',
      express.text({ type: '*/*' }),
      safeJsonRoute<IRequestOperationsUpgradeResponse>(async req => {
        const session = routerAuth.requireMemberSession(req);
        const invite = db.userInvitesTable.fetchByDefaultAccountId(session.accountId, UserRole.Member);
        if (!invite?.authAccountId) {
          throw new RouterError('Invite not found', 404);
        }

        const { operationalAccountId, authBindingExpiresAt, authBindingSignature } =
          requireBody<IRequestOperationsUpgradeRequest>(req);

        const requestedInvite = inviteService.requestOperationsUpgrade({
          defaultAccountId: session.accountId,
          authBinding: {
            accountId: session.accountId,
            operationalAccountId,
            authAccountId: invite.authAccountId,
            expiresAt: authBindingExpiresAt,
          },
          authBindingSignature,
        });

        return {
          operationsUpgradeRequestedAt: requestedInvite.operationsUpgradeRequestedAt!,
        };
      }),
    );

    app.post(
      '/invites/:inviteCode/mark-operations-upgraded',
      requireAdminOperatorAuth,
      express.text({ type: '*/*' }),
      safeJsonRoute<IInviteResponse>(async req => {
        if (!adminOperatorAccountId) {
          throw new RouterError('Router operator account is not configured.', 500);
        }

        const body = requireBody<IMarkOperationsUpgradedRequest>(req);
        const approvedOperationalAccountIds = db.userInvitesTable
          .fetchByRole(UserRole.Member)
          .flatMap(invite =>
            invite.operationsAccessProofSignature && invite.operationalAccountId ? [invite.operationalAccountId] : [],
          );
        const client = await getMainchainClient();
        const operationalAccounts = await client.query.operationalAccounts.operationalAccounts.multi([
          adminOperatorAccountId,
          ...approvedOperationalAccountIds,
        ]);
        const upstreamAccount = operationalAccounts[0];
        if (!upstreamAccount) {
          throw new RouterError('The router operator has not registered an operational account.', 409);
        }

        const registeredOperationalAccountIds = new Set(
          approvedOperationalAccountIds.filter((_, index) => !!operationalAccounts[index + 1]),
        );
        const invite = inviteService.markOperationsUpgraded({
          inviteCode: req.params.inviteCode,
          accessProof: {
            upstreamAccount: adminOperatorAccountId,
            signature: body.signature,
          },
          accessCodeCapacity: {
            availableAccessCodes: upstreamAccount.availableAccessCodes,
            registeredOperationalAccountIds,
          },
        });
        if (!invite) {
          throw new RouterError('Invite not found', 404);
        }

        return { invite: toTreasuryUserInvite(invite) };
      }),
    );

    app.get(
      '/bitcoin-lock-coupons',
      requireAdminOperatorAuth,
      safeJsonRoute<IListBitcoinLockCouponsResponse>(async () => {
        return {
          bitcoinLockCoupons: await bitcoinLockCouponService.getAll(),
        };
      }),
    );

    app.get(
      '/bitcoin-lock-coupons/:offerCode',
      safeJsonRoute<IBitcoinLockStatusResponse>(async req => {
        return {
          bitcoinLock: await bitcoinLockCouponService.getByOfferCode(req.params.offerCode),
        };
      }),
    );

    app.post(
      '/bitcoin-lock-coupons/:offerCode/initialize',
      express.text({ type: '*/*' }),
      safeJsonRoute<IInitializeBitcoinLockResponse>(async req => {
        const body = requireBody<IBitcoinLockCouponRequest>(req);
        routerAuth.requireMemberSession(req, body.ownerAccountId);

        if (body.microgonsAtTargetPerBtc == null) {
          throw new RouterError('A current bitcoin price quote is required to initialize this bitcoin lock.');
        }

        const authorization = await bitcoinLockCouponService.authorizeInitialization(req.params.offerCode, body);
        return {
          bitcoinLock: authorization.status,
          execution: {
            type: 'FeeCoupon',
            requestId: authorization.use.requestId,
            feeCoupon: authorization.use.feeCoupon!,
          },
        };
      }),
    );

    app.post(
      '/bitcoin-lock-coupon-uses/:requestId',
      express.text({ type: '*/*' }),
      safeJsonRoute<IBitcoinLockStatusResponse>(async req => {
        const session = routerAuth.requireMemberSession(req);
        if (!session.accountId) throw new RouterError('A member account is required.', 403);
        const body = requireBody<IBitcoinLockCouponUseUpdateRequest>(req);
        if (body.status !== 'Finalized' && body.status !== 'Failed') {
          throw new RouterError('A valid Bitcoin fee coupon use status is required.', 400);
        }
        return {
          bitcoinLock: await bitcoinLockCouponService.reportFeeCouponUse(req.params.requestId, session.accountId),
        };
      }),
    );

    app.post(
      '/bitcoin-lock-coupons/:offerCode/expiration',
      requireAdminOperatorAuth,
      express.text({ type: '*/*' }),
      safeJsonRoute<IBitcoinLockStatusResponse>(async req => {
        const body = requireBody<IUpdateBitcoinLockCouponExpirationRequest>(req);
        return {
          bitcoinLock: await bitcoinLockCouponService.updateExpiration(req.params.offerCode, body.expiresAfterTicks),
        };
      }),
    );

    app.get(
      '/invites/me/bitcoin-lock-coupons',
      safeJsonRoute<IListBitcoinLockCouponsResponse>(async req => {
        const session = routerAuth.requireMemberSession(req);
        if (!session.accountId) {
          return {
            bitcoinLockCoupons: [],
          };
        }

        const invite = db.userInvitesTable.fetchByDefaultAccountId(session.accountId, UserRole.Member);
        if (!invite) {
          return {
            bitcoinLockCoupons: [],
          };
        }

        return {
          bitcoinLockCoupons: await bitcoinLockCouponService.getByUserId(invite.id),
        };
      }),
    );

    app.get(
      '/ethereum-relay-status',
      safeJsonRoute<IEthereumGatewayRelayStatus>(async req => {
        routerAuth.requireSession(req, [UserRole.AdminOperator, UserRole.Member]);

        return await botClient.getEthereumGatewayRelayStatus().catch(error => {
          if (error instanceof RouterError) {
            throw new RouterError(error.message || 'Bot request failed to load Ethereum relay status.', error.status);
          }
          throw error;
        });
      }),
    );

    app.post(
      '/ethereum-relay-request',
      express.text({ type: '*/*' }),
      safeJsonRoute<IEthereumGatewayCatchUpResponse>(async req => {
        routerAuth.requireSession(req, [UserRole.AdminOperator, UserRole.Member]);

        return await botClient
          .requestEthereumGatewayCatchUp(requireBody<IEthereumGatewayCatchUpRequest>(req))
          .catch(error => {
            if (error instanceof RouterError) {
              throw new RouterError(
                error.message || 'Bot request failed to catch up Ethereum gateway activity.',
                error.status,
              );
            }
            throw error;
          });
      }),
    );

    app.use((_req, res) => {
      res.status(404).send('Not Found');
    });

    this.server = app.listen(this.options.port ?? 0, () => {
      console.log(
        `Router server is running on port ${(this.server.address() as { port?: number } | null)?.port ?? this.options.port}`,
      );
      this.resolveListening();
    });
    this.server.once('error', error => {
      this.rejectListening(error);
    });
  }

  public async waitForListening(): Promise<void> {
    return this.listeningPromise;
  }

  public getAddress(): { host: string; port: number } {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      return { host: '127.0.0.1', port: Number(this.options.port) || 0 };
    }

    const host = address.address === '::' ? '127.0.0.1' : address.address;
    return { host, port: address.port };
  }

  public async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close(err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    await this.mainchainClientPromise
      ?.then(client => client.disconnect().catch(() => undefined))
      .catch(() => undefined);
  }
}

function sendJson(res: Response, data: unknown, status = 200): void {
  res.status(status).type('application/json').send(JsonExt.stringify(data));
}

function requireBody<T>(req: Request): T {
  const rawBody = req.body;
  if (!rawBody) {
    throw new RouterError('Missing JSON body', 400);
  }

  return JsonExt.parse<T>(String(rawBody));
}

function validateInviteCouponRequest(body: IRegenerateInviteRequest): number {
  if (body.expiresAfterTicks <= 0) {
    throw new RouterError('Invite expiry must be greater than zero.');
  }
  if (body.vaultId <= 0) {
    throw new RouterError('A vault is required to create an invite.');
  }
  if (!Number.isFinite(body.estimatedGiftUsd) || body.estimatedGiftUsd < 0) {
    throw new RouterError('Estimated gift USD must be a valid non-negative number.');
  }

  const btcPctFee = body.btcPctFee ?? 0;
  if (!Number.isFinite(btcPctFee) || btcPctFee < 0) {
    throw new RouterError('BTC percent fee must be a valid non-negative number.');
  }

  return btcPctFee;
}

function safeJsonRoute<T>(
  handler: (req: Request, res: Response) => Promise<T | undefined> | T | undefined,
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      const data = await handler(req, res);
      if (!res.headersSent) {
        sendJson(res, data);
      }
    } catch (error) {
      console.error('Route error:', error);

      const status = error instanceof RouterError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof RouterError ? error.code : undefined;
      const minimumDesktopVersion = error instanceof RouterError ? error.minimumDesktopVersion : undefined;

      if (!res.headersSent) {
        const response: IRouterErrorResponse = { error: message };
        if (code) response.code = code;
        if (minimumDesktopVersion) response.minimumDesktopVersion = minimumDesktopVersion;
        sendJson(res, response, status);
      }
    }
  };
}
