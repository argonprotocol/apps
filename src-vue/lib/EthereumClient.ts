import { MoveToken, NetworkConfig } from '@argonprotocol/apps-core';
import {
  buildEthereumEventProof,
  findEthereumBurnForTransferLogIndex,
  MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
  mintingGatewayArtifact,
  waitForRetainedExecutionAnchor,
} from '@argonprotocol/mainchain';
import {
  type Address,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hash,
  type Hex,
  http,
  type PublicClient,
  serializeTransaction,
} from 'viem';
import type { IEthereumMoveToken } from '../interfaces/IEthereumInboundTransferTracker.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { SERVER_ENV_VARS } from './Env.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import type { WalletKeys } from './WalletKeys.ts';
export type { IEthereumMoveToken } from '../interfaces/IEthereumInboundTransferTracker.ts';

export type IEthereumBurnTransfer = {
  moveToken: IEthereumMoveToken;
  amountBaseUnits: bigint;
  destinationAddress: string;
  executionRpcUrl: string;
  burnTxHash: Hash;
  burnBlockNumber?: number;
  burnBlockHash?: Hash;
  burnLogIndex?: number;
};

export type IEthereumBurnProof = Awaited<ReturnType<typeof buildEthereumEventProof>>;

export type IEthereumChainConfig = {
  chainId: number;
  gatewayAddress: Address;
  argonTokenAddress: Address;
  argonotTokenAddress: Address;
};

export type IEthereumNetworkSettings = {
  executionRpcUrl: string;
  argonTokenAddress: Address;
  usdcTokenAddress: Address;
};

type IEthereumSignature = {
  yParity: number;
  r: Hex;
  s: Hex;
};

type IEthereumUnsignedTransaction = {
  chainId: number;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  to: Address;
  value: bigint;
  data: Hex;
  type: 'eip1559';
  accessList: [];
};

const ETHEREUM_BLOCKS_TO_FINALITY = 32;
const MIN_BURN_PROOF_TIMEOUT_MS = 5 * 60_000;
const ETHEREUM_PUBLIC_CLIENT_OPTIONS = { retryCount: 1, timeout: 15_000 } as const;
const ethereumChainConfigPromises = new Map<string, Promise<IEthereumChainConfig | undefined>>();

export class EthereumClient {
  constructor(
    private readonly walletKeys: WalletKeys,
    public readonly executionRpcUrl: string,
  ) {}

  public get sourceAddress() {
    return this.walletKeys.ethereumAddress;
  }

  public getBurnProofWaitEstimateMs() {
    return getEthereumFinalityMillis() + NetworkConfig.tickMillis * 4;
  }

  public getBurnProofPollMs() {
    return getEthereumPollMillis();
  }

  public getBurnProofTimeoutMs() {
    return Math.max(MIN_BURN_PROOF_TIMEOUT_MS, this.getBurnProofWaitEstimateMs() + this.getBurnProofPollMs() * 2);
  }

