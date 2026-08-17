import { defaultMicrogonsPer, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { PriceIndex } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { setupAppScenario } from './setupAppScenario.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { defaultWalletData, type IWallet } from '../../src-vue/lib/Wallet.ts';
import type { IWalletRecord } from '../../src-vue/lib/db/WalletsTable.ts';

export type HomeScenario = 'loading' | 'basic' | 'treasury' | 'operations' | 'priceUnavailable';

export function setupHomeScenario(
  state: HomeScenario,
  configOverrides: Parameters<typeof setupAppScenario>[0]['config'] = {},
) {
  const scenario = setupAppScenario({
    selectedTab: TopTab.Home,
    config: {
      hasExtensionTreasury: state === 'treasury' || state === 'operations',
      hasExtensionOperations: state === 'operations',
      ...configOverrides,
    },
  });
  const { wallets } = scenario;

  const currency = getCurrency();
  const financials = useFinancials();
  const internalWallet = createWalletRecord({
    id: 1,
    walletType: 'argon',
    role: 'defaultArgon',
    name: 'Internal App Wallet',
    address: wallets.defaultArgonWallet.address,
  });
  const ethereumWallets = [
    createWalletRecord({
      id: 2,
      walletType: 'ethereum',
      role: 'defaultEthereum',
      name: 'Main',
      address: '0x1111111111111111111111111111111111111111',
    }),
    createWalletRecord({
      id: 3,
      walletType: 'ethereum',
      role: 'externalEthereum',
      name: 'Treasury',
      address: '0x2222222222222222222222222222222222222222',
    }),
  ];

  (wallets.walletRecords as IWalletRecord[]) =
    state === 'treasury' || state === 'operations' ? [internalWallet, ...ethereumWallets] : [internalWallet];
  wallets.defaultArgonWallet.availableMicrogons = 125n * 1_000_000n;
  wallets.defaultArgonWallet.totalMicrogons = wallets.defaultArgonWallet.availableMicrogons;
  wallets.isLoaded = state !== 'loading';
  financials.savingsIsLoaded = state !== 'loading';

  const ethereumWalletData = new Map<number, IWallet>(
    ethereumWallets.map(record => [
      record.id,
      {
        ...defaultWalletData,
        address: record.address,
        availableMicrogons: 25n * 1_000_000n,
        otherTokens: [],
        totalMicrogons: 25n * 1_000_000n,
      },
    ]),
  );
  const getEthereumWalletRecord: (recordId: number) => IWallet = recordId => {
    const wallet = ethereumWalletData.get(recordId);
    if (!wallet) throw new Error(`Synthetic Ethereum wallet record not found: ${recordId}`);
    return wallet;
  };
  Object.assign(wallets, { getEthereumWalletRecord });

  Object.assign(currency, {
    isLoaded: state !== 'loading',
    microgonsPer: { ...defaultMicrogonsPer },
    priceIndex: Object.assign(new PriceIndex(), {
      argonUsdPrice: BigNumber(state === 'loading' || state === 'priceUnavailable' ? 0 : 1),
      argonUsdTargetPrice: BigNumber(state === 'loading' || state === 'priceUnavailable' ? 0 : 1),
      argonotUsdPrice: BigNumber(14),
      btcUsdPrice: BigNumber(68_000),
    }),
    recordsByKey: {
      [UnitOfMeasurement.USD]: { key: UnitOfMeasurement.USD, symbol: '$', name: 'Dollar' },
    },
    record: { key: UnitOfMeasurement.USD, symbol: '$', name: 'Dollar' },
    symbol: '$',
    targetOffset: 0,
  });

  return scenario;
}

function createWalletRecord(
  record: Pick<IWalletRecord, 'id' | 'walletType' | 'role' | 'name' | 'address'>,
): IWalletRecord {
  const timestamp = new Date('2026-08-16T00:00:00.000Z');
  return { ...record, sortOrder: record.id, createdAt: timestamp, updatedAt: timestamp };
}
