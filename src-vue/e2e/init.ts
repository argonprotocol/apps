import { LOGGABLE_ARG_KEYS, runCommand } from './commands';

const ALLOWED_DRIVER_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

type UnknownObject = Record<string, unknown>;
type DriverCommandPayload = {
  type: 'driver.command';
  id: string;
  command?: string;
  method?: string;
  args?: unknown;
  session?: string;
};
type E2EWindow = Window & {
  __ARGON_E2E_CLIPBOARD__?: string;
  __ARGON_E2E_CLIPBOARD_PATCHED__?: boolean;
};
function installClipboardShim(): void {
  const e2eWindow = window as E2EWindow;
  if (e2eWindow.__ARGON_E2E_CLIPBOARD_PATCHED__) return;

  const clipboard = navigator.clipboard as Clipboard & {
    writeText?: (text: string) => Promise<void>;
    readText?: () => Promise<string>;
  };
  if (!clipboard?.writeText || !clipboard?.readText) return;

  const originalWriteText = clipboard.writeText.bind(clipboard);
  const originalReadText = clipboard.readText.bind(clipboard);

  clipboard.writeText = async (text: string): Promise<void> => {
    e2eWindow.__ARGON_E2E_CLIPBOARD__ = text;
    try {
      await originalWriteText(text);
    } catch {
      // Keep fallback clipboard in-memory for e2e command reads.
    }
  };

  clipboard.readText = async (): Promise<string> => {
    try {
      const text = await originalReadText();
      e2eWindow.__ARGON_E2E_CLIPBOARD__ = text;
      return text;
    } catch {
      return e2eWindow.__ARGON_E2E_CLIPBOARD__ ?? '';
    }
  };

  e2eWindow.__ARGON_E2E_CLIPBOARD_PATCHED__ = true;
}

function parseDriverUrl(raw: string): URL | null {
  const value = raw.trim();
  if (!value) return null;

  try {
    return new URL(value);
  } catch (error) {
    console.error('[E2E] Invalid ARGON_DRIVER_WS URL', error);
    return null;
  }
}

function hasRequiredAuth(url: URL): boolean {
  const session = url.searchParams.get('session')?.trim();
  return Boolean(session);
}

function isSupportedDriverUrl(url: URL): boolean {
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false;
  return ALLOWED_DRIVER_HOSTS.has(url.hostname);
}

function sendMessage(socket: WebSocket, payload: UnknownObject): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function isDriverCommandPayload(payload: UnknownObject): payload is DriverCommandPayload {
  return payload.type === 'driver.command' && typeof payload.id === 'string';
}

function summarizeCommandArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const source = args as UnknownObject;
  const parts: string[] = [];
  for (const key of LOGGABLE_ARG_KEYS) {
    const value = source[key];
    if (value == null) continue;
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    parts.push(`${key}=${String(value)}`);
  }
  if (typeof source.text === 'string') {
    parts.push(`textLength=${source.text.length}`);
  }
  return parts.join(' ');
}

async function onDriverMessage(socket: WebSocket, data: string, session: string): Promise<void> {
  let payload: UnknownObject;
  try {
    payload = JSON.parse(data) as UnknownObject;
  } catch (error) {
    console.warn('[E2E] Ignoring non-JSON driver message', error);
    return;
  }

  if (payload.type === 'driver.ping') {
    sendMessage(socket, { type: 'client.pong', now: Date.now() });
    return;
  }

  if (isDriverCommandPayload(payload)) {
    if (payload.session && payload.session !== session) {
      const command = payload.command ?? payload.method;
      sendMessage(socket, {
        type: 'client.commandResult',
        id: payload.id,
        ...(typeof command === 'string' ? { command } : {}),
        ok: false,
        error: {
          code: 'session_mismatch',
          message: `Command session '${payload.session}' does not match active session`,
        },
      });
      return;
    }

    const command = payload.command ?? payload.method;
    if (!command || typeof command !== 'string') {
      sendMessage(socket, {
        type: 'client.commandResult',
        id: payload.id,
        ok: false,
        error: {
          code: 'invalid_command',
          message: `Missing command name`,
        },
      });
      return;
    }

    const commandSummary = summarizeCommandArgs(payload.args);
    const summarySuffix = commandSummary ? ` ${commandSummary}` : '';
    const startedAt = Date.now();
    sendMessage(socket, {
      type: 'client.event',
      event: 'driver.command.received',
      id: payload.id,
      command,
      summary: commandSummary,
    });
    console.info(`[E2E] <- ${command} (${payload.id})${summarySuffix}`);
    const result = await runCommand(command, payload.args ?? {}, {
      session,
      emit: eventPayload => sendMessage(socket, eventPayload),
    });
    const elapsedMs = Date.now() - startedAt;
    sendMessage(socket, {
      type: 'client.event',
      event: 'driver.command.completed',
      id: payload.id,
      command,
      ok: result.ok,
      elapsedMs,
    });
    console.info(`[E2E] -> result ${command} (${payload.id}) ok=${result.ok} elapsedMs=${elapsedMs}`);
    sendMessage(socket, {
      type: 'client.commandResult',
      id: payload.id,
      command,
      ...result,
    });
  }
}

export function initE2EClient(): void {
  const driverUrl = parseDriverUrl(__ARGON_DRIVER_WS__);
  if (!driverUrl) return;

  if (!isSupportedDriverUrl(driverUrl)) {
    console.error('[E2E] ARGON_DRIVER_WS must use localhost/127.0.0.1 and ws:// or wss://');
    return;
  }
  if (!hasRequiredAuth(driverUrl)) {
    console.error('[E2E] ARGON_DRIVER_WS must include session query param');
    return;
  }

  const session = driverUrl.searchParams.get('session');
  if (!session) return;

  installClipboardShim();

  const socket = new WebSocket(driverUrl.toString());
  let hasOpened = false;
  let hasClosed = false;
  socket.addEventListener('open', () => {
    hasOpened = true;
    sendMessage(socket, {
      type: 'client.hello',
      appId: __ARGON_APP_ID__,
      appName: __ARGON_APP_NAME__,
      instance: __ARGON_APP_INSTANCE__,
      network: __ARGON_NETWORK_NAME__,
      session,
    });
    console.info('[E2E] Driver connected');
  });
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    void onDriverMessage(socket, event.data, session);
  });
  socket.addEventListener('close', event => {
    hasClosed = true;
    const reason = event.reason ? ` reason=${event.reason}` : '';
    console.info(`[E2E] Driver disconnected (${event.code})${reason}`);
  });
  socket.addEventListener('error', event => {
    // During e2e teardown the driver may be stopped before the app exits.
    // Treat post-open socket errors as expected disconnect noise.
    if (hasClosed || hasOpened) {
      console.info('[E2E] Driver socket closed during teardown');
      return;
    }
    const targetState =
      typeof event.target === 'object' && event.target && 'readyState' in event.target
        ? (event.target as WebSocket).readyState
        : 'unknown';
    console.error(`[E2E] Driver connection error before open (readyState=${String(targetState)})`);
  });
}
