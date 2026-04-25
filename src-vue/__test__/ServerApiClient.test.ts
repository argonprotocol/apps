import { describe, expect, it } from 'vitest';
import { ServerType } from '../interfaces/IConfig.ts';
import { ServerApiClient } from '../lib/ServerApiClient.ts';

describe('ServerApiClient', () => {
  it('uses localhost for local loopback gateway urls', () => {
    const serverDetails = {
      type: ServerType.LocalComputer,
      ipAddress: '127.0.0.1',
      gatewayPort: 59397,
    };

    expect(ServerApiClient.getGatewayHttpUrl(serverDetails, '/auth/challenge')).toBe(
      'https://localhost:59397/auth/challenge',
    );
    expect(ServerApiClient.getGatewayWebsocketUrl(serverDetails, '/bot/')).toBe('wss://localhost:59397/bot/');
  });

  it('keeps the configured host for remote gateway urls', () => {
    expect(
      ServerApiClient.getGatewayHttpUrl({
        type: ServerType.CustomServer,
        ipAddress: '203.0.113.10',
        gatewayPort: 443,
      }),
    ).toBe('https://203.0.113.10');
  });
});
