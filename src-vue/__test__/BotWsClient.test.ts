import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotWsClient } from '../lib/BotWsClient.ts';

const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public readyState = FakeWebSocket.CONNECTING;
  private listeners = new Map<string, ((event: any) => void)[]>();

  constructor() {
    sockets.push(this);
  }

  public addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  public close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code: 1000, reason: 'disposed' });
  }

  public fail(error: Error) {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('error', error);
    this.emit('close', { code: 1006, reason: 'connection failed' });
  }

  public emit(type: string, event: any) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('BotWsClient', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('closes its websocket without reconnecting when disposed', async () => {
    vi.useFakeTimers();
    const client = new BotWsClient({
      getAdminOperatorSessionId: vi.fn().mockResolvedValue('session-id'),
      getGatewayWebsocketUrl: vi.fn().mockReturnValue('wss://gateway.test/bot/'),
    } as any);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    await client.connectDeferred.promise;

    client.dispose();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets[0].readyState).toBe(FakeWebSocket.CLOSED);
    expect(sockets).toHaveLength(1);
  });

  it('disposes a client whose initial connection fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const connection = BotWsClient.connectToServerGateway({
      getAdminOperatorSessionId: vi.fn().mockResolvedValue('session-id'),
      getGatewayWebsocketUrl: vi.fn().mockReturnValue('wss://gateway.test/bot/'),
    } as any);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const initialError = new Error('connection failed');
    sockets[0].fail(initialError);

    await expect(connection).rejects.toBe(initialError);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets).toHaveLength(1);
  });
});
