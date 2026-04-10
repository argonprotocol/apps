import { readFile } from 'node:fs/promises';
import { JsonExt } from '@argonprotocol/apps-core';
import { BITCOIN_RPC_URL } from './env';
import type { IJsonRpcResponse } from './interfaces/IJsonRpcResponse';

let requestId = 1;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function getRoundedPercent(num: number, decimals = 1): number {
  const factor = Math.pow(10, decimals);

  const percent = Math.floor(100 * num * factor) / factor;
  return Math.min(percent, 100);
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers();
  const initHeaders = init.headers;

  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => headers.set(key, value));
  } else if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) {
      headers.set(key, value);
    }
  } else if (initHeaders) {
    for (const [key, value] of Object.entries(initHeaders)) {
      if (value !== undefined) headers.set(key, String(value));
    }
  }

  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return new Response(JsonExt.stringify(data), {
    ...init,
    headers,
  });
}

export function safeJsonRoute(handler: (req: Request) => Promise<any>): (req: Request) => Promise<Response> {
  return async req => {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    try {
      const data = await handler(req);
      if (data && data instanceof Response) {
        Object.entries(CORS_HEADERS).forEach(([key, value]) => data.headers.set(key, value));
        return data;
      }
      return jsonResponse(data, {
        headers: CORS_HEADERS,
      });
    } catch (err) {
      console.error('Route error:', err);
      return jsonResponse({ error: String(err) }, { status: 500, headers: CORS_HEADERS });
    }
  };
}

export async function callBitcoinRpc<T = unknown>(method: string, ...params: any[]): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: '1.0',
    id: requestId++,
    method,
    params,
  });
  const url = new URL(BITCOIN_RPC_URL!);
  const login = `${url.username}:${url.password}`;
  url.username = '';
  url.password = '';

  const res = await fetch(url.href, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(login).toString('base64')}`,
    },
    body,
  });

  if (!res.ok) throw new Error(`Bitcoin RPC HTTP error ${res.status}`);
  const json = (await res.json()) as { error?: unknown; result: T };

  if (json.error) throw new Error(`Bitcoin RPC error ${JSON.stringify(json.error)}`);
  return json.result;
}

export async function callArgonRpc<T = unknown>(
  url: string,
  method: string,
  params: any[] = [],
): Promise<IJsonRpcResponse<T>> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: requestId++,
    method,
    params,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  return (await res.json()) as IJsonRpcResponse<T>;
}

export async function readTextFileOrDefault(path: string, defaultValue = '0'): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return defaultValue;
  }
}
