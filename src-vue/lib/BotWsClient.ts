import { createDeferred, createTypedEventEmitter, type IBotState, IDeferred, JsonExt } from '@argonprotocol/apps-core';
import {
  IBotApiMethod,
  type IBotApiSpec,
  JsonRpcResponse,
} from '@argonprotocol/apps-core/src/interfaces/IBotApiSpec.ts';

export class BotWsClient {
  public events = createTypedEventEmitter<{
    '/state': (state: IBotState) => any;
    '/heartbeat': (payload: { ts: number }) => any;
    'ws:disconnected': (payload: {
      source: 'close' | 'error' | 'heartbeat-timeout';
      code?: number;
      reason?: string;
    }) => any;
  }>();

  public connectDeferred = createDeferred<void>();

  private requestIdCounter = 0;
  private readonly url: string;
  private webSocket!: WebSocket;
  private messageWaiters: Map<number, IDeferred<any>> = new Map();

  private shouldReconnect = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reconnectBaseDelayMs = 250;
  private readonly reconnectMaxDelayMs = 8_000;

  private hasEverConnected = false;
  private hasEmittedConnectionLost = false;

  private lastHeartbeatAt = 0;
  private heartbeatWatchdogTimer: ReturnType<typeof setInterval> | undefined;

  // Server heartbeat is ~30s; consider the connection stale if we haven't seen one for >75s.
  private readonly heartbeatStaleAfterMs = 75_000;
  private readonly heartbeatWatchdogIntervalMs = 10_000;

  constructor(url: string) {
    this.url = url;
    this.beginConnect();
  }

