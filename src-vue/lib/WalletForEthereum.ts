import { type Address, erc20Abi, getAddress } from 'viem';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE } from '@argonprotocol/mainchain';
import { defaultWalletData, type IOtherToken, type IOtherTokenDefinition, type IWallet } from './Wallet.ts';
import { createEthereumPublicClient, type IEthereumChainConfig, loadEthereumChainConfig } from './EthereumClient.ts';

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
    address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
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

  constructor(public readonly address: string) {
    this.data.address = address;
  }

  public async load(options: { force?: boolean } = {}) {
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
    } catch (error) {
      console.error('Ethereum wallet balance load failed', {
        address: this.address,
        error,
      });
      this.data.fetchErrorMsg = error instanceof Error ? error.message : 'Unable to load Ethereum token balances.';
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
  return amountBaseUnits / MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
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
  if (chainConfig?.chainId !== ETHEREUM_MAINNET_CHAIN_ID) {
    return trackedOtherEthereumTokens.filter(token => token.unitOfMeasurement === UnitOfMeasurement.ETH);
  }

  return trackedOtherEthereumTokens;
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
