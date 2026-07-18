import { type Address, erc20Abi, getAddress } from 'viem';
import { NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { EvmContracts } from '@argonprotocol/mainchain';
import { defaultWalletData, type IOtherToken, type IOtherTokenDefinition, type IWallet } from './Wallet.ts';
import { createEthereumPublicClient, type IEthereumChainConfig, loadEthereumChainConfig } from './EthereumClient.ts';
import type { Currency } from './Currency.ts';
import { createFinancialPosition, type IEthereumWalletFinancialPosition } from '../interfaces/IFinancialPosition.ts';
import {
  cacheExternalWalletBalances,
  restoreCachedExternalWalletBalances,
  type FinancialCacheTable,
} from './db/FinancialCacheTable.ts';

type ITokenBalanceClient = {
  readContract(args: {
    address: Address;
    abi: typeof erc20Abi;
    functionName: 'balanceOf';
    args: [Address];
  }): Promise<bigint>;
  getBalance(args: { address: Address }): Promise<bigint>;
};

const trackedOtherEthereumTokens = [
  {
    symbol: 'ETH',
    decimals: 18,
    address: null,
    chain: 'ethereum',
    unitOfMeasurement: UnitOfMeasurement.ETH,
  },
  {
    symbol: 'USDC',
    decimals: 6,
    address: null,
    chain: 'ethereum',
    unitOfMeasurement: UnitOfMeasurement.USDC,
  },
  {
    symbol: 'USDT',
    decimals: 6,
    address: getAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
    chain: 'ethereum',
    unitOfMeasurement: UnitOfMeasurement.USDT,
  },
  {
    symbol: 'USDE',
    decimals: 18,
    address: getAddress('0x4c9EDD5852cd905f086C759E8383e09bff1E68B3'),
    chain: 'ethereum',
    unitOfMeasurement: UnitOfMeasurement.USDE,
  },
] as const satisfies readonly IOtherTokenDefinition[];
const ETHEREUM_MAINNET_CHAIN_ID = 1;

export class WalletForEthereum {
  public data: IWallet = {
    ...defaultWalletData,
  };

  private lastBalanceLoadAt = 0;
  private balanceRefreshIsStarted = false;
  private isLoadingBalances = false;
  private readonly balanceLoadIntervalMs = 60_000;
  private argonTokensPromise?: Promise<{
    argonTokens: IOtherTokenDefinition[];
    chainConfig?: IEthereumChainConfig;
  }>;

  constructor(
    public readonly address: string,
    private readonly financialCache?: Promise<FinancialCacheTable>,
  ) {
    this.data.address = address;
  }

  public createFinancialPositions(currency: Currency): IEthereumWalletFinancialPosition[] {
    const wallet = this.data;
    if (wallet.fetchErrorMsg && !wallet.balanceIsCached) {
      return [
        createFinancialPosition('ethereum-wallet-balance', {
          id: `${wallet.address.toLowerCase()}:ethereum:unavailable`,
          label: 'Ethereum balances unavailable',
          lifecycle: 'unavailable',
          wallet,
          asset: 'ethereum:unavailable',
        }),
      ];
    }

    const positions: IEthereumWalletFinancialPosition[] = [];
    const microgons = wallet.availableMicrogons + wallet.reservedMicrogons;
    if (microgons > 0n) {
      positions.push(
        createFinancialPosition('ethereum-wallet-balance', {
          id: `${wallet.address.toLowerCase()}:ethereum:ARGN`,
          label: 'Ethereum ARGN',
          lifecycle: 'available',
          currentValue: microgons,
          wallet,
          asset: 'ethereum:ARGN',
          nativeAmount: microgons,
        }),
      );
    }

    const micronots = wallet.availableMicronots + wallet.reservedMicronots;
    const hasArgonotPrice =
      !!currency.priceIndex.argonotUsdPrice &&
      !currency.priceIndex.argonotUsdPrice.isZero() &&
      !!currency.priceIndex.argonUsdTargetPrice &&
      !currency.priceIndex.argonUsdTargetPrice.isZero();
    if (micronots > 0n) {
      positions.push(
        createFinancialPosition('ethereum-wallet-balance', {
          id: `${wallet.address.toLowerCase()}:ethereum:ARGNOT`,
          label: 'Ethereum ARGNOT',
          lifecycle: 'available',
          currentValue: hasArgonotPrice ? currency.convertMicronotTo(micronots, UnitOfMeasurement.Microgon) : undefined,
          wallet,
          asset: 'ethereum:ARGNOT',
          nativeAmount: micronots,
        }),
      );
    }

    for (const token of wallet.otherTokens) {
      if (token.value <= 0n) continue;

      positions.push(
        createFinancialPosition('ethereum-wallet-balance', {
          id: `${wallet.address.toLowerCase()}:${token.chain}:${token.symbol}`,
          label: `Ethereum ${token.symbol}`,
          lifecycle: 'available',
          currentValue: currency.isLoaded ? currency.convertOtherToMicrogon(token) : undefined,
          wallet,
          asset: `${token.chain}:${token.symbol}`,
        }),
      );
    }

    return positions;
  }

  public async load(options: { force?: boolean } = {}) {
    await restoreCachedExternalWalletBalances(this.financialCache, 'ethereum', this.data);
    await this.loadBalances({ force: options.force ?? true });
    this.startBalanceRefresh();
  }

  private async loadBalances(options: { force?: boolean } = {}) {
    const now = Date.now();

    if (this.isLoadingBalances || (!options.force && now - this.lastBalanceLoadAt < this.balanceLoadIntervalMs)) {
      return;
    }

    this.lastBalanceLoadAt = now;
    this.isLoadingBalances = true;
    this.data.fetchErrorMsg = '';

    const normalizedWalletAddress = getAddress(this.address);

    try {
      const ethereumClient = createEthereumPublicClient();
      const { argonTokens, chainConfig } = await this.loadArgonTokens();
      const tokens = await loadTokens(ethereumClient, normalizedWalletAddress, [
        ...argonTokens,
        ...getTrackedOtherEthereumTokens(chainConfig),
      ]);
      const argonToken = tokens.find(isEthereumArgonToken);
      const argonotToken = tokens.find(isEthereumArgonotToken);

      this.data.otherTokens = tokens.filter(token => !isEthereumArgonFamilyToken(token));
      this.data.availableMicrogons = argonToken ? convertEthereumTokenBaseUnitsToRuntimeAmount(argonToken.value) : 0n;
      this.data.availableMicronots = argonotToken
        ? convertEthereumTokenBaseUnitsToRuntimeAmount(argonotToken.value)
        : 0n;
      this.data.totalMicrogons = this.data.availableMicrogons + this.data.reservedMicrogons;
      this.data.totalMicronots = this.data.availableMicronots + this.data.reservedMicronots;
      this.data.balanceUpdatedAt = new Date();
      this.data.balanceIsCached = false;
      await cacheExternalWalletBalances(this.financialCache, 'ethereum', this.data);
    } catch (error) {
      console.error('Ethereum wallet balance load failed', {
        address: this.address,
        error,
      });
      this.data.fetchErrorMsg = 'Unable to load Ethereum token balances.';
    } finally {
      this.isLoadingBalances = false;
    }
  }

  private startBalanceRefresh() {
    if (this.balanceRefreshIsStarted || typeof window === 'undefined') {
      return;
    }

    this.balanceRefreshIsStarted = true;

    window.addEventListener('focus', () => {
      void this.loadBalances();
    });

    window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void this.loadBalances();
    }, this.balanceLoadIntervalMs);
  }

  private async loadArgonTokens(): Promise<{
    argonTokens: IOtherTokenDefinition[];
    chainConfig?: IEthereumChainConfig;
  }> {
    const argonTokensPromise = this.argonTokensPromise ?? loadEthereumArgonTokens();
    this.argonTokensPromise = argonTokensPromise;

    try {
      const result = await argonTokensPromise;
      if (!result.argonTokens.length && this.argonTokensPromise === argonTokensPromise) {
        this.argonTokensPromise = undefined;
      }
      return result;
    } catch (error) {
      console.warn('Ethereum wallet chain-config load failed', {
        address: this.address,
        error,
      });
      if (this.argonTokensPromise === argonTokensPromise) {
        this.argonTokensPromise = undefined;
      }
      return { argonTokens: [] };
    }
  }
}

