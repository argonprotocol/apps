#!/usr/bin/env tsx

import Path from 'node:path';
import process from 'node:process';
import type { INetworkConfigOverride } from '@argonprotocol/apps-core';
import { startDevEthereumMintingAuthority } from '../helpers/startDevEthereumMintingAuthority.ts';
import type { IDevEthereumConfig, IStartDevEthereumResult } from '../devEthereum.ts';
import { resolveDevUpstreamDir, setDevUpstreamWorkerReady, watchAppInstanceDirectory } from './devUpstreamProcess.ts';
import { startDevUpstreamServer } from './devUpstreamServer.ts';

const devUpstreamDir = resolveDevUpstreamDir();
const archiveUrl = readRequiredEnv('ARGON_DEV_UPSTREAM_ARCHIVE_URL');
const devEthereum =
  readJsonEnv<Pick<IStartDevEthereumResult, 'serverBeaconApiUrl' | 'serverExecutionRpcUrl' | 'usdcTokenAddress'>>(
    'ARGON_DEV_UPSTREAM_ETHEREUM',
  );
const devEthereumConfig = readJsonEnv<Pick<IDevEthereumConfig, 'finalityBlocks' | 'finalityMillis'>>(
  'ARGON_DEV_UPSTREAM_ETHEREUM_CONFIG',
);
const networkConfigOverride = readJsonEnv<INetworkConfigOverride>('ARGON_DEV_UPSTREAM_NETWORK_CONFIG_OVERRIDE');
const executionRpcUrl = process.env.ARGON_DEV_UPSTREAM_EXECUTION_RPC_URL?.trim() || undefined;
const mintingAuthoritySetting = process.env.ARGON_DEV_ETHEREUM_MINTING_AUTHORITY?.trim().toLowerCase();
const shouldStartMintingAuthority =
  !!devEthereum && !['0', 'false', 'no', 'off'].includes(mintingAuthoritySetting ?? '');

let upstreamRuntime: Awaited<ReturnType<typeof startDevUpstreamServer>> | undefined;
let mintingAuthorityRuntime: Awaited<ReturnType<typeof startDevEthereumMintingAuthority>> | undefined;
let shutdownPromise: Promise<void> | undefined;
const appInstanceWatcher = watchAppInstanceDirectory(Path.dirname(devUpstreamDir), () => void shutdown(0));

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
process.once('SIGUSR2', () => void shutdown(0));

void start().catch(error => {
  console.error(`[dev-upstream-worker] Failed to start: ${(error as Error).message}`);
  void shutdown(1);
});

async function start(): Promise<void> {
  const upstreamStartedAt = Date.now();
  console.info('[dev-upstream-worker] Starting upstream services');
  upstreamRuntime = await startDevUpstreamServer({
    archiveUrl,
    networkConfigOverride,
    devEthereum,
    devEthereumConfig,
  });
  console.info(`[dev-upstream-worker] Upstream services ready after ${Date.now() - upstreamStartedAt}ms`);

  if (shouldStartMintingAuthority) {
    const authorityStartedAt = Date.now();
    console.info('[dev-upstream-worker] Starting Ethereum minting authority');
    mintingAuthorityRuntime = await startDevEthereumMintingAuthority({
      archiveUrl,
      executionRpcUrl,
      logPrefix: 'dev-upstream-worker',
      operator: upstreamRuntime.operator,
      virtualEnv: {
        appInstance: process.env.ARGON_APP_INSTANCE,
        network: process.env.ARGON_NETWORK_NAME,
        serverEnvVars: process.env,
      },
    });
    console.info(
      `[dev-upstream-worker] Ethereum minting authority setup returned after ${Date.now() - authorityStartedAt}ms`,
    );
  }

  setDevUpstreamWorkerReady(true, devUpstreamDir);
  console.log(`[dev-upstream-worker] Ready (pid ${process.pid})`);
}

function shutdown(exitCode: number): Promise<void> {
  shutdownPromise ??= (async () => {
    appInstanceWatcher.close();
    setDevUpstreamWorkerReady(false, devUpstreamDir);
    await mintingAuthorityRuntime?.shutdown().catch(() => undefined);
    await upstreamRuntime?.shutdown().catch(() => undefined);
  })().finally(() => process.exit(exitCode));
  return shutdownPromise;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readJsonEnv<T>(name: string): T | undefined {
  const value = process.env[name]?.trim();
  return value ? (JSON.parse(value) as T) : undefined;
}
