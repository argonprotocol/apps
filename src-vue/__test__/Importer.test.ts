import './helpers/mocks.ts';
import { expect, it, vi } from 'vitest';
import Importer from '../lib/Importer.ts';
import { Config } from '../lib/Config.ts';
import { createMockedDbPromise } from './helpers/db.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { instanceChecks } from '../lib/Utils.ts';
import { SSH } from '../lib/SSH.ts';
import { type IConfig, MiningSetupStatus, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import { JsonExt, Mining } from '@argonprotocol/apps-core';
import Restarter from '../lib/Restarter.ts';
import { MemoryWalletKeys } from '../lib/MemoryWalletKeys.ts';
import type { Db } from '../lib/Db.ts';

const importMocks = vi.hoisted(() => ({
  closeWallets: vi.fn(),
  getFinalizedClient: vi.fn(),
  readBalances: vi.fn(),
  stopBlockWatch: vi.fn(),
}));

vi.mock('../stores/mainchain.ts', () => ({
  getFinalizedClient: importMocks.getFinalizedClient,
  getBlockWatch: () => ({ stop: importMocks.stopBlockWatch }),
}));

vi.mock('../stores/wallets.ts', () => ({
  getWalletsForArgon: () => ({ close: importMocks.closeWallets }),
}));

vi.mock('../lib/WalletsForArgon.ts', async importOriginal => ({
  ...(await importOriginal()),
  readArgonWalletBalanceValues: importMocks.readBalances,
}));

it('reconstructs operation state from the imported mnemonic account', async () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const { walletKeys } = createTestWallet('//Alice');
  const importWalletKeys = new MemoryWalletKeys({
    substrateSuri: mnemonic,
    masterMnemonic: mnemonic,
  });
  const insertOrReplace = vi.fn();
  const db = {
    reconnect: vi.fn(),
    configTable: { insertOrReplace },
  } as unknown as Db;
  const operationalDetails = {
    miningSeatAccrual: { toNumber: () => 0 },
    miningSeatAppliedTotal: { toNumber: () => 1 },
    miningAccount: { toHuman: () => importWalletKeys.miningBotAddress },
    vaultCreated: { toPrimitive: () => true },
  };
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockImplementation(async address => {
          const isSome = address === importWalletKeys.operationalAddress;
          return {
            isSome,
            unwrap: () => operationalDetails,
          };
        }),
      },
      system: {
        account: vi.fn().mockImplementation(async address => ({
          nonce: { toBigInt: () => (address === importWalletKeys.miningBotAddress ? 1n : 0n) },
          providers: { toNumber: () => 0 },
          consumers: { toNumber: () => 0 },
          sufficients: { toNumber: () => 0 },
        })),
      },
    },
  });
  importMocks.readBalances.mockImplementation(async (_api, addresses: string[]) => {
    expect(addresses).toEqual([
      importWalletKeys.legacyMiningHoldAddress,
      importWalletKeys.miningBotAddress,
      importWalletKeys.vaultingAddress,
      importWalletKeys.operationalAddress,
    ]);
    return [emptyBalance, emptyBalance, { ...emptyBalance, availableMicrogons: 1n }, emptyBalance];
  });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockImplementation(async address => {
    if (address !== importWalletKeys.miningBotAddress) {
      throw new Error('Queried mining seats for the active wallet');
    }
    return {};
  });
  vi.spyOn(Mining, 'fetchWinningBids').mockResolvedValue([]);
  vi.spyOn(MemoryWalletKeys.prototype, 'getMiningBotSubaccounts').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  const restart = vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer({} as Config, walletKeys, Promise.resolve(db)).importFromMnemonic(mnemonic);

  expect(insertOrReplace).toHaveBeenCalledWith({
    showWelcomeOverlay: 'false',
    walletAccountsHadPreviousLife: 'true',
    walletPreviousLifeRecovered: 'false',
    hasExtensionTreasury: 'true',
    hasExtensionOperations: 'true',
    miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Finished, 2),
    vaultingSetupStatus: JsonExt.stringify(VaultingSetupStatus.Finished, 2),
    hasMiningBids: 'true',
    hasMiningSeats: 'true',
  });
  expect(restart).toHaveBeenCalledOnce();
});

it('rejects a matching server without bidding rules before restoring mining setup', async () => {
  const dbPromise = createMockedDbPromise();
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  vi.spyOn(SSH, 'tryConnection').mockResolvedValue({
    walletAddress: walletKeys.miningBotAddress,
    biddingRules: undefined,
    oldestFrameIdToSync: 10,
    ethereumBeaconApiUrl: 'http://beacon',
    ethereumExecutionRpcUrl: 'http://execution',
  });

  const importer = new Importer(config, walletKeys, dbPromise);
  await expect(importer.importFromServer('10.0.0.1')).rejects.toThrow('No bidding rules found on server');

  expect(config.isServerInstalled).toBe(false);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.None);
  expect(config.hasExtensionTreasury).toBe(false);
  expect(config.hasExtensionOperations).toBe(false);
});

it('restores completed mining setup from a matching server with bidding rules', async () => {
  const dbPromise = createMockedDbPromise();
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  vi.spyOn(SSH, 'tryConnection').mockResolvedValue({
    walletAddress: walletKeys.miningBotAddress,
    biddingRules: Config.getDefault('biddingRules') as IConfig['biddingRules'],
    oldestFrameIdToSync: 10,
    ethereumBeaconApiUrl: 'http://beacon',
    ethereumExecutionRpcUrl: 'http://execution',
  });

  const db = await dbPromise;
  const saveSpy = vi.spyOn(db.configTable, 'insertOrReplace');
  await new Importer(config, walletKeys, dbPromise).importFromServer('10.0.0.1');

  expect(config.serverDetails.ipAddress).toBe('10.0.0.1');
  expect(config.isServerInstalled).toBe(true);
  expect(config.isServerInstalling).toBe(false);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(saveSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      biddingRules: JsonExt.stringify(Config.getDefault('biddingRules'), 2),
      isServerInstalled: 'true',
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Finished, 2),
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
    }),
  );
});

const emptyBalance = {
  availableMicrogons: 0n,
  reservedMicrogons: 0n,
  availableMicronots: 0n,
  reservedMicronots: 0n,
};
