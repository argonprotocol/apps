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
import { GlobalCouncil } from '../../lib/GlobalCouncil.ts';
import type { IConfig } from '../../interfaces/IConfig.ts';
import { MintingAuthorities } from '../../lib/MintingAuthorities.ts';
import { DEFAULT_MASTER_XPUB_PATH, MyVault } from '../../lib/MyVault.ts';
import { TransactionTracker } from '../../lib/TransactionTracker.ts';
import { BitcoinLockCreate } from '../../lib/txs/BitcoinLock.create.ts';
import { BitcoinOrphanRelease } from '../../lib/txs/BitcoinOrphan.release.ts';
import { UpstreamOperatorClient } from '../../lib/UpstreamOperatorClient.ts';
import { Vaults } from '../../lib/Vaults.ts';
import type { WalletKeys } from '../../lib/WalletKeys.ts';
import type { ServerApiClient } from '../../lib/ServerApiClient.ts';
import { setDbPromise } from '../../stores/helpers/dbPromise.ts';
import { setMainchainClients } from '../../stores/mainchain.ts';
import { createTestDb } from './db.ts';
import { createMockWalletKeys } from './wallet.ts';

export const walletFundingMicrogons = 100_000_000n;

export const defaultVaultSetup: IConfig['vaultSetup'] = {
  ...(Config.getDefault('vaultSetup') as IConfig['vaultSetup']),
  securitizationRatio: 1,
  securitizationMicrogons: 10_000_000n,
  committedMicronots: 0n,
  btcFlatFee: 1_000_000n,
  btcPctFee: 2.5,
};

export type BitcoinLocksClientHarness = {
  db: Db;
  clients: MainchainClients;
  walletKeys: WalletKeys;
  currency: CurrencyBase;
  transactionTracker: TransactionTracker;
  bitcoinLocks: BitcoinLocks;
  bitcoinLockCreate: BitcoinLockCreate;
  bitcoinOrphanRelease: BitcoinOrphanRelease;
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
  db?: Db;
  upstreamOperatorClient?: UpstreamOperatorClient;
  walletKeys?: WalletKeys;
}): Promise<BitcoinLocksClientHarness> {
  const { archiveUrl, esploraHost, upstreamOperatorClient } = args;

  const clients = new MainchainClients(archiveUrl);
  setMainchainClients(clients);

  const db = args.db ?? (await createTestDb());
  setDbPromise(Promise.resolve(db));

  const walletKeys = args.walletKeys ?? createMockWalletKeys();

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
  const bitcoinOrphanRelease = new BitcoinOrphanRelease(bitcoinLocks, transactionTracker);
  await bitcoinOrphanRelease.load();
  const bitcoinLockCreate = new BitcoinLockCreate(
    bitcoinLocks,
    transactionTracker,
    currency,
    upstreamOperatorClient ?? new UpstreamOperatorClient(),
  );
  await bitcoinLockCreate.load();

  return {
    db,
    clients,
    walletKeys,
    currency,
    transactionTracker,
    bitcoinLocks,
    bitcoinLockCreate,
    bitcoinOrphanRelease,
    miningFrames,
  };
}

export async function createBitcoinLocksHarness(args: {
  archiveUrl: string;
  esploraHost: string;
  network: string;
  walletKeys?: WalletKeys;
  vaultSetup?: IConfig['vaultSetup'];
  walletFundingMicrogons?: bigint;
  getOperatorServer?: () => ServerApiClient | undefined;
}): Promise<BitcoinLocksHarness> {
  const { archiveUrl, esploraHost, network, vaultSetup = defaultVaultSetup } = args;
  const clientHarness = await createBitcoinLocksClientHarness({
    archiveUrl,
    esploraHost,
    network,
    walletKeys: args.walletKeys,
  });
  const { db, clients, walletKeys, currency, transactionTracker, bitcoinLocks, miningFrames } = clientHarness;
  const fundingMicrogons = args.walletFundingMicrogons ?? walletFundingMicrogons;

  await sudoFundWallet({
    address: walletKeys.defaultArgonAddress,
    microgons: fundingMicrogons,
    micronots: 0n,
    archiveUrl,
  });

  const archiveClient = await clients.archiveClientPromise;
  await waitFor(90e3, 'vault wallet finalized funding visibility', async () => {
    const finalizedHead = await archiveClient.rpc.chain.getFinalizedHead();
    const finalizedClient = await archiveClient.at(finalizedHead);
    const balance = await finalizedClient.query.system.account(walletKeys.defaultArgonAddress).then(x => x.data.free);
    if (balance < fundingMicrogons) return;
    return balance;
  });

  const vaults = new Vaults(network, currency, miningFrames);
  Object.assign(vaults, {
    saveStats: async () => {},
    loadStatsFromFile: async () => undefined,
  });

  const globalCouncil = new GlobalCouncil(Promise.resolve(db), walletKeys, miningFrames);
  const mintingAuthorities = new MintingAuthorities(Promise.resolve(db), walletKeys, miningFrames, transactionTracker);
  const myVault = new MyVault(
    Promise.resolve(db),
    vaults,
    walletKeys,
    transactionTracker,
    bitcoinLocks,
    miningFrames,
    globalCouncil,
    mintingAuthorities,
    args.getOperatorServer,
  );

  Object.assign(myVault.vaults, {
    load: async () => {},
    updateRevenue: async () => ({}) as IAllVaultStats,
  });

  const config = new Config(Promise.resolve(db), walletKeys);
  await config.load();
  await myVault.load();

  const vaultCreation = await myVault.createNew({
    masterXpubPath: DEFAULT_MASTER_XPUB_PATH,
    vaultSetup,
  });
  await vaultCreation.txResult.waitForFinalizedBlock;
  await vaultCreation.waitForPostProcessing;
  await myVault.subscribe();

  await waitFor(60e3, 'vault securitization availability', () =>
    myVault.createdVault ? myVault.createdVault.availableBitcoinSpace() > 0n : false,
  );

  return {
    ...clientHarness,
    vaults,
    myVault,
  };
}

export async function cleanupBitcoinLocksClientHarness(harness: BitcoinLocksClientHarness): Promise<void> {
  await shutdownBitcoinLocksClientHarness(harness);
  await harness.db.close();
}

export async function shutdownBitcoinLocksClientHarness(harness: BitcoinLocksClientHarness): Promise<void> {
  await harness.bitcoinLocks.shutdown();
  await harness.transactionTracker.shutdown();
  await harness.miningFrames.stop();
  await harness.clients.disconnect();
}

export async function cleanupBitcoinLocksHarness(harness: BitcoinLocksHarness): Promise<void> {
  harness.myVault.unsubscribe();
  await cleanupBitcoinLocksClientHarness(harness);
}
