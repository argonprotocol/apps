import {
  resolveDevDockerComposePorts,
  getDevDockerServerEnvVars,
  resolveDevDockerNetworkConfigOverride,
  resolveRuntimeEthereumExecutionRpcUrl,
  resolveRuntimeEthereumUsdcTokenAddress,
  readNonEmpty,
  mergeNetworkConfigOverrides,
} from './network.ts';

import { spawn } from 'child_process';
import { type INetworkConfigOverride, toComposeProjectName } from '@argonprotocol/apps-core';
import { ensureDevGatewayCerts } from './gatewayCerts.ts';
import {
  createDevEthereumSetup,
  type IDevEthereumSetup,
  type IStartDevEthereumResult,
  loadConfiguredDevEthereumGateway,
  readDevEthereumConfigFromEnv,
  startDevEthereum,
} from '../e2e/devEthereum.ts';
import {
  getDevDockerComposeContext,
  readDevUpstreamServerPorts,
  waitForDevUpstreamEthereumRelayReady,
} from '../e2e/scripts/devUpstreamServer.ts';
import {
  resolveDevUpstreamDir,
  restartDevUpstreamWorker,
  signalProcessTree,
  watchAppInstanceDirectory,
} from '../e2e/scripts/devUpstreamProcess.ts';
import { isPortAvailable } from '../scripts/utils.ts';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('../src-tauri/', import.meta.url));

