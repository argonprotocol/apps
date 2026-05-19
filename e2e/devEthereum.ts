import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import process from 'node:process';
import { EthereumBeaconSyncService } from '../bot/src/EthereumBeaconSyncService.ts';
import {
  dispatchErrorToString,
  getClient,
  getEthereumBeaconSyncState,
  Keyring,
  type KeyringPair,
  TxSubmitter,
  waitForLoad,
} from '@argonprotocol/mainchain';
import { TestEthereum } from '@argonprotocol/testing';
import { createPublicClient, defineChain, http, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const DEV_ETHEREUM_ADMIN_ACCOUNT = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  balance: '100ETH',
} as const;

const MINIMUM_BOOTSTRAP_FINALIZED_SLOT_BY_PRESET: Record<DevEthereumBeaconPreset, bigint> = {
  minimal: 64n,
  mainnet: 8192n,
};

export type DevEthereumBeaconPreset = 'mainnet' | 'minimal';

export interface IDevEthereumConfig {
  beaconPreset: DevEthereumBeaconPreset;
  secondsPerSlot: number;
  finalityMillis: number;
  relayerPollMs: number;
}

export interface IStartDevEthereumResult {
  beaconPreset: DevEthereumBeaconPreset;
  enclaveName: string;
  executionRpcUrl: string;
  beaconApiUrl: string;
  chainId: string;
  gatewayAddress: string;
  argonTokenAddress: string;
  argonotTokenAddress: string;
  serverExecutionRpcUrl: string;
  serverBeaconApiUrl: string;
}

export interface IDevEthereumSetup {
  env: NodeJS.ProcessEnv;
  relayerUrl: string;
  start(): Promise<{ shutdown(): Promise<void> }>;
}

export function readDevEthereumConfigFromEnv(): IDevEthereumConfig | undefined {
  const enabledValue = readNonEmpty(process.env.ARGON_DEV_ETHEREUM)?.toLowerCase();
  if (enabledValue && ['0', 'false', 'no', 'off'].includes(enabledValue)) {
    return undefined;
  }

  const beaconPreset = readDevEthereumBeaconPreset();
  const secondsPerSlot = readPositiveIntEnv('ARGON_DEV_ETHEREUM_SECONDS_PER_SLOT') ?? 1;
  const finalitySlots = beaconPreset === 'minimal' ? 16 : 64;
  const finalityMillis = secondsPerSlot * finalitySlots * 1_000;

  return {
    beaconPreset,
    secondsPerSlot,
    finalityMillis,
    relayerPollMs: Math.max(1_000, Math.floor(finalityMillis / 32)),
  };
}

export async function startDevEthereum(config: IDevEthereumConfig): Promise<IStartDevEthereumResult> {
  if (!TestEthereum.isInstalled()) {
    throw new Error(
      'Kurtosis is required to launch the local Ethereum devnet. Install Kurtosis first, or rerun with ARGON_DEV_ETHEREUM=0 to disable Ethereum.',
    );
  }

  const ethereum = new TestEthereum();
  const endpoints = await ethereum.launch({
    consensusClient: 'lighthouse',
    preset: config.beaconPreset,
    secondsPerSlot: config.secondsPerSlot,
    prefundedAccounts: {
      [DEV_ETHEREUM_ADMIN_ACCOUNT.address]: {
        balance: DEV_ETHEREUM_ADMIN_ACCOUNT.balance,
      },
    },
  });
  const fixture = await ethereum.deployMintingGatewayFixture({
    deployerPrivateKey: DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey,
  });
  await waitForStableExecutionRpc(endpoints.executionRpcUrl, endpoints.chainId);

  return {
    beaconPreset: config.beaconPreset,
    enclaveName: ethereum.enclaveName,
    ...endpoints,
    ...fixture,
    serverExecutionRpcUrl: rewriteLocalUrlHost(endpoints.executionRpcUrl, 'host.docker.internal'),
    serverBeaconApiUrl: rewriteLocalUrlHost(endpoints.beaconApiUrl, 'host.docker.internal'),
  };
}

