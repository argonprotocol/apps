import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { MainchainHttpProvider, MainchainWsProvider } from '../src/MainchainRpcProvider.ts';
import { createDeferred } from '../src/Deferred.ts';

describe.each([
  { name: 'WebSocket', Provider: MainchainWsProvider, scheme: 'ws' },
  { name: 'HTTP', Provider: MainchainHttpProvider, scheme: 'http' },
])('$name RPC cache', ({ Provider, scheme }) => {
  let server: ReturnType<typeof createServer>;
  let websocketServer: WebSocketServer;
  let provider: MainchainHttpProvider | MainchainWsProvider;
  let requestCount: number;
  let result: unknown;
  let shouldFail: boolean;
  let responseWait: Promise<void> | undefined;
  const blockHash = `0x${'11'.repeat(32)}`;
  const header = { number: '0x9', parentHash: `0x${'22'.repeat(32)}` };

  beforeEach(async () => {
    requestCount = 0;
    result = null;
    shouldFail = false;
    responseWait = undefined;
    async function respond(body: string) {
      const { id } = JSON.parse(body);
      requestCount += 1;
      const response = shouldFail
        ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'Historical state temporarily unavailable' } }
        : { jsonrpc: '2.0', id, result };
      const wait = responseWait;
      responseWait = undefined;
      await wait;
      return JSON.stringify(response);
    }

    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      response.setHeader('Content-Type', 'application/json');
      response.end(await respond(Buffer.concat(chunks).toString()));
    });
    websocketServer = new WebSocketServer({ server });
    websocketServer.on('connection', socket => {
      socket.on('message', bytes => void respond(bytes.toString()).then(response => socket.send(response)));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test RPC address');
    provider = new Provider(`${scheme}://127.0.0.1:${address.port}`);
    if ('isReady' in provider) await provider.isReady;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await provider?.disconnect();
    for (const socket of websocketServer.clients) socket.terminate();
    await new Promise<void>(resolve => websocketServer.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('deduplicates pending reads, retries null and errors, and retains successful reads', async () => {
    const releaseResponse = createDeferred<void>(false);
    responseWait = releaseResponse.promise;
    const pending = provider.send('chain_getHeader', [blockHash], true);
    const duplicate = provider.send('chain_getHeader', [blockHash], true);
    try {
      await vi.waitFor(() => expect(requestCount).toBe(1));
    } finally {
      releaseResponse.resolve();
    }
    await expect(Promise.all([pending, duplicate])).resolves.toEqual([null, null]);

    result = header;
    await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
    await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
    expect(requestCount).toBe(2);

    shouldFail = true;
    const otherHash = `0x${'33'.repeat(32)}`;
    await expect(provider.send('chain_getHeader', [otherHash], true)).rejects.toThrow(
      'Historical state temporarily unavailable',
    );
    shouldFail = false;
    await expect(provider.send('chain_getHeader', [otherHash], true)).resolves.toEqual(header);
    await expect(provider.send('chain_getHeader', [otherHash], true)).resolves.toEqual(header);
    expect(requestCount).toBe(4);
  });

  it.each(['null', 'error'])('keeps a newer successful read when an expired pending read returns %s', async failure => {
    shouldFail = failure === 'error';
    const releaseResponse = createDeferred<void>(false);
    responseWait = releaseResponse.promise;
    const pending = provider.send('chain_getHeader', [blockHash], true);
    // Observe a possible rejection immediately, while holding its RPC response.
    const oldResult = Promise.allSettled([pending]);
    try {
      await vi.waitFor(() => expect(requestCount).toBe(1));
      const now = performance.now();
      vi.spyOn(performance, 'now').mockReturnValue(now + 31_000);
      result = header;
      shouldFail = false;
      await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
      expect(requestCount).toBe(2);
    } finally {
      releaseResponse.resolve();
    }
    const [old] = await oldResult;
    expect(old.status).toBe(failure === 'error' ? 'rejected' : 'fulfilled');
    await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
    expect(requestCount).toBe(2);
  });

  it('leaves live reads uncached and expires successful reads despite repeated cache hits', async () => {
    result = header;
    await provider.send('chain_getHeader', [], false);
    result = { ...header, number: '0xa' };
    await expect(provider.send('chain_getHeader', [], false)).resolves.toEqual(result);
    expect(requestCount).toBe(2);

    result = header;
    const now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now);
    await provider.send('chain_getHeader', [blockHash], true);
    for (const elapsed of [10_000, 20_000, 29_000]) {
      clock.mockReturnValue(now + elapsed);
      await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
    }
    expect(requestCount).toBe(3);

    clock.mockReturnValue(now + 31_000);
    await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
    expect(requestCount).toBe(4);
  });

  it('gives a cloned provider an independent cache that retries missing headers', async () => {
    result = header;
    await provider.send('chain_getHeader', [blockHash], true);

    const clone = provider.clone();
    try {
      if ('isReady' in clone) await clone.isReady;
      result = null;
      await expect(clone.send('chain_getHeader', [blockHash], true)).resolves.toBeNull();
      result = header;
      await expect(clone.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
      await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
      expect(requestCount).toBe(3);
    } finally {
      await clone.disconnect();
    }
  });

  it('clears successful reads when disconnected', async () => {
    result = header;
    await provider.send('chain_getHeader', [blockHash], true);
    await provider.disconnect();
    if ('isReady' in provider) {
      await vi.waitFor(() => expect(provider.isConnected).toBe(false));
      await provider.connect();
      await vi.waitFor(() => expect(provider.isConnected).toBe(true));
    }

    await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
    expect(requestCount).toBe(2);
  });

  if (scheme === 'ws') {
    it('clears successful reads when the transport disconnects and reconnects automatically', async () => {
      result = header;
      await provider.send('chain_getHeader', [blockHash], true);
      const disconnected = createDeferred<void>(false);
      const unsubscribe = provider.on('disconnected', () => disconnected.resolve());
      try {
        for (const socket of websocketServer.clients) socket.close(1001, 'RPC restarting');
        await disconnected.promise;
        await vi.waitFor(() => expect(provider.isConnected).toBe(true), { timeout: 5_000 });
        await expect(provider.send('chain_getHeader', [blockHash], true)).resolves.toEqual(header);
        expect(requestCount).toBe(2);
      } finally {
        unsubscribe();
      }
    });
  }
});
