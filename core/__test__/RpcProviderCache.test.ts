import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { MainchainHttpProvider, MainchainWsProvider } from '../src/MainchainRpcProvider.ts';

describe.each([
  { name: 'WebSocket', Provider: MainchainWsProvider, scheme: 'ws' },
  { name: 'HTTP', Provider: MainchainHttpProvider, scheme: 'http' },
])('$name RPC cache', ({ Provider, scheme }) => {
  let server: ReturnType<typeof createServer>;
  let websocketServer: WebSocketServer;
  let provider: MainchainHttpProvider | MainchainWsProvider;
  let result: unknown;
  let shouldFail: boolean;
  const blockHash = `0x${'11'.repeat(32)}`;
  const header = { number: '0x9', parentHash: `0x${'22'.repeat(32)}` };

  beforeEach(async () => {
    result = null;
    shouldFail = false;
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
      response.setHeader('Content-Type', 'application/json');
      response.end(respond(Buffer.concat(chunks).toString()));
    });
    websocketServer = new WebSocketServer({ server });
    websocketServer.on('connection', socket => {
      socket.on('message', bytes => socket.send(respond(bytes.toString())));
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
  });
});
