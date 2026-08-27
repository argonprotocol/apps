import './helpers/mocks.ts';
import { beforeEach, expect, it, vi } from 'vitest';
import { AccountActivityKind, JsonExt, Mining, Vault } from '@argonprotocol/apps-core';
import Importer from '../lib/Importer.ts';
import { Config } from '../lib/Config.ts';
import { createMockedDbPromise, createTestDb } from './helpers/db.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { instanceChecks } from '../lib/Utils.ts';
import { SSH } from '../lib/SSH.ts';
import { type IConfig, MiningSetupStatus, OnboardingSetupStatus, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import Restarter from '../lib/Restarter.ts';
import { MemoryWalletKeys } from '../lib/MemoryWalletKeys.ts';
import { invokeWithTimeout } from '../lib/tauriApi.ts';

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

const testJurisdiction = {
  ipAddress: '',
  city: '',
  region: '',
  countryName: '',
  countryCode: '',
  latitude: '',
  longitude: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  importMocks.getOperatorVaultId.mockResolvedValue(null);
  importMocks.getMainchainClient.mockResolvedValue({
    tx: { operationalAccounts: { setName: vi.fn() } },
  });
});

async function createImporterConfig(walletKeys: MemoryWalletKeys) {
  const db = await createTestDb();
  await db.configTable.insertOrReplace({
    showWelcomeOverlay: 'true',
    userJurisdiction: JsonExt.stringify(testJurisdiction, 2),
  });
  const dbPromise = Promise.resolve(db);
  vi.spyOn(db, 'reconnect').mockResolvedValue();
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  return { config, db, dbPromise };
}

it('stops background sync before importing and keeps the current database on failure', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const { config, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
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

  await expect(new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic)).rejects.toThrow(
    'import failed',
  );

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
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  const operationalDetails = {
    accountBitcoinAmount: 0n,
    accountVaultBondAmount: 0n,
    availableAccessCodes: 0,
    isOperationallyCertified: false,
    miningSeatAccrual: 0,
    miningSeatAppliedTotal: 1,
    name: null,
    operationalCertificationsCount: 0,
    rewardsCollectedAmount: 0n,
    rewardsEarnedAmount: 0n,
    rewardsEarnedCount: 0,
    uniswapArgonTransfersInAmount: 0n,
    upstreamAccount: null,
    vaultBitcoinAccrual: 0n,
    vaultBitcoinAppliedTotal: 0n,
    vaultCreated: true,
  };
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(operationalDetails),
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

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Finished);
  expect(config.certificationDetails?.hasSavedMnemonic).toBe(true);
  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
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
    }),
  );
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
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
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

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(importMocks.findMiningActivity).toHaveBeenCalledWith(importWalletKeys.miningBotAddress, {
    activityMask: AccountActivityKind.MiningBid | AccountActivityKind.MiningSeat,
  });
  expect(await db.configTable.fetchAllAsObject()).toEqual(
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
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue(balances);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
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
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
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

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'false',
      hasExtensionOperations: 'false',
      miningSetupStatus: JsonExt.stringify(MiningSetupStatus.None, 2),
    }),
  );
});

it.each([
  { name: 'does not restore Crosschain Transfers from council signer registration alone', isActive: false },
  { name: 'restores Crosschain Transfers for an active council member', isActive: true },
])('$name', async ({ isActive }) => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const importWalletKeys = new MemoryWalletKeys({
    substrateSuri: mnemonic,
    masterMnemonic: mnemonic,
  });
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
      crosschainTransfer: {
        councilSignerByDestinationChainAndAccountId: vi.fn().mockResolvedValue('0xsigner'),
        activeGlobalIssuanceCouncilByDestinationChain: vi.fn().mockResolvedValue('0xactive'),
        globalIssuanceCouncilByHash: vi.fn().mockResolvedValue({
          epochMicrogonsPerArgonot: 0n,
          members: {
            '0xsigner': {
              accountId: isActive ? importWalletKeys.vaultingAddress : '5AnotherCouncilMember',
              signer: '0xsigner',
              weight: 1n,
            },
          },
          totalWeight: 1n,
        }),
      },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: `${isActive}`,
      hasExtensionTreasury: `${isActive}`,
      hasExtensionOperations: `${isActive}`,
      hasActivatedCrosschain: `${isActive}`,
    }),
  );
});

it('preserves Operations history without granting Crosschain access from an owned minting authority', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const importWalletKeys = new MemoryWalletKeys({
    substrateSuri: mnemonic,
    masterMnemonic: mnemonic,
  });
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
      crosschainTransfer: {
        councilSignerByDestinationChainAndAccountId: vi.fn().mockResolvedValue(null),
        activeGlobalIssuanceCouncilByDestinationChain: vi.fn().mockResolvedValue(null),
        mintingAuthoritiesBySigner: {
          multi: vi.fn(async (signers: string[]) =>
            signers.map((_, index) =>
              index === 0
                ? {
                    accountId: importWalletKeys.vaultingAddress,
                    destinationChain: { type: 'Ethereum' },
                  }
                : null,
            ),
          ),
        },
      },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
      hasActivatedCrosschain: 'false',
    }),
  );
});

