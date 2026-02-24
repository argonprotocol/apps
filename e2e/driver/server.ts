import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

type UnknownRecord = Record<string, unknown>;
const DRIVER_TRACE_ENABLED = (process.env.E2E_DRIVER_TRACE ?? '0').trim() !== '0';

export interface DriverServer {
  url: string;
  session: string;
  close: () => Promise<void>;
}

type ClientRole = 'app' | 'controller' | 'unknown';
const PENDING_COMMAND_TIMEOUT_MS = Number(process.env.E2E_DRIVER_PENDING_TIMEOUT_MS ?? 120_000);
const COMMAND_RECEIVED_TIMEOUT_MS = Number(process.env.E2E_DRIVER_RECEIVED_TIMEOUT_MS ?? 5_000);

interface PendingCommand {
  controller: WebSocket;
  commandId: string;
  commandName: string;
  argsSummary: UnknownRecord;
  startedAt: number;
  receivedAt: number | null;
  timeoutMs: number;
  timeout: ReturnType<typeof setTimeout>;
  receivedTimeout: ReturnType<typeof setTimeout> | null;
}

function formatLogValue(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (value == null) {
    return 'null';
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof Buffer) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

function readCommandTimeoutMs(payload: UnknownRecord): number | undefined {
  const args = payload.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const rawTimeoutMs = (args as UnknownRecord).timeoutMs;
  if (typeof rawTimeoutMs !== 'number' || !Number.isFinite(rawTimeoutMs) || rawTimeoutMs <= 0) {
    return undefined;
  }
  return rawTimeoutMs;
}

function readCommandName(payload: UnknownRecord): string {
  if (typeof payload.command === 'string') return payload.command;
  if (typeof payload.method === 'string') return payload.method;
  return 'unknown';
}

function resolvePendingTimeoutMs(payload: UnknownRecord): number {
  const commandTimeoutMs = readCommandTimeoutMs(payload);
  if (!commandTimeoutMs) return PENDING_COMMAND_TIMEOUT_MS;
  const commandName = readCommandName(payload);
  const isUiCommand = commandName.startsWith('ui.');
  const jitterBufferMs = isUiCommand ? 5_000 : 15_000;
  const minimumTimeoutMs = isUiCommand ? 8_000 : 10_000;
  const minimumReceivedWindowMs = COMMAND_RECEIVED_TIMEOUT_MS + 5_000;
  // Allow small transport/UI scheduling jitter above the app-level timeout.
  return Math.max(commandTimeoutMs + jitterBufferMs, minimumTimeoutMs, minimumReceivedWindowMs);
}

function summarizeCommandArgs(payload: UnknownRecord): UnknownRecord {
  const args = payload.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};

  const source = args as UnknownRecord;
  const summary: UnknownRecord = {};
  for (const key of ['__operationName', 'testId', 'selector', 'state', 'timeoutMs', 'index', 'attribute']) {
    if (key in source) {
      summary[key] = source[key];
    }
  }
  if (typeof source.text === 'string') {
    summary.textLength = source.text.length;
  }
  return summary;
}

function formatArgsSummary(summary: UnknownRecord): string {
  const entries = Object.entries(summary);
  if (!entries.length) return '';
  return entries.map(([key, value]) => `${key}=${formatLogValue(value)}`).join(' ');
}

function summarizeLastAppEvent(lastAppEvent: UnknownRecord | null): UnknownRecord | null {
  if (!lastAppEvent) return null;
  const summary: UnknownRecord = {};
  for (const key of ['event', 'name', 'id', 'command', 'target', 'state', 'elapsedMs', 'ok']) {
    if (!(key in lastAppEvent)) continue;
    summary[key] = lastAppEvent[key];
  }
  if (Object.keys(summary).length > 0) {
    return summary;
  }
  return lastAppEvent;
}

function logDriverTrace(message: string): void {
  if (!DRIVER_TRACE_ENABLED) return;
  console.info(message);
}

