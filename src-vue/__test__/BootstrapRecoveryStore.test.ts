import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encryptBootstrapRecovery, type ArgonClient, type MainchainClients } from '@argonprotocol/apps-core';
import { u8aToHex } from '@argonprotocol/mainchain';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { type IConfig, ServerType } from '../interfaces/IConfig.ts';
import { BootstrapRecovery, BootstrapRecoveryContext } from '../lib/BootstrapRecovery.ts';
import { ServerAdmin } from '../lib/ServerAdmin.ts';
import { SSHConnection } from '../lib/SSHConnection.ts';
import { AppStartup } from '../lib/AppStartup.ts';
import type { WalletRecovery } from '../lib/WalletRecovery.ts';
import type { Config } from '../lib/Config.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';

const mocks = vi.hoisted(() => ({
  recoverySeed: `0x${'11'.repeat(32)}`,
  config: {
    bootstrapDetails: undefined as IConfig['bootstrapDetails'],
    upstreamOperator: undefined as IConfig['upstreamOperator'],
    hasExtensionTreasury: false,
    hasExtensionOperations: false,
    isServerInstalled: false,
    walletAccountsHadPreviousLife: false,
    serverDetails: {} as IConfig['serverDetails'],
    save: vi.fn(),
  },
  walletKeys: undefined as WalletKeys | undefined,
  startup: undefined as AppStartup | undefined,
  wallets: {
    defaultArgonWallet: {
      availableMicrogons: 1n,
    },
    balanceListeners: new Set<(...args: any[]) => void>(),
  },
  refreshPrunedClientFromConfig: vi.fn(),
  client: undefined as ArgonClient | undefined,
  transactionTracker: undefined as TransactionTracker | undefined,
}));

vi.mock('../stores/config.ts', () => ({
  getConfig: () => mocks.config,
}));
vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: () => Promise.resolve(mocks.client ?? 'mainchain-client'),
  refreshPrunedClientFromConfig: mocks.refreshPrunedClientFromConfig,
}));
vi.mock('../stores/wallets.ts', () => ({
  getWalletKeys: () => mocks.walletKeys,
  getWalletsForArgon: () => ({
    defaultArgonWallet: mocks.wallets.defaultArgonWallet,
    events: {
      on: vi.fn((_event, listener) => {
        mocks.wallets.balanceListeners.add(listener);
        return () => mocks.wallets.balanceListeners.delete(listener);
      }),
    },
  }),
}));
vi.mock('../stores/transactions.ts', () => ({
  getTransactionTracker: () => mocks.transactionTracker ?? 'transaction-tracker',
}));
vi.mock('../stores/startup.ts', () => ({ getAppStartup: () => mocks.startup }));

import { recoverUpstreamHost } from '../stores/bootstrapRecovery.ts';

beforeEach(async () => {
  await cryptoWaitReady();
  mocks.walletKeys = createMockWalletKeys('//BootstrapPublication');
  mocks.recoverySeed = await mocks.walletKeys.getUpstreamEndpointRecoverySeed();
  mocks.startup = new AppStartup(mocks.config as unknown as Config, mocks.walletKeys, {
    get: async () => 'mainchain-client',
  } as unknown as MainchainClients);
});

afterEach(() => {
  mocks.config.bootstrapDetails = undefined;
  mocks.config.upstreamOperator = undefined;
  mocks.config.hasExtensionTreasury = false;
  mocks.config.hasExtensionOperations = false;
  mocks.config.isServerInstalled = false;
  mocks.config.walletAccountsHadPreviousLife = false;
  mocks.config.serverDetails = {} as IConfig['serverDetails'];
  mocks.config.save.mockReset();
  mocks.wallets.defaultArgonWallet.availableMicrogons = 1n;
  mocks.wallets.balanceListeners.clear();
  mocks.refreshPrunedClientFromConfig.mockReset();
  mocks.client = undefined;
  mocks.transactionTracker = undefined;
  vi.restoreAllMocks();
});

