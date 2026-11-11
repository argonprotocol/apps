import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { createDeferred, MainchainClients } from '@argonprotocol/apps-core';
import { ask } from '@tauri-apps/plugin-dialog';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { WalletsForArgon } from '../lib/WalletsForArgon.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { WalletForBase } from '../lib/WalletForBase.ts';
import { WalletHistoryRecovery } from '../lib/recovery/WalletHistory.ts';
import { initializeWalletKeys, useWallets } from '../stores/wallets.ts';
import handleFatalError from '../stores/helpers/handleFatalError.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

const boundary = vi.hoisted(() => ({
  db: { walletsTable: { getDefaultArgon: vi.fn() }, financialCacheTable: {} },
  clients: undefined as MainchainClients | undefined,
  connect: vi.fn(),
}));
vi.mock('../../core/src/MainchainRpcProvider.ts', () => ({ getMainchainClient: boundary.connect }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
vi.mock('../stores/helpers/handleFatalError.ts', () => ({ default: vi.fn() }));
vi.mock('../stores/helpers/dbPromise.ts', () => ({ getDbPromise: () => Promise.resolve(boundary.db) }));
vi.mock('../stores/config.ts', () => ({ getConfig: () => ({ isLoadedPromise: Promise.resolve() }) }));
vi.mock('../stores/currency.ts', () => ({ getCurrency: () => ({ isLoadedPromise: Promise.resolve() }) }));
vi.mock('../stores/myMiningSeats.ts', () => ({ getMyMiningSeats: () => ({}) }));
vi.mock('../stores/mainchain.ts', () => ({
  getBlockWatch: () => ({ finalizedBlockHeader: { blockNumber: 1 } }),
  getMainchainClients: () => boundary.clients,
}));
vi.mock('../stores/bitcoin.ts', () => ({ getBitcoinLocks: vi.fn(), getBitcoinTransactionOperations: () => ({}) }));
vi.mock('../lib/EthereumClient.ts', () => ({ loadEthereumChainConfig: async () => undefined }));

let pinia: Pinia;
beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const keys = createMockWalletKeys('//Alice//wallet-load', { canSign: false });
  vi.spyOn(WalletKeys, 'load').mockResolvedValue({ walletKeys: keys });
  boundary.db.walletsTable.getDefaultArgon.mockResolvedValue({
    address: keys.defaultArgonAddress,
    keyReference: '//vaulting',
  });
  vi.spyOn(WalletsForEthereum.prototype, 'loadCachedBalances').mockResolvedValue(undefined);
  vi.spyOn(WalletsForEthereum.prototype, 'load').mockResolvedValue(undefined);
  vi.spyOn(WalletForBase.prototype, 'load').mockResolvedValue(undefined);
  vi.spyOn(WalletHistoryRecovery.prototype, 'prepare').mockResolvedValue(false);
  vi.spyOn(WalletHistoryRecovery.prototype, 'hasCompleteCoverage').mockResolvedValue(true);
  vi.spyOn(WalletHistoryRecovery.prototype, 'close').mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  boundary.connect.mockResolvedValue({ query: {}, tx: {}, on: vi.fn(), disconnect: async () => undefined });
  await initializeWalletKeys();
});
afterEach(async () => {
  disposePinia(pinia);
  await boundary.clients?.disconnect();
  boundary.clients = undefined;
  vi.restoreAllMocks();
  vi.mocked(ask).mockReset();
  vi.mocked(handleFatalError).mockReset();
  boundary.connect.mockReset();
});

it('shares one retry dialog across callers and becomes ready on the third attempt', async () => {
  const failed = new Error('Temporary chain read failure');
  boundary.connect.mockRejectedValueOnce(failed).mockRejectedValueOnce(failed);
  const clients = new MainchainClients('ws://archive.test', () => false);
  boundary.clients = clients;
  void clients.archiveClientPromise.catch(() => undefined);
  const load = vi.spyOn(WalletsForArgon.prototype, 'load').mockImplementation(async () => {
    await clients.get(false);
  });
  const first = createDeferred<boolean>();
  const second = createDeferred<boolean>();
  vi.mocked(ask).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const wallets = useWallets();
  const requests = [wallets.load(), wallets.load()];
  const ready = Promise.all([...requests, wallets.isLoadedPromise]);
  void ready.catch(() => undefined);
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  expect(load).toHaveBeenCalledTimes(1);
  expect(wallets.isLoaded).toBe(false);

  first.resolve(true);
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
  second.resolve(true);
  await ready;
  expect(wallets.isLoaded).toBe(true);
  expect(handleFatalError).not.toHaveBeenCalled();
  expect(boundary.connect).toHaveBeenCalledTimes(3);

  await wallets.load();
  expect(load).toHaveBeenCalledTimes(3);
});

it('keeps a declined load terminal when later callers poll it', async () => {
  const failed = new Error('Chain read failed');
  boundary.connect.mockRejectedValue(failed);
  const clients = new MainchainClients('ws://archive.test', () => false);
  boundary.clients = clients;
  void clients.archiveClientPromise.catch(() => undefined);
  const load = vi.spyOn(WalletsForArgon.prototype, 'load').mockImplementation(async () => {
    await clients.get(false);
  });
  const answer = createDeferred<boolean>();
  vi.mocked(ask).mockReturnValue(answer.promise);
  const wallets = useWallets();
  const readiness = expect(wallets.isLoadedPromise).rejects.toBe(failed);
  const request = expect(wallets.load()).rejects.toBe(failed);
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  answer.resolve(false);
  await Promise.all([readiness, request]);

  await expect(wallets.load()).rejects.toBe(failed);
  await expect(wallets.load()).rejects.toBe(failed);
  expect(wallets.isLoaded).toBe(false);
  expect(ask).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
  expect(boundary.connect).toHaveBeenCalledTimes(1);
});
