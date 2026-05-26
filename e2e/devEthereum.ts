import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { DelegateSubmitLane } from '../bot/src/DelegateSubmitLane.ts';
import { EthereumBeaconSyncService } from '../bot/src/EthereumBeaconSyncService.ts';
import { EthereumGatewayProverService } from '../bot/src/EthereumGatewayProverService.ts';
import { configureNetwork } from '../bot/src/configureNetwork.ts';
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
import erc20PresetFixedSupplyArtifact from '@openzeppelin/contracts/build/contracts/ERC20PresetFixedSupply.json' with { type: 'json' };
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';
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
  finalityBlocks: number;
  relayerPollMs: number;
}

export interface IStartDevEthereumResult {
  beaconPreset: DevEthereumBeaconPreset;
  enclaveName: string;
  executionRpcUrl: string;
  beaconApiUrl: string;
  chainId: string;
  serverExecutionRpcUrl: string;
  serverBeaconApiUrl: string;
  usdcTokenAddress: Address;
}

export interface IDevEthereumRuntimeState {
  beaconPreset: DevEthereumBeaconPreset;
  enclaveName: string;
  executionRpcUrl: string;
  beaconApiUrl: string;
  chainId: string;
  serverExecutionRpcUrl: string;
  serverBeaconApiUrl: string;
  usdcTokenAddress: Address;
  updatedAt: string;
}

export interface IDevEthereumSetup {
  env: NodeJS.ProcessEnv;
  start(): Promise<{ shutdown(): Promise<void> }>;
}