function send(socket: WebSocket, payload: UnknownRecord) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export async function startDriverServer(): Promise<DriverServer> {
  const session = randomUUID();
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: Error) => reject(err));
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind driver server');
  }

  const url = new URL(`ws://127.0.0.1:${address.port}/control`);
  url.searchParams.set('session', session);
  console.info(`[E2E] Driver server listening at ${url.toString()}`);

  const wss = new WebSocketServer({ server, path: '/control' });
  let appSocket: WebSocket | null = null;
  let controllerSocket: WebSocket | null = null;
  let lastHello: UnknownRecord | null = null;
  let lastAppMessageAt: number | null = null;
  let lastAppEventAt: number | null = null;
  let lastAppEvent: UnknownRecord | null = null;
  const pendingCommands = new Map<string, PendingCommand>();

  const buildPendingDiagnostics = (pending: PendingCommand, extra: UnknownRecord = {}): UnknownRecord => {
    const now = Date.now();
    return {
      commandId: pending.commandId,
      command: pending.commandName,
      elapsedMs: now - pending.startedAt,
      timeoutMs: pending.timeoutMs,
      receivedAt: pending.receivedAt,
      args: pending.argsSummary,
      appConnected: !!appSocket && appSocket.readyState === WebSocket.OPEN,
      appSocketState: appSocket?.readyState ?? null,
      controllerSocketState: controllerSocket?.readyState ?? null,
      pendingCount: pendingCommands.size,
      sinceLastAppMessageMs: lastAppMessageAt ? now - lastAppMessageAt : null,
      sinceLastAppEventMs: lastAppEventAt ? now - lastAppEventAt : null,
      lastAppEvent: summarizeLastAppEvent(lastAppEvent),
      ...extra,
    };
  };

  const clearPendingCommand = (commandId: string): void => {
    const pending = pendingCommands.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    if (pending.receivedTimeout) {
      clearTimeout(pending.receivedTimeout);
    }
    pendingCommands.delete(commandId);
  };

  const failPendingCommand = (
    pending: PendingCommand,
    code: string,
    message: string,
    details?: UnknownRecord,
  ): void => {
    clearTimeout(pending.timeout);
    if (pending.receivedTimeout) {
      clearTimeout(pending.receivedTimeout);
    }
    pendingCommands.delete(pending.commandId);
    send(pending.controller, {
      type: 'client.commandResult',
      id: pending.commandId,
      ok: false,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    });
  };

  const failPendingForController = (controller: WebSocket, code: string, message: string): void => {
    for (const pending of [...pendingCommands.values()]) {
      if (pending.controller !== controller) continue;
      failPendingCommand(pending, code, message);
    }
  };

  const failAllPending = (
    code: string,
    message: string,
    detailsForPending?: (pending: PendingCommand) => UnknownRecord | undefined,
  ): void => {
    for (const pending of [...pendingCommands.values()]) {
      failPendingCommand(pending, code, message, detailsForPending?.(pending));
    }
  };

  const closeAll = async () => {
    failAllPending('driver_closed', 'Driver server closed before command completed');
    for (const socket of [appSocket, controllerSocket]) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    }
    await new Promise<void>((resolve, reject) => {
      wss.close(err => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  };

  wss.on('connection', (socket: WebSocket, req: http.IncomingMessage) => {
    console.info('[E2E] Driver socket connected');
    const reqUrl = req.url ? new URL(req.url, url) : null;
    if (!reqUrl) {
      socket.close();
      return;
    }

    const reqSession = reqUrl.searchParams.get('session');
    if (reqSession !== session) {
      socket.close();
      return;
    }

    let role: ClientRole = 'unknown';

    socket.on('message', (raw: RawData) => {
      let payload: UnknownRecord;
      try {
        payload = JSON.parse(rawDataToString(raw)) as UnknownRecord;
      } catch (_error) {
        return;
      }

      if (payload.type === 'client.hello') {
        role = 'app';
        appSocket = socket;
        lastHello = payload;
        lastAppMessageAt = Date.now();
        console.info('[E2E] App connected to driver');
        if (controllerSocket) {
          send(controllerSocket, payload);
        }
        return;
      }

      if (payload.type === 'driver.hello') {
        role = 'controller';
        controllerSocket = socket;
        console.info('[E2E] Controller connected to driver');
        if (lastHello) {
          send(controllerSocket, lastHello);
        }
        return;
      }

      if (payload.type === 'driver.command' && role === 'controller') {
        const commandName =
          typeof payload.command === 'string'
            ? payload.command
            : typeof payload.method === 'string'
              ? payload.method
              : 'unknown';
        const commandId = typeof payload.id === 'string' ? payload.id : 'unknown';
        const argsSummary = summarizeCommandArgs(payload);
        const summaryText = formatArgsSummary(argsSummary);
        const summarySuffix = summaryText ? ` ${summaryText}` : '';
        logDriverTrace(`[E2E] Forwarding command ${commandName} (${commandId})${summarySuffix}`);
        if (!appSocket || appSocket.readyState !== WebSocket.OPEN) {
          const details: UnknownRecord = {
            commandId: typeof payload.id === 'string' ? payload.id : null,
            command: commandName,
            args: argsSummary,
            appSocketState: appSocket?.readyState ?? null,
            controllerSocketState: controllerSocket?.readyState ?? null,
            pendingCount: pendingCommands.size,
            sinceLastAppMessageMs: lastAppMessageAt ? Date.now() - lastAppMessageAt : null,
            sinceLastAppEventMs: lastAppEventAt ? Date.now() - lastAppEventAt : null,
            lastAppEvent: summarizeLastAppEvent(lastAppEvent),
          };
          console.warn('[E2E] Rejecting command because app is not connected', details);
          send(socket, {
            type: 'client.commandResult',
            id: payload.id,
            ok: false,
            error: {
              code: 'app_not_connected',
              message: 'App is not connected to the driver',
              details,
            },
          });
          return;
        }
        if (typeof payload.id === 'string') {
          clearPendingCommand(payload.id);
          const pendingTimeoutMs = resolvePendingTimeoutMs(payload);
          const startedAt = Date.now();
          const receivedTimeout = setTimeout(() => {
            const pending = pendingCommands.get(payload.id as string);
            if (!pending || pending.receivedAt) return;
            const details = buildPendingDiagnostics(pending, {
              receivedTimeoutMs: COMMAND_RECEIVED_TIMEOUT_MS,
            });
            console.warn('[E2E] Driver command was not acknowledged by app', details);
            failPendingCommand(
              pending,
              'app_command_not_received',
              `App did not acknowledge '${pending.commandName}' within ${COMMAND_RECEIVED_TIMEOUT_MS}ms (likely UI thread stall)`,
              details,
            );
          }, COMMAND_RECEIVED_TIMEOUT_MS);
          const timeout = setTimeout(() => {
            const pending = pendingCommands.get(payload.id as string);
            if (!pending) return;
            const details = buildPendingDiagnostics(pending);
            console.warn('[E2E] Driver command timeout', details);
            failPendingCommand(
              pending,
              'driver_command_timeout',
              `Driver did not receive a response for '${pending.commandName}' within ${pending.timeoutMs}ms (elapsed=${String(
                details.elapsedMs,
              )}ms, appConnected=${String(
                details.appConnected,
              )}, sinceLastAppMessageMs=${String(details.sinceLastAppMessageMs)})`,
              details,
            );
          }, pendingTimeoutMs);
          pendingCommands.set(payload.id, {
            controller: socket,
            commandId: payload.id,
            commandName,
            argsSummary,
            startedAt,
            receivedAt: null,
            timeoutMs: pendingTimeoutMs,
            timeout,
            receivedTimeout,
          });
        }
        send(appSocket, payload);
        return;
      }

      if ((payload.type === 'client.commandResult' || payload.type === 'client.event') && role === 'app') {
        lastAppMessageAt = Date.now();
        if (payload.type === 'client.commandResult') {
          const commandId = typeof payload.id === 'string' ? payload.id : 'unknown';
          const commandFromPayload = typeof payload.command === 'string' ? payload.command : null;
          let commandFromPending: string | null = null;
          if (typeof payload.id === 'string') {
            const pending = pendingCommands.get(payload.id);
            commandFromPending = pending?.commandName ?? null;
            clearPendingCommand(payload.id);
          }
          const commandName = commandFromPayload ?? commandFromPending ?? 'unknown';
          const ok = payload.ok === true;
          logDriverTrace(`[E2E] Received command result ${commandName} (${commandId}) ok=${ok}`);
        }
        if (payload.type === 'client.event') {
          lastAppEventAt = Date.now();
          lastAppEvent = payload;
          const eventName =
            typeof payload.event === 'string'
              ? payload.event
              : typeof payload.name === 'string'
                ? payload.name
                : 'client.event';
          if (eventName === 'driver.command.received' && typeof payload.id === 'string') {
            const pending = pendingCommands.get(payload.id);
            if (pending && !pending.receivedAt) {
              pending.receivedAt = Date.now();
              if (pending.receivedTimeout) {
                clearTimeout(pending.receivedTimeout);
                pending.receivedTimeout = null;
              }
            }
          }
          if (
            eventName !== 'driver.command.received' &&
            eventName !== 'driver.command.completed' &&
            eventName !== 'ui.wait.progress'
          ) {
            logDriverTrace(`[E2E] App event (${eventName})`);
          }
        }
        if (controllerSocket) {
          send(controllerSocket, payload);
        }
        return;
      }
    });

    socket.on('close', (closeCode, closeReasonBuffer) => {
      const closeReason = closeReasonBuffer.toString();
      console.info(
        `[E2E] Driver socket closed (role=${role}, code=${closeCode}${closeReason ? ` reason=${closeReason}` : ''})`,
      );
      if (role === 'app') {
        failAllPending('app_disconnected', 'App disconnected from driver before command completed', pending =>
          buildPendingDiagnostics(pending, {
            socketCloseCode: closeCode,
            socketCloseReason: closeReason || null,
          }),
        );
        appSocket = null;
      }
      if (role === 'controller') {
        failPendingForController(socket, 'controller_disconnected', 'Controller disconnected before command completed');
        controllerSocket = null;
      }
    });
  });

  return {
    url: url.toString(),
    session,
    close: closeAll,
  };
}
