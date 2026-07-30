// server.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type BotServer, startServer } from '../src/server.ts';
import type Bot from '../src/Bot.ts';
import {
  createDeferred,
  JsonExt,
  type IEthereumGatewayRelayStatus,
  type JsonRpcResponse,
} from '@argonprotocol/apps-core';

function createMockBot(overrides: Record<string, any> = {}): Bot {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return {
    isReady: true,
    errorMessage: '',
    currentFrameId: Promise.resolve(123),
    state: async (startupError: string) => ({ startupError, ok: true }),
    ethereumGatewayProverService: {
      getRelayStatus: async () => ({ isReady: true }),
      runToCheckpoint: async () => ({ outcome: 'Noop' }),
      shutdown: async () => undefined,
    },
    history: { recent: Promise.resolve({ activities: [{ id: 'a1' }] }) },
    getMiningSummary: async () => ({
      observedAt: new Date('2026-07-28T12:00:00Z'),
      sourceBlockNumber: 456,
      latestFrameId: 123,
      cohorts: [],
      frames: [],
      currentBids: [],
      global: {
        seatsTotal: 0,
        framesCompleted: 0,
        framesRemaining: 0,
        framedCost: 0n,
        transactionFeesTotal: 0n,
        microgonsBidTotal: 0n,
        micronotsMinedTotal: 0n,
        microgonsMinedTotal: 0n,
        microgonsMintedTotal: 0n,
      },
    }),
    storage: {
      bidsFile: (_start: number, _end: number) => ({ get: async () => ({ bids: [] }) }),
      earningsFile: (_frameId: number) => ({ get: async () => ({ earnings: [] }) }),
    },
    ...overrides,
  } as any;
}

describe('BotServer basic behavior', () => {
  let server: BotServer;

  afterEach(async () => {
    if (server) await server.close();
  });

  it('GET /is-ready returns bot.isReady', async () => {
    server = startServer(createMockBot({ isReady: true }), 0);
    await server.waitForListening();
    const { host, port } = server.getAddress();

    const response = await fetch(`http://${host}:${port}/is-ready`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').toContain('application/json');

    const body = await response.json();
    expect(body).toBe(true);
  });

  it('GET /ethereum-relay-status returns the gateway prover relay status', async () => {
    server = startServer(
      createMockBot({
        ethereumGatewayProverService: {
          getRelayStatus: async () => ({
            isReady: false,
            reason: 'Vault delegate cannot afford Ethereum gateway relay.',
          }),
        },
      }),
      0,
    );
    await server.waitForListening();
    const { host, port } = server.getAddress();

    const response = await fetch(`http://${host}:${port}/ethereum-relay-status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').toContain('application/json');

    const body = JsonExt.parse<IEthereumGatewayRelayStatus>(await response.text());
    expect(body).toEqual({
      isReady: false,
      reason: 'Vault delegate cannot afford Ethereum gateway relay.',
    });
  });

  it('pushes state immediately and continues sending heartbeats', async () => {
    server = startServer(createMockBot(), 0, 100);
    await server.waitForListening();
    const { host, port } = server.getAddress();

    const ws = new WebSocket(`ws://${host}:${port}`);

    const got2Heartbeats = createDeferred<boolean>();
    let heartbeatCount = 0;
    const firstMessage = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for message')), 5000);

      ws.on('message', data => {
        const msg: JsonRpcResponse = JsonExt.parse(readMessageData(data));
        if ('event' in msg && msg.event === '/heartbeat') {
          heartbeatCount += 1;
          if (heartbeatCount >= 2) {
            got2Heartbeats.resolve(true);
            clearTimeout(timeout);
            ws.close();
          }
        }
        try {
          resolve(msg);
        } catch (e) {
          reject(e);
        }
      });

      ws.on('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(firstMessage).toMatchObject({
      jsonrpc: '2.0',
      event: '/state',
      data: { ok: true },
    });
    await expect(got2Heartbeats.promise).resolves.toBe(true);
  });

  it('JSON-RPC routes to /state if bot not ready (or has errors)', async () => {
    server = startServer(
      createMockBot({
        isReady: false,
      }),
      0,
    );
    await server.waitForListening();
    const response = await requestRpc(server, '/bids', 1);

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ ok: true });
  });

  it('returns the server mining summary over JSON-RPC', async () => {
    server = startServer(createMockBot(), 0);
    await server.waitForListening();
    const response = await requestRpc(server, '/mining-summary', 3);

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      observedAt: new Date('2026-07-28T12:00:00Z'),
      sourceBlockNumber: 456,
      latestFrameId: 123,
      cohorts: [],
      frames: [],
      currentBids: [],
      global: expect.objectContaining({ framedCost: 0n }),
    });
  });

  it('unknown RPC method returns Method not found error', async () => {
    server = startServer(createMockBot(), 0);
    await server.waitForListening();
    const response = await requestRpc(server, '/definitely-not-a-real-method', 2);

    expect(response.id).toBe(2);
    expect(response.result).toBeUndefined();
    expect(response.error).toMatchObject({
      code: -32000,
    });
    expect(String(response.error.message)).toContain('Method not found');
  });
});

async function requestRpc(server: BotServer, method: string, id: number): Promise<any> {
  const { host, port } = server.getAddress();
  const ws = new WebSocket(`ws://${host}:${port}`);

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for rpc response')), 5_000);

    ws.on('open', () => {
      ws.send(JsonExt.stringify({ jsonrpc: '2.0', id, method, params: [] }));
    });
    ws.on('message', data => {
      const message = JsonExt.parse<any>(readMessageData(data));
      if (message.id !== id) return;

      clearTimeout(timeout);
      resolve(message);
      ws.close();
    });
    ws.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function readMessageData(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}
