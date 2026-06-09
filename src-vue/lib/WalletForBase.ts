import { createPublicClient, getAddress, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { fetch, NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { defaultWalletData, IOtherTokenDefinition, type IWallet } from './Wallet.ts';
import { loadTokens } from './WalletForEthereum.ts';

export class WalletForBase {
  public data: IWallet = {
    ...defaultWalletData,
  };

  constructor(public readonly address: string) {
    this.data.address = address;
  }

  public async load(): Promise<void> {
    const { baseNetwork } = NetworkConfig.get();
    const chain = getBaseChain(baseNetwork.chainId);
    const rpcUrl = baseNetwork.rpcUrl.trim();

    if (!rpcUrl || !chain) {
      this.data.fetchErrorMsg = '';
      this.data.otherTokens = [];
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
    } catch (error) {
      console.error('Base wallet balance load failed', {
        address: this.address,
        rpcUrl,
        error,
      });
      this.data.fetchErrorMsg = 'Unable to load Base token balances.';
      this.data.otherTokens = [];
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
