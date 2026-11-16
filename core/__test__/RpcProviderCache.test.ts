import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { MainchainHttpProvider, MainchainWsProvider } from '../src/MainchainRpcProvider.ts';
import { RpcStats } from '../src/RpcStats.ts';

describe.each([
  { name: 'WebSocket', Provider: MainchainWsProvider, scheme: 'ws' },
  { name: 'HTTP', Provider: MainchainHttpProvider, scheme: 'http' },
])('$name RPC cache', ({ Provider, scheme }) => {
  let server: ReturnType<typeof createServer>;
  let websocketServer: WebSocketServer;
  let provider: MainchainHttpProvider | MainchainWsProvider;
  let result: unknown;
  let shouldFail: boolean;
  let responseGate: Promise<void> | undefined;
  const blockHash = `0x${'11'.repeat(32)}`;
  const header = { number: '0x9', parentHash: `0x${'22'.repeat(32)}` };

  beforeEach(async () => {
    result = null;
    shouldFail = false;
    responseGate = undefined;
    function respond(body: string) {
      const { id } = JSON.parse(body);
      const response = shouldFail
        ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'Historical state temporarily unavailable' } }
        : { jsonrpc: '2.0', id, result };
      return JSON.stringify(response);
    }

    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      await responseGate;
      response.setHeader('Content-Type', 'application/json');
      response.end(respond(Buffer.concat(chunks).toString()));
    });
    websocketServer = new WebSocketServer({ server });
    websocketServer.on('connection', socket => {
      socket.on('message', async bytes => {
        await responseGate;
        socket.send(respond(bytes.toString()));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test RPC address');
    provider = new Provider(`${scheme}://127.0.0.1:${address.port}`);
    if ('isReady' in provider) await provider.isReady;
  });

  afterEach(async () => {
    await provider?.disconnect();
    for (const socket of websocketServer.clients) socket.terminate();
    await new Promise<void>(resolve => websocketServer.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('recovers missing and failed historical reads, retains valid cached data through an RPC outage, and reads advancing live headers', async () => {
    await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toBeNull();

    result = header;
    await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
    shouldFail = true;
    await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);

    const otherHash = `0x${'33'.repeat(32)}`;
    await expect(provider.send('chain_getHeader', [otherHash], true)).rejects.toThrow(
      'Historical state temporarily unavailable',
    );
    shouldFail = false;
    await expect(provider.send('chain_getHeader', [otherHash], true)).resolves.toEqual(header);

    await expect(provider.send('chain_getHeader', [], false)).resolves.toEqual(header);
    result = { ...header, number: '0xa' };
    await expect(provider.send('chain_getHeader', [], false)).resolves.toEqual(result);

    expect(provider.stats.calls.total).toMatchObject({ requests: 6, cacheHits: 1, errors: 1, pending: 0 });
    expect(provider.stats.total.requests).toBe(6);
    expect(provider.stats.calls.methods.chain_getHeader).toMatchObject({ requests: 6, cacheHits: 1, errors: 1 });
  });

  it('measures network concurrency and batched storage reads without retaining account keys or results', async () => {
    const accountPrefix = `0x${'ab'.repeat(32)}`;
    const eventsPrefix = `0x${'cd'.repeat(32)}`;
    const accountSuffix = '1234567890abcdef'.repeat(4);
    provider.rpcStats.nameStorage(accountPrefix, 'system.account');
    provider.rpcStats.nameStorage(eventsPrefix, 'system.events');
    result = 'private-response-value';

    let release!: () => void;
    responseGate = new Promise<void>(resolve => (release = resolve));
    const first = provider.send('state_getStorage', [accountPrefix + accountSuffix], true);
    const duplicate = provider.send('state_getStorage', [accountPrefix + accountSuffix], true);
    const batch = provider.send('state_queryStorageAt', [[accountPrefix + accountSuffix, eventsPrefix]], true);
    try {
      expect(provider.stats.calls.total).toMatchObject({ requests: 2, cacheHits: 1, pending: 2, peakPending: 2 });
      expect(provider.stats.calls.storage).toEqual({ 'system.account': 2, 'system.events': 1 });
    } finally {
      release();
      await Promise.all([first, duplicate, batch]);
    }

    const stats = provider.stats;
    expect(stats.total.requests).toBe(2);
    expect(stats.calls.total).toMatchObject({ requests: 2, cacheHits: 1, pending: 0, peakPending: 2 });
    expect(stats.calls.total.totalMs).toBeGreaterThan(0);
    expect(JSON.stringify(stats)).not.toContain(accountSuffix);
    expect(JSON.stringify(stats)).not.toContain(result);
  });
});

it('keeps bounded request-start windows and includes earlier requests in peak concurrency', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    const stats = new RpcStats();
    let release!: () => void;
    const first = stats.request('chain_getHeader', [], false, () => new Promise<void>(resolve => (release = resolve)));
    clock.mockReturnValue(10_000);
    const second = stats.request(
      'state_call',
      ['TransactionPaymentApi_query_info', 'private-payload'],
      false,
      async () => 1,
    );
    expect(stats.snapshot().windows[1].peakPending).toBe(2);
    release();
    await Promise.all([first, second]);

    for (let index = 2; index <= 61; index++) {
      clock.mockReturnValue(index * 10_000);
      await stats.request('chain_getHeader', [], false, async () => 1);
    }
    const snapshot = stats.snapshot();
    expect(snapshot.windows).toHaveLength(60);
    expect(snapshot.windows[0].fromMs).toBe(20_000);
    expect(snapshot.total).toMatchObject({ requests: 62, pending: 0, peakPending: 2 });
    expect(snapshot.methods['state_call.TransactionPaymentApi_query_info'].requests).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('private-payload');
  } finally {
    clock.mockRestore();
  }
});
