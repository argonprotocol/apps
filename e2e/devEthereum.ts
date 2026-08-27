import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  EvmContracts,
  getClient,
  getEthereumBeaconSyncState,
  Keyring,
  MICROGONS_PER_ARGON,
  type KeyringPair,
  waitForLoad,
} from '@argonprotocol/mainchain';
import { TestEthereum } from '@argonprotocol/testing';
import erc20PresetFixedSupplyArtifact from '@openzeppelin/contracts/build/contracts/ERC20PresetFixedSupply.json' with { type: 'json' };
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseUnits,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sudoFundWallet } from '../core/__test__/helpers/sudoFundWallet.ts';
import { createArgonClient } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { waitForQueryableClient } from '../core/__test__/startArgonTestNetwork.ts';
import {
  DEV_ETHEREUM_TOKEN_RESERVE_RUNTIME_AMOUNT,
  ensureDevEthereumBeaconBootstrapped,
  initializeDevEthereumTokenReserve,
  loadDevEthereumActivationRepaymentPricing,
  submitDevSudoTransaction,
  syncEthereumGatewayActiveCouncilToArgon,
} from './devEthereumRuntimeSetup.ts';

export const DEV_ETHEREUM_ADMIN_ACCOUNT = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  balance: '100ETH',
} as const;

const MINIMUM_BOOTSTRAP_FINALIZED_SLOT_BY_PRESET: Record<DevEthereumBeaconPreset, bigint> = {
  minimal: 64n,
  mainnet: 8192n,
};
const DEV_ETHEREUM_LAUNCH_MAX_ATTEMPTS = 3;
const DEV_ETHEREUM_LAUNCH_RETRY_DELAY_MS = 1_000;
let runtimeStateOperation = Promise.resolve();
export type DevEthereumBeaconPreset = 'mainnet' | 'minimal';
type DevEthereumGateway = Awaited<ReturnType<TestEthereum['deployMintingGatewayFixture']>>;

export interface IDevEthereumConfig {
  beaconPreset: DevEthereumBeaconPreset;
  secondsPerSlot: number;
  finalityMillis: number;
  finalityBlocks: number;
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
  gateway?: DevEthereumGateway;
}

export interface IDevEthereumRuntimeState extends IStartDevEthereumResult {
  mintingAuthorityStatus?: 'starting' | 'ready';
  setupStatus: 'starting' | 'ready';
  updatedAt: string;
}

export interface IDevEthereumSetup {
  env: NodeJS.ProcessEnv;
  start(): Promise<void>;
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
  };
}

