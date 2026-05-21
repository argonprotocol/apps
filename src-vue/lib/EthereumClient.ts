import { MoveToken, NetworkConfig } from '@argonprotocol/apps-core';
import {
  argonTokenArtifact,
  decodeEthereumTransferToArgonStartedLog,
  findEthereumTransferToArgonStartedLogIndexes,
  MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE,
  mintingGatewayArtifact,
} from '@argonprotocol/mainchain';
import {
  type Address,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  http,
  type PublicClient,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem';
import type { IEthereumMoveToken } from '../interfaces/IEthereumInboundTransferTracker.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { SERVER_ENV_VARS } from './Env.ts';
import type { WalletKeys } from './WalletKeys.ts';

export type { IEthereumMoveToken } from '../interfaces/IEthereumInboundTransferTracker.ts';

export type IEthereumTransferToArgon = {
  moveToken: IEthereumMoveToken;
  amountBaseUnits: bigint;
  destinationAddress: string;
  executionRpcUrl: string;
  sourceTxHash: Hash;
  sourceBlockNumber?: number;
  sourceBlockHash?: Hash;
  sourceLogIndex?: number;
  gatewayActivityNonce?: bigint;
};

export type IEthereumChainConfig = {
  chainId: number;
  gatewayAddress: Address;
  argonTokenAddress: Address;
  argonotTokenAddress: Address;
};

const ETHEREUM_PUBLIC_CLIENT_OPTIONS = { retryCount: 1, timeout: 15_000 } as const;
const ethereumChainConfigPromises = new Map<string, Promise<IEthereumChainConfig | undefined>>();

export class EthereumClient {
  constructor(
    private readonly walletKeys: Pick<WalletKeys, 'ethereumAddress' | 'signEthereumPermit' | 'signEthereumTransaction'>,
    public readonly executionRpcUrl: string,
  ) {}

  public get sourceAddress() {
    return this.walletKeys.ethereumAddress;
  }

  public getTransferToArgonWaitEstimateMs() {
    return getEthereumFinalityMillis() + NetworkConfig.tickMillis * 4;
  }

  public getTransferToArgonPollMs() {
    const finalityBlocks = NetworkConfig.get().ethereumNetwork.finalityBlocks;
    if (!Number.isFinite(finalityBlocks) || finalityBlocks <= 0) {
      throw new Error('Ethereum finality blocks are missing from the network config.');
    }

    return Math.max(1_000, Math.floor(getEthereumFinalityMillis() / finalityBlocks));
  }

  public async startTransferToArgon(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    destinationAddress: string;
  }): Promise<IEthereumTransferToArgon> {
    const { moveToken, amountBaseUnits, destinationAddress } = args;
    const mainchainClient = await getMainchainClient(false);
    const chainConfig = await this.loadChainConfig();
    const tokenAddress =
      moveToken === MoveToken.ARGNOT ? chainConfig.argonotTokenAddress : chainConfig.argonTokenAddress;
    const { chain, publicClient } = await this.createExecutionClient();
    const from = getAddress(this.walletKeys.ethereumAddress);
    const runtimeAmount = convertEthereumBaseUnitsToRuntimeAmount(amountBaseUnits);
    const latestBlock = await publicClient.getBlock();
    const permitDeadline = latestBlock.timestamp + 3600n;
    const [permitNonce, tokenName] = await Promise.all([
      publicClient.readContract({
        address: tokenAddress,
        abi: argonTokenArtifact.abi,
        functionName: 'nonces',
        args: [from],
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: argonTokenArtifact.abi,
        functionName: 'name',
      }),
    ]);
    const permitSignature = await this.walletKeys.signEthereumPermit({
      tokenAddress,
      tokenName,
      value: amountBaseUnits,
      nonce: permitNonce,
      deadline: permitDeadline,
    });
    const argonDestination = mainchainClient.createType('AccountId32', destinationAddress).toHex();
    const callData = encodeFunctionData({
      abi: mintingGatewayArtifact.abi,
      functionName: 'startTransferToArgon',
      args: [
        tokenAddress,
        runtimeAmount,
        argonDestination,
        permitDeadline,
        permitSignature.v,
        permitSignature.r as Hex,
        permitSignature.s as Hex,
      ],
    });
    const { transaction, unsignedTransaction } = await buildEthereumUnsignedTransaction({
      publicClient,
      from,
      chainId: chain.id,
      to: chainConfig.gatewayAddress,
      data: callData,
    });
    const signature = await this.walletKeys.signEthereumTransaction(unsignedTransaction);
    const sourceTxHash = await publicClient.sendRawTransaction({
      serializedTransaction: serializeTransaction(transaction, signature),
    });

    return {
      moveToken,
      amountBaseUnits,
      destinationAddress,
      executionRpcUrl: this.executionRpcUrl,
      sourceTxHash,
    };
  }

  public async confirmTransferToArgon(transfer: IEthereumTransferToArgon): Promise<IEthereumTransferToArgon> {
    if (
      transfer.sourceBlockNumber !== undefined &&
      transfer.sourceLogIndex !== undefined &&
      transfer.gatewayActivityNonce !== undefined
    ) {
      return transfer;
    }

    const chainConfig = await this.loadChainConfig();
    const { publicClient } = await this.createExecutionClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transfer.sourceTxHash });
    const logIndexes = findEthereumTransferToArgonStartedLogIndexes(receipt, chainConfig.gatewayAddress);
    const sourceLogIndex = logIndexes[0];
    const transferLog = sourceLogIndex !== undefined ? receipt.logs[sourceLogIndex] : undefined;
    if (!transferLog) {
      throw new Error(
        `Ethereum receipt ${receipt.transactionHash} did not emit TransferToArgonStarted from gateway ${chainConfig.gatewayAddress}`,
      );
    }

    const decodedEvent = decodeEthereumTransferToArgonStartedLog({
      data: transferLog.data,
      topics: [...transferLog.topics],
    });
    if (decodedEvent.gatewayState?.gatewayActivityNonce === undefined) {
      throw new Error(
        `Ethereum receipt ${receipt.transactionHash} emitted TransferToArgonStarted without a gateway activity nonce.`,
      );
    }
    const gatewayActivityNonce = decodedEvent.gatewayState.gatewayActivityNonce;

    return {
      ...transfer,
      sourceBlockNumber: Number(receipt.blockNumber),
      sourceBlockHash: receipt.blockHash,
      sourceLogIndex,
      gatewayActivityNonce,
    };
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

  try {
    const config = await configPromise;
    if (!config) {
      ethereumChainConfigPromises.delete(resolvedExecutionRpcUrl);
    }

    return config;
  } catch (error) {
    ethereumChainConfigPromises.delete(resolvedExecutionRpcUrl);
    throw error;
  }
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

function convertEthereumBaseUnitsToRuntimeAmount(amountBaseUnits: bigint): bigint {
  if (amountBaseUnits % MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE !== 0n) {
    throw new Error('Ethereum token balance is not aligned to Argon runtime units.');
  }

  return amountBaseUnits / MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
}

export function getEthereumExecutionRpcUrl(): string | undefined {
  return NetworkConfig.get().ethereumNetwork.executionRpcUrl.trim() || undefined;
}

async function buildEthereumUnsignedTransaction(args: {
  publicClient: PublicClient;
  from: Address;
  chainId: number;
  to: Address;
  data: Hex;
}): Promise<{ transaction: TransactionSerializableEIP1559; unsignedTransaction: Hex }> {
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

  const transaction: TransactionSerializableEIP1559 = {
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
