import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { JsonExt, UserRole } from '@argonprotocol/apps-core';
import { ArgonApis } from './ArgonApis.ts';
import { BitcoinApis } from './BitcoinApis.ts';
import { BotCouponClient } from './BotCouponClient.ts';
import { ADMIN_OPERATOR_ACCOUNT_ID, BITCOIN_CONFIG, ROUTER_AUTH_SESSION_TTL_SECONDS, SERVER_ROOT } from './env.ts';
import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import { RouterAuthService, type IRouterAuthServiceOptions } from './RouterAuthService.ts';
import { UserInviteService } from './UserInviteService.ts';
import type {
  IBitcoinLockRelayRequest,
  IBitcoinLockStatusResponse,
  ICreateOperationalInviteResponse,
  ICreateTreasuryInviteResponse,
  IListBitcoinLockCouponsResponse,
  IListOperationalInvitesResponse,
  IListTreasuryInvitesResponse,
  IOpenOperationalInviteRequest,
  IOpenOperationalInviteResponse,
  IOpenTreasuryInviteRequest,
  IOpenTreasuryInviteResponse,
  IOperationalUserInviteCreateRequest,
  IRouterAuthChallengeRequest,
  IRouterAuthSessionRequest,
  IRouterAuthSessionResponse,
  ITreasuryUserInviteCreateRequest,
} from './interfaces/index.ts';

interface IRouterServerOptions {
  db: Db;
  botInternalUrl: string;
  port?: number | string;
  localNodeUrl?: string;
  mainNodeUrl?: string;
  auth?: IRouterAuthServiceOptions;
}

export class RouterServer {
  private server!: Server;
  private readonly listeningPromise: Promise<void>;
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
    const botCouponClient = new BotCouponClient(botInternalUrl);
    const inviteService = new UserInviteService(db);
    const routerAuth = new RouterAuthService({
      db,
      adminOperatorAccountId: ADMIN_OPERATOR_ACCOUNT_ID,
      sessionTtlSeconds: ROUTER_AUTH_SESSION_TTL_SECONDS ? Number(ROUTER_AUTH_SESSION_TTL_SECONDS) : undefined,
      ...this.options.auth,
    });
    routerAuth.pruneInactiveSessions();

    const requireAdminOperatorAuth = routerAuth.requireAdminOperator();

    app.use((req, res, next) => {
      const requestOrigin = req.headers.origin;
      res.setHeader('Access-Control-Allow-Origin', requestOrigin ?? '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (requestOrigin) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
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
        const { authAccountId, role } = requireBody<IRouterAuthChallengeRequest>(req);
        return routerAuth.createChallenge(authAccountId, role);
      }),
    );

