import './helpers/mocks.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { reactive, watch } from 'vue';
import { type ArgonCurrentQueryClient, MainchainClients, MiningFrames } from '@argonprotocol/apps-core';
import { Config } from '../lib/Config.ts';
import { Currency } from '../lib/Currency.ts';
import { EthereumClient } from '../lib/EthereumClient.ts';
import { MyVault } from '../lib/MyVault.ts';
import { Vaults } from '../lib/Vaults.ts';
import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import { instanceChecks } from '../lib/Utils.ts';
import { createTestDb } from './helpers/db.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { getConfig } from '../stores/config.ts';
import { getDbPromise } from '../stores/helpers/dbPromise.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { getMainchainClients, getMiningFrames } from '../stores/mainchain.ts';
import { getCurrency } from '../stores/currency.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getMyVault } from '../stores/vaults.ts';

vi.mock('../stores/config.ts', () => ({ getConfig: vi.fn(), NETWORK_NAME: 'dev-docker' }));
vi.mock('../stores/helpers/dbPromise.ts', () => ({ getDbPromise: vi.fn() }));
vi.mock('../stores/wallets.ts', () => ({ getWalletKeys: vi.fn() }));
vi.mock('../stores/mainchain.ts', () => ({ getMiningFrames: vi.fn(), getMainchainClients: vi.fn() }));
vi.mock('../stores/currency.ts', () => ({ getCurrency: vi.fn() }));
vi.mock('../stores/transactions.ts', () => ({ getTransactionTracker: vi.fn() }));
vi.mock('../stores/bitcoin.ts', () => ({ getBitcoinLocks: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it('publishes the Ethereum approval nonce when config loads after council startup without another refresh', async () => {
  const db = await createTestDb();
  await db.configTable.insertOrReplace({ ethereumExecutionRpcUrl: JSON.stringify('http://127.0.0.1:18545') });
  const { walletKeys } = createTestWallet('//Alice', { canSign: false, canAccessServer: false });
  vi.spyOn(walletKeys, 'didWalletHavePreviousLife').mockResolvedValue(false);
  instanceChecks.delete(Config.prototype.constructor);
  let releaseConfig!: () => void;
  const waitForConfig = new Promise<void>(resolve => (releaseConfig = resolve));
  const fetchConfig = db.configTable.fetchAllAsObject.bind(db.configTable);
  vi.spyOn(db.configTable, 'fetchAllAsObject').mockImplementation(async () => {
    await waitForConfig;
    return fetchConfig();
  });
  const config = reactive(new Config(Promise.resolve(db), walletKeys));
  const loadConfig = config.load();
  const clients = { events: { on: vi.fn() } } as unknown as MainchainClients;
  const miningFrames = new MiningFrames(clients);
  const finalizedClient = {
    query: {
      crosschainTransfer: {
        councilSignerByDestinationChainAndAccountId: async () => null,
        councilApprovalCursorByDestinationChainAndAccountId: async () => null,
        gatewayStateBySourceChain: async () => null,
        nextCouncilApprovalQueueNonceByDestinationChain: async () => 0n,
        activeGlobalIssuanceCouncilByDestinationChain: async () => null,
        transferOutQuoteMicrogonsPerArgonotByDestinationChain: async () => null,
      },
    },
  } as unknown as ArgonCurrentQueryClient;
  vi.spyOn(miningFrames.blockWatch, 'start').mockResolvedValue();
  vi.spyOn(miningFrames.blockWatch, 'getFinalizedApi').mockResolvedValue(finalizedClient);
  vi.spyOn(MyVault.prototype, 'load').mockResolvedValue();
  vi.spyOn(Vaults.prototype, 'loadCurrentState').mockResolvedValue();
  vi.mocked(getConfig).mockReturnValue(config);
  vi.mocked(getDbPromise).mockReturnValue(Promise.resolve(db));
  vi.mocked(getWalletKeys).mockReturnValue(walletKeys);
  vi.mocked(getMainchainClients).mockReturnValue(clients);
  vi.mocked(getMiningFrames).mockReturnValue(miningFrames);
  vi.mocked(getCurrency).mockReturnValue(new Currency(clients, config as Config));
  vi.mocked(getTransactionTracker).mockReturnValue({} as TransactionTracker);
  vi.mocked(getBitcoinLocks).mockReturnValue({ data: { readiness: 'loading' } } as BitcoinLocks);
  vi.spyOn(EthereumClient.prototype, 'getGatewayApprovalNonce').mockResolvedValue(7n);
  const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const globalCouncil = getMyVault().globalCouncil;
  const observedNonces: bigint[] = [];
  const stopWatching = watch(
    () => globalCouncil.data.ethereumApprovalNonce,
    nonce => {
      if (nonce !== undefined) observedNonces.push(nonce);
    },
  );

  try {
    await globalCouncil.load();
    expect(globalCouncil.data.isReady).toBe(true);
    expect(globalCouncil.data.ethereumApprovalNonce).toBeUndefined();

    releaseConfig();
    await loadConfig;
    await vi.waitFor(() => expect(observedNonces).toEqual([7n]));
    expect(globalCouncil.data.ethereumApprovalNonce).toBe(7n);
    expect(logError).not.toHaveBeenCalled();
  } finally {
    releaseConfig();
    stopWatching();
    await loadConfig;
    await db.close();
  }
});