it('restores the recovered server install type and work directory before marking it installed', async () => {
  mocks.config.walletAccountsHadPreviousLife = true;
  mocks.config.serverDetails = {
    ipAddress: '',
    sshUser: 'root',
    type: 'DigitalOcean',
    workDir: '~',
  } as IConfig['serverDetails'];
  vi.spyOn(BootstrapRecovery.prototype, 'recoverEndpoint').mockResolvedValueOnce({
    version: 1,
    host: '127.0.0.1',
    port: 8443,
    sequence: 2,
    bootstrapEndpointSecret: 'bootstrap-secret',
    bootstrapEndpointIndex: 0,
    ssh: {
      user: 'argon',
      port: 2222,
    },
  });
  vi.spyOn(SSHConnection.prototype, 'connect').mockResolvedValue();
  vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue();
  vi.spyOn(ServerAdmin.prototype, 'downloadInstallManifest').mockResolvedValue({
    version: 1,
    type: ServerType.LocalComputer,
    workDir: '/app',
  });

  await mocks.startup!.recoverOwnServerConnection();

  expect(mocks.config.serverDetails).toMatchObject({
    ipAddress: '127.0.0.1',
    sshPort: 2222,
    gatewayPort: 8443,
    sshUser: 'argon',
    type: 'LocalComputer',
    workDir: '/app',
  });
  expect(mocks.config.hasExtensionTreasury).toBe(true);
  expect(mocks.config.hasExtensionOperations).toBe(true);
  expect(mocks.config.isServerInstalled).toBe(true);
  expect(mocks.config.save).toHaveBeenCalledOnce();
});

it('restores a recovered server with defaults when SSH is unavailable', async () => {
  mocks.config.walletAccountsHadPreviousLife = true;
  mocks.config.serverDetails = {
    ipAddress: '',
    sshUser: 'root',
    type: 'DigitalOcean',
    workDir: '~',
  } as IConfig['serverDetails'];
  vi.spyOn(BootstrapRecovery.prototype, 'recoverEndpoint').mockResolvedValueOnce({
    version: 1,
    host: '127.0.0.1',
    port: 8443,
    sequence: 2,
    bootstrapEndpointSecret: 'bootstrap-secret',
    bootstrapEndpointIndex: 0,
    ssh: {
      user: 'argon',
      port: 2222,
    },
  });
  vi.spyOn(SSHConnection.prototype, 'connect').mockRejectedValue(new Error('SSH unavailable'));

  await mocks.startup!.recoverOwnServerConnection();

  expect(mocks.config.serverDetails).toMatchObject({
    ipAddress: '127.0.0.1',
    sshPort: 2222,
    gatewayPort: 8443,
    sshUser: 'argon',
    bootstrapEndpointIndex: 0,
    type: ServerType.DigitalOcean,
    workDir: '~',
  });
  expect(mocks.config.isServerInstalled).toBe(true);
  expect(mocks.config.save).toHaveBeenCalledOnce();
});

it('recovers an upstream host without creating a partial upstream record', async () => {
  const recoverEndpoint = vi.spyOn(BootstrapRecovery.prototype, 'recoverEndpoint').mockResolvedValue({
    version: 1,
    host: 'recovered.example',
    port: 8443,
    sequence: 4,
    bootstrapEndpointSecret: '0x1234',
  });

  await expect(recoverUpstreamHost()).resolves.toBe('https://recovered.example:8443');

  expect(recoverEndpoint).toHaveBeenCalledWith('mainchain-client', BootstrapRecoveryContext.Upstream, undefined);
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
  });
  const recoverEndpoint = vi.spyOn(BootstrapRecovery.prototype, 'recoverEndpoint');

  await expect(recoverUpstreamHost()).resolves.toBe('https://rotated.example:9443');

  expect(resolveEndpoint).toHaveBeenCalledWith('mainchain-client', bootstrapEndpointSecret, 3);
  expect(recoverEndpoint).not.toHaveBeenCalled();
  expect(mocks.config.save).not.toHaveBeenCalled();
  expect(mocks.refreshPrunedClientFromConfig).not.toHaveBeenCalled();
});
