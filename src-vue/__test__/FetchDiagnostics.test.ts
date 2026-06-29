import { fetch, setFetchImplementation, type FetchImplementation } from '@argonprotocol/apps-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchMock = vi.fn();

describe('fetch diagnostics', () => {
  beforeEach(() => {
    runtimeFetchMock.mockReset();
    setFetchImplementation(runtimeFetchMock as unknown as FetchImplementation, 'tauri-plugin-http');
  });

  afterEach(() => {
    setFetchImplementation();
    vi.restoreAllMocks();
  });

  it('logs non-ok HTTP responses with sanitized request details', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    runtimeFetchMock.mockResolvedValue(
      new Response('Unauthorized', {
        status: 401,
        headers: {
          'Content-Type': 'text/plain',
        },
      }),
    );

    await fetch('https://api.digitalocean.com/v2/account/keys?tag_name=wallet', {
      headers: {
        Authorization: 'Bearer secret',
      },
    });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[fetch] HTTP response',
      expect.objectContaining({
        implementation: 'tauri-plugin-http',
        request: expect.objectContaining({
          url: 'https://api.digitalocean.com/v2/account/keys',
          hasAuthorization: true,
        }),
        response: expect.objectContaining({
          status: 401,
        }),
      }),
    );
  });

  it('logs classified transport failures', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = Object.assign(new Error('TLS handshake failed'), {
      code: 'CERT_E_UNTRUSTEDROOT',
      sessionId: 'secret',
    });
    const error = Object.assign(
      new Error('error sending request for url (https://raw.githubusercontent.com/path/file.json?sessionId=secret)'),
      {
        cause,
        proxyDetected: false,
        sessionId: 'secret',
      },
    );
    runtimeFetchMock.mockRejectedValue(error);

    await expect(fetch('https://raw.githubusercontent.com/argonprotocol/apps/main/file.json')).rejects.toThrow(
      'error sending request for url',
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[fetch] HTTP request failed',
      expect.objectContaining({
        implementation: 'tauri-plugin-http',
        runtime: expect.any(Object),
        request: expect.objectContaining({
          url: 'https://raw.githubusercontent.com/argonprotocol/apps/main/file.json',
        }),
        error: expect.objectContaining({
          classification: 'transport',
          message: 'error sending request for url (https://raw.githubusercontent.com/path/file.json)',
          keys: ['proxyDetected'],
          cause: expect.objectContaining({
            classification: 'tls',
            code: 'CERT_E_UNTRUSTEDROOT',
          }),
        }),
      }),
    );
  });
});
