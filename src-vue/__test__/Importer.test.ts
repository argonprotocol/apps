import './helpers/mocks.ts';
import { beforeEach, expect, it, vi } from 'vitest';
import { AccountActivityKind, JsonExt, Mining } from '@argonprotocol/apps-core';
import Importer from '../lib/Importer.ts';
import { Config } from '../lib/Config.ts';
import { createMockedDbPromise } from './helpers/db.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { instanceChecks } from '../lib/Utils.ts';
import { SSH } from '../lib/SSH.ts';
import { type IConfig, MiningSetupStatus, OnboardingSetupStatus, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import Restarter from '../lib/Restarter.ts';
import { MemoryWalletKeys } from '../lib/MemoryWalletKeys.ts';
import type { Db } from '../lib/Db.ts';
import { invokeWithTimeout } from '../lib/tauriApi.ts';
import { Vault } from '@argonprotocol/mainchain';

const importMocks = vi.hoisted(() => ({
  closeWallets: vi.fn(),
  findMiningActivity: vi.fn(),
  getFinalizedClient: vi.fn(),
  getMainchainClient: vi.fn(),
  getOperatorVaultId: vi.fn(),
  readBalances: vi.fn(),
  stopBlockWatch: vi.fn(),
}));

vi.mock('../stores/mainchain.ts', () => ({
  getFinalizedClient: importMocks.getFinalizedClient,
  getMainchainClient: importMocks.getMainchainClient,
  getBlockWatch: () => ({ stop: importMocks.stopBlockWatch }),
}));

vi.mock('../stores/wallets.ts', () => ({
  getWalletsForArgon: () => ({ close: importMocks.closeWallets }),
}));

vi.mock('../lib/WalletsForArgon.ts', async importOriginal => ({
  ...(await importOriginal()),
  readArgonWalletBalanceValues: importMocks.readBalances,
}));

vi.mock('../lib/IndexerClient.ts', () => ({
  findAddressActivity: importMocks.findMiningActivity,
}));

beforeEach(() => {
  vi.clearAllMocks();
  importMocks.getOperatorVaultId.mockResolvedValue({ isSome: false });
  importMocks.getMainchainClient.mockResolvedValue({
    tx: { operationalAccounts: {}, vaults: { setName: vi.fn() } },
  });
});

it('stops background sync before importing and keeps the current database on failure', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const db = {
    reconnect: vi.fn(),
    configTable: { insertOrReplace: vi.fn() },
  } as unknown as Db;
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({ isSome: false }),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([
    emptyBalance,
    emptyBalance,
    { ...emptyBalance, availableMicrogons: 1n },
    emptyBalance,
  ]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.mocked(invokeWithTimeout).mockRejectedValueOnce(new Error('import failed'));
  const deleteDatabase = vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();

  await expect(
    new Importer({} as Config, walletKeys, Promise.resolve(db)).importFromMnemonic(mnemonic),
  ).rejects.toThrow('import failed');

  expect(invokeWithTimeout).toHaveBeenCalledWith('import_mnemonic', { mnemonic }, 10_000);
  expect(importMocks.closeWallets).toHaveBeenCalledOnce();
  expect(importMocks.stopBlockWatch).toHaveBeenCalledOnce();
  expect(importMocks.stopBlockWatch.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(invokeWithTimeout).mock.invocationCallOrder[0],
  );
  expect(deleteDatabase).not.toHaveBeenCalled();
});

it('restores completed mining setup from imported operational account state', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
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
    accountBitcoinAmount: { toBigInt: () => 0n },
    accountVaultBondAmount: { toBigInt: () => 0n },
    availableAccessCodes: { toNumber: () => 0 },
    isOperationallyCertified: { toPrimitive: () => false },
    miningSeatAccrual: { toNumber: () => 0 },
    miningSeatAppliedTotal: { toNumber: () => 1 },
    operationalCertificationsCount: { toNumber: () => 0 },
    rewardsCollectedAmount: { toBigInt: () => 0n },
    rewardsEarnedAmount: { toBigInt: () => 0n },
    rewardsEarnedCount: { toNumber: () => 0 },
    uniswapArgonTransfersInAmount: { toBigInt: () => 0n },
    upstreamAccount: { isSome: false },
    vaultBitcoinAccrual: { toBigInt: () => 0n },
    vaultBitcoinAppliedTotal: { toBigInt: () => 0n },
    vaultCreated: { toPrimitive: () => true },
  };
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({
          isSome: true,
          unwrap: () => operationalDetails,
        }),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
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
  const fetchMiningSeats = vi.spyOn(Mining, 'fetchMiningSeatsForAccount');
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  const restart = vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer({} as Config, walletKeys, Promise.resolve(db)).importFromMnemonic(mnemonic);

  expect(insertOrReplace).toHaveBeenCalledWith({
    showWelcomeOverlay: 'false',
    walletAccountsHadPreviousLife: 'true',
    walletPreviousLifeRecovered: 'false',
    hasExtensionTreasury: 'true',
    hasExtensionOperations: 'true',
    hasActivatedCrosschain: 'false',
    certificationDetails: JsonExt.stringify({ hasSavedMnemonic: true }, 2),
    miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Finished, 2),
    vaultingSetupStatus: JsonExt.stringify(VaultingSetupStatus.Finished, 2),
    onboardingSetupStatus: JsonExt.stringify(OnboardingSetupStatus.Checklist, 2),
    hasMiningBids: 'true',
    hasMiningSeats: 'true',
  });
  expect(fetchMiningSeats).not.toHaveBeenCalled();
  expect(importMocks.findMiningActivity).not.toHaveBeenCalled();
  expect(restart).toHaveBeenCalledOnce();
});

