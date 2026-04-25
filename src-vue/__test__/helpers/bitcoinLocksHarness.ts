import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import {
  Currency as CurrencyBase,
  type IAllVaultStats,
  MainchainClients,
  MiningFrames,
} from '@argonprotocol/apps-core';
import { Config } from '../../lib/Config.ts';
import BitcoinLocks from '../../lib/BitcoinLocks.ts';
import BitcoinMempool from '../../lib/BitcoinMempool.ts';
import type { Db } from '../../lib/Db.ts';
import type IVaultingRules from '../../interfaces/IVaultingRules.ts';
import { DEFAULT_MASTER_XPUB_PATH, MyVault } from '../../lib/MyVault.ts';
import { TransactionTracker } from '../../lib/TransactionTracker.ts';
import type { UpstreamOperatorClient } from '../../lib/UpstreamOperatorClient.ts';
import { Vaults } from '../../lib/Vaults.ts';
import type { WalletKeys } from '../../lib/WalletKeys.ts';
import { setDbPromise } from '../../stores/helpers/dbPromise.ts';
import { setMainchainClients } from '../../stores/mainchain.ts';
import { createTestDb } from './db.ts';
import { createMockWalletKeys } from './wallet.ts';

export const walletFundingMicrogons = 100_000_000n;

export const defaultVaultRules: IVaultingRules = {
  ...(Config.getDefault('vaultingRules') as IVaultingRules),
  personalBtcPct: 0,
  securitizationRatio: 1,
  capitalForTreasuryPct: 50,
  capitalForSecuritizationPct: 50,
  baseMicrogonCommitment: 10_000_000n,
  baseMicronotCommitment: 0n,
  btcFlatFee: 100_000n,
  btcPctFee: 2.5,
  profitSharingPct: 5,
};

export type BitcoinLocksClientHarness = {
  db: Db;
  clients: MainchainClients;
  walletKeys: WalletKeys;
  currency: CurrencyBase;
  transactionTracker: TransactionTracker;
  bitcoinLocks: BitcoinLocks;
  miningFrames: MiningFrames;
};

export type BitcoinLocksHarness = BitcoinLocksClientHarness & {
  vaults: Vaults;
  myVault: MyVault;
};

export async function createBitcoinLocksClientHarness(args: {
  archiveUrl: string;
  esploraHost: string;
  network: string;
  upstreamOperatorClient?: UpstreamOperatorClient;
}): Promise<BitcoinLocksClientHarness> {
  const { archiveUrl, esploraHost, upstreamOperatorClient } = args;

  const clients = new MainchainClients(archiveUrl);
  setMainchainClients(clients);

  const db = await createTestDb();
  setDbPromise(Promise.resolve(db));

  const walletKeys = createMockWalletKeys();

  const currency = new CurrencyBase(clients);
  await currency.fetchMainchainRates();

  const miningFrames = new MiningFrames(clients);
  const transactionTracker = new TransactionTracker(Promise.resolve(db), miningFrames.blockWatch);
  const bitcoinLocks = new BitcoinLocks(
    Promise.resolve(db),
    walletKeys,
    miningFrames.blockWatch,
    currency,
    transactionTracker,
    new BitcoinMempool(esploraHost),
    upstreamOperatorClient,
  );
  await bitcoinLocks.load();

  return {
    db,
    clients,
    walletKeys,
    currency,
    transactionTracker,
    bitcoinLocks,
    miningFrames,
  };
}

export async function createBitcoinLocksHarness(args: {
  archiveUrl: string;
  esploraHost: string;
  network: string;
  vaultRules?: IVaultingRules;
}): Promise<BitcoinLocksHarness> {
  const { archiveUrl, esploraHost, network, vaultRules = defaultVaultRules } = args;
  const clientHarness = await createBitcoinLocksClientHarness({
    archiveUrl,
    esploraHost,
    network,
  });
  const { db, clients, walletKeys, currency, transactionTracker, bitcoinLocks, miningFrames } = clientHarness;

  await sudoFundWallet({
    address: walletKeys.vaultingAddress,
    microgons: walletFundingMicrogons,
    micronots: 0n,
    archiveUrl,
  });

  const archiveClient = await clients.archiveClientPromise;
  await waitFor(90e3, 'vault wallet finalized funding visibility', async () => {
    const finalizedHead = await archiveClient.rpc.chain.getFinalizedHead();
    const finalizedClient = await archiveClient.at(finalizedHead);
    const balance = await finalizedClient.query.system
      .account(walletKeys.vaultingAddress)
      .then(x => x.data.free.toBigInt());
    if (balance < walletFundingMicrogons) return;
    return balance;
  });

  const vaults = new Vaults(network, currency, miningFrames);
  Object.assign(vaults, {
    saveStats: async () => {},
    loadStatsFromFile: async () => undefined,
  });

  const myVault = new MyVault(Promise.resolve(db), vaults, walletKeys, transactionTracker, bitcoinLocks, miningFrames);

  Object.assign(myVault.vaults, {
    load: async () => {},
    updateRevenue: async () => ({}) as IAllVaultStats,
  });

  const config = new Config(Promise.resolve(db), walletKeys);
  await config.load();
  await myVault.load();

  const vaultCreation = await myVault.createNew({
    masterXpubPath: DEFAULT_MASTER_XPUB_PATH,
    rules: vaultRules,
    config,
  });
  await vaultCreation.txResult.waitForFinalizedBlock;
  await vaultCreation.waitForPostProcessing;
  await myVault.subscribe();

  await waitFor(
    60e3,
    'vault securitization availability',
    () => (myVault.createdVault?.availableBitcoinSpace() ?? 0n) > 0n,
  );

  return {
    ...clientHarness,
    vaults,
    myVault,
  };
}

export async function cleanupBitcoinLocksClientHarness(harness: BitcoinLocksClientHarness): Promise<void> {
  await harness.bitcoinLocks.shutdown();
  harness.miningFrames.blockWatch.stop();
  await harness.db.close();
  await harness.clients.disconnect();
}

export async function cleanupBitcoinLocksHarness(harness: BitcoinLocksHarness): Promise<void> {
  harness.myVault.unsubscribe();
  await cleanupBitcoinLocksClientHarness(harness);
}
