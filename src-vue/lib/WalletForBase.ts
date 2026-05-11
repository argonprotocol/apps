import { createPublicClient, getAddress, http } from 'viem';
import { base } from 'viem/chains';
import { defaultWalletData, IOtherTokenDefinition, type IWallet } from './Wallet.ts';
import { NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { loadTokens } from './WalletForEthereum.ts';

export const trackedBaseTokens = [
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
    address: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    chain: 'base',
    unitOfMeasurement: UnitOfMeasurement.USDC,
  },
] as const satisfies readonly IOtherTokenDefinition[];

export class WalletForBase {
  public data: IWallet = {
    ...defaultWalletData,
  };

  constructor(public readonly address: string) {
    this.data.address = address;
  }

  public async load(): Promise<void> {
    const { baseNetwork } = NetworkConfig.get();
    const rpcUrl = baseNetwork.rpcUrl.trim();

    if (!rpcUrl) {
      this.data.fetchErrorMsg = '';
      this.data.otherTokens = [];
      return;
    }

    this.data.fetchErrorMsg = '';

    try {
      const basePublicClient = createPublicClient({
        chain: base,
        transport: http(rpcUrl, {
          retryCount: 1,
          timeout: 15_000,
        }),
      });

      this.data.otherTokens = await loadTokens(basePublicClient, getAddress(this.data.address), trackedBaseTokens);
    } catch (error) {
      console.error('Base wallet balance load failed', {
        address: this.address,
        rpcUrl,
        error,
      });
      this.data.fetchErrorMsg = error instanceof Error ? error.message : 'Unable to load Base token balances.';
      this.data.otherTokens = [];
    }
  }
}
