export type FetchImplementation = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>;

let fetchImplementation: FetchImplementation | undefined;
let fetchImplementationLabel = 'globalThis.fetch';
const standardErrorKeys = new Set(['name', 'message', 'stack', 'cause', 'code', 'status']);

export function setFetchImplementation(next?: FetchImplementation, label?: string): void {
  fetchImplementation = next;
  fetchImplementationLabel = next ? (label ?? 'custom fetch implementation') : 'globalThis.fetch';
}

export async function fetch(...args: Parameters<FetchImplementation>): ReturnType<FetchImplementation> {
  const implementation = fetchImplementation ?? globalThis.fetch;
  if (typeof implementation !== 'function') {
    throw new Error('Fetch API is not available in this runtime');
  }

  const startedAt = Date.now();
  const shouldLog = Boolean(fetchImplementation);
  const implementationLabel = fetchImplementation ? fetchImplementationLabel : 'globalThis.fetch';

  try {
    const response = await implementation(...args);

    if (shouldLog && !response.ok) {
      console.warn('[fetch] HTTP response', {
        implementation: implementationLabel,
        elapsedMs: Date.now() - startedAt,
        request: summarizeRequest(...args),
        response: summarizeResponse(response),
      });
    }

    return response;
  } catch (error) {
    if (shouldLog) {
      console.error('[fetch] HTTP request failed', {
        implementation: implementationLabel,
        elapsedMs: Date.now() - startedAt,
        request: summarizeRequest(...args),
        runtime: getRuntimeDiagnostics(),
        error: getErrorDiagnostics(error),
      });
    }
    throw error;
  }
}

function summarizeRequest(...args: Parameters<FetchImplementation>) {
  const [input, init] = args;
  const request = getRequestFromInput(input);

  return {
    method: init?.method ?? request?.method ?? 'GET',
    url: summarizeUrl(
      typeof input === 'string' || input instanceof URL ? String(input) : (request?.url ?? String(input)),
    ),
    hasQuery: hasQueryString(typeof input === 'string' || input instanceof URL ? String(input) : request?.url),
    hasAuthorization: hasAuthorizationHeader(init?.headers) || Boolean(request?.headers?.has('authorization')),
  };
}

function summarizeResponse(response: Response) {
  return {
    status: response.status,
    statusText: response.statusText,
    url: summarizeUrl(response.url),
    contentType: response.headers.get('content-type') ?? undefined,
  };
}

export function getErrorDiagnostics(error: unknown) {
  if (!(error instanceof Error)) {
    const message = sanitizeDiagnosticText(String(error));

    return {
      type: typeof error,
      message,
      classification: classifyError(message),
      keys: getDiagnosticKeys(error),
    };
  }

  const errorRecord = error as Error & Record<string, unknown>;
  const message = sanitizeDiagnosticText(error.message || String(error));

  return {
    name: error.name,
    message,
    code: typeof errorRecord.code === 'string' ? errorRecord.code : undefined,
    status: typeof errorRecord.status === 'number' ? errorRecord.status : undefined,
    classification: classifyError(message),
    keys: getDiagnosticKeys(errorRecord),
    cause: getErrorCauseDiagnostics(errorRecord.cause),
  };
}

export function getRuntimeDiagnostics() {
  const navigatorWithDiagnostics =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { onLine?: boolean; userAgentData?: { platform?: string } })
      : undefined;

  return {
    online: navigatorWithDiagnostics?.onLine,
    platform: getPlatformHint(navigatorWithDiagnostics),
  };
}

function classifyError(message: string): string {
  const text = message.toLowerCase();

  if (text.includes('certificate') || text.includes('tls') || text.includes('ssl')) {
    return 'tls';
  }
  if (text.includes('proxy')) {
    return 'proxy';
  }
  if (
    text.includes('dns') ||
    text.includes('name or service not known') ||
    text.includes('could not resolve host') ||
    text.includes('lookup')
  ) {
    return 'dns';
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return 'timeout';
  }
  if (
    text.includes('connection refused') ||
    text.includes('connection reset') ||
    text.includes('connection aborted') ||
    text.includes('socket')
  ) {
    return 'connection';
  }
  if (text.includes('error sending request for url')) {
    return 'transport';
  }
  if (text.includes('authenticate') || text.includes('unauthorized') || text.includes('forbidden')) {
    return 'auth';
  }

  return 'unknown';
}

function summarizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

function sanitizeDiagnosticText(text: string): string {
  return text
    .replace(/0x[a-fA-F0-9]{32,}/g, value => `${value.slice(0, 10)}...${value.slice(-8)}`)
    .replace(/https?:\/\/[^\s)]+/g, url => summarizeUrl(url));
}

function hasQueryString(url?: string): boolean {
  if (!url) {
    return false;
  }

  try {
    return new URL(url).search.length > 0;
  } catch {
    return url.includes('?');
  }
}

function getRequestFromInput(input: Parameters<FetchImplementation>[0]): Request | undefined {
  if (typeof Request === 'undefined') {
    return undefined;
  }

  return input instanceof Request ? input : undefined;
}

function getErrorCauseDiagnostics(cause: unknown) {
  if (cause == null) {
    return undefined;
  }

  if (cause instanceof Error) {
    const causeRecord = cause as Error & Record<string, unknown>;
    const message = sanitizeDiagnosticText(cause.message || String(cause));

    return {
      name: cause.name,
      message,
      code: typeof causeRecord.code === 'string' ? causeRecord.code : undefined,
      classification: classifyError(message),
      keys: getDiagnosticKeys(causeRecord),
    };
  }

  const message = sanitizeDiagnosticText(String(cause));

  return {
    type: typeof cause,
    message,
    keys: getDiagnosticKeys(cause),
  };
}

function getDiagnosticKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const keys = Object.keys(value).filter(key => !standardErrorKeys.has(key) && !isSensitiveDiagnosticKey(key));
  return keys.length ? keys.slice(0, 8) : undefined;
}

function isSensitiveDiagnosticKey(key: string): boolean {
  return /auth|token|secret|password|cookie|session|header|body/i.test(key);
}

function getPlatformHint(
  navigatorWithDiagnostics?: Navigator & { onLine?: boolean; userAgentData?: { platform?: string } },
): string | undefined {
  if (navigatorWithDiagnostics) {
    return navigatorWithDiagnostics.userAgentData?.platform ?? navigatorWithDiagnostics.platform;
  }

  if (typeof process !== 'undefined') {
    return process.platform;
  }
}

function hasAuthorizationHeader(headers: RequestInit['headers']): boolean {
  if (!headers) {
    return false;
  }

  if (headers instanceof Headers) {
    return headers.has('authorization');
  }

  if (Array.isArray(headers)) {
    return headers.some(([key]) => key.toLowerCase() === 'authorization');
  }

  return Object.keys(headers).some(key => key.toLowerCase() === 'authorization');
}