export function createDevEthereumSetup(
  archiveUrl: string,
  devEthereum: IStartDevEthereumResult,
  config: Pick<IDevEthereumConfig, 'finalityMillis' | 'relayerPollMs'>,
): IDevEthereumSetup {
  const relayerPort = readPositiveIntEnv('ARGON_DEV_ETHEREUM_RELAYER_PORT') ?? 55_156;
  const relayerUrl = `http://localhost:${relayerPort}`;

  console.log(`[tauri-dev] Ethereum execution RPC (app): ${devEthereum.executionRpcUrl}`);
  console.log(`[tauri-dev] Ethereum beacon API (app): ${devEthereum.beaconApiUrl}`);
  console.log(`[tauri-dev] Add this beacon URL in server config: ${devEthereum.serverBeaconApiUrl}`);

  return {
    env: {
      ETHEREUM_BEACON_API_URL: devEthereum.serverBeaconApiUrl,
      ETHEREUM_EXECUTION_RPC_URL: devEthereum.serverExecutionRpcUrl,
      ETHEREUM_FINALITY_MILLIS: String(config.finalityMillis),
    },
    relayerUrl,
    async start(): Promise<{ shutdown(): Promise<void> }> {
      await waitForLoad();
      const alice = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');
      await ensureDevEthereumChainConfig(archiveUrl, devEthereum, alice);
      await ensureDevEthereumBeaconBootstrap(archiveUrl, devEthereum.beaconApiUrl, devEthereum.beaconPreset, alice);
      return await startDevEthereumRelayer({
        archiveUrl,
        beaconApiUrl: devEthereum.beaconApiUrl,
        relayerPollMs: config.relayerPollMs,
        relayerPort,
        syncKeypair: alice,
      });
    },
  };
}

export async function sendDevEthereumAdminTransaction(args: {
  rpcUrl: string;
  to: Address;
  value?: bigint;
  data?: Hex;
}): Promise<{ hash: Hash; sender: Address }> {
  const { rpcUrl, to, data, value = 0n } = args;
  const account = privateKeyToAccount(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey);
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: 'argon-dev-ethereum',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: [rpcUrl],
      },
    },
  });
  const nonce = await publicClient.getTransactionCount({
    address: account.address,
  });
  const gas = await publicClient.estimateGas({
    account: account.address,
    to,
    value,
    data,
  });
  const fees = await publicClient.estimateFeesPerGas({
    chain,
    type: 'eip1559',
  });
  if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null) {
    throw new Error('Unable to estimate EIP-1559 fees for the local dev Ethereum network.');
  }
  const serializedTransaction = await account.signTransaction({
    type: 'eip1559',
    chain,
    chainId,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    to,
    value,
    data,
  });

  const hash = await publicClient.sendRawTransaction({
    serializedTransaction,
  });

  return {
    hash,
    sender: account.address,
  };
}

export async function resolveDevEthereumRpcUrl(args: { rpcUrl?: string; logPrefix?: string }): Promise<string> {
  const { rpcUrl, logPrefix = 'dev-ethereum' } = args;
  const envRpc = process.env.ETH_RPC?.trim();
  if (rpcUrl?.trim()) return rpcUrl.trim();
  if (envRpc) return envRpc;

  const candidates = await detectExecutionRpcUrls();
  if (!candidates.length) {
    throw new Error(
      'Unable to detect a local Ethereum execution RPC. Pass --rpc http://127.0.0.1:<port> or set ETH_RPC.',
    );
  }

  if (candidates.length > 1) {
    const selected = candidates.at(-1)!;
    console.warn(
      `[${logPrefix}] Multiple execution RPC endpoints detected (${candidates.join(', ')}). Using newest ${selected}. Override with --rpc if needed.`,
    );
    return selected;
  }

  return candidates[0];
}