it.each([
  {
    activityKind: 'bid',
    activityMask: AccountActivityKind.MiningBid,
    hasMiningSeats: 'false',
  },
  {
    activityKind: 'seat',
    activityMask: AccountActivityKind.MiningSeat,
    hasMiningSeats: 'true',
  },
])('restores indexed mining $activityKind history', async params => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const importWalletKeys = new MemoryWalletKeys({
    substrateSuri: mnemonic,
    masterMnemonic: mnemonic,
  });
  const insertOrReplace = vi.fn();
  const db = {
    reconnect: vi.fn(),
    configTable: { insertOrReplace },
  } as unknown as Db;
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({
          isSome: false,
        }),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.findMiningActivity.mockResolvedValue({
    blocks: [{ blockNumber: 10, activityMask: params.activityMask }],
    coverage: { gaps: [] },
  });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer({} as Config, walletKeys, Promise.resolve(db)).importFromMnemonic(mnemonic);

  expect(importMocks.findMiningActivity).toHaveBeenCalledWith(importWalletKeys.miningBotAddress, {
    activityMask: AccountActivityKind.MiningBid | AccountActivityKind.MiningSeat,
  });
  expect(insertOrReplace).toHaveBeenCalledWith(
    expect.objectContaining({
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Finished, 2),
      hasMiningBids: 'true',
      hasMiningSeats: params.hasMiningSeats,
    }),
  );
});

it.each([
  {
    accountKind: 'legacy mining hold',
    balanceIndex: 0,
  },
  {
    accountKind: 'mining bot',
    balanceIndex: 1,
  },
])('keeps a funded $accountKind account on the checklist without bid or seat history', async params => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const balances = [emptyBalance, emptyBalance, emptyBalance, emptyBalance];
  balances[params.balanceIndex] = { ...emptyBalance, availableMicrogons: 1n };
  const insertOrReplace = vi.fn();
  const db = {
    reconnect: vi.fn(),
    configTable: { insertOrReplace },
  } as unknown as Db;
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({
          isSome: false,
        }),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue(balances);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer({} as Config, walletKeys, Promise.resolve(db)).importFromMnemonic(mnemonic);

  expect(insertOrReplace).toHaveBeenCalledWith(
    expect.objectContaining({
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Checklist, 2),
      hasMiningBids: 'false',
      hasMiningSeats: 'false',
    }),
  );
});

