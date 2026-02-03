import 'source-map-support/register';
import Bot from './Bot.ts';
import express from 'express';
import cors from 'cors';
import { DockerStatus } from './DockerStatus.ts';
import type {
  IBotApiMethod,
  IBotApiResponse,
  IBotApiSpec,
  JsonRpcRequest,
  JsonRpcResponse,
} from '@argonprotocol/apps-core';
import { JsonExt } from '@argonprotocol/apps-core';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'node:http';

export class BotServer {
  public startupError = '';
  private server!: Server;
  private wss!: WebSocketServer;
  private readonly rpcHandlers: {
    [K in IBotApiMethod]: (...args: Parameters<IBotApiSpec[K]>) => IBotApiResponse<K>;
  };

  constructor(
    public bot: Bot,
    public port: number | string,
    public heartbeatIntervalMs: number = 30e3,
  ) {
    this.rpcHandlers = {
      '/state': async () => await bot.state(this.startupError),
      '/bitcoin-recent-blocks': async () => await DockerStatus.getBitcoinLatestBlocks(),
      '/history': async () => (await bot.history?.recent) || { activities: [] },
      '/bids': async cohortBiddingFrameId => {
        const startingFrameId = cohortBiddingFrameId ?? (await bot.currentFrameId);
        return await bot.storage.bidsFile(startingFrameId, startingFrameId + 1).get();
      },
      '/earnings': async frameId => await bot.storage.earningsFile(frameId).get(),
      '/heartbeat': async () => null,
    };
  }

  public start() {
    const app = express();
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    const bot = this.bot;

    app.use(cors({ origin: true, methods: ['GET'] }));

    app.get('/is-ready', async (_req, res) => {
      res.status(200).type('application/json').send(bot.isReady);
    });

    wss.on('connection', (ws: WebSocket & { isAlive?: boolean }) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      ws.on('message', data => this.onMessage(ws, data));

      const interval = setInterval(() => {
        if (!ws.isAlive) {
          ws.terminate();
          return;
        }

        ws.isAlive = false;
        ws.ping();
        ws.send(
          JsonExt.stringify({
            jsonrpc: '2.0',
            event: '/heartbeat',
            data: null,
          } as JsonRpcResponse),
        );
      }, this.heartbeatIntervalMs).unref();

      ws.on('close', () => {
        ws.isAlive = false;
        clearInterval(interval);
      });
    });

    app.use((_req, res) => {
      res.status(404).send('Not Found');
    });

    this.server = app.listen(this.port, () => {
      console.log(`Server is running on port ${this.port}`);
    });
    this.server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, ws => {
        console.log('[BotServer] New WebSocket connection established', { remoteClient: request.socket.remoteAddress });
        wss.emit('connection', ws, request);
      });
    });
  }

  public async broadcast(method: IBotApiMethod, ...params: Parameters<IBotApiSpec[typeof method]>) {
    if (!this.wss.clients.size) {
      return;
    }
    const handler = this.rpcHandlers[method] as (...args: any[]) => any;
    const data = await handler(...params);
    for (const client of this.wss.clients) {
      client.send(
        JsonExt.stringify({
          jsonrpc: '2.0',
          event: method,
          data: data,
        } as JsonRpcResponse<typeof method>),
      );
    }
  }

  public getAddress(): { host: string; port: number } {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      // When not yet listening, or if Node returns a pipe name
      return { host: '127.0.0.1', port: Number(this.port) || 0 };
    }
    // Bind host for convenient test URLs; Node may return '::' for IPv6
    const host = address.address === '::' ? '127.0.0.1' : address.address;
    return { host, port: address.port };
  }

  public async close() {
    this.wss.close();
    return new Promise<void>((resolve, reject) => {
      this.server.close(err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private async onMessage(ws: WebSocket, raw: WebSocket.Data) {
    // WebSocket message handler invoked via ws.on('message', ...).
    let msg: JsonRpcRequest;

    try {
      let text: string;
      if (raw instanceof ArrayBuffer) {
        text = Buffer.from(raw).toString('utf8');
      } else if (Array.isArray(raw)) {
        text = Buffer.concat(raw).toString('utf8');
      } else {
        text = (raw as Buffer).toString('utf8');
      }
      msg = JsonExt.parse(text);
    } catch {
      return;
    }

    const msgLogKey = `[BotServer] ${msg.method}${msg.id ? ` #${msg.id}` : ''}${'params' in msg ? ` params: ${JsonExt.stringify(msg.params)}` : ''}`;

    console.time(msgLogKey);
    if (msg.jsonrpc !== '2.0') return;

    let method = msg.method;
    if (!this.bot.isReady || this.startupError || this.bot.errorMessage) {
      method = '/state';
    }
    const handler = this.rpcHandlers[method] as (...args: any[]) => any;
    if (!handler) {
      this.wsReply(ws, msg.id, new Error(`Method not found: ${msg.method}`));
      console.warn(`[BotServer] Method not found: ${msg.method}`);
      console.timeEnd(msgLogKey);
      return;
    }

    try {
      const result = await handler(...(msg.params ?? []));
      this.wsReply(ws, msg.id, result);
    } catch (e) {
      this.wsReply(ws, msg.id, e as Error);
      console.error(`[BotServer] Error handling ${msg.method}:`, e);
    }
    console.timeEnd(msgLogKey);
  }

  private wsReply(ws: WebSocket, id: number, responseOrError: object | Error) {
    ws.send(
      JsonExt.stringify({
        jsonrpc: '2.0',
        id,
        result: responseOrError instanceof Error ? undefined : responseOrError,
        error: responseOrError instanceof Error ? { code: -32000, message: String(responseOrError) } : undefined,
      } as JsonRpcResponse),
    );
  }
}

export function startServer(bot: Bot, port: number | string = 0, heartbeatIntervalMs: number = 30e3): BotServer {
  const server = new BotServer(bot, port, heartbeatIntervalMs);
  server.start();
  return server;
}