async function ensureDevEthereumBeaconBootstrap(
  archiveUrl: string,
  beaconApiUrl: string,
  beaconPreset: DevEthereumBeaconPreset,
  sudoKeypair: KeyringPair,
): Promise<void> {
  const client = await getClient(archiveUrl);

  try {
    const state = await getEthereumBeaconSyncState(client);
    if (state.isBootstrapped) {
      console.log('[tauri-dev] Ethereum verifier already bootstrapped');
      return;
    }

    await EthereumBeaconSyncService.ensureBootstrapped(client, beaconApiUrl, sudoKeypair, {
      minimumFinalizedSlot: MINIMUM_BOOTSTRAP_FINALIZED_SLOT_BY_PRESET[beaconPreset],
    });
    console.log(`[tauri-dev] Bootstrapped ethereum verifier from ${beaconApiUrl}`);
  } finally {
    await client.disconnect();
  }
}

async function startDevEthereumRelayer(args: {
  archiveUrl: string;
  beaconApiUrl: string;
  relayerPollMs: number;
  relayerPort: number;
  syncKeypair: KeyringPair;
}): Promise<{ shutdown(): Promise<void> }> {
  const relayerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argon-dev-relayer-'));
  const delegateKeypairPath = path.join(relayerDir, 'vaultDelegate.json');
  fs.writeFileSync(delegateKeypairPath, JSON.stringify(args.syncKeypair.toJson('')));

  const relayer = spawn('yarn', ['workspace', '@argonprotocol/apps-bot', 'run', 'start:relayer'], {
    env: {
      ...process.env,
      ARGON_CHAIN: 'dev-docker',
      ARCHIVE_NODE_URL: args.archiveUrl,
      LOCAL_RPC_URL: args.archiveUrl,
      ETHEREUM_BEACON_API_URL: args.beaconApiUrl,
      ETHEREUM_BEACON_POLL_MS: String(args.relayerPollMs),
      VAULT_DELEGATE_KEYPAIR_PATH: delegateKeypairPath,
      PORT: String(args.relayerPort),
    },
    stdio: 'inherit',
    shell: false,
  });

  let hasExited = false;
  relayer.once('exit', code => {
    hasExited = true;
    if (code !== 0) {
      console.error(`[tauri-dev] Local Ethereum relayer exited with code ${code ?? 'unknown'}`);
    }
  });

  console.log(
    `[tauri-dev] Started local Ethereum relayer entrypoint with //Alice at http://localhost:${args.relayerPort}`,
  );

  return {
    async shutdown(): Promise<void> {
      if (!hasExited) {
        relayer.kill('SIGTERM');
        await new Promise<void>(resolve => {
          relayer.once('exit', () => resolve());
        });
      }
      fs.rmSync(relayerDir, { recursive: true, force: true });
    },
  };
}

async function ensureDevEthereumChainConfig(
  archiveUrl: string,
  devEthereum: Pick<IStartDevEthereumResult, 'gatewayAddress' | 'argonTokenAddress' | 'argonotTokenAddress'>,
  sudoKeypair: KeyringPair,
): Promise<void> {
  const client = await getClient(archiveUrl);

  try {
    const currentConfig = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
    if (currentConfig.isSome && currentConfig.unwrap().isEthereum) {
      const ethereumConfig = currentConfig.unwrap().asEthereum;
      const isMatch =
        ethereumConfig.gateway.toHex().toLowerCase() === devEthereum.gatewayAddress.toLowerCase() &&
        ethereumConfig.argonToken.toHex().toLowerCase() === devEthereum.argonTokenAddress.toLowerCase() &&
        ethereumConfig.argonotToken.toHex().toLowerCase() === devEthereum.argonotTokenAddress.toLowerCase();

      if (isMatch) {
        console.log('[tauri-dev] Ethereum chain config already matches local gateway fixture');
        return;
      }
    }

    const result = await new TxSubmitter(
      client,
      client.tx.sudo.sudo(
        client.tx.crosschainTransfer.setChainConfig({
          Ethereum: {
            gateway: devEthereum.gatewayAddress,
            argonToken: devEthereum.argonTokenAddress,
            argonotToken: devEthereum.argonotTokenAddress,
            previousGateway: null,
            previousReleaseExpiration: null,
          },
        }),
      ),
      sudoKeypair,
    ).submit();
    await result.waitForInFirstBlock;

    const sudoResultEvent = result.events.find(event => client.events.sudo.Sudid.is(event));
    if (!sudoResultEvent || !client.events.sudo.Sudid.is(sudoResultEvent)) {
      throw new Error('Ethereum chain-config transaction did not emit sudo.Sudid.');
    }
    if (sudoResultEvent.data.sudoResult.isErr) {
      throw new Error(
        `Ethereum chain-config setup failed: ${dispatchErrorToString(client, sudoResultEvent.data.sudoResult.asErr as any)}`,
      );
    }

    console.log('[tauri-dev] Configured local Ethereum gateway on Argon');
  } finally {
    await client.disconnect();
  }
}