it('does not infer treasury from an unattributed account hold', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
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

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
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
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.getOperatorVaultId.mockResolvedValue(params.activityKind === 'vault' ? 7 : null);
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

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(importMocks.findMiningActivity).toHaveBeenCalledWith(importWalletKeys.defaultArgonAddress, {
    activityMask: AccountActivityKind.BondPosition | AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
  });
  expect(importMocks.getOperatorVaultId).toHaveBeenCalledWith(importWalletKeys.vaultingAddress);
  expect(getVault).toHaveBeenCalledTimes(params.activityKind === 'vault' ? 1 : 0);
  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'true',
      hasExtensionOperations: params.hasExtensionOperations,
      vaultingSetupStatus: params.vaultingSetupStatus,
    }),
  );

  getVault.mockRestore();
});

it('keeps proven account state when index history is unavailable during repair', async () => {
  const { mnemonic, walletKeys } = createTestWallet('//Alice');
  const { config, db, dbPromise } = await createImporterConfig(walletKeys);
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([emptyBalance, emptyBalance, emptyBalance, emptyBalance]);
  importMocks.findMiningActivity.mockRejectedValue(new Error('index unavailable'));
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockRejectedValue(new Error('seat lookup unavailable'));
  vi.spyOn(Restarter.prototype, 'deleteAndCreateLocalDatabase').mockResolvedValue();
  const restart = vi.spyOn(Restarter.prototype, 'restart').mockImplementation(() => undefined);

  await new Importer(config, walletKeys, dbPromise).importFromMnemonic(mnemonic);

  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      hasExtensionTreasury: 'false',
      hasExtensionOperations: 'false',
      hasMiningBids: 'false',
      hasMiningSeats: 'false',
    }),
  );
  expect(restart).toHaveBeenCalledOnce();

  importMocks.readBalances.mockResolvedValue([
    emptyBalance,
    { ...emptyBalance, availableMicrogons: 1n },
    emptyBalance,
    emptyBalance,
  ]);
  importMocks.getOperatorVaultId.mockRejectedValueOnce(new Error('vault lookup unavailable'));

  await new Importer(config, walletKeys, dbPromise).recoverCurrentAccountState();

  expect(config.walletAccountsHadPreviousLife).toBe(true);
  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(await db.configTable.fetchAllAsObject()).toEqual(
    expect.objectContaining({
      walletAccountsHadPreviousLife: 'true',
      hasExtensionTreasury: 'true',
      hasExtensionOperations: 'true',
    }),
  );
});

it('non-destructively recovers the current wallet setup', async () => {
  const db = await createTestDb();
  await db.configTable.insertOrReplace({
    walletAccountsHadPreviousLife: 'false',
    hasExtensionTreasury: 'false',
    hasExtensionOperations: 'false',
    certificationDetails: JsonExt.stringify({ hasSavedMnemonic: false }, 2),
    walletPreviousLifeRecovered: 'false',
    requiresPassword: 'true',
    userJurisdiction: JsonExt.stringify(testJurisdiction, 2),
  });
  const dbPromise = Promise.resolve(db);
  const { walletKeys } = createTestWallet('//Alice');
  instanceChecks.delete(Config.prototype.constructor);
  const config = new Config(dbPromise, walletKeys);
  await config.load();
  importMocks.getFinalizedClient.mockResolvedValue({
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(null),
      },
      vaults: { vaultIdByOperator: importMocks.getOperatorVaultId },
    },
  });
  importMocks.readBalances.mockResolvedValue([
    emptyBalance,
    { ...emptyBalance, availableMicrogons: 1n },
    emptyBalance,
    emptyBalance,
  ]);
  importMocks.findMiningActivity.mockResolvedValue({ blocks: [], coverage: { gaps: [] } });
  vi.spyOn(Mining, 'fetchMiningSeatsForAccount').mockResolvedValue({});

  await new Importer(config, walletKeys, dbPromise).recoverCurrentAccountState();

  expect(config.walletAccountsHadPreviousLife).toBe(true);
  expect(config.walletPreviousLifeRecovered).toBe(false);
  expect(config.isBootingUpPreviousWalletHistory).toBe(false);
  expect(config.hasExtensionTreasury).toBe(true);
  expect(config.hasExtensionOperations).toBe(true);
  expect(config.miningSetupStatus).toBe(MiningSetupStatus.Checklist);
  expect(config.certificationDetails?.hasSavedMnemonic).toBe(false);

  instanceChecks.delete(Config.prototype.constructor);
  const recoverAccount = vi.fn(async () => ({}));
  const restartedConfig = new Config(dbPromise, walletKeys, recoverAccount);
  await restartedConfig.load();

  expect(recoverAccount).toHaveBeenCalledOnce();
  expect(restartedConfig.walletAccountsHadPreviousLife).toBe(true);
  expect(restartedConfig.walletPreviousLifeRecovered).toBe(true);
  expect(restartedConfig.isBootingUpPreviousWalletHistory).toBe(false);
  expect(restartedConfig.hasExtensionTreasury).toBe(true);
  expect(restartedConfig.hasExtensionOperations).toBe(true);
  expect(restartedConfig.miningSetupStatus).toBe(MiningSetupStatus.Checklist);
  expect(restartedConfig.certificationDetails?.hasSavedMnemonic).toBe(false);
  expect(restartedConfig.requiresPassword).toBe(true);
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