  public async approveTransfer(args: { moveToken: IEthereumMoveToken; amountBaseUnits: bigint }) {
    const { moveToken, amountBaseUnits } = args;
    const chainConfig = await this.loadChainConfig();
    const tokenAddress = getEthereumTokenAddress(chainConfig, moveToken);
    const { chain, publicClient } = await this.createExecutionClient();
    const from = getAddress(this.walletKeys.ethereumAddress);

    const approveCallData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [chainConfig.gatewayAddress, amountBaseUnits],
    });
    const { transaction: approveTransaction, unsignedTransaction: unsignedApproveTransaction } =
      await buildEthereumUnsignedTransaction({
        publicClient,
        from,
        chainId: chain.id,
        to: tokenAddress,
        data: approveCallData,
      });
    const approveSignature = await signEthereumTransaction(unsignedApproveTransaction);
    const approveHash = await publicClient.sendRawTransaction({
      serializedTransaction: serializeTransaction(approveTransaction, approveSignature),
    });

    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  public async submitBurnTransfer(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    destinationAddress: string;
  }): Promise<IEthereumBurnTransfer> {
    const { moveToken, amountBaseUnits, destinationAddress } = args;
    const mainchainClient = await getMainchainClient(false);
    const chainConfig = await this.loadChainConfig();
    const tokenAddress = getEthereumTokenAddress(chainConfig, moveToken);
    const { chain, publicClient } = await this.createExecutionClient();
    const from = getAddress(this.walletKeys.ethereumAddress);
    const runtimeAmount = convertEthereumBaseUnitsToRuntimeAmount(amountBaseUnits);

    const argonDestination = mainchainClient.createType('AccountId32', destinationAddress).toHex();
    const burnCallData = encodeFunctionData({
      abi: mintingGatewayArtifact.abi,
      functionName: 'burnForTransfer',
      args: [tokenAddress, runtimeAmount, argonDestination],
    });
    const { transaction: burnTransaction, unsignedTransaction: unsignedBurnTransaction } =
      await buildEthereumUnsignedTransaction({
        publicClient,
        from,
        chainId: chain.id,
        to: chainConfig.gatewayAddress,
        data: burnCallData,
      });
    const burnSignature = await signEthereumTransaction(unsignedBurnTransaction);
    const burnTxHash = await publicClient.sendRawTransaction({
      serializedTransaction: serializeTransaction(burnTransaction, burnSignature),
    });

    return {
      moveToken,
      amountBaseUnits,
      destinationAddress,
      executionRpcUrl: this.executionRpcUrl,
      burnTxHash,
    };
  }

  public async confirmBurnTransfer(burnTransfer: IEthereumBurnTransfer): Promise<IEthereumBurnTransfer> {
    if (burnTransfer.burnBlockNumber != null && burnTransfer.burnLogIndex != null) {
      return burnTransfer;
    }

    const chainConfig = await this.loadChainConfig();
    const { publicClient } = await this.createExecutionClient();
    const burnReceipt = await publicClient.waitForTransactionReceipt({ hash: burnTransfer.burnTxHash });

    return {
      ...burnTransfer,
      burnBlockNumber: Number(burnReceipt.blockNumber),
      burnBlockHash: burnReceipt.blockHash,
      burnLogIndex: findEthereumBurnForTransferLogIndex(burnReceipt, chainConfig.gatewayAddress),
    };
  }

  public async buildBurnProof(burnTransfer: IEthereumBurnTransfer): Promise<IEthereumBurnProof> {
    if (burnTransfer.burnBlockNumber == null || burnTransfer.burnLogIndex == null) {
      throw new Error('Ethereum burn transfer must be confirmed before building a proof.');
    }

    const mainchainClient = await getMainchainClient(false);
    const { publicClient } = await this.createExecutionClient();
    const burnReceipt = await publicClient.waitForTransactionReceipt({ hash: burnTransfer.burnTxHash });
    const pollMs = this.getBurnProofPollMs();
    const timeoutMs = this.getBurnProofTimeoutMs();

    await waitForRetainedExecutionAnchor(mainchainClient, BigInt(burnTransfer.burnBlockNumber), {
      pollMs,
      timeoutMs,
    });

    return buildEthereumEventProof(mainchainClient, {
      txHash: burnTransfer.burnTxHash,
      logIndex: burnTransfer.burnLogIndex,
      executionClient: publicClient,
      receipt: burnReceipt,
    });
  }

  private async loadChainConfig(): Promise<IEthereumChainConfig> {
    const chainConfig = await loadEthereumChainConfigForRpc(this.executionRpcUrl);
    if (!chainConfig) {
      throw new Error('Ethereum transfer gateway is not configured on this network.');
    }

    return chainConfig;
  }

  private async createExecutionClient() {
    const chainConfig = await this.loadChainConfig();
    const resolvedExecutionRpcUrl = this.executionRpcUrl.trim();
    if (!resolvedExecutionRpcUrl) {
      throw new Error('Ethereum execution RPC is not configured for this app instance.');
    }
    const chain = defineChain({
      id: chainConfig.chainId,
      name: 'argon-wallet-ethereum',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: [resolvedExecutionRpcUrl],
        },
      },
    });
    const publicClient = createEthereumPublicClientForRpc(resolvedExecutionRpcUrl, chain);

    return {
      chain,
      publicClient,
    };
  }
}

export async function loadEthereumChainConfig(): Promise<IEthereumChainConfig | undefined> {
  const resolvedExecutionRpcUrl = getEthereumExecutionRpcUrl();
  if (!resolvedExecutionRpcUrl) {
    return undefined;
  }

  return loadEthereumChainConfigForRpc(resolvedExecutionRpcUrl);
}

