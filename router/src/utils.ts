import { readFile } from 'node:fs/promises';
import * as Http from 'node:http';
import * as Https from 'node:https';
import { JsonExt } from '@argonprotocol/apps-core';
import { BITCOIN_RPC_URL } from './env';
import type { IJsonRpcResponse } from './interfaces/IJsonRpcResponse';

let requestId = 1;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
  const rpcUrl = new URL(url);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: requestId++,
    method,
    params,
  });

  const localServicePort = rpcUrl.port || (rpcUrl.protocol === 'https:' ? '443' : '80');
  const localServiceHostHeader = rpcUrl.hostname === 'argon-miner' ? `localhost:${localServicePort}` : undefined;
  const request = rpcUrl.protocol === 'https:' ? Https.request : Http.request;
  const path = `${rpcUrl.pathname || '/'}${rpcUrl.search}`;

  const response = await new Promise<Http.IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        hostname: rpcUrl.hostname,
        port: rpcUrl.port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(localServiceHostHeader ? { Host: localServiceHostHeader } : {}),
        },
      },
      resolve,
    );
    req.on('error', reject);
    req.end(body);
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`HTTP error ${response.statusCode}`);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return JsonExt.parse<IJsonRpcResponse<T>>(raw);
}

export async function readTextFileOrDefault(path: string, defaultValue = '0'): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return defaultValue;
  }
}
