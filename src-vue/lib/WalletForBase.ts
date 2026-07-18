import { createPublicClient, getAddress, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { fetch, NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { defaultWalletData, IOtherTokenDefinition, type IWallet } from './Wallet.ts';
import { loadTokens } from './WalletForEthereum.ts';
import type { Currency } from './Currency.ts';
import { createFinancialPosition, type IBaseWalletFinancialPosition } from '../interfaces/IFinancialPosition.ts';
import {
  cacheExternalWalletBalances,
  restoreCachedExternalWalletBalances,
  type FinancialCacheTable,
} from './db/FinancialCacheTable.ts';

export class WalletForBase {
  public data: IWallet = {
    ...defaultWalletData,
  };

  constructor(
    public readonly address: string,
    private readonly financialCache?: Promise<FinancialCacheTable>,
  ) {
    this.data.address = address;
  }

  public createFinancialPositions(currency: Currency): IBaseWalletFinancialPosition[] {
    const wallet = this.data;
    if (wallet.fetchErrorMsg && !wallet.balanceIsCached) {
      return [
        createFinancialPosition('base-wallet-balance', {
          id: `${wallet.address.toLowerCase()}:base:unavailable`,
          label: 'Base balances unavailable',
          lifecycle: 'unavailable',
          wallet,
          asset: 'base:unavailable',
        }),
      ];
    }

    const positions: IBaseWalletFinancialPosition[] = [];
    const hasStablecoinPrice =
      !!currency.priceIndex.argonUsdTargetPrice && !currency.priceIndex.argonUsdTargetPrice.isZero();
    for (const token of wallet.otherTokens) {
      if (token.value <= 0n) continue;

      const isStablecoin = [UnitOfMeasurement.USDC, UnitOfMeasurement.USDT, UnitOfMeasurement.USDE].includes(
        token.unitOfMeasurement,
      );
      positions.push(
        createFinancialPosition('base-wallet-balance', {
          id: `${wallet.address.toLowerCase()}:${token.chain}:${token.symbol}`,
          label: `Base ${token.symbol}`,
          lifecycle: 'available',
          currentValue: isStablecoin && hasStablecoinPrice ? currency.convertOtherToMicrogon(token) : undefined,
          wallet,
          asset: `${token.chain}:${token.symbol}`,
        }),
      );
    }
    return positions;
  }

  public async load(): Promise<void> {
    await restoreCachedExternalWalletBalances(this.financialCache, 'base', this.data);
    const { baseNetwork } = NetworkConfig.get();
    const chain = getBaseChain(baseNetwork.chainId);
    const rpcUrl = baseNetwork.rpcUrl.trim();

    if (!rpcUrl || !chain) {
      this.data.fetchErrorMsg = '';
      this.data.otherTokens = [];
      this.data.balanceUpdatedAt = new Date();
      this.data.balanceIsCached = false;
      return;
    }

    this.data.fetchErrorMsg = '';

    try {
      const basePublicClient = createPublicClient({
        chain,
        transport: http(rpcUrl, {
          fetchFn: fetch,
          retryCount: 1,
          timeout: 15_000,
        }),
      });

      this.data.otherTokens = await loadTokens(
        basePublicClient,
        getAddress(this.data.address),
        getTrackedBaseTokens(baseNetwork.usdcTokenAddress),
      );
      this.data.balanceUpdatedAt = new Date();
      this.data.balanceIsCached = false;
      await cacheExternalWalletBalances(this.financialCache, 'base', this.data);
    } catch (error) {
      console.error('Base wallet balance load failed', {
        address: this.address,
        rpcUrl,
        error,
      });
      this.data.fetchErrorMsg = 'Unable to load Base token balances.';
      if (!this.data.balanceIsCached) this.data.otherTokens = [];
    }
  }
}

function getBaseChain(chainId: number) {
  if (chainId === base.id) {
    return base;
  }

  if (chainId === baseSepolia.id) {
    return baseSepolia;
  }
}

function getTrackedBaseTokens(usdcTokenAddress: string): readonly IOtherTokenDefinition[] {
  return [
    {
      symbol: 'ETH',
      decimals: 18,
      address: null,
      chain: 'base',
      unitOfMeasurement: UnitOfMeasurement.ETH,
    },
    {
      symbol: 'USDC',
      decimals: 6,
      address: getAddress(usdcTokenAddress),
      chain: 'base',
      unitOfMeasurement: UnitOfMeasurement.USDC,
    },
  ];
}
