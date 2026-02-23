import { WebSocket, type RawData } from 'ws';

type UnknownRecord = Record<string, unknown>;
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function summarizeArgs(args: UnknownRecord | undefined): string {
  if (!args) return '';
  const parts: string[] = [];
  for (const key of ['testId', 'selector', 'state', 'timeoutMs', 'index', 'attribute']) {
    const value = args[key];
    if (value == null) continue;
    parts.push(`${key}=${String(value)}`);
  }
  if (typeof args.text === 'string') {
    parts.push(`textLength=${args.text.length}`);
  }
  return parts.join(' ');
}

export class DriverClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private appHello: UnknownRecord | null = null;
  private appHelloWaiters: Array<() => void> = [];
  private messageBuffer: UnknownRecord[] = [];
  private frontendErrors: string[] = [];
  private readonly commandTimeoutMs: number;

  constructor(private readonly url: string) {
    const timeout = Number(process.env.E2E_DRIVER_COMMAND_TIMEOUT_MS ?? DEFAULT_COMMAND_TIMEOUT_MS);
    this.commandTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_COMMAND_TIMEOUT_MS;
  }

  public getUrl(): string {
    return this.url;
  }

  public getFrontendErrors(): string[] {
    return [...this.frontendErrors];
  }

  public async connect(): Promise<void> {
    if (this.socket) return;
    console.info(`[E2E] Connecting to driver at ${this.url}`);
    this.socket = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      if (!this.socket) return reject(new Error('Socket not initialized'));
      this.socket.on('open', () => resolve());
      this.socket.on('error', (err: Error) => reject(err));
    });

    this.socket.on('message', (data: RawData) => {
      let payload: UnknownRecord;
      try {
        payload = JSON.parse(data.toString()) as UnknownRecord;
      } catch (_error) {
        return;
      }

      if (payload.type === 'client.hello') {
        this.appHello = payload;
        this.appHelloWaiters.forEach(fn => fn());
        this.appHelloWaiters = [];
        console.info('[E2E] Received app hello');
        return;
      }

      if (payload.type === 'client.commandResult' && typeof payload.id === 'string') {
        const pending = this.pending.get(payload.id);
        if (!pending) return;
        this.pending.delete(payload.id);
        clearTimeout(pending.timeout);
        if (payload.ok === true) {
          pending.resolve(payload.result);
        } else {
          const error = payload.error;
          const baseMessage =
            error &&
            typeof error === 'object' &&
            'message' in error &&
            typeof (error as { message?: unknown }).message === 'string'
              ? (error as { message: string }).message
              : 'Command failed';
          const code =
            error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : undefined;
          const details =
            error &&
            typeof error === 'object' &&
            'details' in error &&
            typeof (error as { details?: unknown }).details === 'object'
              ? (error as { details: unknown }).details
              : undefined;
          const message = code ? `[${code}] ${baseMessage}` : baseMessage;
          if (details) {
            pending.reject(new Error(`${message} details=${JSON.stringify(details)}`));
          } else {
            pending.reject(new Error(message));
          }
        }
        return;
      }

      if (payload.type === 'client.event') {
        this.messageBuffer.push(payload);
        const eventName =
          typeof payload.event === 'string'
            ? payload.event
            : typeof payload.name === 'string'
              ? payload.name
              : 'client.event';
        if (eventName === 'ui.wait.progress') {
          const target = typeof payload.target === 'string' ? payload.target : 'unknown-target';
          const state = typeof payload.state === 'string' ? payload.state : 'unknown-state';
          const commandLabel = typeof payload.commandLabel === 'string' ? payload.commandLabel : null;
          const commandPrefix = commandLabel ? `${commandLabel} | ` : '';
          const pointerBlocker = typeof payload.pointerBlocker === 'string' ? payload.pointerBlocker : '';
          const blockerSuffix = pointerBlocker ? ` blocker=${pointerBlocker}` : '';
          console.info(`[E2E] App wait ${commandPrefix}${state} ${target}${blockerSuffix}`);
        } else if (eventName === 'driver.command.received') {
          const command = typeof payload.command === 'string' ? payload.command : 'unknown';
          const id = typeof payload.id === 'string' ? payload.id : 'unknown';
          const summary = typeof payload.summary === 'string' && payload.summary ? ` ${payload.summary}` : '';
          console.info(`[E2E] App command received ${command} (${id})${summary}`);
        } else if (eventName === 'driver.command.completed') {
          const command = typeof payload.command === 'string' ? payload.command : 'unknown';
          const id = typeof payload.id === 'string' ? payload.id : 'unknown';
          const elapsedMs = typeof payload.elapsedMs === 'number' ? payload.elapsedMs : null;
          const elapsed = elapsedMs == null ? '' : ` elapsedMs=${elapsedMs}`;
          console.info(`[E2E] App command completed ${command} (${id}) ok=${String(payload.ok === true)}${elapsed}`);
        } else if (eventName === 'frontend.error') {
          const details = formatFrontendError(payload);
          this.frontendErrors.push(details);
          console.error(`[E2E] App event ${eventName} ${details}`);
        } else {
          console.info(`[E2E] App event ${eventName}`);
        }
      }
    });
    this.socket.on('close', (code, reason) => {
      const reasonText = reason.toString();
      const detail = reasonText ? `: ${reasonText}` : '';
      this.rejectAllPending(new Error(`Driver socket closed (${code}${detail})`));
    });
    this.socket.on('error', (error: Error) => {
      this.rejectAllPending(error);
    });

    this.send({ type: 'driver.hello' });
  }

  public async waitForApp(): Promise<UnknownRecord> {
    if (this.appHello) return this.appHello;
    return new Promise(resolve => {
      this.appHelloWaiters.push(() => resolve(this.appHello ?? {}));
    });
  }

  public async command<T = unknown>(command: string, args?: UnknownRecord): Promise<T> {
    if (!this.socket) throw new Error('Driver not connected');
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const summary = summarizeArgs(args);
    const suffix = summary ? ` ${summary}` : '';
    console.info(`[E2E] -> ${command} (${id})${suffix}`);
    const payload: UnknownRecord = {
      type: 'driver.command',
      id,
      command,
      args: args ?? {},
    };

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for '${command}' response after ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      this.pending.set(id, {
        timeout,
        resolve: value => resolve(value as T),
        reject,
      });
    });

    this.send(payload);
    return promise;
  }

  public close(): void {
    this.rejectAllPending(new Error('Driver client closed'));
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
    this.socket = null;
  }

  private send(payload: UnknownRecord): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function formatFrontendError(payload: UnknownRecord): string {
  const label = typeof payload.label === 'string' ? payload.label : 'frontend.error';
  const message = typeof payload.message === 'string' ? payload.message : 'unknown message';
  const filename = typeof payload.filename === 'string' ? ` filename=${payload.filename}` : '';
  const line = typeof payload.line === 'number' ? ` line=${payload.line}` : '';
  const column = typeof payload.column === 'number' ? ` column=${payload.column}` : '';
  const stack = typeof payload.stack === 'string' ? ` stack=${payload.stack}` : '';
  return `[${label}] ${message}${filename}${line}${column}${stack}`;
}
