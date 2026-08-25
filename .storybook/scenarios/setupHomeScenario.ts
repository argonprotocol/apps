import { defaultMicrogonsPer, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { PriceIndex } from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import { setupAppScenario } from './setupAppScenario.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { defaultWalletData, type IWalletData, WalletType } from '../../src-vue/lib/Wallet.ts';
import type { IWalletRecord } from '../../src-vue/lib/db/WalletsTable.ts';
import { WalletForEthereum } from '../../src-vue/lib/WalletForEthereum.ts';

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
  const ethereumWalletRecords = [
    createWalletRecord({
      id: 2,
      walletType: 'ethereum',
      name: 'Main',
      address: '0x1111111111111111111111111111111111111111',
    }),
    createWalletRecord({
      id: 3,
      walletType: 'ethereum',
      name: 'Treasury',
      address: '0x2222222222222222222222222222222222222222',
    }),
  ];

  wallets.defaultArgonWallet.availableMicrogons = 125n * 1_000_000n;
  wallets.defaultArgonWallet.totalMicrogons = wallets.defaultArgonWallet.availableMicrogons;
  wallets.isLoaded = state !== 'loading';
  financials.savingsIsLoaded = state !== 'loading';

  const ethereumWalletData = new Map<number, IWalletData<WalletType.ethereum>>(
    ethereumWalletRecords.map(record => [
      record.id,
      {
        ...defaultWalletData,
        type: WalletType.ethereum,
        address: record.address,
        availableMicrogons: 25n * 1_000_000n,
        otherTokens: [],
        totalMicrogons: 25n * 1_000_000n,
      },
    ]),
  );
  const persistedWallets =
    state === 'treasury' || state === 'operations'
      ? ethereumWalletRecords.map(record => {
          const wallet = new WalletForEthereum(record.address, undefined, record);
          wallet.data = ethereumWalletData.get(record.id)!;
          return wallet;
        })
      : [];
  Object.assign(wallets, {
    ethereumWallets: {
      persistedWallets,
      length: persistedWallets.length,
    },
  });

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

function createWalletRecord(record: Pick<IWalletRecord, 'id' | 'walletType' | 'name' | 'address'>): IWalletRecord {
  const timestamp = new Date('2026-08-16T00:00:00.000Z');
  return { ...record, sortOrder: record.id, createdAt: timestamp, updatedAt: timestamp };
}
