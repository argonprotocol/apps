import type { PublicClient } from 'viem';
import { createEthereumPublicClient } from './EthereumClient.ts';
import { NETWORK_NAME } from './Env.ts';

export async function createStableSwapPublicClient(): Promise<PublicClient> {
  if (NETWORK_NAME === 'dev-docker') {
    const { createStableSwapFixturePublicClient } = await import('./StableSwapFixturePublicClient.ts');
    return createStableSwapFixturePublicClient();
  }

  return createEthereumPublicClient();
}