it('does not invent extensions from an imported basic wallet balance', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const insertOrReplace = vi.fn();
  const db = {
    reconnect: vi.fn(),
    configTable: { insertOrReplace },
  } as unknown as Db;
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({
          isSome: false,
        }),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([
    emptyBalance,
    emptyBalance,
    { ...emptyBalance, availableMicrogons: 1n },
    emptyBalance,
  ]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer({} as Config, walletKeys, Promise.resolve(db)).importFromMnemonic(mnemonic);

  expect(insertOrReplace).toHaveBeenCalledWith(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'false',
      hasExtensionOperations: 'false',
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.None, 2),
    }),
  );
});

it('restores Crosschain Transfers for an unfunded account with a minting-authority council signer', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const insertOrReplace = vi.fn();
  const db = {
    reconnect: vi.fn(),
    configTable: { insertOrReplace },
  } as unknown as Db;
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({ isSome: false }),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
      crosschainTransfer: {
        councilSignerByDestinationChainAndAccountId: vi.fn().mockResolvedValue({ isSome: true }),
      },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer({} as Config, walletKeys, Promise.resolve(db)).importFromMnemonic(mnemonic);

  expect(insertOrReplace).toHaveBeenCalledWith(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
      hasActivatedCrosschain: 'true',
    }),
  );
});

it('does not infer treasury from an unattributed account hold', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const insertOrReplace = vi.fn();
  const db = {
    reconnect: vi.fn(),
    configTable: { insertOrReplace },
  } as unknown as Db;
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({
          isSome: false,
        }),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([
    emptyBalance,
    emptyBalance,
    { ...emptyBalance, reservedMicrogons: 1n },
    emptyBalance,
  ]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer({} as Config, walletKeys, Promise.resolve(db)).importFromMnemonic(mnemonic);

  expect(insertOrReplace).toHaveBeenCalledWith(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'false',
      hasExtensionOperations: 'false',
    }),
  );
});

it.each([
  {
    activityKind: 'bitcoin',
    activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.VaultPosition,
    hasExtensionOperations: 'false',
    vaultingSetupStatus: JsonExt.stringify(VaultingSetupStatus.None, 2),
  },
  {
    activityKind: 'bond',
    activityMask: AccountActivityKind.BondPosition,
    hasExtensionOperations: 'false',
    vaultingSetupStatus: JsonExt.stringify(VaultingSetupStatus.None, 2),
  },
  {
    activityKind: 'vault',
    activityMask: AccountActivityKind.VaultPosition,
    hasExtensionOperations: 'true',
    vaultingSetupStatus: JsonExt.stringify(VaultingSetupStatus.Finished, 2),
  },
])('restores extensions from imported $activityKind history', async params => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const importWalletKeys = new MemoryWalletKeys({
    substrateSuri: mnemonic,
    masterMnemonic: mnemonic,
  });
  const insertOrReplace = vi.fn();
  const db = {
    reconnect: vi.fn(),
    configTable: { insertOrReplace },
  } as unknown as Db;
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({
          isSome: false,
        }),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.getOperatorVaultId.mockResolvedValue({
    isSome: params.activityKind === 'vault',
    unwrap: () => ({ toNumber: () => 7 }),
  });
  const getVault = vi.spyOn(Vault, 'get').mockResolvedValue({ vaultId: 7 } as Vault);
  importMocks.findMiningActivity.mockImplementation(async (_address, filters) => {
    return {
      blocks:
        filters.activityMask & params.activityMask ? [{ blockNumber: 10, activityMask: params.activityMask }] : [],
      coverage: { gaps: [] },
    };
  });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer({} as Config, walletKeys, Promise.resolve(db)).importFromMnemonic(mnemonic);

  expect(importMocks.findMiningActivity).toHaveBeenCalledWith(importWalletKeys.defaultArgonAddress, {
    activityMask: AccountActivityKind.BondPosition | AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
  });
  expect(importMocks.getOperatorVaultId).toHaveBeenCalledWith(importWalletKeys.vaultingAddress);
  expect(getVault).toHaveBeenCalledTimes(params.activityKind === 'vault' ? 1 : 0);
  expect(insertOrReplace).toHaveBeenCalledWith(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'true',
      hasExtensionOperations: params.hasExtensionOperations,
      vaultingSetupStatus: params.vaultingSetupStatus,
    }),
  );

  getVault.mockRestore();
});