function isEthereumArgonToken(token: IOtherTokenDefinition): boolean {
  return token.unitOfMeasurement === UnitOfMeasurement.ARGN;
}

function isEthereumArgonotToken(token: IOtherTokenDefinition): boolean {
  return token.unitOfMeasurement === UnitOfMeasurement.ARGNOT;
}

function isEthereumArgonFamilyToken(token: IOtherTokenDefinition): boolean {
  return isEthereumArgonToken(token) || isEthereumArgonotToken(token);
}

export function convertEthereumTokenBaseUnitsToRuntimeAmount(amountBaseUnits: bigint): bigint {
  return amountBaseUnits / EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
}

export async function loadTokens(
  client: ITokenBalanceClient,
  walletAddress: Address,
  tokens: readonly IOtherTokenDefinition[],
): Promise<IOtherToken[]> {
  return await Promise.all(
    tokens.map(async token => {
      const rawBalance = token.address
        ? await client.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [walletAddress],
          })
        : await client.getBalance({
            address: walletAddress,
          });

      return {
        ...token,
        value: rawBalance,
      };
    }),
  );
}

function getTrackedOtherEthereumTokens(chainConfig?: IEthereumChainConfig): readonly IOtherTokenDefinition[] {
  const tokens = trackedOtherEthereumTokens.map(token =>
    token.unitOfMeasurement === UnitOfMeasurement.USDC
      ? {
          ...token,
          address: getAddress(NetworkConfig.get().ethereumNetwork.usdcTokenAddress),
        }
      : token,
  );

  if (chainConfig?.chainId !== ETHEREUM_MAINNET_CHAIN_ID) {
    const allowedTokens = [UnitOfMeasurement.ETH, UnitOfMeasurement.USDC];
    return tokens.filter(token => allowedTokens.includes(token.unitOfMeasurement));
  }

  return tokens;
}

async function loadEthereumArgonTokens(): Promise<{
  argonTokens: IOtherTokenDefinition[];
  chainConfig?: IEthereumChainConfig;
}> {
  const chainConfig = await loadEthereumChainConfig();
  if (!chainConfig) {
    return { argonTokens: [] };
  }

  return {
    chainConfig,
    argonTokens: [
      {
        symbol: 'ARGN',
        decimals: 18,
        address: chainConfig.argonTokenAddress,
        chain: 'ethereum',
        unitOfMeasurement: UnitOfMeasurement.ARGN,
      },
      {
        symbol: 'ARGNOT',
        decimals: 18,
        address: chainConfig.argonotTokenAddress,
        chain: 'ethereum',
        unitOfMeasurement: UnitOfMeasurement.ARGNOT,
      },
    ],
  };
}
