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
export type DevEthereumBeaconPreset = 'mainnet' | 'minimal';

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

export async function startDevEthereum(config: IDevEthereumConfig): Promise<IStartDevEthereumResult> {
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
        await waitForLoad();
        const alice = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');

        setupStep = 'bootstrapping the Ethereum verifier on Argon';
        console.log(`[tauri-dev] ${setupStep}`);
        await ensureDevEthereumBeaconBootstrap(archiveUrl, devEthereum.beaconApiUrl, devEthereum.beaconPreset, alice);

        setupStep = 'deploying the local Ethereum gateway fixture';
        console.log(`[tauri-dev] ${setupStep}`);
        const fixtureDeployer = new TestEthereum(devEthereum.enclaveName);
        fixtureDeployer.executionRpcUrl = devEthereum.executionRpcUrl;
        fixtureDeployer.chainId = devEthereum.chainId;
        const initialMicrogonsPerArgonot = await loadLocalGatewayCouncilFloorMicrogonsPerArgonot(archiveUrl);
        const fixture = await fixtureDeployer.deployMintingGatewayFixture({
          deployerPrivateKey: DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey,
          initialMicrogonsPerArgonot,
        });

        setupStep = 'initializing the local Ethereum token reserve';
        console.log(`[tauri-dev] ${setupStep}`);
        const publicClient = createPublicClient({
          transport: http(devEthereum.executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
        });
        await initializeDevEthereumTokenReserve({
          publicClient,
          gatewayAddress: fixture.gatewayAddress,
          argonTokenAddress: fixture.argonTokenAddress,
          argonotTokenAddress: fixture.argonotTokenAddress,
          rootAccountAddress: DEV_ETHEREUM_ADMIN_ACCOUNT.address,
          ensureBacking: async () => {
            const client = await getClient(archiveUrl);

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
                to: fixture.gatewayAddress,
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
          fixture,
          alice,
        );

        setupStep = 'syncing the Ethereum gateway council to Argon';
        console.log(`[tauri-dev] ${setupStep}`);
        await ensureDevEthereumGatewayActiveCouncil(archiveUrl, devEthereum.executionRpcUrl, fixture);
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

export async function readDevEthereumRuntimeState(
  executionRpcUrl?: string,
): Promise<IDevEthereumRuntimeState | undefined> {
  try {
    const raw = await fs.readFile(getDevEthereumRuntimeStatePath(executionRpcUrl), 'utf8');
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
  if (runtimeRpc) {
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
    const client = await getClient(archiveUrl);

    try {
      console.log(`[tauri-dev] Ethereum verifier bootstrap attempt ${attemptNumber}/3: reading current verifier state`);
      const state = await getEthereumBeaconSyncState(client);
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

export async function writeDevEthereumRuntimeState(state: Omit<IDevEthereumRuntimeState, 'updatedAt'>): Promise<void> {
  const runtimeState = {
    ...state,
    updatedAt: new Date().toISOString(),
  } satisfies IDevEthereumRuntimeState;
  const latestStatePath = getDevEthereumRuntimeStatePath();
  const scopedStatePath = getDevEthereumRuntimeStatePath(state.executionRpcUrl);
  const serialized = `${JSON.stringify(runtimeState, null, 2)}\n`;

  await Promise.all([
    fs.mkdir(path.dirname(latestStatePath), { recursive: true }),
    fs.mkdir(path.dirname(scopedStatePath), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(latestStatePath, serialized, 'utf8'),
    fs.writeFile(scopedStatePath, serialized, 'utf8'),
  ]);
}

function getDevEthereumRuntimeStatePath(executionRpcUrl?: string): string {
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
  const client = await getClient(archiveUrl);

  try {
    const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());
    const hasMatchingChainConfig = async () => {
      const currentConfig = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
      if (currentConfig.isNone || !currentConfig.unwrap().isEvm) {
        return false;
      }

      const ethereumConfig = currentConfig.unwrap().asEvm;
      return (
        ethereumConfig.gateway.toHex().toLowerCase() === devEthereum.gatewayAddress.toLowerCase() &&
        ethereumConfig.argonToken.toHex().toLowerCase() === devEthereum.argonTokenAddress.toLowerCase() &&
        ethereumConfig.argonotToken.toHex().toLowerCase() === devEthereum.argonotTokenAddress.toLowerCase()
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
      const repaymentPricing = currentRepaymentPricing.isSome ? currentRepaymentPricing.unwrap() : undefined;

      return (
        repaymentPricing?.activationGasCost.toBigInt() === expectedRepaymentPricing.activationGasCost &&
        repaymentPricing.signatureGasCost.toBigInt() === expectedRepaymentPricing.signatureGasCost &&
        repaymentPricing.estimatedWeiPerGas.toBigInt() === expectedRepaymentPricing.estimatedWeiPerGas &&
        repaymentPricing.estimatedMicrogonsPerEth.toBigInt() === expectedRepaymentPricing.estimatedMicrogonsPerEth
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
  const client = await getClient(archiveUrl);
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
  const client = await getClient(archiveUrl);

  try {
    const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());

    const priceIndex = await finalizedClient.query.priceIndex.current();
    if (priceIndex.isNone) {
      throw new Error('Unable to derive the local Ethereum gateway council floor because priceIndex.current is empty.');
    }

    const current = priceIndex.unwrap();
    const argonUsdPrice = current.argonUsdPrice.toBigInt();
    const argonotUsdPrice = current.argonotUsdPrice.toBigInt();
    if (argonUsdPrice === 0n || argonotUsdPrice === 0n) {
      throw new Error(
        'Unable to derive the local Ethereum gateway council floor because the current Argon or Argonot price is zero.',
      );
    }

    return (argonotUsdPrice * BigInt(MICROGONS_PER_ARGON)) / argonUsdPrice;
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