export async function startDevEthereum(
  config: IDevEthereumConfig,
  configuredGateway?: DevEthereumGateway,
): Promise<IStartDevEthereumResult> {
  const candidates = await readDevEthereumRuntimeStateCandidates();
  for (const current of candidates) {
    if (current.beaconPreset !== config.beaconPreset) continue;

    try {
      const [chainId, beaconResponse] = await Promise.all([
        rpcCall<string>(current.executionRpcUrl, 'eth_chainId', []),
        fetch(new URL('/eth/v1/beacon/genesis', current.beaconApiUrl), {
          signal: AbortSignal.timeout(10_000),
        }),
      ]);
      if (chainId === current.chainId && beaconResponse.ok) {
        if (configuredGateway && !(await doesDevEthereumGatewayMatch(current.executionRpcUrl, configuredGateway))) {
          console.warn(
            `[tauri-dev] Local dev Ethereum enclave ${current.enclaveName} does not match the gateway configured on Argon`,
          );
          continue;
        }

        const action = current.setupStatus === 'ready' ? 'Reusing' : 'Resuming';
        console.log(`[tauri-dev] ${action} local dev Ethereum enclave ${current.enclaveName}`);
        await writeDevEthereumRuntimeState(current);
        return current;
      }
    } catch (error) {
      console.warn(
        `[tauri-dev] Dev Ethereum enclave ${current.enclaveName} is unavailable: ${(error as Error).message}`,
      );
    }
  }

  if (configuredGateway) {
    throw new Error(
      'No running local Ethereum enclave matches the gateway configured on Argon. Restart the full dev-docker stack so Argon and Ethereum are recreated together.',
    );
  }

  if (!TestEthereum.isInstalled()) {
    throw new Error(
      'Kurtosis is required to launch the local Ethereum devnet. Install Kurtosis first, or rerun with ARGON_DEV_ETHEREUM=0 to disable Ethereum.',
    );
  }

  for (let attempt = 1; attempt <= DEV_ETHEREUM_LAUNCH_MAX_ATTEMPTS; attempt += 1) {
    const ethereum = new TestEthereum();

    try {
      const endpoints = await ethereum.launch({
        consensusClient: 'lighthouse',
        preset: config.beaconPreset,
        secondsPerSlot: config.secondsPerSlot,
        waitForFinalization: false,
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
      await writeDevEthereumRuntimeState({
        ...result,
        setupStatus: 'starting',
      });
      return result;
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      const hitPortCollision = errorText.includes('port is already allocated');

      await ethereum.teardown().catch(() => undefined);

      if (attempt === DEV_ETHEREUM_LAUNCH_MAX_ATTEMPTS || !hitPortCollision) {
        throw error;
      }

      console.warn(
        `[tauri-dev] Local dev Ethereum launch hit a transient port collision on attempt ${attempt}/${DEV_ETHEREUM_LAUNCH_MAX_ATTEMPTS}; retrying`,
      );
      await delay(DEV_ETHEREUM_LAUNCH_RETRY_DELAY_MS);
    }
  }

  throw new Error('Local dev Ethereum failed to launch after exhausting retries');
}

export function createDevEthereumSetup(
  archiveUrl: string,
  devEthereum: IStartDevEthereumResult,
  config: Pick<IDevEthereumConfig, 'finalityMillis'>,
): IDevEthereumSetup {
  console.log(`[tauri-dev] Ethereum execution RPC (app): ${devEthereum.executionRpcUrl}`);
  console.log(`[tauri-dev] Ethereum beacon API (app): ${devEthereum.beaconApiUrl}`);
  console.log(`[tauri-dev] Upstream relay beacon API: ${devEthereum.serverBeaconApiUrl}`);

  return {
    env: {
      ETHEREUM_BEACON_API_URL: devEthereum.serverBeaconApiUrl,
      ETHEREUM_EXECUTION_RPC_URL: devEthereum.serverExecutionRpcUrl,
      ETHEREUM_FINALITY_MILLIS: String(config.finalityMillis),
    },
    async start(): Promise<void> {
      let setupStep = 'waiting for Polkadot crypto load';

      try {
        await updateDevEthereumRuntimeState(devEthereum.executionRpcUrl, { setupStatus: 'starting' });
        await waitForLoad();
        const alice = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');

        setupStep = 'bootstrapping the Ethereum verifier on Argon';
        console.log(`[tauri-dev] ${setupStep}`);
        await ensureDevEthereumBeaconBootstrap(archiveUrl, devEthereum.beaconApiUrl, devEthereum.beaconPreset, alice);

        setupStep = 'preparing the local Ethereum gateway';
        console.log(`[tauri-dev] ${setupStep}`);
        let gateway = devEthereum.gateway ?? (await loadConfiguredDevEthereumGateway(archiveUrl));
        if (gateway && !(await doesDevEthereumGatewayMatch(devEthereum.executionRpcUrl, gateway))) {
          gateway = undefined;
        }
        if (!gateway) {
          const fixtureDeployer = new TestEthereum(devEthereum.enclaveName);
          fixtureDeployer.executionRpcUrl = devEthereum.executionRpcUrl;
          fixtureDeployer.chainId = devEthereum.chainId;
          const initialMicrogonsPerArgonot = await loadLocalGatewayCouncilFloorMicrogonsPerArgonot(archiveUrl);
          gateway = await fixtureDeployer.deployMintingGatewayFixture({
            deployerPrivateKey: DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey,
            initialMicrogonsPerArgonot,
          });
        } else {
          console.log('[tauri-dev] Reusing the local Ethereum gateway deployment');
        }
        await updateDevEthereumRuntimeState(devEthereum.executionRpcUrl, { gateway });

        setupStep = 'initializing the local Ethereum token reserve';
        console.log(`[tauri-dev] ${setupStep}`);
        const publicClient = createPublicClient({
          transport: http(devEthereum.executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
        });
        await initializeDevEthereumTokenReserve({
          publicClient,
          gatewayAddress: gateway.gatewayAddress,
          argonTokenAddress: gateway.argonTokenAddress,
          argonotTokenAddress: gateway.argonotTokenAddress,
          rootAccountAddress: DEV_ETHEREUM_ADMIN_ACCOUNT.address,
          ensureBacking: async () => {
            const client = createArgonClient(await getClient(archiveUrl));

            try {
              await sudoFundWallet({
                client,
                address: client.consts.crosschainTransfer.ethereumBurnAccount.toString(),
                microgons: DEV_ETHEREUM_TOKEN_RESERVE_RUNTIME_AMOUNT,
                micronots: DEV_ETHEREUM_TOKEN_RESERVE_RUNTIME_AMOUNT,
              });
            } finally {
              await client.disconnect().catch(() => undefined);
            }
          },
          sendMigration: async data =>
            (
              await sendDevEthereumAdminTransaction({
                rpcUrl: devEthereum.executionRpcUrl,
                to: gateway.gatewayAddress,
                data,
              })
            ).hash,
        });

        setupStep = 'configuring the local Ethereum gateway on Argon';
        console.log(`[tauri-dev] ${setupStep}`);
        await ensureDevEthereumChainConfig(
          archiveUrl,
          devEthereum.chainId,
          devEthereum.executionRpcUrl,
          gateway,
          alice,
        );

        setupStep = 'syncing the Ethereum gateway council to Argon';
        console.log(`[tauri-dev] ${setupStep}`);
        await ensureDevEthereumGatewayActiveCouncil(archiveUrl, devEthereum.executionRpcUrl, gateway);

        await updateDevEthereumRuntimeState(devEthereum.executionRpcUrl, {
          gateway,
          setupStatus: 'ready',
        });
      } catch (error) {
        throw new Error(`Failed while ${setupStep}: ${(error as Error).message}`);
      }
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

async function doesDevEthereumGatewayMatch(executionRpcUrl: string, gateway: DevEthereumGateway): Promise<boolean> {
  const publicClient = createPublicClient({
    transport: http(executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
  });

  try {
    const [argonTokenAddress, argonotTokenAddress] = await Promise.all([
      publicClient.readContract({
        address: gateway.gatewayAddress,
        abi: EvmContracts.mintingGatewayAbi,
        functionName: 'argonToken',
      }),
      publicClient.readContract({
        address: gateway.gatewayAddress,
        abi: EvmContracts.mintingGatewayAbi,
        functionName: 'argonotToken',
      }),
    ]);

    return (
      argonTokenAddress.toLowerCase() === gateway.argonTokenAddress.toLowerCase() &&
      argonotTokenAddress.toLowerCase() === gateway.argonotTokenAddress.toLowerCase()
    );
  } catch {
    return false;
  }
}

export async function loadConfiguredDevEthereumGateway(archiveUrl: string): Promise<DevEthereumGateway | undefined> {
  await waitForQueryableClient(archiveUrl, { label: 'dev Ethereum chain-config client' });
  const client = createArgonClient(await getClient(archiveUrl));

  try {
    const chainConfig = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
    if (chainConfig?.type !== 'Evm') return;

    const ethereum = chainConfig.value;
    return {
      gatewayAddress: getAddress(ethereum.gateway),
      argonTokenAddress: getAddress(ethereum.argonToken),
      argonotTokenAddress: getAddress(ethereum.argonotToken),
    };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

async function readDevEthereumRuntimeStateCandidates(): Promise<IDevEthereumRuntimeState[]> {
  const latest = await readDevEthereumRuntimeState();
  const latestStatePath = getDevEthereumRuntimeStatePath();
  const configuredStateDir = process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR?.trim();
  const scopedStateDir = configuredStateDir
    ? path.dirname(latestStatePath)
    : path.join(path.dirname(latestStatePath), 'dev-ethereum');
  const fileNames = await fs.readdir(scopedStateDir).catch(() => []);
  const scopedStates = await Promise.all(
    fileNames
      .filter(fileName => fileName.endsWith('.json') && fileName !== 'latest.json')
      .map(async fileName => {
        try {
          const raw = await fs.readFile(path.join(scopedStateDir, fileName), 'utf8');
          return JSON.parse(raw) as IDevEthereumRuntimeState;
        } catch {
          return undefined;
        }
      }),
  );
  scopedStates.sort((left, right) => Date.parse(right?.updatedAt ?? '') - Date.parse(left?.updatedAt ?? ''));

  const candidates: IDevEthereumRuntimeState[] = [];
  for (const state of [latest, ...scopedStates]) {
    if (!state || candidates.some(candidate => candidate.executionRpcUrl === state.executionRpcUrl)) continue;
    candidates.push(state);
  }
  return candidates;
}

export async function readDevEthereumRuntimeState(
  executionRpcUrl?: string,
  runtimeStateDir?: string,
): Promise<IDevEthereumRuntimeState | undefined> {
  try {
    const raw = await fs.readFile(getDevEthereumRuntimeStatePath(executionRpcUrl, runtimeStateDir), 'utf8');
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

  const runtimeState = await readDevEthereumRuntimeState();
  const runtimeRpc = readNonEmpty(runtimeState?.executionRpcUrl);
  if (runtimeRpc && runtimeState?.setupStatus === 'ready') {
    try {
      const chainId = await rpcCall<string>(runtimeRpc, 'eth_chainId', []);
      if (!runtimeState?.chainId || chainId === runtimeState.chainId) {
        return runtimeRpc;
      }

      console.warn(
        `[${logPrefix}] Ignoring dev Ethereum runtime state at ${runtimeRpc} because it reported chainId ${chainId}, expected ${runtimeState.chainId}.`,
      );
    } catch (error) {
      console.warn(
        `[${logPrefix}] Ignoring unreadable dev Ethereum runtime state at ${runtimeRpc}: ${(error as Error).message}`,
      );
    }
  } else if (runtimeRpc) {
    throw new Error('Local Ethereum setup has not finished. Keep Tauri dev running and retry after it is ready.');
  }

  throw new Error(
    'Unable to resolve a local Ethereum execution RPC. Pass --rpc http://127.0.0.1:<port>, set ETH_RPC or ETHEREUM_EXECUTION_RPC_URL, or start the local Kurtosis devnet first.',
  );
}

async function ensureDevEthereumBeaconBootstrap(
  archiveUrl: string,
  beaconApiUrl: string,
  beaconPreset: DevEthereumBeaconPreset,
  sudoKeypair: KeyringPair,
): Promise<void> {
  const bootstrapStartedAt = Date.now();
  console.log(`[tauri-dev] Waiting for bootstrap archive client at ${archiveUrl}`);
  await waitForQueryableClient(archiveUrl, {
    timeoutMs: 120_000,
    pollMs: 1_000,
    label: `dev Ethereum bootstrap archive ${archiveUrl}`,
  });
  console.log(`[tauri-dev] Bootstrap archive client is queryable after ${Date.now() - bootstrapStartedAt}ms`);

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attemptNumber = attempt + 1;
    const attemptStartedAt = Date.now();
    console.log(`[tauri-dev] Ethereum verifier bootstrap attempt ${attemptNumber}/3: connecting archive client`);
    const client = createArgonClient(await getClient(archiveUrl));

    try {
      console.log(`[tauri-dev] Ethereum verifier bootstrap attempt ${attemptNumber}/3: reading current verifier state`);
      const state = await getEthereumBeaconSyncState(client.raw);
      if (state.isBootstrapped) {
        console.log(
          `[tauri-dev] Ethereum verifier already bootstrapped (attempt ${attemptNumber}, ${Date.now() - attemptStartedAt}ms)`,
        );
        return;
      }

      console.log(
        `[tauri-dev] Ethereum verifier bootstrap attempt ${attemptNumber}/3: waiting for beacon bootstrap inputs from ${beaconApiUrl}`,
      );
      await ensureDevEthereumBeaconBootstrapped(client, beaconApiUrl, sudoKeypair, {
        minimumFinalizedSlot: MINIMUM_BOOTSTRAP_FINALIZED_SLOT_BY_PRESET[beaconPreset],
      });
      console.log(
        `[tauri-dev] Bootstrapped ethereum verifier from ${beaconApiUrl} in ${Date.now() - attemptStartedAt}ms`,
      );
      return;
    } catch (error) {
      lastError = error as Error;
      if (attempt === 2 || !isRetryableBootstrapError(lastError)) {
        throw error;
      }
      console.warn(`[tauri-dev] Retrying Ethereum verifier bootstrap (${lastError.message})`);
      await delay(1_000);
      await waitForQueryableClient(archiveUrl, {
        timeoutMs: 120_000,
        pollMs: 1_000,
        label: `dev Ethereum bootstrap archive ${archiveUrl}`,
      });
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  }

  throw lastError ?? new Error('Ethereum verifier bootstrap failed without an error.');
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

  throw new Error(
    `Timed out waiting for Ethereum transaction receipt: ${hash}${lastError ? ` (${lastError.message})` : ''}`,
  );
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

export function writeDevEthereumRuntimeState(state: Omit<IDevEthereumRuntimeState, 'updatedAt'>): Promise<void> {
  return queueDevEthereumRuntimeStateOperation(() => writeDevEthereumRuntimeStateNow(state));
}

export function updateDevEthereumRuntimeState(
  executionRpcUrl: string,
  updates: Partial<Pick<IDevEthereumRuntimeState, 'gateway' | 'setupStatus' | 'mintingAuthorityStatus'>>,
): Promise<void> {
  return queueDevEthereumRuntimeStateOperation(async () => {
    const runtimeState = await readDevEthereumRuntimeState(executionRpcUrl);
    if (!runtimeState || runtimeState.executionRpcUrl !== executionRpcUrl) {
      return;
    }

    await writeDevEthereumRuntimeStateNow({
      ...runtimeState,
      ...updates,
    });
  });
}

async function writeDevEthereumRuntimeStateNow(state: Omit<IDevEthereumRuntimeState, 'updatedAt'>): Promise<void> {
  const runtimeState = {
    ...state,
    updatedAt: new Date().toISOString(),
  } satisfies IDevEthereumRuntimeState;
  const latestStatePath = getDevEthereumRuntimeStatePath();
  const scopedStatePath = getDevEthereumRuntimeStatePath(state.executionRpcUrl);
  const serialized = `${JSON.stringify(runtimeState, null, 2)}\n`;

  await fs.mkdir(path.dirname(scopedStatePath), { recursive: true });
  await writeFileAtomically(scopedStatePath, serialized);
  await writeFileAtomically(latestStatePath, serialized);
}

async function queueDevEthereumRuntimeStateOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = runtimeStateOperation.then(operation);
  runtimeStateOperation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(temporaryPath, contents, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function getDevEthereumRuntimeStatePath(executionRpcUrl?: string, runtimeStateDir?: string): string {
  const configuredStateDir = runtimeStateDir?.trim() || process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR?.trim();
  if (configuredStateDir) {
    const stateDir = path.resolve(configuredStateDir);
    if (!executionRpcUrl) {
      return path.join(stateDir, 'latest.json');
    }

    const safeExecutionRpcUrl = executionRpcUrl.replace(/[^a-zA-Z0-9_.-]+/g, '_');
    return path.join(stateDir, `${safeExecutionRpcUrl}.json`);
  }

  if (!executionRpcUrl) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts', 'dev-ethereum.json');
  }

  const safeExecutionRpcUrl = executionRpcUrl.replace(/[^a-zA-Z0-9_.-]+/g, '_');
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'artifacts',
    'dev-ethereum',
    `${safeExecutionRpcUrl}.json`,
  );
}

async function ensureDevEthereumChainConfig(
  archiveUrl: string,
  chainId: string,
  executionRpcUrl: string,
  devEthereum: Awaited<ReturnType<TestEthereum['deployMintingGatewayFixture']>>,
  sudoKeypair: KeyringPair,
): Promise<void> {
  const client = createArgonClient(await getClient(archiveUrl));

  try {
    const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());
    const hasMatchingChainConfig = async () => {
      const currentConfig = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
      if (currentConfig?.type !== 'Evm') return false;

      const ethereumConfig = currentConfig.value;
      return (
        ethereumConfig.gateway.toLowerCase() === devEthereum.gatewayAddress.toLowerCase() &&
        ethereumConfig.argonToken.toLowerCase() === devEthereum.argonTokenAddress.toLowerCase() &&
        ethereumConfig.argonotToken.toLowerCase() === devEthereum.argonotTokenAddress.toLowerCase()
      );
    };

    if (!(await hasMatchingChainConfig())) {
      await submitDevSudoTransaction({
        client,
        tx: client.tx.crosschainTransfer.setChainConfig('Ethereum', {
          Evm: {
            chainId,
            gateway: devEthereum.gatewayAddress,
            argonToken: devEthereum.argonTokenAddress,
            argonotToken: devEthereum.argonotTokenAddress,
          },
        }),
        sudoKeypair,
        isApplied: hasMatchingChainConfig,
        description: 'Ethereum chain-config setup',
      });

      console.log('[tauri-dev] Configured local Ethereum gateway on Argon');
    } else {
      console.log('[tauri-dev] Ethereum chain config already matches local gateway fixture');
    }

    console.log('[tauri-dev] Deriving local Ethereum activation repayment pricing');
    const expectedRepaymentPricing = await loadDevEthereumActivationRepaymentPricing({
      finalizedClient,
      executionRpcUrl,
    }).catch(error => {
      throw new Error(`Unable to derive local Ethereum activation repayment pricing: ${(error as Error).message}`);
    });
    const hasMatchingRepaymentPricing = async () => {
      const currentRepaymentPricing =
        await client.query.crosschainTransfer.mintingAuthorityActivationRepaymentPricingByDestinationChain('Ethereum');
      const repaymentPricing = currentRepaymentPricing ?? undefined;

      return (
        repaymentPricing?.activationGasCost === expectedRepaymentPricing.activationGasCost &&
        repaymentPricing.signatureGasCost === expectedRepaymentPricing.signatureGasCost &&
        repaymentPricing.estimatedWeiPerGas === expectedRepaymentPricing.estimatedWeiPerGas &&
        repaymentPricing.estimatedMicrogonsPerEth === expectedRepaymentPricing.estimatedMicrogonsPerEth
      );
    };

    if (!(await hasMatchingRepaymentPricing())) {
      await submitDevSudoTransaction({
        client,
        tx: client.tx.crosschainTransfer.setMintingAuthorityActivationRepaymentPricing(
          'Ethereum',
          expectedRepaymentPricing,
        ),
        sudoKeypair,
        isApplied: hasMatchingRepaymentPricing,
        description: 'Ethereum activation repayment pricing setup',
      });

      console.log('[tauri-dev] Configured local Ethereum activation repayment pricing on Argon');
    } else {
      console.log('[tauri-dev] Ethereum activation repayment pricing already matches local dev fixture');
    }
  } finally {
    await client.disconnect();
  }
}

async function ensureDevEthereumGatewayActiveCouncil(
  archiveUrl: string,
  executionRpcUrl: string,
  devEthereum: Awaited<ReturnType<TestEthereum['deployMintingGatewayFixture']>>,
): Promise<void> {
  const client = createArgonClient(await getClient(archiveUrl));
  const publicClient = createPublicClient({
    transport: http(executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
  });

  try {
    const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());
    const result = await syncEthereumGatewayActiveCouncilToArgon({
      finalizedClient,
      gatewayAddress: devEthereum.gatewayAddress,
      publicClient,
      sendCurrentCouncil: async (currentCouncil, nextMicrogonsPerArgonot) => {
        const { hash } = await sendDevEthereumAdminTransaction({
          rpcUrl: executionRpcUrl,
          to: devEthereum.gatewayAddress,
          data: encodeFunctionData({
            abi: EvmContracts.mintingGatewayAbi,
            functionName: 'forceUpdateActiveCouncil',
            args: [currentCouncil, nextMicrogonsPerArgonot],
          }),
        });
        return hash;
      },
    });

    switch (result.status) {
      case 'no-active-council':
        console.log('[tauri-dev] No active Ethereum council found on Argon yet');
        break;
      case 'missing-active-council':
        console.log('[tauri-dev] Active Ethereum council hash is missing on Argon');
        break;
      case 'already-matching':
        console.log('[tauri-dev] Ethereum gateway council already matches Argon active council');
        break;
      case 'synced':
        console.log('[tauri-dev] Synced Ethereum gateway council to Argon active council');
        break;
    }
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

async function loadLocalGatewayCouncilFloorMicrogonsPerArgonot(archiveUrl: string): Promise<bigint> {
  const client = createArgonClient(await getClient(archiveUrl));

  try {
    const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());

    const priceIndex = await finalizedClient.query.priceIndex.current();
    if (!priceIndex) {
      throw new Error('Unable to derive the local Ethereum gateway council floor because priceIndex.current is empty.');
    }

    const argonUsdPrice = priceIndex.argonUsdPrice;
    const argonotUsdPrice = priceIndex.argonotUsdPrice;
    if (!argonotUsdPrice || argonUsdPrice.isZero() || argonotUsdPrice.isZero()) {
      throw new Error(
        'Unable to derive the local Ethereum gateway council floor because the current Argon or Argonot price is zero.',
      );
    }

    return BigInt(
      new BigNumber(argonotUsdPrice)
        .dividedBy(argonUsdPrice)
        .times(MICROGONS_PER_ARGON)
        .integerValue(BigNumber.ROUND_FLOOR)
        .toFixed(0),
    );
  } finally {
    await client.disconnect().catch(() => undefined);
  }
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

function isRetryableBootstrapError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('priority is too low') ||
    message.includes('fetch failed') ||
    message.includes('disconnected from ws://') ||
    message.includes('abnormal closure')
  );
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