export function readDevEthereumConfigFromEnv(): IDevEthereumConfig | undefined {
  const enabledValue = readNonEmpty(process.env.ARGON_DEV_ETHEREUM)?.toLowerCase();
  if (enabledValue && ['0', 'false', 'no', 'off'].includes(enabledValue)) {
    return undefined;
  }

  const beaconPreset = readDevEthereumBeaconPreset();
  const secondsPerSlot = readPositiveIntEnv('ARGON_DEV_ETHEREUM_SECONDS_PER_SLOT') ?? 1;
  const finalityBlocks = beaconPreset === 'minimal' ? 16 : 64;
  const finalityMillis = secondsPerSlot * finalityBlocks * 1_000;

  return {
    beaconPreset,
    secondsPerSlot,
    finalityMillis,
    finalityBlocks,
    relayerPollMs: Math.max(1_000, Math.floor(finalityMillis / finalityBlocks)),
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
  await waitForStableExecutionRpc(endpoints.executionRpcUrl, endpoints.chainId);
  const usdcTokenAddress = await deployDevEthereumUsdc({
    executionRpcUrl: endpoints.executionRpcUrl,
    chainId: endpoints.chainId,
  });

  const result = {
    beaconPreset: config.beaconPreset,
    enclaveName: ethereum.enclaveName,
    ...endpoints,
    serverExecutionRpcUrl: rewriteLocalUrlHost(endpoints.executionRpcUrl, 'host.docker.internal'),
    serverBeaconApiUrl: rewriteLocalUrlHost(endpoints.beaconApiUrl, 'host.docker.internal'),
    usdcTokenAddress,
  };
  await writeDevEthereumRuntimeState(result);
  return result;
}

export function createDevEthereumSetup(
  archiveUrl: string,
  devEthereum: IStartDevEthereumResult,
  config: Pick<IDevEthereumConfig, 'finalityBlocks' | 'finalityMillis' | 'relayerPollMs'>,
): IDevEthereumSetup {
  console.log(`[tauri-dev] Ethereum execution RPC (app): ${devEthereum.executionRpcUrl}`);
  console.log(`[tauri-dev] Ethereum beacon API (app): ${devEthereum.beaconApiUrl}`);
  console.log(`[tauri-dev] Add this beacon URL in server config: ${devEthereum.serverBeaconApiUrl}`);

  return {
    env: {
      ETHEREUM_BEACON_API_URL: devEthereum.serverBeaconApiUrl,
      ETHEREUM_EXECUTION_RPC_URL: devEthereum.serverExecutionRpcUrl,
      ETHEREUM_FINALITY_MILLIS: String(config.finalityMillis),
    },
    async start(): Promise<{ shutdown(): Promise<void> }> {
      await waitForLoad();
      const alice = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');
      await ensureDevEthereumBeaconBootstrap(archiveUrl, devEthereum.beaconApiUrl, devEthereum.beaconPreset, alice);
      const fixtureDeployer = new TestEthereum(devEthereum.enclaveName);
      fixtureDeployer.executionRpcUrl = devEthereum.executionRpcUrl;
      fixtureDeployer.chainId = devEthereum.chainId;
      const fixture = await fixtureDeployer.deployMintingGatewayFixture({
        deployerPrivateKey: DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey,
      });
      await ensureDevEthereumChainConfig(archiveUrl, fixture, alice);
      return await startDevEthereumRelayer({
        archiveUrl,
        beaconApiUrl: devEthereum.beaconApiUrl,
        executionRpcUrl: devEthereum.executionRpcUrl,
        usdcTokenAddress: devEthereum.usdcTokenAddress,
        finalityMillis: config.finalityMillis,
        finalityBlocks: config.finalityBlocks,
        relayerPollMs: config.relayerPollMs,
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
  const chain = createDevEthereumChain(chainId, rpcUrl);
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

export async function readDevEthereumRuntimeState(): Promise<IDevEthereumRuntimeState | undefined> {
  try {
    const raw = await fs.readFile(getDevEthereumRuntimeStatePath(), 'utf8');
    return JSON.parse(raw) as IDevEthereumRuntimeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function resolveDevEthereumRpcUrl(args: { rpcUrl?: string; logPrefix?: string }): Promise<string> {
  const { rpcUrl, logPrefix = 'dev-ethereum' } = args;
  const explicitRpc = readNonEmpty(rpcUrl);
  const envRpc = readNonEmpty(process.env.ETH_RPC) ?? readNonEmpty(process.env.ETHEREUM_EXECUTION_RPC_URL);
  if (explicitRpc) return explicitRpc;
  if (envRpc) return envRpc;

  const candidates = await detectExecutionRpcUrls();
  if (!candidates.length) {
    throw new Error(
      'Unable to detect a local Ethereum execution RPC. Pass --rpc http://127.0.0.1:<port>, set ETH_RPC or ETHEREUM_EXECUTION_RPC_URL, or start the local Kurtosis devnet first.',
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
  executionRpcUrl: string;
  usdcTokenAddress: Address;
  finalityMillis: number;
  finalityBlocks: number;
  relayerPollMs: number;
  syncKeypair: KeyringPair;
}): Promise<{ shutdown(): Promise<void> }> {
  const previousArgonChain = process.env.ARGON_CHAIN;
  const previousEthereumFinalityMillis = process.env.ETHEREUM_FINALITY_MILLIS;
  process.env.ARGON_CHAIN = 'dev-docker';
  process.env.ETHEREUM_FINALITY_MILLIS = String(args.finalityMillis);
  await configureNetwork(args.archiveUrl);
  NetworkConfig.setRuntimeOverride('dev-docker', {
    ethereumNetwork: {
      executionRpcUrl: args.executionRpcUrl,
      finalityBlocks: args.finalityBlocks,
      usdcTokenAddress: args.usdcTokenAddress,
    },
  });

  const client = await getClient(args.archiveUrl);
  const submitLane = new DelegateSubmitLane(args.syncKeypair);
  submitLane.client = client;

  const ethereumBeaconSyncService = new EthereumBeaconSyncService(client, {
    beaconApiUrl: args.beaconApiUrl,
    pollMs: args.relayerPollMs,
    submitLane,
  });
  const ethereumGatewayProverService = new EthereumGatewayProverService(submitLane, {
    backgroundSweepMs: args.relayerPollMs,
  });

  try {
    await ethereumBeaconSyncService.start();
    await ethereumGatewayProverService.start();
  } catch (error) {
    await client.disconnect().catch(() => undefined);
    NetworkConfig.clearRuntimeOverride('dev-docker');
    process.env.ARGON_CHAIN = previousArgonChain;
    restoreEnvVar('ETHEREUM_FINALITY_MILLIS', previousEthereumFinalityMillis);
    throw error;
  }

  console.log(`[tauri-dev] Started local Ethereum relayer with //Alice on ${args.executionRpcUrl}`);

  return {
    async shutdown(): Promise<void> {
      await ethereumGatewayProverService.shutdown().catch(() => undefined);
      await ethereumBeaconSyncService.shutdown().catch(() => undefined);
      await client.disconnect().catch(() => undefined);
      NetworkConfig.clearRuntimeOverride('dev-docker');
      process.env.ARGON_CHAIN = previousArgonChain;
      restoreEnvVar('ETHEREUM_FINALITY_MILLIS', previousEthereumFinalityMillis);
    },
  };
}

async function deployDevEthereumUsdc(args: { executionRpcUrl: string; chainId: string }): Promise<Address> {
  const account = privateKeyToAccount(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey);
  const chain = createDevEthereumChain(Number(BigInt(args.chainId)), args.executionRpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(args.executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(args.executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const hash = await walletClient.deployContract({
    abi: erc20PresetFixedSupplyArtifact.abi as Abi,
    bytecode: erc20PresetFixedSupplyArtifact.bytecode as Hex,
    args: ['USD Coin', 'USDC', parseUnits('1000000000', 6), account.address],
  });
  const receipt = await waitForDevEthereumTransactionReceipt(publicClient, hash);
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`USDC mock deployment failed: ${hash}`);
  }

  console.log(`[tauri-dev] Deployed mock USDC at ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function waitForDevEthereumTransactionReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hash,
): Promise<TransactionReceipt> {
  const startedAt = Date.now();
  const timeoutMs = 60_000;
  let lastError: Error | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch (error) {
      lastError = error as Error;
      const message = lastError.message.toLowerCase();
      if (
        !message.includes('not found') &&
        !message.includes('could not be found') &&
        !message.includes('indexing is in progress')
      ) {
        throw lastError;
      }
      await delay(500);
    }
  }

  throw new Error(`Timed out waiting for Ethereum transaction receipt: ${hash}`, {
    cause: lastError,
  });
}

function createDevEthereumChain(chainId: number, rpcUrl: string) {
  return defineChain({
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
}

async function writeDevEthereumRuntimeState(state: Omit<IDevEthereumRuntimeState, 'updatedAt'>): Promise<void> {
  const statePath = getDevEthereumRuntimeStatePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    `${JSON.stringify(
      {
        ...state,
        updatedAt: new Date().toISOString(),
      } satisfies IDevEthereumRuntimeState,
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function getDevEthereumRuntimeStatePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts', 'dev-ethereum.json');
}

async function ensureDevEthereumChainConfig(
  archiveUrl: string,
  devEthereum: Awaited<ReturnType<TestEthereum['deployMintingGatewayFixture']>>,
  sudoKeypair: KeyringPair,
): Promise<void> {
  const client = await getClient(archiveUrl);

  try {
    const currentConfig = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
    let hasMatchingConfig = false;
    if (currentConfig.isSome && currentConfig.unwrap().isEthereum) {
      const ethereumConfig = currentConfig.unwrap().asEthereum;
      hasMatchingConfig =
        ethereumConfig.gateway.toHex().toLowerCase() === devEthereum.gatewayAddress.toLowerCase() &&
        ethereumConfig.argonToken.toHex().toLowerCase() === devEthereum.argonTokenAddress.toLowerCase() &&
        ethereumConfig.argonotToken.toHex().toLowerCase() === devEthereum.argonotTokenAddress.toLowerCase();
    }

    if (!hasMatchingConfig) {
      const result = await new TxSubmitter(
        client,
        client.tx.sudo.sudo(
          client.tx.crosschainTransfer.setChainConfig({
            Ethereum: {
              gateway: devEthereum.gatewayAddress,
              argonToken: devEthereum.argonTokenAddress,
              argonotToken: devEthereum.argonotTokenAddress,
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
    } else {
      console.log('[tauri-dev] Ethereum chain config already matches local gateway fixture');
    }
  } finally {
    await client.disconnect();
  }
}

async function detectExecutionRpcUrls(): Promise<string[]> {
  const candidates: string[] = [];
  const portRangeSize = 32;
  const portStart = 32_000;
  const portScanLimit = 1_024;

  // Mirror TestEthereum.launch() in @argonprotocol/testing, which allocates the
  // first free 32-port execution block starting near 32000 for each devnet.
  for (let rangeStart = portStart; rangeStart < portStart + portScanLimit; rangeStart += portRangeSize) {
    for (let port = rangeStart; port < rangeStart + portRangeSize; port += 1) {
      const rpcUrl = `http://127.0.0.1:${port}`;
      try {
        const chainId = await rpcCall<string>(rpcUrl, 'eth_chainId', []);
        if (typeof chainId === 'string') {
          candidates.push(rpcUrl);
          break;
        }
      } catch {
        continue;
      }
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

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
