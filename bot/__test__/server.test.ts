// server.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type BotServer, startServer } from '../src/server.ts';
import type Bot from '../src/Bot.ts';
import { createDeferred, JsonExt, type JsonRpcResponse } from '@argonprotocol/apps-core';

function createMockBot(overrides: Record<string, any> = {}): Bot {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return {
    isReady: true,
    errorMessage: '',
    currentFrameId: Promise.resolve(123),
    state: async (startupError: string) => ({ startupError, ok: true }),
    history: { recent: Promise.resolve({ activities: [{ id: 'a1' }] }) },
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
    const { host, port } = server.getAddress();

    const response = await fetch(`http://${host}:${port}/is-ready`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').toContain('application/json');

    const body = await response.json();
    expect(body).toBe(true);
  });

  it('WS sends /heartbeat event periodically (we see at least one)', async () => {
    // To avoid waiting 30s, this test just checks we can connect and receive *something*
    // NOTE: With the current implementation, first heartbeat is at 30s.
    // If you want this test fast, see the note below about making heartbeat interval injectable.
    server = startServer(createMockBot(), 0, 100);
    const { host, port } = server.getAddress();

    const ws = new WebSocket(`ws://${host}:${port}`);

    const got2Heartbeats = createDeferred<boolean>();
    let heartbeatCount = 0;
    const firstMessage = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for message')), 5000);

      ws.on('message', data => {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const msg: JsonRpcResponse = JsonExt.parse(String(data));
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
      event: '/heartbeat',
      data: null,
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
    const { host, port } = server.getAddress();

    const ws = new WebSocket(`ws://${host}:${port}`);

    const response = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for rpc response')), 5_000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: '/bids', // should be forced to /state because isReady=false
            params: [],
          }),
        );
      });

      ws.on('message', data => {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const msg = JSON.parse(String(data));
        if (msg.id === 1) {
          clearTimeout(timeout);
          resolve(msg);
          ws.close();
        }
      });

      ws.on('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response.error).toBeUndefined();
    // From our mock bot.state()
    expect(response.result).toMatchObject({ ok: true });
  });

  it('unknown RPC method returns Method not found error', async () => {
    server = startServer(createMockBot(), 0);
    const { host, port } = server.getAddress();

    const ws = new WebSocket(`ws://${host}:${port}`);

    const response = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for rpc response')), 5_000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: '/definitely-not-a-real-method',
            params: [],
          }),
        );
      });

      ws.on('message', data => {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const msg = JSON.parse(String(data));
        if (msg.id === 2) {
          clearTimeout(timeout);
          resolve(msg);
          ws.close();
        }
      });

      ws.on('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(response.id).toBe(2);
    expect(response.result).toBeUndefined();
    expect(response.error).toMatchObject({
      code: -32000,
    });
    expect(String(response.error.message)).toContain('Method not found');
  });
});
