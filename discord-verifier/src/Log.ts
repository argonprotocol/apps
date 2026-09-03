import type { NextFunction, Request, Response } from 'express';

type LogFields = Record<string, boolean | number | string | undefined>;

export function logApiRequests(request: Request, response: Response, next: NextFunction): void {
  if (request.path !== '/health') {
    const startedAt = performance.now();
    response.once('finish', () => {
      logInfo('api_request', {
        method: request.method,
        path: request.path,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  }
  next();
}

export function logInfo(event: string, fields: LogFields = {}): void {
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', event, ...fields }));
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  const detail = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error);
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event,
      ...fields,
      error: redact(detail),
    }),
  );
}

function redact(value: string): string {
  return value
    .replace(/ARGON-[0-9a-f]{32}/gi, '[verification code]')
    .replace(/0x[0-9a-f]{64,}/gi, '[hex value]')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{40,64}\b/g, '[account]');
}
