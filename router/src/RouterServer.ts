import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { JsonExt } from '@argonprotocol/apps-core';
import { ArgonApis } from './ArgonApis.ts';
import { BitcoinApis } from './BitcoinApis.ts';
import { BITCOIN_CONFIG, SERVER_ROOT } from './env.ts';
import type { Db } from './Db.ts';
import { toPublicBitcoinLockRelay } from './PublicBitcoinLockRelay.ts';
import { RouterError } from './RouterError.ts';
import { TreasuryInviteService } from './TreasuryInviteService.ts';
import type {
  IBitcoinLockRelayRecord,
  IBitcoinLockRelayResponse,
  ICreateTreasuryInviteResponse,
  IInitializeBitcoinLockRequest,
  IListTreasuryInvitesResponse,
  IListTreasuryMembersResponse,
  IOpenTreasuryInviteRequest,
  IOpenTreasuryInviteResponse,
  IRouterErrorResponse,
  IRouterProfileResponse,
  IRouterProfileUpdateRequest,
  ITreasuryUserInviteCreateRequest,
} from './interfaces/index.ts';

interface IRouterServerOptions {
  db: Db;
  inviteService: TreasuryInviteService;
  botInternalUrl: string;
  port?: number | string;
  localNodeUrl?: string;
  mainNodeUrl?: string;
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
    const { botInternalUrl, db, inviteService } = this.options;

    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
      })),
    );

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
      express.text({ type: '*/*' }),
      safeJsonRoute(async (req, res) => {
        const rawBody = req.body;
        if (!rawBody) {
          sendJson(res, { error: 'Missing JSON body' }, 400);
          return;
        }

        const invite = await inviteService.createInvite(
          JsonExt.parse<ITreasuryUserInviteCreateRequest>(String(rawBody)),
        );

        return { invite } satisfies ICreateTreasuryInviteResponse;
      }),
    );

    app.get(
      '/treasury-users/invites',
      safeJsonRoute(async () => {
        return {
          invites: db.treasuryUserInvitesTable.fetchInvites(),
        } satisfies IListTreasuryInvitesResponse;
      }),
    );

    app.get(
      '/treasury-users/members',
      safeJsonRoute(async () => {
        return {
          members: db.treasuryUserInvitesTable.fetchMembers(),
        } satisfies IListTreasuryMembersResponse;
      }),
    );

    app.get(
      '/treasury-users/:inviteCode/relays/:relayId',
      safeJsonRoute(async req => {
        const relayId = Number(req.params.relayId);
        if (!Number.isFinite(relayId) || relayId <= 0) {
          throw new RouterError('Invalid relay id.');
        }

        const invite = db.treasuryUserInvitesTable.fetchInviteByCode(req.params.inviteCode);
        if (!invite) {
          throw new RouterError('Invite not found.', 404);
        }

        const relay = await fetchBotRelay(`${botInternalUrl}/internal/bitcoin-lock-relays/${relayId}`).catch(error => {
          if (error instanceof RouterError) {
            throw new RouterError(error.message || `Bot request failed for relay ${relayId}.`, error.status);
          }
          throw error;
        });
        if (relay.routerInviteId !== invite.id) {
          throw new RouterError('Relay not found.', 404);
        }
        if (relay.status === 'Finalized') {
          db.treasuryUserInvitesTable.setLockedBitcoinAt(invite.id);
        }

        return { relay: toPublicBitcoinLockRelay(relay) } satisfies IBitcoinLockRelayResponse;
      }),
    );

    app.post(
      '/treasury-users/:inviteCode',
      express.text({ type: '*/*' }),
      safeJsonRoute(async (req, res) => {
        const rawBody = req.body;
        if (!rawBody) {
          sendJson(res, { error: 'Missing JSON body' }, 400);
          return;
        }

        const { accountAddress } = JsonExt.parse<IOpenTreasuryInviteRequest>(String(rawBody));
        const profile = db.profileTable.fetch();
        const invite = await inviteService.openInvite(req.params.inviteCode, accountAddress);
        if (!invite) {
          sendJson(res, { error: 'Invite not found' }, 404);
          return;
        }

        return {
          fromName: profile.name,
          invite,
        } satisfies IOpenTreasuryInviteResponse;
      }),
    );

    app.post(
      '/treasury-users/:inviteCode/initialize-bitcoin-lock',
      express.text({ type: '*/*' }),
      safeJsonRoute(async (req, res) => {
        const rawBody = req.body;
        if (!rawBody) {
          sendJson(res, { error: 'Missing JSON body' }, 400);
          return;
        }

        const relayRequest = await inviteService.createRelayRequest(
          req.params.inviteCode,
          JsonExt.parse<IInitializeBitcoinLockRequest>(String(rawBody)),
        );
        const relay = await fetchBotRelay(`${botInternalUrl}/internal/bitcoin-lock-relays`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JsonExt.stringify(relayRequest),
        }).catch(error => {
          if (error instanceof RouterError) {
            throw new RouterError(error.message || 'Bot request failed to initialize this bitcoin lock.', error.status);
          }
          throw error;
        });

        db.treasuryUserInvitesTable.setRedeemedAt(relayRequest.routerInviteId);

        return { relay: toPublicBitcoinLockRelay(relay) } satisfies IBitcoinLockRelayResponse;
      }),
    );

    app.post(
      '/profile',
      express.text({ type: '*/*' }),
      safeJsonRoute(async (req, res) => {
        const rawBody = req.body;
        if (!rawBody) {
          sendJson(res, { error: 'Missing JSON body' }, 400);
          return;
        }

        const payload = JsonExt.parse<IRouterProfileUpdateRequest>(String(rawBody));
        const profile = db.profileTable.save(payload);
        return { profile } satisfies IRouterProfileResponse;
      }),
    );

    app.get(
      '/profile',
      safeJsonRoute(async () => {
        const profile = db.profileTable.fetch();
        return { profile } satisfies IRouterProfileResponse;
      }),
    );

    app.use((_req, res) => {
      res.status(404).send('Not Found');
    });

    this.server = app.listen(this.options.port ?? 0, () => {
      console.log(`Router server is running on port ${(this.server.address() as { port?: number } | null)?.port ?? this.options.port}`);
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

async function fetchBotRelay(url: string, init?: RequestInit): Promise<IBitcoinLockRelayRecord> {
  const response = await fetch(url, init);
  const rawBody = await response.text();
  const body = rawBody ? JsonExt.parse<IBitcoinLockRelayRecord | IRouterErrorResponse>(rawBody) : undefined;

  if (!response.ok) {
    const message =
      body != null && typeof body === 'object' && !Array.isArray(body) && 'error' in body && typeof body.error === 'string'
        ? body.error
        : 'Bot request failed.';
    throw new RouterError(message, response.status);
  }

  if (!body) {
    throw new RouterError('Bot request failed.', response.status || 500);
  }

  return body as IBitcoinLockRelayRecord;
}

function sendJson(res: Response, data: unknown, status = 200): void {
  res.status(status).type('application/json').send(JsonExt.stringify(data));
}

function safeJsonRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
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