async function loadEthereumChainConfigForRpc(executionRpcUrl: string): Promise<IEthereumChainConfig | undefined> {
  const resolvedExecutionRpcUrl = executionRpcUrl.trim();
  if (!resolvedExecutionRpcUrl) {
    return undefined;
  }

  let configPromise = ethereumChainConfigPromises.get(resolvedExecutionRpcUrl);

  configPromise ??= (async () => {
    const client = await getMainchainClient(false);
    const ethereumClient = createEthereumPublicClientForRpc(resolvedExecutionRpcUrl);
    const config = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');

    if (config.isNone || !config.unwrap().isEthereum) {
      return undefined;
    }

    const ethereumConfig = config.unwrap().asEthereum;
    return {
      chainId: await ethereumClient.getChainId(),
      gatewayAddress: getAddress(ethereumConfig.gateway.toHex()),
      argonTokenAddress: getAddress(ethereumConfig.argonToken.toHex()),
      argonotTokenAddress: getAddress(ethereumConfig.argonotToken.toHex()),
    };
  })();
  ethereumChainConfigPromises.set(resolvedExecutionRpcUrl, configPromise);

  const config = await configPromise;
  if (!config) {
    ethereumChainConfigPromises.delete(resolvedExecutionRpcUrl);
  }

  return config;
}

export function createEthereumPublicClient(chain?: Parameters<typeof createPublicClient>[0]['chain']): PublicClient {
  const resolvedExecutionRpcUrl = getEthereumExecutionRpcUrl();
  if (!resolvedExecutionRpcUrl) {
    throw new Error('Ethereum execution RPC is not configured for this app instance.');
  }

  return createEthereumPublicClientForRpc(resolvedExecutionRpcUrl, chain);
}

function createEthereumPublicClientForRpc(
  executionRpcUrl: string,
  chain?: Parameters<typeof createPublicClient>[0]['chain'],
): PublicClient {
  return createPublicClient({
    ...(chain ? { chain } : {}),
    transport: http(executionRpcUrl, ETHEREUM_PUBLIC_CLIENT_OPTIONS),
  });
}

export function getEthereumNetworkSettings(): IEthereumNetworkSettings {
  const { ethereumNetwork } = NetworkConfig.get();
  return {
    executionRpcUrl: ethereumNetwork.executionRpcUrl,
    argonTokenAddress: getAddress(ethereumNetwork.argonTokenAddress),
    usdcTokenAddress: getAddress(ethereumNetwork.usdcTokenAddress),
  };
}

function getEthereumTokenAddress(chainConfig: IEthereumChainConfig, moveToken: IEthereumMoveToken): Address {
  if (moveToken === MoveToken.ARGNOT) {
    return chainConfig.argonotTokenAddress;
  }

  return chainConfig.argonTokenAddress;
}

function convertEthereumBaseUnitsToRuntimeAmount(amountBaseUnits: bigint): bigint {
  if (amountBaseUnits % MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE !== 0n) {
    throw new Error('Ethereum token balance is not aligned to Argon runtime units.');
  }

  return amountBaseUnits / MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
}

export function getEthereumExecutionRpcUrl(): string | undefined {
  return getEthereumNetworkSettings().executionRpcUrl.trim() || undefined;
}

async function buildEthereumUnsignedTransaction(args: {
  publicClient: ReturnType<typeof createPublicClient>;
  from: Address;
  chainId: number;
  to: Address;
  data: Hex;
}): Promise<{ transaction: IEthereumUnsignedTransaction; unsignedTransaction: Hex }> {
  const { publicClient, from, chainId, to, data } = args;
  const [nonce, gasEstimate, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: from, blockTag: 'pending' }),
    publicClient.estimateGas({
      account: from,
      to,
      data,
      value: 0n,
    }),
    publicClient.estimateFeesPerGas(),
  ]);
  const fallbackGasPrice = fees.gasPrice ?? (await publicClient.getGasPrice());

  const transaction: IEthereumUnsignedTransaction = {
    chainId,
    nonce,
    gas: (gasEstimate * 12n) / 10n,
    maxFeePerGas: fees.maxFeePerGas ?? fallbackGasPrice,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? fallbackGasPrice,
    to,
    value: 0n,
    data,
    type: 'eip1559',
    accessList: [],
  };

  return {
    transaction,
    unsignedTransaction: serializeTransaction(transaction),
  };
}

function getEthereumFinalityMillis(): number {
  const raw = SERVER_ENV_VARS.ETHEREUM_FINALITY_MILLIS?.trim();
  const value = Number.parseInt(raw ?? '', 10);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('ETHEREUM_FINALITY_MILLIS is missing from the server environment.');
  }

  return value;
}

function getEthereumPollMillis(): number {
  return Math.max(1_000, Math.floor(getEthereumFinalityMillis() / ETHEREUM_BLOCKS_TO_FINALITY));
}

async function signEthereumTransaction(unsignedTransaction: Hex): Promise<IEthereumSignature> {
  return invokeWithTimeout<IEthereumSignature>(
    'sign_ethereum_transaction',
    {
      request: { unsignedTransaction },
    },
    60e3,
  );
}
