import { erc20Abi, getAddress, type Address } from 'viem';
import { createStableSwapPublicClient, getStableSwapArgonTokenAddress } from './StableSwaps.ts';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { type IWallet, type IOtherToken, type IOtherTokenDefinition, defaultWalletData } from './Wallet.ts';

type ITokenBalanceClient = {
  readContract(args: {
    address: Address;
    abi: typeof erc20Abi;
    functionName: 'balanceOf';
    args: [Address];
  }): Promise<bigint>;
  getBalance(args: { address: Address }): Promise<bigint>;
};

const trackedEthereumTokens = [
  {
    symbol: 'ARGN',
    decimals: 18,
    address: getStableSwapArgonTokenAddress(),
    chain: 'ethereum',
    unitOfMeasurement: UnitOfMeasurement.ARGN,
  },
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

export class WalletForEthereum {
  public data: IWallet = {
    ...defaultWalletData,
  };

  private lastBalanceLoadAt = 0;
  private balanceRefreshIsStarted = false;
  private isLoadingBalances = false;
  private readonly balanceLoadIntervalMs = 60_000;

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
    const ethereumClient = createStableSwapPublicClient();

    try {
      const tokens = await loadTokens(ethereumClient, normalizedWalletAddress, trackedEthereumTokens);
      const argonToken = tokens.find(isEthereumArgonToken);

      this.data.otherTokens = tokens.filter(token => !isEthereumArgonToken(token));
      console.log('OTHER TOKENS: ', this.data.otherTokens);

      if (argonToken) {
        this.data.availableMicrogons = argonToken.value / ethereumArgonValueToMicrogonsFactor;
      } else {
        this.data.availableMicrogons = 0n;
      }
      this.data.totalMicrogons = this.data.availableMicrogons + this.data.reservedMicrogons;
      this.data.totalMicronots = this.data.availableMicronots + this.data.reservedMicronots;
    } catch (error) {
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
}

function isEthereumArgonToken(token: IOtherTokenDefinition): boolean {
  return token.unitOfMeasurement === UnitOfMeasurement.ARGN;
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

const ethereumArgonValueToMicrogonsFactor = 10n ** 18n / BigInt(MICROGONS_PER_ARGON);