  private startHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdogTimer) return;

    this.heartbeatWatchdogTimer = setInterval(() => {
      if (this.webSocket.readyState !== WebSocket.OPEN) return;
      if (!this.lastHeartbeatAt) return;

      const now = Date.now();
      if (now - this.lastHeartbeatAt <= this.heartbeatStaleAfterMs) return;

      // Force-close so our normal reconnect logic runs.
      this.emitConnectionLostOnce({ source: 'heartbeat-timeout' });
      try {
        this.webSocket.close();
      } catch {
        // ignore
      }
    }, this.heartbeatWatchdogIntervalMs);
  }

  private stopHeartbeatWatchdog(): void {
    if (!this.heartbeatWatchdogTimer) return;
    clearInterval(this.heartbeatWatchdogTimer);
    this.heartbeatWatchdogTimer = undefined;
  }

  private emitConnectionLostOnce(payload: {
    source: 'close' | 'error' | 'heartbeat-timeout';
    code?: number;
    reason?: string;
  }): void {
    if (!this.hasEverConnected) return;
    if (this.hasEmittedConnectionLost) return;
    this.hasEmittedConnectionLost = true;
    this.events.emit('ws:disconnected', payload);
  }

  private beginConnect(): void {
    // New connection attempt -> new deferred for callers waiting on readiness.
    if (this.connectDeferred.isSettled) {
      this.connectDeferred = createDeferred<void>();
    }

    // Clear any scheduled reconnect because we're connecting now.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.stopHeartbeatWatchdog();

    this.webSocket = new WebSocket(this.url);

    this.webSocket.addEventListener('open', event => {
      this.reconnectAttempt = 0;
      this.hasEverConnected = true;
      this.hasEmittedConnectionLost = false;
      this.lastHeartbeatAt = Date.now();
      this.startHeartbeatWatchdog();

      if (!this.connectDeferred.isSettled) this.connectDeferred.resolve();
    });

    this.webSocket.addEventListener('error', err => {
      if (!this.connectDeferred.isSettled) {
        this.connectDeferred.reject(err);
      }

      // If the connection errors after being established, fail all in-flight requests.
      for (const [id, waiter] of this.messageWaiters.entries()) {
        waiter.reject(new Error(`BotWsClient WebSocket error (request id: ${id})`));
      }
      this.messageWaiters.clear();

      console.error('WebSocket error:', err);
      this.emitConnectionLostOnce({ source: 'error' });

      // Many browsers will emit 'error' and then 'close'. Schedule reconnect here too for safety.
      this.scheduleReconnect();
    });

    this.webSocket.addEventListener('close', event => {
      this.stopHeartbeatWatchdog();
      this.emitConnectionLostOnce({ source: 'close', code: event.code, reason: event.reason || 'n/a' });

      if (!this.connectDeferred.isSettled) {
        this.connectDeferred.reject(
          new Error(
            `BotWsClient WebSocket closed before connect (code: ${event.code}, reason: ${event.reason || 'n/a'})`,
          ),
        );
      }

      // Reject any pending RPC calls so callers don't hang until timeout.
      for (const [id, waiter] of this.messageWaiters.entries()) {
        waiter.reject(
          new Error(
            `BotWsClient WebSocket closed (request id: ${id}, code: ${event.code}, reason: ${event.reason || 'n/a'})`,
          ),
        );
      }
      this.messageWaiters.clear();

      this.scheduleReconnect();
    });

    this.webSocket.addEventListener('message', (event: MessageEvent) => {
      try {
        const response: JsonRpcResponse = JsonExt.parse(event.data);
        if ('id' in response && this.messageWaiters.has(response.id)) {
          const waiter = this.messageWaiters.get(response.id);
          this.messageWaiters.delete(response.id);
          if (!waiter) {
            console.warn('[BotWsClient] No waiter found for request ID:', response.id);
            return;
          }
          if ('error' in response) {
            waiter.reject(new Error(response.error.message));
          } else {
            waiter.resolve(response.result);
          }
        } else {
          if ('data' in response && 'event' in response) {
            if (response.event === '/heartbeat') {
              this.lastHeartbeatAt = Date.now();
            }
            this.events.emit(response.event as any, response.data);
          } else {
            console.warn('[BotWsClient] Unhandled WebSocket message:', response);
          }
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;

    // Exponential backoff with a little jitter.
    const exponentialDelay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempt),
    );
    const jitterMultiplier = 0.8 + Math.random() * 0.4;
    const delayMs = Math.max(0, Math.floor(exponentialDelay * jitterMultiplier));

    this.reconnectAttempt += 1;

    // If callers are awaiting readiness, make sure they are awaiting a fresh deferred.
    if (this.connectDeferred.isSettled && this.webSocket.readyState !== WebSocket.OPEN) {
      this.connectDeferred = createDeferred<void>();
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;

      // If we already reconnected in the meantime, do nothing.
      if (this.webSocket.readyState === WebSocket.OPEN || this.webSocket.readyState === WebSocket.CONNECTING) {
        return;
      }

      this.beginConnect();
    }, delayMs);
  }

  private async ensureConnected(): Promise<void> {
    if (this.webSocket.readyState === WebSocket.OPEN) return;

    // If we're closed or closing, nudge the reconnect loop.
    if (this.webSocket.readyState === WebSocket.CLOSED || this.webSocket.readyState === WebSocket.CLOSING) {
      this.scheduleReconnect();
    }

    // If connectDeferred has already been rejected/settled, replace it so awaiting doesn't immediately throw.
    if (this.connectDeferred.isSettled && this.webSocket.readyState !== WebSocket.OPEN) {
      this.connectDeferred = createDeferred<void>();
      this.scheduleReconnect();
    }

    await this.connectDeferred.promise;
  }

  public async fetch<K extends IBotApiMethod>(
    method: K,
    ...params: Parameters<IBotApiSpec[K]>
  ): Promise<Awaited<ReturnType<IBotApiSpec[K]>>> {
    await this.ensureConnected();

    if (this.webSocket.readyState !== WebSocket.OPEN) {
      throw new Error(`BotWsClient WebSocket is not open (readyState: ${this.webSocket.readyState})`);
    }

    const requestId = this.requestIdCounter++;
    const requestPayload = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    };
    const deferred = createDeferred<Awaited<ReturnType<IBotApiSpec[K]>>>();
    const timeoutId = setTimeout(() => {
      if (!deferred.isSettled) deferred.reject(new Error(`BotWsClient request timed out for method: ${method}`));
    }, 10e3);

    this.messageWaiters.set(requestId, deferred);

    try {
      this.webSocket.send(JsonExt.stringify(requestPayload));
    } catch (error) {
      this.messageWaiters.delete(requestId);
      deferred.reject(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      return await deferred.promise;
    } finally {
      clearTimeout(timeoutId);
      this.messageWaiters.delete(requestId);
    }
  }
}
