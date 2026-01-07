import { SubstrateChain } from '@hyperbridge/sdk';
import { toHex } from 'viem';
import { createDeferred } from './Deferred.ts';
import { NetworkConfig } from './NetworkConfig.ts';
import { getPercent } from './utils.ts';

export async function getTokenGatewayClient(): Promise<SubstrateChain> {
  const hyperbridgeChain = new SubstrateChain({
    stateMachineId: 'SUBSTRATE-argn',
    wsUrl: 'wss://hyperbridge-nexus-rpc.blockops.network',
    hasher: 'Blake2',
    consensusStateId: 'ARGN',
  });

  // Connect to Substrate chain
  await hyperbridgeChain.connect();
  return hyperbridgeChain;
}

export async function getTokenGatewaySyncHeight(client: SubstrateChain): Promise<number> {
  const height = await client.latestStateMachineHeight({
    stateId: {
      Substrate: toHex('argn'),
    },
    consensusStateId: toHex('ARGN'),
  });
  return Number(height);
}

export async function waitForGatewaySyncedToHeight(args: {
  gatewayClient: SubstrateChain;
  targetHeight: number;
  onProgress?: (percent: number) => void;
}): Promise<{ unsubscribe: () => void; complete: Promise<void> }> {
  const { gatewayClient, targetHeight } = args;

  const startHeight = await getTokenGatewaySyncHeight(gatewayClient);
  const blocksToSync = targetHeight - startHeight;
  const expectedEndTime = NetworkConfig.tickMillis * blocksToSync;

  const startTimeMs = Date.now();

  // Cache the last known gateway sync height so the 1s ticker can update progress
  // without hammering the RPC every second.
  let lastGatewaySyncHeight = startHeight;
  let lastPercent = 0;
  const deferred = createDeferred<void>();
  const result = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    unsubscribe: () => {},
    complete: deferred.promise,
  };

  const computePercent = () => {
    // Expected progress based on time elapsed (ticks in seconds).
    if (blocksToSync <= 0) {
      args.onProgress?.(100);
      return;
    }
    // Cap expected percent at 99% to avoid reaching 100% too early.
    const expectedPercent = Math.min(99, getPercent(Date.now() - startTimeMs, expectedEndTime));

    // Actual progress based on observed gateway sync height.
    const actualPercent = getPercent(lastGatewaySyncHeight - startHeight, blocksToSync);

    let percent = Math.max(expectedPercent, actualPercent, 0);
    if (percent > 100) percent = 100;

    // Keep the value monotonic (never go backwards) to avoid UI jitter.
    lastPercent = Math.max(lastPercent, percent);
    args.onProgress?.(lastPercent);
  };

  let lastRefreshTime = 0;
  const check = async (): Promise<boolean> => {
    if (Date.now() - lastRefreshTime > 5000) {
      lastGatewaySyncHeight = await getTokenGatewaySyncHeight(gatewayClient);
      lastRefreshTime = Date.now();
    }
    computePercent();
    return lastGatewaySyncHeight >= targetHeight;
  };

  // Prime the cache and progress value.
  if (await check()) {
    deferred.resolve();
    return result;
  }

  // ticker: advances expected progress smoothly, clamped by actual progress.
  const interval = setInterval(async () => {
    if (await check()) {
      clearInterval(interval);
      deferred.resolve();
    }
  }, 100);

  result.unsubscribe = () => {
    clearInterval(interval);
  };

  return result;
}