it('does not block account import when fallback index history is unavailable', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const insertOrReplace = vi.fn();
  const db = {
    reconnect: vi.fn(),
    configTable: { insertOrReplace },
  } as unknown as Db;
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({
          isSome: false,
        }),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.findMiningActivity.mockRejectedValue(new Error('index unavailable'));
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockRejectedValue(new Error('seat lookup unavailable'));
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  const restart = vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer({} as Config, walletKeys, Promise.resolve(db)).importFromMnemonic(mnemonic);

  expect(insertOrReplace).toHaveBeenCalledWith(
    expect.objectContaining({
      hasExtensionTreasury: 'false',
      hasExtensionOperations: 'false',
      hasMiningBids: 'false',
      hasMiningSeats: 'false',
    }),
  );
  expect(restart).toHaveBeenCalledOnce();
});

it('restores a matching server without completing mining setup when bidding rules are absent', async () => {
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

  const db = await dbPromise;
  const saveSpy = vi.spyOn(db.configTable, 'insertOrReplace');
  const importer = new Importer(config, walletKeys, dbPromise);
  await importer.importFromServer('10.0.0.1');

  expect(config.isServerInstalled).toBe(true);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Checklist);
  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(saveSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      isServerInstalled: 'true',
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Checklist, 2),
    }),
  );
  expect(saveSpy).not.toHaveBeenCalledWith(
    expect.objectContaining({
      biddingRules: expect.anything(),
    }),
  );
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
    hasMiningBids: false,
    hasMiningSeats: false,
  });

  const db = await dbPromise;
  const saveSpy = vi.spyOn(db.configTable, 'insertOrReplace');
  await new Importer(config, walletKeys, dbPromise).importFromServer('10.0.0.1');

  expect(config.serverDetails.ipAddress).toBe('10.0.0.1');
  expect(config.isServerInstalled).toBe(true);
  expect(config.isServerInstalling).toBe(false);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.hasMiningBids).toBe(false);
  expect(config.hasMiningSeats).toBe(false);
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

it('restores completed mining setup from server bid history without bidding rules', async () => {
  const dbPromise = createMockedDbPromise();
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  vi.spyOn(SSH, 'tryConnection').mockResolvedValue({
    walletAddress: walletKeys.miningBotAddress,
    biddingRules: undefined,
    oldestFrameIdToSync: 10,
    ethereumBeaconApiUrl: undefined,
    ethereumExecutionRpcUrl: undefined,
    hasMiningBids: true,
    hasMiningSeats: false,
  });

  await new Importer(config, walletKeys, dbPromise).importFromServer('10.0.0.1');

  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.hasMiningBids).toBe(true);
  expect(config.hasMiningSeats).toBe(false);
});

it('does not erase stronger imported mining history when server flags are false', async () => {
  const dbPromise = createMockedDbPromise({
    miningSetupStatus: JsonExt.stringify(MiningSetupStatus.Finished, 2),
    hasMiningBids: 'true',
    hasMiningSeats: 'false',
  });
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  vi.spyOn(SSH, 'tryConnection').mockResolvedValue({
    walletAddress: walletKeys.miningBotAddress,
    biddingRules: undefined,
    oldestFrameIdToSync: 10,
    ethereumBeaconApiUrl: undefined,
    ethereumExecutionRpcUrl: undefined,
    hasMiningBids: false,
    hasMiningSeats: false,
  });

  await new Importer(config, walletKeys, dbPromise).importFromServer('10.0.0.1');

  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.hasMiningBids).toBe(true);
  expect(config.hasMiningSeats).toBe(false);
});

const emptyBalance = {
  availableMicrogons: 0n,
  reservedMicrogons: 0n,
  availableMicronots: 0n,
  reservedMicronots: 0n,
};
