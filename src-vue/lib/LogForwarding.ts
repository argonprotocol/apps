import { debug, error, info, LogOptions, warn } from '@tauri-apps/plugin-log';
import { toRaw } from 'vue';
import dayjs from 'dayjs';
import { u8aToHex } from '@argonprotocol/mainchain';

function forwardConsole(
  fnName: 'log' | 'debug' | 'info' | 'warn' | 'error',
  backendLogger: (message: string, options?: LogOptions) => Promise<void>,
) {
  const original = console[fnName];
  console[fnName] = (message: any, ...args: any[]) => {
    const ts = dayjs().local().format('HH:mm:ss.SSS');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    args = args.map(arg => safeRaw(arg));
    message = safeRaw(message);
    original(`[${ts}]`, message, ...args);

    let msg = safeStringify(message);

    for (const arg of args) {
      if (arg !== undefined) msg += ` | ${safeStringify(arg)}`;
    }

    void backendLogger(msg);
  };
}

forwardConsole('log', debug);
forwardConsole('debug', debug);
forwardConsole('info', info);
forwardConsole('warn', warn);
forwardConsole('error', error);

function safeRaw<T>(value: T): T {
  try {
    return toRaw(value);
  } catch (_e) {
    return value;
  }
}

function safeStringify(value: any): string {
  value = safeRaw(value);

  // Best-effort structured stringify (handles bigint/Uint8Array etc via JsonExt).
  try {
    return JSON.stringify(
      value,
      (key, v) => {
        if (v === undefined) return 'undefined';
        if (v === null) return 'null';
        if (typeof v === 'string') return v;
        if (typeof v === 'number') {
          if (Number.isNaN(v)) return 'NaN';
          if (v === Infinity) return 'Infinity';
          if (v === -Infinity) return '-Infinity';
          return v;
        }
        if (typeof v === 'bigint') return `${v}n`; // Append 'n' to indicate BigInt
        if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
        if (typeof v === 'symbol') return v.toString();

        // Prefer rich error output over JSON-ish output.
        if (v instanceof Error) {
          const name = v.name || 'Error';
          const msg = v.message || '';
          const stack = typeof v.stack === 'string' && v.stack.length > 0 ? `\n${v.stack}` : '';
          // `cause` is increasingly common and very useful.
          const cause = (v as any).cause;
          const causeStr = cause !== undefined ? `\nCaused by: ${String(cause)}` : '';
          return `${name}${msg ? `: ${msg}` : ''}${stack}${causeStr}`;
        }

        // DOMException isn't an Error in all environments.
        if (typeof DOMException !== 'undefined' && v instanceof DOMException) {
          const name = (v as any).name || 'DOMException';
          const msg = (v as any).message || '';
          return `${name}${msg ? `: ${msg}` : ''}`;
        }

        if (typeof v === 'object' && 'toHuman' in v && typeof v.toHuman === 'function') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return,@typescript-eslint/no-unsafe-call
            return v.toHuman();
          } catch (_e) {
            // ignore
          }
        }
        if (v instanceof Uint8Array) return u8aToHex(v);
        if (key.startsWith('_')) return '[hidden]';

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return v;
      },
      2,
    );
  } catch (_e) {
    try {
      return String(value);
    } catch (_e2) {
      return '[unserializable data]';
    }
  }
}