    app.post(
      '/auth/login',
      express.text({ type: '*/*' }),
      safeJsonRoute<IRouterAuthSessionResponse>(async (req, res) => {
        const { sessionId, ...session } = routerAuth.createSession(requireBody<IRouterAuthSessionRequest>(req));
        routerAuth.setSessionCookie(res, { sessionId });
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
      routerAuth.handleVerify(req, res, [UserRole.AdminOperator, UserRole.TreasuryUser, UserRole.OperationalPartner]);
    });

    app.get('/auth/verify/treasury-coupon', (req, res) => {
      routerAuth.handleVerify(req, res, [UserRole.TreasuryUser]);
    });

    app.get('/auth/verify/operational', (req, res) => {
      routerAuth.handleVerify(req, res, [UserRole.OperationalPartner]);
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
      '/bitcoin/recentblocks',
      safeJsonRoute(async req => {
        const blockCount = Number(String(req.query.blockCount ?? '10'));
        return BitcoinApis.recentBlocks(blockCount);
      }),
    );

    app.post(
      '/treasury-users/create',
      requireAdminOperatorAuth,
      express.text({ type: '*/*' }),
      safeJsonRoute<ICreateTreasuryInviteResponse>(async req => {
        const body = requireBody<ITreasuryUserInviteCreateRequest>(req);
        if (body.expiresAfterTicks <= 0) {
          throw new RouterError('Invite expiry must be greater than zero.');
        }
        if (body.vaultId <= 0) {
          throw new RouterError('A vault is required to create an invite.');
        }

        const userInvite = inviteService.createInvite(UserRole.TreasuryUser, {
          name: body.name,
          fromName: body.fromName,
          inviteCode: body.inviteCode,
        });

        let bitcoinLockCoupon;
        try {
          bitcoinLockCoupon = await botCouponClient.createCoupon({
            userId: userInvite.id,
            vaultId: body.vaultId,
            maxSatoshis: body.maxSatoshis,
            expiresAfterTicks: body.expiresAfterTicks,
          });
        } catch (error) {
          try {
            inviteService.deleteInvitedUser(userInvite.id);
          } catch (cleanupError) {
            console.error('Failed to roll back invite after coupon creation error:', cleanupError);
          }

          throw error;
        }

        return {
          invite: {
            ...userInvite,
            vaultId: body.vaultId,
            bitcoinLockCoupon,
          },
        };
      }),
    );

    app.post(
      '/treasury-users/:inviteCode/open',
      express.text({ type: '*/*' }),
      safeJsonRoute<IOpenTreasuryInviteResponse>(async req => {
        const { accountId, authAccountId, authBindingExpiresAt, authBindingSignature, inviteSignature } =
          requireBody<IOpenTreasuryInviteRequest>(req);
        const inviteCode = req.params.inviteCode;
        const userInvite = inviteService.claimInvite({
          role: UserRole.TreasuryUser,
          inviteCode,
          accountId,
          inviteSignature,
          authBinding: {
            role: UserRole.TreasuryUser,
            accountId,
            authAccountId,
            inviteCode,
            expiresAt: authBindingExpiresAt,
          },
          authBindingSignature,
        });
        if (!userInvite) {
          throw new RouterError('Invite not found', 404);
        }
        const bitcoinLockCoupon = await botCouponClient.activateLatestCoupon({
          userId: userInvite.id,
          accountId,
        });

        return {
          fromName: userInvite.fromName,
          invite: {
            ...userInvite,
            vaultId: bitcoinLockCoupon.coupon.vaultId,
            bitcoinLockCoupon,
          },
        };
      }),
    );

    app.get(
      '/treasury-users/invites',
      requireAdminOperatorAuth,
      safeJsonRoute<IListTreasuryInvitesResponse>(async () => {
        const couponsByUserId = await botCouponClient.listLatestCouponsByUserId();

        return {
          invites: db.userInvitesTable.fetchByRole(UserRole.TreasuryUser).map(user => {
            const bitcoinLockCoupon = couponsByUserId.get(user.id);
            return {
              ...user,
              vaultId: bitcoinLockCoupon?.coupon.vaultId,
              bitcoinLockCoupon,
            };
          }),
        };
      }),
    );

    app.post(
      '/operational-users/create',
      requireAdminOperatorAuth,
      express.text({ type: '*/*' }),
      safeJsonRoute<ICreateOperationalInviteResponse>(async req => {
        const body = requireBody<IOperationalUserInviteCreateRequest>(req);
        const invite = inviteService.createInvite(UserRole.OperationalPartner, {
          name: body.name,
          fromName: body.fromName,
          inviteCode: body.inviteCode,
        });
        return { invite };
      }),
    );

    app.post(
      '/operational-users/:inviteCode/open',
      express.text({ type: '*/*' }),
      safeJsonRoute<IOpenOperationalInviteResponse>(async req => {
        const { accountId, authAccountId, authBindingExpiresAt, authBindingSignature, inviteSignature } =
          requireBody<IOpenOperationalInviteRequest>(req);
        const inviteCode = req.params.inviteCode;
        const invite = inviteService.claimInvite({
          role: UserRole.OperationalPartner,
          inviteCode,
          accountId,
          inviteSignature,
          authBinding: {
            role: UserRole.OperationalPartner,
            accountId,
            authAccountId,
            inviteCode,
            expiresAt: authBindingExpiresAt,
          },
          authBindingSignature,
        });
        if (!invite) {
          throw new RouterError('Invite not found', 404);
        }

        return {
          fromName: invite.fromName,
          invite,
        };
      }),
    );

    app.get(
      '/operational-users/invites',
      requireAdminOperatorAuth,
      safeJsonRoute<IListOperationalInvitesResponse>(async () => {
        return {
          invites: db.userInvitesTable.fetchByRole(UserRole.OperationalPartner),
        };
      }),
    );

    app.get(
      '/bitcoin-lock-coupons',
      requireAdminOperatorAuth,
      safeJsonRoute<IListBitcoinLockCouponsResponse>(async () => {
        return {
          bitcoinLockCoupons: await botCouponClient.listCoupons(),
        };
      }),
    );

    app.get(
      '/bitcoin-lock-coupons/:offerCode',
      safeJsonRoute<IBitcoinLockStatusResponse>(async req => {
        return {
          bitcoinLock: await botCouponClient.getCoupon(req.params.offerCode),
        };
      }),
    );

    app.post(
      '/bitcoin-lock-coupons/:offerCode/initialize',
      express.text({ type: '*/*' }),
      safeJsonRoute<IBitcoinLockStatusResponse>(async req => {
        const body = requireBody<IBitcoinLockRelayRequest>(req);
        routerAuth.requireTreasuryUserSession(req, body.ownerAccountId);

        if (body.microgonsPerBtc == null) {
          throw new RouterError('A current bitcoin price quote is required to initialize this bitcoin lock.');
        }

        const bitcoinLock = await botCouponClient
          .initializeCoupon(req.params.offerCode, {
            offerCode: req.params.offerCode,
            requestedSatoshis: body.requestedSatoshis,
            ownerAccountId: body.ownerAccountId,
            ownerBitcoinPubkey: body.ownerBitcoinPubkey,
            microgonsPerBtc: body.microgonsPerBtc,
          })
          .catch(error => {
            if (error instanceof RouterError) {
              throw new RouterError(
                error.message || 'Bot request failed to initialize this bitcoin lock.',
                error.status,
              );
            }
            throw error;
          });

        return { bitcoinLock };
      }),
    );

    app.get(
      '/treasury-users/:accountId/bitcoin-lock-coupons',
      safeJsonRoute<IListBitcoinLockCouponsResponse>(async req => {
        routerAuth.requireTreasuryUserSession(req, req.params.accountId);

        const user = db.userInvitesTable.fetchByAccountId(req.params.accountId, UserRole.TreasuryUser);
        if (!user) {
          return {
            bitcoinLockCoupons: [],
          };
        }

        return {
          bitcoinLockCoupons: await botCouponClient.listCouponsByUserId(user.id),
        };
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
    this.server.once('error', err => {
      this.rejectListening(err);
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
    return await new Promise<void>((resolve, reject) => {
      this.server.close(err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
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

      if (!res.headersSent) {
        sendJson(res, { error: message }, status);
      }
    }
  };
}