async function detectExecutionRpcUrls(): Promise<string[]> {
  const candidates: string[] = [];

  for (let port = 32_000; port < 32_032; port += 1) {
    const rpcUrl = `http://127.0.0.1:${port}`;
    try {
      const chainId = await rpcCall<string>(rpcUrl, 'eth_chainId', []);
      if (typeof chainId === 'string') {
        candidates.push(rpcUrl);
      }
    } catch {
      continue;
    }
  }

  return candidates;
}

async function waitForStableExecutionRpc(
  rpcUrl: string,
  expectedChainId: string,
  options: { timeoutMs?: number; consecutiveSuccesses?: number } = {},
): Promise<void> {
  const { timeoutMs = 60_000, consecutiveSuccesses = 3 } = options;
  const startedAt = Date.now();
  let successes = 0;
  let lastError: Error | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const [chainId, blockNumber] = await Promise.all([
        rpcCall<string>(rpcUrl, 'eth_chainId', []),
        rpcCall<string>(rpcUrl, 'eth_blockNumber', []),
      ]);
      if (chainId !== expectedChainId) {
        throw new Error(`Execution RPC reported chainId ${chainId}, expected ${expectedChainId}`);
      }
      if (typeof blockNumber !== 'string') {
        throw new Error('Execution RPC did not return a block number');
      }

      successes += 1;
      lastError = undefined;
      if (successes >= consecutiveSuccesses) {
        return;
      }
    } catch (error) {
      successes = 0;
      if (error instanceof Error) {
        lastError = error;
      } else {
        throw error;
      }
    }

    await delay(1_000);
  }

  throw new Error(
    `Ethereum execution RPC at ${rpcUrl} did not stay ready for ${consecutiveSuccesses} consecutive probes within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`,
  );
}
async function rpcCall<TResult>(rpcUrl: string, method: string, params: unknown[]): Promise<TResult> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`RPC request failed for ${method}: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as {
    result?: TResult;
    error?: {
      code?: number;
      message?: string;
    };
  };

  if (body.error) {
    throw new Error(body.error.message ?? `${method} failed`);
  }

  return body.result as TResult;
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
function rewriteLocalUrlHost(url: string, host: string): string {
  const parsed = new URL(url);
  if (['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname)) {
    parsed.hostname = host;
  }
  return parsed.toString();
}

function readDevEthereumBeaconPreset(): DevEthereumBeaconPreset {
  const value = readNonEmpty(process.env.ARGON_DEV_ETHEREUM_PRESET)?.toLowerCase();
  if (!value) {
    return 'minimal';
  }
  if (value === 'mainnet' || value === 'minimal') {
    return value;
  }

  throw new Error(`Unsupported ARGON_DEV_ETHEREUM_PRESET value: ${value}`);
}

function readPositiveIntEnv(name: string): number | undefined {
  const value = readNonEmpty(process.env[name]);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
