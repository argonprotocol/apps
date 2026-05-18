import type { Response } from 'express';
import { JsonExt } from '@argonprotocol/apps-core';
import { HttpError } from './HttpError.ts';

export function requireBody<T>(body: unknown): T {
  if (!body) {
    throw new HttpError('Missing JSON body', 400);
  }

  return JsonExt.parse<T>(String(body));
}

export async function safeJsonRoute(res: Response, handler: () => Promise<unknown>): Promise<void> {
  try {
    sendJson(res, await handler());
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, { error: message }, status);
  }
}

export function sendJson(res: Response, data: unknown, status = 200): void {
  res.status(status).type('application/json').send(JsonExt.stringify(data));
}
