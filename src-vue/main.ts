import { debug, error, info, LogOptions, warn } from '@tauri-apps/plugin-log';
import { createApp, toRaw } from 'vue';
import { createPinia } from 'pinia';
import dayjs from 'dayjs';
import App from './App.vue';
import './main.css';
import { JsonExt } from '@argonprotocol/apps-core';

function safeStringify(value: any): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';

  try {
    value = toRaw(value);
  } catch (_e) {
    // ignore; keep original value
  }

  // Prefer rich error output over JSON-ish output.
  if (value instanceof Error) {
    const name = value.name || 'Error';
    const msg = value.message || '';
    const stack = typeof value.stack === 'string' && value.stack.length > 0 ? `\n${value.stack}` : '';
    // `cause` is increasingly common and very useful.
    const cause = (value as any).cause;
    const causeStr = cause !== undefined ? `\nCaused by: ${safeStringify(cause)}` : '';
    return `${name}${msg ? `: ${msg}` : ''}${stack}${causeStr}`;
  }

  // DOMException isn't an Error in all environments.
  if (typeof DOMException !== 'undefined' && value instanceof DOMException) {
    const name = (value as any).name || 'DOMException';
    const msg = (value as any).message || '';
    return `${name}${msg ? `: ${msg}` : ''}`;
  }

  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();

  // Best-effort structured stringify (handles bigint/Uint8Array etc via JsonExt).
  try {
    return JsonExt.stringify(value);
  } catch (_e) {
    try {
      return String(value);
    } catch (_e2) {
      return '[unserializable data]';
    }
  }
}

function forwardConsole(
  fnName: 'log' | 'debug' | 'info' | 'warn' | 'error',
  backendLogger: (message: string, options?: LogOptions) => Promise<void>,
) {
  const original = console[fnName];
  console[fnName] = (message: any, ...args: any[]) => {
    const ts = dayjs().local().format('HH:mm:ss.SSS');
    original(`[${ts}]`, message, ...args);

    let msg = safeStringify(message);

    for (const arg of args) {
      if (arg !== undefined) msg += ` -- ${safeStringify(arg)}`;
    }

    void backendLogger(msg);
  };
}

forwardConsole('log', debug);
forwardConsole('debug', debug);
forwardConsole('info', info);
forwardConsole('warn', warn);
forwardConsole('error', error);

window.addEventListener('unhandledrejection', error => {
  console.error('Unhandled promise rejection:', error.reason);
});

window.addEventListener('error', error => {
  const file = error.filename ?? '<unknown>';
  const line = error.lineno ?? '?';
  const col = error.colno ?? '?';

  console.error(`[${file}:${line}:${col}] Unhandled error: ${error.message}`, error.error);
});

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
  console.error(`Vue error: ${info}`, err);
};
app.use(createPinia());
app.mount('#app');
