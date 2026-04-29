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
    const basePublicClient = createPublicClient({
      chain: base,
      transport: http(baseNetwork.rpcUrl, {
        retryCount: 1,
        timeout: 15_000,
      }),
    });
    this.data.otherTokens = await loadTokens(basePublicClient, getAddress(this.data.address), trackedBaseTokens);
  }
}
