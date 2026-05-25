import type { PublicClient } from 'viem';
import { createEthereumPublicClient } from './EthereumClient.ts';
import { createStableSwapFixturePublicClient } from './StableSwapFixturePublicClient.ts';

export function createStableSwapPublicClient(): PublicClient {
  if (__ARGON_NETWORK_NAME__ === 'dev-docker') {
    return createStableSwapFixturePublicClient();
  }

  return createEthereumPublicClient();
}
