import { afterEach, expect, it, vi } from 'vitest';
import { encryptBootstrapRecovery } from '@argonprotocol/apps-core';
import { u8aToHex } from '@argonprotocol/mainchain';
import type { IConfig } from '../interfaces/IConfig.ts';
import { BootstrapRecovery, BootstrapRecoveryContext } from '../lib/BootstrapRecovery.ts';

const mocks = vi.hoisted(() => ({
  recoverySeed: `0x${'11'.repeat(32)}`,
  config: {
    bootstrapDetails: undefined as IConfig['bootstrapDetails'],
    upstreamOperator: undefined as IConfig['upstreamOperator'],
    save: vi.fn(),
  },
  walletKeys: {
    getUpstreamEndpointRecoverySeed: vi.fn(),
  },
  refreshPrunedClientFromConfig: vi.fn(),
}));

vi.mock('../stores/config.ts', () => ({
  getConfig: () => mocks.config,
}));
vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: () => Promise.resolve('mainchain-client'),
  refreshPrunedClientFromConfig: mocks.refreshPrunedClientFromConfig,
}));
vi.mock('../stores/wallets.ts', () => ({
  getWalletKeys: () => mocks.walletKeys,
}));

import { recoverUpstreamHost } from '../stores/bootstrapRecovery.ts';

afterEach(() => {
  mocks.config.bootstrapDetails = undefined;
  mocks.config.upstreamOperator = undefined;
  mocks.config.save.mockReset();
  mocks.walletKeys.getUpstreamEndpointRecoverySeed.mockResolvedValue(mocks.recoverySeed);
  mocks.refreshPrunedClientFromConfig.mockReset();
  vi.restoreAllMocks();
});

it('recovers an upstream host without creating a partial upstream record', async () => {
  const recoverEndpoint = vi.spyOn(BootstrapRecovery.prototype, 'recoverEndpoint').mockResolvedValue({
    version: 1,
    host: 'recovered.example',
    port: 8443,
    sequence: 4,
    bootstrapEndpointSecret: '0x1234',
    ownerAccountId: 'operator-account',
  });

  await expect(recoverUpstreamHost()).resolves.toBe('https://recovered.example:8443');

  expect(recoverEndpoint).toHaveBeenCalledWith(
    'mainchain-client',
    BootstrapRecoveryContext.Upstream,
    undefined,
    undefined,
  );
  expect(mocks.config).toMatchObject({
    bootstrapDetails: {
      routerHost: 'recovered.example:8443',
    },
  });
  expect(mocks.config.upstreamOperator).toBeUndefined();
  expect(mocks.config.save).toHaveBeenCalledOnce();
  expect(mocks.refreshPrunedClientFromConfig).toHaveBeenCalledOnce();
});

it('resolves the cached encrypted recovery without rewriting an unchanged host', async () => {
  const bootstrapEndpointSecret = `0x${'22'.repeat(32)}`;
  const encryptedBootstrapRecovery = await encryptBootstrapRecovery(
    {
      version: 1,
      endpointSecret: bootstrapEndpointSecret,
    },
    mocks.recoverySeed,
  );
  mocks.config.bootstrapDetails = {
    type: 'Private',
    routerHost: 'rotated.example:9443',
  } as IConfig['bootstrapDetails'];
  mocks.config.upstreamOperator = {
    name: 'Operator',
    accountId: 'operator-account',
    encryptedBootstrapRecovery: u8aToHex(encryptedBootstrapRecovery),
    bootstrapEndpointSequence: 3,
  };
  const resolveEndpoint = vi.spyOn(BootstrapRecovery.prototype, 'resolveEndpoint').mockResolvedValue({
    version: 1,
    host: 'rotated.example',
    port: 9443,
    sequence: 4,
    bootstrapEndpointSecret,
    ownerAccountId: 'operator-account',
  });
  const recoverEndpoint = vi.spyOn(BootstrapRecovery.prototype, 'recoverEndpoint');

  await expect(recoverUpstreamHost()).resolves.toBe('https://rotated.example:9443');

  expect(resolveEndpoint).toHaveBeenCalledWith('mainchain-client', bootstrapEndpointSecret, 'operator-account', 3);
  expect(recoverEndpoint).not.toHaveBeenCalled();
  expect(mocks.config.save).not.toHaveBeenCalled();
  expect(mocks.refreshPrunedClientFromConfig).not.toHaveBeenCalled();
});
