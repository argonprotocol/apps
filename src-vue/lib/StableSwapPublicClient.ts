import type { PublicClient } from 'viem';
import { createEthereumPublicClient } from './EthereumClient.ts';
import { NETWORK_NAME } from './Env.ts';

export async function createStableSwapPublicClient(executionRpcUrl?: string): Promise<PublicClient> {
  if (NETWORK_NAME === 'dev-docker' && !executionRpcUrl?.trim()) {
    const { createStableSwapFixturePublicClient } = await import('./StableSwapFixturePublicClient.ts');
    return createStableSwapFixturePublicClient();
  }

  return createEthereumPublicClient(undefined, executionRpcUrl);
}
