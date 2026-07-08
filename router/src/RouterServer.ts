import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import {
  type ArgonClient,
  type ICertificationProgress,
  JsonExt,
  loadCertificationProgress,
  UserRole,
  type IEthereumGatewayCatchUpRequest,
  type IEthereumGatewayCatchUpResponse,
  type IEthereumGatewayRelayStatus,
} from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { ArgonApis } from './ArgonApis.ts';
import { BitcoinApis } from './BitcoinApis.ts';
import { BotUpstreamClient } from './BotUpstreamClient.ts';
import { ADMIN_OPERATOR_ACCOUNT_ID, BITCOIN_CONFIG, ROUTER_AUTH_SESSION_TTL_SECONDS, SERVER_ROOT } from './env.ts';
import type { Db } from './Db.ts';
import { RouterError } from './RouterError.ts';
import { RouterAuthService, type IRouterAuthServiceOptions } from './RouterAuthService.ts';
import { UserInviteService } from './UserInviteService.ts';
import type {
  IBitcoinLockRelayRequest,
  IBitcoinLockStatusResponse,
  ICreateInviteRequest,
  IInviteResponse,
  IListBitcoinLockCouponsResponse,
  IListInvitesResponse,
  IOpenInviteRequest,
  IOpenInviteResponse,
  IPreviewInviteResponse,
  IRequestOperationsUpgradeRequest,
  IRequestOperationsUpgradeResponse,
  IRouterAuthChallengeRequest,
  IRouterAuthSessionRequest,
  IRouterAuthSessionResponse,
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
  private inviteProgressClientPromise?: Promise<ArgonClient>;
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
    const inviteProgressNodeUrl = this.options.mainNodeUrl ?? this.options.localNodeUrl;
    const adminOperatorAccountId = this.options.auth?.adminOperatorAccountId?.trim() || ADMIN_OPERATOR_ACCOUNT_ID?.trim();
    const routerAuth = new RouterAuthService({
      db,
      sessionTtlSeconds: ROUTER_AUTH_SESSION_TTL_SECONDS ? Number(ROUTER_AUTH_SESSION_TTL_SECONDS) : undefined,
      ...this.options.auth,
      adminOperatorAccountId,
    });
    routerAuth.pruneInactiveSessions();

    const requireAdminOperatorAuth = routerAuth.requireAdminOperator();

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
        const { authAccountId, role } = requireBody<IRouterAuthChallengeRequest>(req);
        return routerAuth.createChallenge(authAccountId, role);
      }),
    );

    app.post(
      '/auth/login',
      express.text({ type: '*/*' }),
      safeJsonRoute<IRouterAuthSessionResponse>(async req =>
        routerAuth.createSession(requireBody<IRouterAuthSessionRequest>(req)),
      ),
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
      '/bitcoin/recentblocks',
      safeJsonRoute(async req => {
        const blockCount = Number(String(req.query.blockCount ?? '10'));
        return BitcoinApis.recentBlocks(blockCount);
      }),
    );

    app.post(
      '/invites/create',
      requireAdminOperatorAuth,
      express.text({ type: '*/*' }),
      safeJsonRoute<IInviteResponse>(async req => {
        const body = requireBody<ICreateInviteRequest>(req);
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

        const invite = inviteService.createInvite({
          name: body.name,
          fromName: body.fromName,
        });

        let bitcoinLockCoupon;
        try {
          bitcoinLockCoupon = await botClient.createCoupon({
            userId: invite.id,
            vaultId: body.vaultId,
            maxSatoshis: body.maxSatoshis,
            estimatedGiftUsd: body.estimatedGiftUsd,
            btcPctFee,
            expiresAfterTicks: body.expiresAfterTicks,
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

        const [bitcoinLockCoupon] = await botClient.listCouponsByUserId(invite.id);
        if (!bitcoinLockCoupon) {
          throw new RouterError('Bitcoin lock coupon not found.', 404);
        }

        const { coupon } = bitcoinLockCoupon;
        return {
          maxSatoshis: coupon.maxSatoshis,
          estimatedGiftUsd: coupon.estimatedGiftUsd,
          btcPctFee: coupon.btcPctFee,
          expiresAt: new Date(new Date(coupon.createdAt).getTime() + 24 * 60 * 60 * 1000),
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

        const bitcoinLockCoupon = await botClient.activateLatestCoupon({
          userId: invite.id,
          accountId: defaultAccountId,
        });

        return {
          fromName: invite.fromName,
          referrer: adminOperatorAccountId,
          invite: {
            ...invite,
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
        const couponsByUserId = await botClient.listLatestCouponsByUserId();
        const invites = db.userInvitesTable.fetchByRole(UserRole.Member);

        return {
          invites: await Promise.all(
            invites.map(async invite => {
              let certificationProgress: ICertificationProgress | undefined;
              if (inviteProgressNodeUrl && invite.defaultAccountId) {
                try {
                  this.inviteProgressClientPromise ??= getClient(inviteProgressNodeUrl, { throwOnConnect: true });
                  certificationProgress = await loadCertificationProgress({
                    client: await this.inviteProgressClientPromise,
                    defaultAccountId: invite.defaultAccountId,
                    operationalAccountId: invite.operationalAccountId ?? undefined,
                  });
                } catch (error) {
                  this.inviteProgressClientPromise = undefined;
                  console.warn('[router] Unable to load invite certification progress.', error);
                }
              }

              return {
                ...invite,
                vaultId: couponsByUserId.get(invite.id)?.coupon.vaultId,
                bitcoinLockCoupon: couponsByUserId.get(invite.id),
                certificationProgress,
              };
            }),
          ),
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
          invite,
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
      safeJsonRoute<IInviteResponse>(async req => {
        const invite = inviteService.markOperationsUpgraded(req.params.inviteCode);
        if (!invite) {
          throw new RouterError('Invite not found', 404);
        }

        return { invite };
      }),
    );

    app.get(
      '/bitcoin-lock-coupons',
      requireAdminOperatorAuth,
      safeJsonRoute<IListBitcoinLockCouponsResponse>(async () => {
        return {
          bitcoinLockCoupons: await botClient.listCoupons(),
        };
      }),
    );

    app.get(
      '/bitcoin-lock-coupons/:offerCode',
      safeJsonRoute<IBitcoinLockStatusResponse>(async req => {
        return {
          bitcoinLock: await botClient.getCoupon(req.params.offerCode),
        };
      }),
    );

    app.post(
      '/bitcoin-lock-coupons/:offerCode/initialize',
      express.text({ type: '*/*' }),
      safeJsonRoute<IBitcoinLockStatusResponse>(async req => {
        const body = requireBody<IBitcoinLockRelayRequest>(req);
        routerAuth.requireMemberSession(req, body.ownerAccountId);

        if (body.microgonsAtTargetPerBtc == null) {
          throw new RouterError('A current bitcoin price quote is required to initialize this bitcoin lock.');
        }

        const bitcoinLock = await botClient
          .initializeCoupon(req.params.offerCode, {
            offerCode: req.params.offerCode,
            requestedSatoshis: body.requestedSatoshis,
            ownerAccountId: body.ownerAccountId,
            ownerBitcoinPubkey: body.ownerBitcoinPubkey,
            microgonsAtTargetPerBtc: body.microgonsAtTargetPerBtc,
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
          bitcoinLockCoupons: await botClient.listCouponsByUserId(invite.id),
        };
      }),
    );

    app.get(
      '/ethereum-relay-status',
      safeJsonRoute<IEthereumGatewayRelayStatus>(async req => {
        routerAuth.requireSession(req, [UserRole.AdminOperator, UserRole.Member]);

        return await botClient.getEthereumGatewayRelayStatus().catch(error => {
          if (error instanceof RouterError) {
            throw new RouterError(
              error.message || 'Bot request failed to load Ethereum relay status.',
              error.status,
            );
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

    void (async () => {
      const migrationNodeUrl = this.options.mainNodeUrl ?? this.options.localNodeUrl;
      if (migrationNodeUrl) {
        const client = await getClient(migrationNodeUrl, { throwOnConnect: true });
        try {
          await inviteService.migrateMissingOperationalAccountIds(client);
        } finally {
          await client.disconnect().catch(() => undefined);
        }
      }

      this.server = app.listen(this.options.port ?? 0, () => {
        console.log(
          `Router server is running on port ${(this.server.address() as { port?: number } | null)?.port ?? this.options.port}`,
        );
        this.resolveListening();
      });
      this.server.once('error', err => {
        this.rejectListening(err);
      });
    })().catch(error => {
      this.rejectListening(error instanceof Error ? error : new Error(String(error)));
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

    await this.inviteProgressClientPromise
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

      if (!res.headersSent) {
        sendJson(res, code ? { error: message, code } : { error: message }, status);
      }
    }
  };
}
