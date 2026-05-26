import type { PublicClient } from 'viem';
import { createEthereumPublicClient } from './EthereumClient.ts';

export async function createStableSwapPublicClient(): Promise<PublicClient> {
  if (__ARGON_NETWORK_NAME__ === 'dev-docker') {
    const { createStableSwapFixturePublicClient } = await import('./StableSwapFixturePublicClient.ts');
    return createStableSwapFixturePublicClient();
  }

  return createEthereumPublicClient();
}