export async function startDesktop(
  options: {
    logFd?: number;
    deferEthereumRelay?: boolean;
    visibleEthereumReady?: boolean;
    beforeLaunch?: (env: NodeJS.ProcessEnv, devEthereum?: IStartDevEthereumResult) => Promise<void>;
    progress?: (stage: string) => void;
    onStarted?: () => void;
  } = {},
): Promise<void> {
  const network = process.env.ARGON_NETWORK_NAME || 'testnet';
  const argonAppInstance = process.env.ARGON_APP_INSTANCE || '';
  console.log(`[tauri-dev] Starting Tauri dev for network="${network}" with instance="${argonAppInstance}"`);

  const tauriPort = await getTauriPort(argonAppInstance);
  const configFileName = `tauri.desktop.local.${network.replace('dev-docker', 'docknet')}.conf.json`;
  const configFilePath = path.resolve(__dirname, configFileName);
  const baseConfig = loadBaseConfig(configFileName, configFilePath);
  baseConfig.build ??= {};
  baseConfig.build.beforeDevCommand = 'yarn exec vite';
  baseConfig.build.devUrl = `http://localhost:${tauriPort}`;
  const configJson = JSON.stringify(baseConfig);

  const tauriEnv: NodeJS.ProcessEnv = { ...process.env };
  tauriEnv.ARGON_APP_INSTANCE = `${argonAppInstance.split(':')[0] || 'default'}:${tauriPort}`;
  const devEthereumConfig = readDevEthereumConfigFromEnv();
  let devEthereumSetup: IDevEthereumSetup | undefined;
  let devDockerArchiveUrl: string | undefined;
  let devEthereumExecutionRpcUrl: string | undefined;
  let networkConfigOverride: INetworkConfigOverride | undefined;
  let startedDevEthereum: IStartDevEthereumResult | undefined;
  let appInstanceDir: string | undefined;
  let devUpstreamDir: string | undefined;
  if (network === 'dev-docker') {
    devUpstreamDir = resolveDevUpstreamDir();
    appInstanceDir = path.dirname(devUpstreamDir);
    fs.mkdirSync(appInstanceDir, { recursive: true });
    process.env.ARGON_DEV_UPSTREAM_DIR = devUpstreamDir;
    tauriEnv.ARGON_DEV_UPSTREAM_DIR = devUpstreamDir;
    await ensureDevGatewayCerts({ appInstance: argonAppInstance, network });

    console.log('[tauri-dev] Resolving dev-docker compose ports');
    const composePorts = await resolveDevDockerComposePorts();
    if (!composePorts && devEthereumConfig) {
      throw new Error('Local Ethereum requires the dev-docker services and their host ports to be available.');
    }
    if (composePorts) {
      devDockerArchiveUrl = `ws://127.0.0.1:${composePorts.archiveRpcPort}`;
      console.log(
        `[tauri-dev] Resolved compose ports archiveNode=${composePorts.archivePort} archiveRpc=${composePorts.archiveRpcPort} archiveP2p=${composePorts.archiveP2pPort} bitcoinP2p=${composePorts.bitcoinP2pPort} esplora=${composePorts.esploraPort}${composePorts.indexerPort ? ` indexer=${composePorts.indexerPort}` : ''} notary=${composePorts.notaryAliasContainerId}`,
      );
      const upstreamProjectName = getDevDockerComposeContext().composeProjectName;
      const appProjectName = toComposeProjectName(argonAppInstance.split(':')[0] || 'default', network);
      Object.assign(tauriEnv, getDevDockerServerEnvVars(composePorts, upstreamProjectName === appProjectName));
    } else {
      console.warn('[tauri-dev] Server env override unavailable, falling back to static server config');
    }

    if (devEthereumConfig) {
      const configuredGateway = devDockerArchiveUrl
        ? await loadConfiguredDevEthereumGateway(devDockerArchiveUrl)
        : undefined;
      options.progress?.('Starting Ethereum');
      console.log(
        `[tauri-dev] Launching local dev Ethereum (preset=${devEthereumConfig.beaconPreset}, secondsPerSlot=${devEthereumConfig.secondsPerSlot})`,
      );
      startedDevEthereum = await startDevEthereum(devEthereumConfig, configuredGateway);
    }
    if (devDockerArchiveUrl && startedDevEthereum && devEthereumConfig) {
      devEthereumSetup = createDevEthereumSetup(devDockerArchiveUrl, startedDevEthereum, devEthereumConfig);
      Object.assign(tauriEnv, devEthereumSetup.env);
    }

    const inheritedOverride = readNonEmpty(process.env.ARGON_NETWORK_CONFIG_OVERRIDE);
    const inheritedRuntimeOverride: INetworkConfigOverride | undefined = inheritedOverride
      ? JSON.parse(inheritedOverride)
      : undefined;
    const ethereumExecutionRpcUrl = await resolveRuntimeEthereumExecutionRpcUrl(
      startedDevEthereum,
      inheritedRuntimeOverride,
    );
    devEthereumExecutionRpcUrl = ethereumExecutionRpcUrl;
    const ethereumUsdcTokenAddress = await resolveRuntimeEthereumUsdcTokenAddress(
      ethereumExecutionRpcUrl,
      startedDevEthereum,
      inheritedRuntimeOverride,
    );
    const runtimeOverride = composePorts
      ? await resolveDevDockerNetworkConfigOverride(composePorts, ethereumExecutionRpcUrl, ethereumUsdcTokenAddress)
      : null;
    const resolvedOverride = inheritedRuntimeOverride
      ? mergeNetworkConfigOverrides(inheritedRuntimeOverride, runtimeOverride)
      : runtimeOverride;
    networkConfigOverride = resolvedOverride ?? undefined;

    if (resolvedOverride) {
      tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE = JSON.stringify(resolvedOverride);
      console.log(
        `[tauri-dev] Runtime override archive=${resolvedOverride.archiveUrl} esplora=${resolvedOverride.esploraHost}${resolvedOverride.indexerHost ? ` indexer=${resolvedOverride.indexerHost}` : ''}${resolvedOverride.ethereumNetwork?.executionRpcUrls?.[0] ? ` ethereumExecution=${resolvedOverride.ethereumNetwork.executionRpcUrls[0]}` : ''}${resolvedOverride.ethereumNetwork?.usdcTokenAddress ? ` usdc=${resolvedOverride.ethereumNetwork.usdcTokenAddress}` : ''}`,
      );
    } else {
      delete tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE;
      console.warn('[tauri-dev] Runtime override unavailable, falling back to static network config');
    }
  }

  const configArg = process.platform === 'win32' ? `"${configJson.replace(/"/g, '\\"')}"` : configJson;
  const tauriArgs = ['tauri', 'dev', '--config', configArg];
  const isE2EAppRun = Boolean(readNonEmpty(tauriEnv.ARGON_DRIVER_WS));
  if (isE2EAppRun) {
    tauriArgs.push('--no-watch', '--features', 'e2e-screenshots,e2e-insecure-gateway-certs');
    console.log('[tauri-dev] Enabling e2e features (ARGON_DRIVER_WS detected)');
  }

  if (devEthereumSetup) {
    const ethereumSetupStartedAt = Date.now();
    await devEthereumSetup.start().catch(error => {
      console.error(`[tauri-dev] Failed to configure local Ethereum: ${(error as Error).message}`);
      throw error;
    });
    console.log(`[tauri-dev] Local Ethereum setup finished after ${Date.now() - ethereumSetupStartedAt}ms`);
  }

  const shouldStartDevUpstream = !['0', 'false', 'no', 'off'].includes(
    readNonEmpty(process.env.ARGON_DEV_UPSTREAM)?.toLowerCase() ?? '',
  );
  if (devDockerArchiveUrl && shouldStartDevUpstream && (!isE2EAppRun || devEthereumConfig)) {
    if (!devUpstreamDir) throw new Error('Dev upstream requires an app instance directory.');
    options.progress?.('Starting upstream operator');
    const pid = await restartDevUpstreamWorker({
      archiveUrl: devDockerArchiveUrl,
      devUpstreamDir,
      env: tauriEnv,
      networkConfigOverride,
      devEthereum: startedDevEthereum,
      devEthereumConfig,
      executionRpcUrl: devEthereumExecutionRpcUrl,
    }).catch(error => {
      console.error(`[tauri-dev] Failed to start upstream server: ${(error as Error).message}`);
      throw error;
    });
    console.log(`[tauri-dev][upstream-ready] upstream worker is ready (pid ${pid})`);
    options.progress?.('Upstream operator ready');
  }

  if (devEthereumSetup && !options.deferEthereumRelay) {
    try {
      if (!devDockerArchiveUrl || !startedDevEthereum) {
        throw new Error('Dev Ethereum relay activation is missing archive or Ethereum setup details.');
      }
      if (!options.visibleEthereumReady) {
        const { botPort } = await readDevUpstreamServerPorts();
        await waitForDevUpstreamEthereumRelayReady({ archiveUrl: devDockerArchiveUrl, botPort });
      }
      console.log('[tauri-dev][ethereum-ready] upstream Ethereum relay is ready');
      options.progress?.('Ethereum bridge ready');
    } catch (error) {
      console.error(`[tauri-dev] Failed to activate the local Ethereum relay: ${(error as Error).message}`);
      throw error;
    }
  }

  await options.beforeLaunch?.(tauriEnv, startedDevEthereum);
  options.progress?.('Launching desktop');

  const child = spawn('yarn', tauriArgs, {
    env: tauriEnv,
    stdio: options.logFd === undefined ? 'inherit' : ['ignore', options.logFd, options.logFd],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });
  child.once('spawn', () => options.onStarted?.());

  const killChildTree = (signal: NodeJS.Signals) => {
    if (child.exitCode !== null) {
      return;
    }

    if (child.pid) {
      try {
        signalProcessTree(child.pid, signal);
        return;
      } catch {
        // Fall back to the direct child if the process tree is already gone.
      }
    }

    child.kill(signal);
  };

  const stopChildTree = (signal: NodeJS.Signals) => {
    killChildTree(signal);
    setTimeout(() => {
      if (child.exitCode === null) {
        killChildTree('SIGKILL');
      }
    }, 5_000).unref();
  };

  const appInstanceWatcher = appInstanceDir
    ? watchAppInstanceDirectory(appInstanceDir, () => stopChildTree('SIGTERM'))
    : undefined;

  const onInterrupt = () => stopChildTree('SIGINT');
  const onTerminate = () => stopChildTree('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => {
        if (code && code !== 0) reject(new Error(`Desktop exited with code ${code}`));
        else resolve();
      });
    });
  } finally {
    appInstanceWatcher?.close();
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

async function getTauriPort(argonAppInstance: string): Promise<string> {
  if (argonAppInstance.includes(':')) {
    const parts = argonAppInstance.split(':');
    const port = parts[parts.length - 1];
    if (port) return port;
  }

  const requestedPort = 1420;
  let port = requestedPort;
  while (true) {
    const isAvailable = (await isPortAvailable(port, 'localhost')) && (await isPortAvailable(port, '0.0.0.0'));
    if (isAvailable) break;

    port += 1;
  }

  if (port !== requestedPort) {
    console.log(`[tauri-dev] Port ${requestedPort} is already in use; using port ${port}`);
  }
  return String(port);
}

function loadBaseConfig(configFileName: string, configFilePath: string): any {
  try {
    const raw = fs.readFileSync(configFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    console.log(`[tauri-dev] Using config file: ${configFileName}`);
    return parsed;
  } catch (err: any) {
    console.warn(
      `[tauri-dev] Could not read ${configFileName} (${err.message}). Falling back to empty config override.`,
    );
    return {};
  }
}
