import process from 'node:process';
import { expect, it, vi } from 'vitest';

vi.mock('../../e2e/scripts/devUpstreamProcess.ts', () => ({
  resolveDevUpstreamDir: () => '/tmp/synthetic-dev-upstream',
  watchAppInstanceDirectory: () => ({ close() {} }),
}));

vi.mock('../../e2e/scripts/devUpstreamServer.ts', () => ({
  startDevUpstreamServer: vi.fn(() => new Promise(() => undefined)),
}));

it('uses local Ethereum finality for relay retries from the first worker import', async () => {
  vi.stubEnv('ARGON_DEV_UPSTREAM_ARCHIVE_URL', 'ws://127.0.0.1:9944');
  vi.stubEnv('ARGON_NETWORK_NAME', 'dev-docker');
  vi.stubEnv('ETHEREUM_FINALITY_MILLIS', '16000');
  const signals = ['SIGINT', 'SIGTERM', 'SIGUSR2'] as const;
  const priorListeners = new Set(signals.flatMap(signal => process.listeners(signal)));

  try {
    await import('../../e2e/scripts/devUpstreamWorker.ts');
    const { NetworkConfig } = await import('@argonprotocol/apps-core');
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', { ethereumNetwork: { finalityBlocks: 16 } });
    const { getEthereumFinalityMillis } = await import('../../src-vue/lib/EthereumClient.ts');

    // The fallback assumes 12-second slots and delays retries beyond the 180-second startup deadline.
    expect(getEthereumFinalityMillis()).toBe(16_000);
  } finally {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!priorListeners.has(listener)) process.removeListener(signal, listener);
      }
    }
    vi.unstubAllEnvs();
  }
}, 30_000);
