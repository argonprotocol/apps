import { getObjectStringProperty, MoveToken, NetworkConfig } from '@argonprotocol/apps-core';
import {
  decodeAddress,
  decodeEthereumGatewayActivityLog,
  decodeEthereumTransferToArgonStartedLog,
  EvmContracts,
  hexToU8a,
  findEthereumTransferToArgonStartedLogIndexes,
  type IArgonQueryable,
  type PalletCrosschainTransferCouncilApprovalQueueEntry,
  u8aToHex,
} from '@argonprotocol/mainchain';
import {
  type Address,
  type ContractFunctionArgs,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  keccak256,
  hexToBytes,
  type Hash,
  type Hex,
  HttpRequestError,
  http,
  type PublicClient,
  RpcRequestError,
  serializeTransaction,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type TransactionSerializableEIP1559,
  toHex,
} from 'viem';
import type { IEthereumMoveToken } from '../interfaces/IEthereumInboundTransferTracker.ts';
import { sleep } from './Utils.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { SERVER_ENV_VARS } from './Env.ts';
import { getArgonFinalityMillis } from './TransactionInfo.ts';
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

export type IEthereumTransferOutOfArgon = {
  targetTxHash: Hash;
  targetBlockNumber?: number;
  targetBlockHash?: Hash;
  gatewayActivityNonce?: bigint;
};

export type IEthereumChainConfig = {
  chainId: number;
  gatewayAddress: Address;
  argonTokenAddress: Address;
  argonotTokenAddress: Address;
};
export type IEthereumTransactionProgress = {
  blockNumber?: number;
  blockHash?: Hash;
  confirmations: number;
  expectedConfirmations: number;
  progressPct: number;
  isFinalized: boolean;
};
export type IFinalizedEthereumTransactionProgress = IEthereumTransactionProgress & {
  blockNumber: number;
  blockHash: Hash;
};
type IEthereumSubmissionClient = {
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hash>;
  getTransaction(args: { hash: Hash }): Promise<unknown>;
  getTransactionReceipt(args: { hash: Hash }): Promise<unknown>;
};
type IEthereumGatewayCouncilSnapshot = {
  signers: Address[];
  weights: bigint[];
};
type IEthereumGatewayUpdate = {
  queueNonce: bigint;
  kind: bigint;
  payload: Hex;
  signatures: Hex[];
};
const ETHEREUM_PUBLIC_CLIENT_OPTIONS = { retryCount: 1, timeout: 15_000 } as const;
const ethereumChainConfigPromises = new Map<string, Promise<IEthereumChainConfig | undefined>>();
type EthereumExecutionReceipt = Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
type MintingGatewayTransferOutOfArgonAuthorization = {
  microgonCollateral: bigint;
  micronotCollateral: bigint;
  signature: Hex;
};
type MintingGatewayTransferOutOfArgonProof = {
  authorizations: MintingGatewayTransferOutOfArgonAuthorization[];
};
export type IEthereumFinalizeTransferOutOfArgonArgs = {
  request: EvmContracts.MintingGatewayTransferOutOfArgonRequest;
  proof: MintingGatewayTransferOutOfArgonProof;
};
type LoadedCouncil = {
  totalWeight: bigint;
  members: {
    signer: Address;
    weight: bigint;
  }[];
};
type RelayableGatewayUpdate = {
  ownerArgonAccountId?: Hex;
  activationSettlement?: {
    heldRepaymentMicrogons: bigint;
    baseRepaymentQuoteMicrogons: bigint;
  };
  update: IEthereumGatewayUpdate;
};
export type IEthereumGatewayRelayPreview = {
  signerAddress: Address;
  ethereumBalanceWei: bigint;
  feeEstimateWei?: bigint;
  expectedRepaymentMicrogons: bigint;
  estimatedMicrogonsPerEth: bigint;
  updateCount: number;
  activationCount: number;
  deactivationCount: number;
  firstQueueNonce?: bigint;
  lastQueueNonce?: bigint;
  isPaused: boolean;
  canRelay: boolean;
  reason?: 'paused' | 'noReadyUpdates' | 'uncompensatedSharedBatch' | 'insufficientBalance' | 'repaymentTooLow';
};
type IPreparedGatewayRelay = IEthereumGatewayRelayPreview & {
  publicClient: PublicClient;
  transaction?: TransactionSerializableEIP1559;
  unsignedTransaction?: Hex;
};

export class EthereumClient {
  constructor(
    private readonly walletKeys: Pick<
      WalletKeys,
      | 'configureEthereumSignerPolicy'
      | 'ethereumAddress'
      | 'signEthereumPermit'
      | 'signEthereumTransaction'
      | 'vaultingAddress'
    >,
    public readonly executionRpcUrl: string,
  ) {}

  public get sourceAddress() {
    return this.walletKeys.ethereumAddress;
  }

  public getTransactionFinalityBlocks() {
    const finalityBlocks = NetworkConfig.get().ethereumNetwork.finalityBlocks;
    if (!Number.isFinite(finalityBlocks) || finalityBlocks <= 0) {
      throw new Error('Ethereum finality blocks are missing from the network config.');
    }

    return finalityBlocks;
  }

  public getTransactionFinalityWaitEstimateMs() {
    return getEthereumFinalityMillis();
  }

  public getTransactionFinalityPollMs() {
    return Math.max(
      1_000,
      Math.floor(this.getTransactionFinalityWaitEstimateMs() / this.getTransactionFinalityBlocks()),
    );
  }

  public getTransferToArgonWaitEstimateMs() {
    return getTransferToArgonWaitEstimateMs();
  }

  public getTransferToArgonPollMs() {
    return this.getTransactionFinalityPollMs();
  }

  public getGatewayActivityWaitEstimateMs() {
    return getGatewayActivityWaitEstimateMs();
  }

  public getGatewayActivityPollMs() {
    return this.getTransferToArgonPollMs();
  }

  public async startTransferToArgon(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    destinationAddress: string;
  }): Promise<IEthereumTransferToArgon> {
    const { moveToken, amountBaseUnits, destinationAddress } = args;
    const { publicClient, transaction, unsignedTransaction } = await this.prepareTransferToArgon(args);
    await this.ensureEthereumSignerPolicyConfigured();
    const signature = await this.walletKeys.signEthereumTransaction(unsignedTransaction);
    const sourceTxHash = await submitEthereumTransaction({
      publicClient,
      serializedTransaction: serializeTransaction(transaction, signature),
      fallbackErrorMessage: 'Unable to submit the Ethereum transaction right now.',
    });

    return {
      moveToken,
      amountBaseUnits,
      destinationAddress,
      executionRpcUrl: this.executionRpcUrl,
      sourceTxHash,
    };
  }

  public async estimateTransferToArgonFee(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    destinationAddress: string;
  }): Promise<bigint> {
    const { feeEstimateWei } = await this.prepareTransferToArgon(args);
    return feeEstimateWei;
  }

  public async estimateFinalizeTransferOutOfArgonFee(args: IEthereumFinalizeTransferOutOfArgonArgs): Promise<bigint> {
    const chainConfig = await this.loadChainConfig();
    const { chain, publicClient } = await this.createExecutionClient();
    const { feeEstimateWei } = await buildEthereumUnsignedTransaction({
      publicClient,
      from: getAddress(this.walletKeys.ethereumAddress),
      chainId: chain.id,
      to: chainConfig.gatewayAddress,
      data: encodeFunctionData({
        abi: EvmContracts.mintingGatewayAbi,
        functionName: 'finalizeTransferOutOfArgon',
        args: [args.request, args.proof],
      }),
    });

    return feeEstimateWei;
  }

  public async estimateLikelyFinalizeTransferOutOfArgonFee(
    args: IEthereumFinalizeTransferOutOfArgonArgs,
  ): Promise<bigint> {
    const resolvedExecutionRpcUrl = this.executionRpcUrl.trim();
    if (!resolvedExecutionRpcUrl) {
      throw new Error('Ethereum execution RPC is not configured for this app instance.');
    }

    const publicClient = createEthereumPublicClientForRpc(resolvedExecutionRpcUrl);
    const data = encodeFunctionData({
      abi: EvmContracts.mintingGatewayAbi,
      functionName: 'finalizeTransferOutOfArgon',
      args: [args.request, args.proof],
    });

    // Before the transfer is ready on Argon we do not have the real authorization signatures yet,
    // so use calldata shape plus current fee rates for a provisional quote.
    return await estimateEthereumFeeWeiForGas(
      publicClient,
      estimateFinalizeTransferOutOfArgonGas(data, args.proof.authorizations.length),
    );
  }

  public async getNativeBalanceWei(): Promise<bigint> {
    const { publicClient } = await this.createExecutionClient();
    return await publicClient.getBalance({
      address: getAddress(this.walletKeys.ethereumAddress),
    });
  }

  public async getTransactionProgress(args: {
    txHash: Hash;
    blockNumber?: number;
    blockHash?: Hash;
  }): Promise<IEthereumTransactionProgress> {
    const { txHash, blockNumber, blockHash } = args;
    const { publicClient } = await this.createExecutionClient();
    const expectedConfirmations = this.getTransactionFinalityBlocks();
    let receiptBlockNumber = blockNumber;
    let receiptBlockHash = blockHash;

    if (receiptBlockNumber == null) {
      const receipt = await getIndexedReceiptIfAvailable(publicClient, txHash);
      receiptBlockNumber = receipt?.blockNumber != null ? Number(receipt.blockNumber) : undefined;
      receiptBlockHash = receipt?.blockHash ?? undefined;
    }

    if (receiptBlockNumber == null) {
      return {
        confirmations: -1,
        expectedConfirmations,
        progressPct: 0,
        isFinalized: false,
      };
    }

    const latestExecutionBlockNumber = Number(await publicClient.getBlockNumber());
    const confirmations = Math.max(0, latestExecutionBlockNumber - receiptBlockNumber);
    const progressPct = Math.min(100, (Math.min(confirmations, expectedConfirmations) / expectedConfirmations) * 100);

    return {
      blockNumber: receiptBlockNumber,
      blockHash: receiptBlockHash,
      confirmations,
      expectedConfirmations,
      progressPct,
      isFinalized: confirmations >= expectedConfirmations,
    };
  }

  public async waitForTransactionFinality(args: {
    txHash: Hash;
    blockNumber?: number;
    blockHash?: Hash;
    onProgress?: (progress: IEthereumTransactionProgress) => void;
    onRpcDelay?: (progress?: IEthereumTransactionProgress) => void;
  }): Promise<IFinalizedEthereumTransactionProgress> {
    const { txHash, onProgress, onRpcDelay } = args;
    let blockNumber = args.blockNumber;
    let blockHash = args.blockHash;
    let lastProgress: IEthereumTransactionProgress | undefined;

    while (true) {
      try {
        const progress = await this.getTransactionProgress({
          txHash,
          blockNumber,
          blockHash,
        });
        lastProgress = progress;
        blockNumber = progress.blockNumber ?? blockNumber;
        blockHash = progress.blockHash ?? blockHash;
        onProgress?.(progress);

        if (!progress.isFinalized || blockNumber == null || !blockHash) {
          await sleep(this.getTransactionFinalityPollMs());
          continue;
        }

        return {
          ...progress,
          blockNumber,
          blockHash,
        };
      } catch (error) {
        if (error instanceof HttpRequestError || error instanceof RpcRequestError) {
          onRpcDelay?.(lastProgress);
          await sleep(this.getTransactionFinalityPollMs());
          continue;
        }

        throw error;
      }
    }
  }

  public async finalizeTransferOutOfArgon(args: IEthereumFinalizeTransferOutOfArgonArgs): Promise<Hash> {
    const chainConfig = await this.loadChainConfig();
    const { chain, publicClient } = await this.createExecutionClient();
    const { transaction, unsignedTransaction } = await buildEthereumUnsignedTransaction({
      publicClient,
      from: getAddress(this.walletKeys.ethereumAddress),
      chainId: chain.id,
      to: chainConfig.gatewayAddress,
      data: encodeFunctionData({
        abi: EvmContracts.mintingGatewayAbi,
        functionName: 'finalizeTransferOutOfArgon',
        args: [args.request, args.proof],
      }),
    });
    await this.ensureEthereumSignerPolicyConfigured(chainConfig);
    const signature = await this.walletKeys.signEthereumTransaction(unsignedTransaction);
    return await submitEthereumTransaction({
      publicClient,
      serializedTransaction: serializeTransaction(transaction, signature),
      fallbackErrorMessage: 'Unable to submit the Ethereum transfer right now.',
    });
  }

  public async confirmTransferOutOfArgon(transfer: IEthereumTransferOutOfArgon): Promise<IEthereumTransferOutOfArgon> {
    if (transfer.targetBlockNumber != null && transfer.gatewayActivityNonce != null) {
      return transfer;
    }

    const chainConfig = await this.loadChainConfig();
    const { publicClient } = await this.createExecutionClient();
    const receipt = await waitForIndexedReceipt(publicClient, transfer.targetTxHash);
    const transferLog = receipt.logs.find(
      log =>
        log.address.toLowerCase() === chainConfig.gatewayAddress.toLowerCase() &&
        log.topics[0]?.toLowerCase() === EvmContracts.MintingGatewayEvents.TransferOutOfArgonFinalized.topic,
    );
    if (!transferLog) {
      throw new Error(
        `Ethereum receipt ${receipt.transactionHash} did not emit TransferOutOfArgonFinalized from gateway ${chainConfig.gatewayAddress}`,
      );
    }

    const decodedEvent = decodeEthereumGatewayActivityLog({
      data: transferLog.data,
      topics: [...transferLog.topics],
    });
    if (decodedEvent.kind !== EvmContracts.MintingGatewayEvents.TransferOutOfArgonFinalized.name) {
      throw new Error(
        `Ethereum receipt ${receipt.transactionHash} emitted the wrong gateway activity while finalizing a transfer out of Argon.`,
      );
    }

    return {
      ...transfer,
      targetBlockNumber: Number(receipt.blockNumber),
      targetBlockHash: receipt.blockHash,
      gatewayActivityNonce: decodedEvent.gatewayState.gatewayActivityNonce,
    };
  }

  public async confirmTransferToArgon(transfer: IEthereumTransferToArgon): Promise<IEthereumTransferToArgon> {
    if (
      transfer.sourceBlockNumber != null &&
      transfer.sourceLogIndex != null &&
      transfer.gatewayActivityNonce != null
    ) {
      return transfer;
    }

    const chainConfig = await this.loadChainConfig();
    const { publicClient } = await this.createExecutionClient();
    const receipt = await waitForIndexedReceipt(publicClient, transfer.sourceTxHash);
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

  public async getReadyGatewayRelayPreview(
    finalizedClient: IArgonQueryable,
    relayerArgonAddress: string,
    signer: { address: string; hdPath: `m/44'/60'/${string}` },
  ): Promise<IEthereumGatewayRelayPreview> {
    const {
      publicClient: _publicClient,
      transaction: _transaction,
      unsignedTransaction: _unsignedTransaction,
      ...preview
    } = await this.prepareReadyGatewayRelay(finalizedClient, relayerArgonAddress, signer);
    return preview;
  }

  public async applyReadyGatewayUpdates(
    finalizedClient: IArgonQueryable,
    relayerArgonAddress: string,
    signer: { address: string; hdPath: `m/44'/60'/${string}` },
    options: { allowUncompensatedRelay?: boolean } = {},
  ): Promise<EthereumExecutionReceipt | undefined> {
    const prepared = await this.prepareReadyGatewayRelay(finalizedClient, relayerArgonAddress, signer, options);
    if (!prepared.canRelay || !prepared.transaction || !prepared.unsignedTransaction) {
      return;
    }
    await this.ensureEthereumSignerPolicyConfigured();
    const signature = await this.walletKeys.signEthereumTransaction(prepared.unsignedTransaction, signer.hdPath);
    const hash = await submitEthereumTransaction({
      publicClient: prepared.publicClient,
      serializedTransaction: serializeTransaction(prepared.transaction, signature),
      fallbackErrorMessage: 'Unable to submit the Ethereum relay transaction right now.',
    });

    return await waitForIndexedReceipt(prepared.publicClient, hash);
  }

  private async prepareReadyGatewayRelay(
    finalizedClient: IArgonQueryable,
    relayerArgonAddress: string,
    signer: { address: string; hdPath: `m/44'/60'/${string}` },
    options: { allowUncompensatedRelay?: boolean } = {},
  ): Promise<IPreparedGatewayRelay> {
    const relayerArgonAccountId = toArgonAccountIdHex(relayerArgonAddress);
    const throughOwnerArgonAccountId = options.allowUncompensatedRelay
      ? toArgonAccountIdHex(this.walletKeys.vaultingAddress)
      : undefined;
    const chainConfig = await this.loadChainConfig();
    const { chain, publicClient } = await this.createExecutionClient();
    const batch = await getReadyEthereumGatewayUpdates(
      finalizedClient,
      publicClient,
      chainConfig,
      relayerArgonAccountId,
      {
        throughOwnerArgonAccountId,
      },
    );
    const signerAddress = getAddress(signer.address);
    const ethereumBalanceWei = await publicClient.getBalance({ address: signerAddress });
    const activationCount = batch.updates.filter(
      update => update.kind === EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.mintingAuthorityActivate,
    ).length;
    const deactivationCount = batch.updates.filter(
      update => update.kind === EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.mintingAuthorityDeactivate,
    ).length;
    const firstQueueNonce = batch.updates[0]?.queueNonce;
    const lastQueueNonce = batch.updates.at(-1)?.queueNonce;

    if (batch.paused) {
      return {
        publicClient,
        signerAddress,
        ethereumBalanceWei,
        expectedRepaymentMicrogons: batch.expectedRepaymentMicrogons,
        estimatedMicrogonsPerEth: batch.estimatedMicrogonsPerEth,
        updateCount: batch.updates.length,
        activationCount,
        deactivationCount,
        firstQueueNonce,
        lastQueueNonce,
        isPaused: true,
        canRelay: false,
        reason: 'paused',
      };
    }

    if (!batch.updates.length) {
      return {
        publicClient,
        signerAddress,
        ethereumBalanceWei,
        expectedRepaymentMicrogons: batch.expectedRepaymentMicrogons,
        estimatedMicrogonsPerEth: batch.estimatedMicrogonsPerEth,
        updateCount: batch.updates.length,
        activationCount,
        deactivationCount,
        firstQueueNonce,
        lastQueueNonce,
        isPaused: false,
        canRelay: false,
        reason: 'noReadyUpdates',
      };
    }
    const { transaction, unsignedTransaction, feeEstimateWei } = await buildEthereumUnsignedTransaction({
      publicClient,
      from: signerAddress,
      chainId: chain.id,
      to: chainConfig.gatewayAddress,
      data: encodeFunctionData({
        abi: EvmContracts.mintingGatewayAbi,
        functionName: 'applyGatewayUpdates',
        args: [batch.currentCouncil, batch.updates, relayerArgonAccountId] satisfies ContractFunctionArgs<
          typeof EvmContracts.mintingGatewayAbi,
          'nonpayable',
          'applyGatewayUpdates'
        >,
      }),
    });

    const shouldRequireCompensation = !options.allowUncompensatedRelay;
    let reason: IEthereumGatewayRelayPreview['reason'];

    if (shouldRequireCompensation && batch.expectedRepaymentMicrogons <= 0n) {
      reason = 'uncompensatedSharedBatch';
    } else if (
      shouldRequireCompensation &&
      batch.estimatedMicrogonsPerEth > 0n &&
      convertWeiToMicrogons(feeEstimateWei, batch.estimatedMicrogonsPerEth) > batch.expectedRepaymentMicrogons
    ) {
      reason = 'repaymentTooLow';
    } else if (ethereumBalanceWei < feeEstimateWei) {
      reason = 'insufficientBalance';
    }

    return {
      publicClient,
      transaction,
      unsignedTransaction,
      signerAddress,
      ethereumBalanceWei,
      feeEstimateWei,
      expectedRepaymentMicrogons: batch.expectedRepaymentMicrogons,
      estimatedMicrogonsPerEth: batch.estimatedMicrogonsPerEth,
      updateCount: batch.updates.length,
      activationCount,
      deactivationCount,
      firstQueueNonce,
      lastQueueNonce,
      isPaused: false,
      canRelay: !reason,
      reason,
    };
  }

  private async loadChainConfig(): Promise<IEthereumChainConfig> {
    const chainConfig = await loadEthereumChainConfigForRpc(this.executionRpcUrl);
    if (!chainConfig) {
      throw new Error('Ethereum transfer gateway is not configured on this network.');
    }

    return chainConfig;
  }

  private async ensureEthereumSignerPolicyConfigured(chainConfig?: IEthereumChainConfig) {
    const config = chainConfig ?? (await this.loadChainConfig());
    await this.walletKeys.configureEthereumSignerPolicy({
      chainId: config.chainId,
      gatewayAddress: config.gatewayAddress,
      tokenAddresses: [config.argonTokenAddress, config.argonotTokenAddress],
    });
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

  private async prepareTransferToArgon(args: {
    moveToken: IEthereumMoveToken;
    amountBaseUnits: bigint;
    destinationAddress: string;
  }) {
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
        abi: EvmContracts.argonTokenAbi,
        functionName: 'nonces',
        args: [from],
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: EvmContracts.argonTokenAbi,
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
      abi: EvmContracts.mintingGatewayAbi,
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
    const { transaction, unsignedTransaction, feeEstimateWei } = await buildEthereumUnsignedTransaction({
      publicClient,
      from,
      chainId: chain.id,
      to: chainConfig.gatewayAddress,
      data: callData,
    });

    return {
      publicClient,
      transaction,
      unsignedTransaction,
      feeEstimateWei,
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

    if (config.isNone || !config.unwrap().isEvm) {
      return undefined;
    }

    const ethereumConfig = config.unwrap().asEvm;
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
  if (amountBaseUnits % EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE !== 0n) {
    throw new Error('Ethereum token balance is not aligned to Argon runtime units.');
  }

  return amountBaseUnits / EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
}

export function getEthereumExecutionRpcUrl(): string | undefined {
  return NetworkConfig.get().ethereumNetwork.executionRpcUrl.trim() || undefined;
}

export function getEthereumBeaconApiUrl(configuredBeaconApiUrl?: string): string | undefined {
  if (!configuredBeaconApiUrl) {
    return undefined;
  }

  const resolvedConfiguredBeaconApiUrl = configuredBeaconApiUrl.trim();
  if (resolvedConfiguredBeaconApiUrl) {
    return resolvedConfiguredBeaconApiUrl;
  }

  return NetworkConfig.get().ethereumNetwork.beaconApiUrl.trim() || undefined;
}

// Keep runtime batching aligned with the integration harness so approval relays hit Ethereum exactly once.
async function getReadyEthereumGatewayUpdates(
  finalizedClient: IArgonQueryable,
  gatewayClient: Pick<PublicClient, 'readContract'>,
  chainConfig: IEthereumChainConfig,
  relayerArgonAccountId: Hex,
  options: { throughOwnerArgonAccountId?: Hex } = {},
  maxQueueEntries = 100,
): Promise<{
  currentCouncil: IEthereumGatewayCouncilSnapshot;
  estimatedMicrogonsPerEth: bigint;
  paused: boolean;
  updates: IEthereumGatewayUpdate[];
  expectedRepaymentMicrogons: bigint;
}> {
  const currentCouncilHashOption =
    await finalizedClient.query.crosschainTransfer.activeGlobalIssuanceCouncilByDestinationChain('Ethereum');
  if (currentCouncilHashOption.isNone) {
    throw new Error('Active GlobalIssuanceCouncil not found for Ethereum.');
  }

  const currentCouncilHash = toHexValue(currentCouncilHashOption.unwrap());
  const councilCache = new Map<Hex, LoadedCouncil>();
  const currentCouncil = councilToSnapshot(await loadCouncilByHash(finalizedClient, currentCouncilHash, councilCache));
  const hashContext = {
    chainId: BigInt(chainConfig.chainId),
    gatewayAddress: chainConfig.gatewayAddress,
  };
  const repaymentPricingOption =
    await finalizedClient.query.crosschainTransfer.mintingAuthorityActivationRepaymentPricingByDestinationChain(
      'Ethereum',
    );
  const repaymentPricing = repaymentPricingOption.isSome ? repaymentPricingOption.unwrap() : undefined;
  const estimatedMicrogonsPerEth = repaymentPricing?.estimatedMicrogonsPerEth.toBigInt() ?? 0n;
  const singleSignatureRepaymentQuoteMicrogons = repaymentPricing
    ? convertWeiToMicrogons(
        repaymentPricing.signatureGasCost.toBigInt() * repaymentPricing.estimatedWeiPerGas.toBigInt(),
        estimatedMicrogonsPerEth,
      )
    : 0n;

  const [rawArgonApprovalsNonce, rawArgonApprovalsHash, rawPaused] = await Promise.all([
    gatewayClient.readContract({
      abi: EvmContracts.mintingGatewayAbi,
      address: chainConfig.gatewayAddress,
      functionName: 'argonApprovalsNonce',
    }),
    gatewayClient.readContract({
      abi: EvmContracts.mintingGatewayAbi,
      address: chainConfig.gatewayAddress,
      functionName: 'argonApprovalsHash',
    }),
    gatewayClient.readContract({
      abi: EvmContracts.mintingGatewayAbi,
      address: chainConfig.gatewayAddress,
      functionName: 'paused',
    }),
  ]);
  const argonApprovalsNonce = rawArgonApprovalsNonce as bigint;
  const argonApprovalsHash = rawArgonApprovalsHash as Hex;
  const paused = rawPaused as boolean;
  const relayableUpdates: RelayableGatewayUpdate[] = [];
  let expectedPreviousApprovalHash = argonApprovalsHash;

  if (!paused) {
    for (let queueNonce = argonApprovalsNonce + 1n; relayableUpdates.length < maxQueueEntries; queueNonce += 1n) {
      const entryOption = await finalizedClient.query.crosschainTransfer.councilApprovalQueueByDestinationChainAndNonce(
        'Ethereum',
        queueNonce,
      );
      if (entryOption.isNone) {
        break;
      }

      const entry = entryOption.unwrap();
      const approvingCouncilHash = toHexValue(entry.approvingCouncilHash);
      const approvingCouncil = await loadCouncilByHash(finalizedClient, approvingCouncilHash, councilCache);
      if (!queueEntryHasQuorum(entry, approvingCouncil)) {
        break;
      }

      if (toHexValue(entry.previousApprovalHash) !== expectedPreviousApprovalHash) {
        throw new Error(
          `Queue nonce ${queueNonce} expected previous approval hash ${expectedPreviousApprovalHash}, received ${toHexValue(entry.previousApprovalHash)}`,
        );
      }

      const relayableUpdate = await buildGatewayUpdate(
        finalizedClient,
        hashContext,
        queueNonce,
        entry,
        approvingCouncilHash,
      );
      relayableUpdates.push(relayableUpdate);
      expectedPreviousApprovalHash = toHexValue(entry.approvalHash);
    }
  }

  let readyRelayableUpdates = relayableUpdates;
  if (options.throughOwnerArgonAccountId) {
    const ownerArgonAccountIdLower = options.throughOwnerArgonAccountId.toLowerCase();
    let lastOwnedUpdateIndex = -1;

    for (let index = relayableUpdates.length - 1; index >= 0; index -= 1) {
      if (relayableUpdates[index].ownerArgonAccountId?.toLowerCase() === ownerArgonAccountIdLower) {
        lastOwnedUpdateIndex = index;
        break;
      }
    }

    readyRelayableUpdates = lastOwnedUpdateIndex >= 0 ? relayableUpdates.slice(0, lastOwnedUpdateIndex + 1) : [];
  }

  const updates = readyRelayableUpdates.map(({ update }) => update);
  for (let index = 0; index < updates.length; index += 1) {
    const isBorder =
      updates[index].kind === EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.globalIssuanceCouncilRotate ||
      index === updates.length - 1;
    if (isBorder || updates[index].signatures.length === 0) continue;
    updates[index] = {
      ...updates[index],
      signatures: [],
    };
  }

  const expectedRepaymentMicrogons = calculateExpectedGatewayRelayRepaymentMicrogons({
    relayableUpdates: readyRelayableUpdates,
    relayerArgonAccountId,
    singleSignatureRepaymentQuoteMicrogons,
  });

  return {
    currentCouncil,
    estimatedMicrogonsPerEth,
    paused,
    updates,
    expectedRepaymentMicrogons,
  };
}

// ESLint loses the helper call types through the EvmContracts namespace here.
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
async function buildGatewayUpdate(
  finalizedClient: IArgonQueryable,
  hashContext: { chainId: bigint; gatewayAddress: Address },
  queueNonce: bigint,
  entry: PalletCrosschainTransferCouncilApprovalQueueEntry,
  approvingCouncilHash: Hex,
): Promise<RelayableGatewayUpdate> {
  if (entry.target.isMintingAuthorityDeactivation) {
    const signingKey = getAddress(toHexValue(entry.target.asMintingAuthorityDeactivation));
    const authorityOption = await finalizedClient.query.crosschainTransfer.mintingAuthoritiesBySigner(signingKey);
    if (authorityOption.isNone) {
      throw new Error(`Minting authority deactivation ${signingKey} not found for queue nonce ${queueNonce}`);
    }

    const authority = authorityOption.unwrap();
    if (authority.destinationChain.type !== 'Ethereum') {
      throw new Error(
        `Minting authority ${signingKey} belongs to ${String(authority.destinationChain.type)}, expected Ethereum`,
      );
    }

    const target = { signingKey };
    const payload = EvmContracts.encodeMintingGatewayMintingAuthorityDeactivateTarget(target);
    const targetPayloadHash = keccak256(payload);
    const approvalHash = EvmContracts.hashMintingGatewayGatewayUpdateApproval(hashContext, {
      queueNonce,
      approvingCouncilHash,
      kind: EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.mintingAuthorityDeactivate,
      targetId: signingKeyTargetId(signingKey),
      targetPayloadHash,
      previousUpdateHash: toHexValue(entry.previousApprovalHash),
    });

    if (toHexValue(entry.targetPayloadHash) !== targetPayloadHash) {
      throw new Error(`Queue nonce ${queueNonce} target payload hash does not match deactivation`);
    }
    if (toHexValue(entry.approvalHash) !== approvalHash) {
      throw new Error(
        `Queue nonce ${queueNonce} approval hash does not match deactivation: actual=${toHexValue(entry.approvalHash)} expected=${approvalHash} previous=${toHexValue(entry.previousApprovalHash)} council=${approvingCouncilHash}`,
      );
    }

    return {
      ownerArgonAccountId: toHexValue(authority.accountId),
      update: {
        queueNonce,
        kind: EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.mintingAuthorityDeactivate,
        payload,
        signatures: getSortedSignatures(entry.signatures),
      },
    };
  }

  if (!entry.target.isMintingAuthorityActivation) {
    throw new Error(`Unsupported approval queue target ${entry.target.type}`);
  }

  const signingKey = getAddress(toHexValue(entry.target.asMintingAuthorityActivation));
  const authorityOption = await finalizedClient.query.crosschainTransfer.mintingAuthoritiesBySigner(signingKey);
  if (authorityOption.isNone) {
    throw new Error(`Minting authority activation ${signingKey} not found for queue nonce ${queueNonce}`);
  }

  const authority = authorityOption.unwrap();
  if (authority.destinationChain.type !== 'Ethereum') {
    throw new Error(
      `Minting authority ${signingKey} belongs to ${String(authority.destinationChain.type)}, expected Ethereum`,
    );
  }

  const target = {
    microgonCollateral: authority.gatewayRemainingMicrogonCollateral.toBigInt(),
    micronotCollateral: authority.gatewayRemainingMicronotCollateral.toBigInt(),
    signingKey,
  };
  const payload = EvmContracts.encodeMintingGatewayMintingAuthorityActivationTarget(target);
  const targetPayloadHash = payloadHashFromActivationPayload(hashContext, target);
  const approvalHash = EvmContracts.hashMintingGatewayGatewayUpdateApproval(hashContext, {
    queueNonce,
    approvingCouncilHash,
    kind: EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.mintingAuthorityActivate,
    targetId: signingKeyTargetId(signingKey),
    targetPayloadHash,
    previousUpdateHash: toHexValue(entry.previousApprovalHash),
  });

  if (toHexValue(entry.targetPayloadHash) !== targetPayloadHash) {
    throw new Error(`Queue nonce ${queueNonce} target payload hash does not match authority`);
  }
  if (toHexValue(entry.approvalHash) !== approvalHash) {
    throw new Error(
      `Queue nonce ${queueNonce} approval hash does not match authority: actual=${toHexValue(entry.approvalHash)} expected=${approvalHash} previous=${toHexValue(entry.previousApprovalHash)} council=${approvingCouncilHash} targetPayload=${toHexValue(entry.targetPayloadHash)}`,
    );
  }

  const baseRepaymentQuoteMicrogons = authority.activationBaseRepaymentQuote.toBigInt();
  const heldRepaymentMicrogons = baseRepaymentQuoteMicrogons + authority.activationSignatureRepaymentQuote.toBigInt();

  return {
    ownerArgonAccountId: toHexValue(authority.accountId),
    activationSettlement: {
      heldRepaymentMicrogons,
      baseRepaymentQuoteMicrogons,
    },
    update: {
      queueNonce,
      kind: EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.mintingAuthorityActivate,
      payload,
      signatures: getSortedSignatures(entry.signatures),
    },
  };
}

async function loadCouncilByHash(
  client: IArgonQueryable,
  councilHash: Hex,
  cache: Map<Hex, LoadedCouncil>,
): Promise<LoadedCouncil> {
  const cached = cache.get(councilHash);
  if (cached) {
    return cached;
  }

  const councilOption = await client.query.crosschainTransfer.globalIssuanceCouncilByHash(councilHash);
  if (councilOption.isNone) {
    throw new Error(`GlobalIssuanceCouncil ${councilHash} not found.`);
  }

  const council = councilOption.unwrap();
  const loaded = {
    totalWeight: council.totalWeight.toBigInt(),
    members: [...council.members.entries()]
      .map(([signer, member]) => ({
        signer: getAddress(toHexValue(signer)),
        weight: member.weight.toBigInt(),
      }))
      .sort((left, right) => left.signer.localeCompare(right.signer)),
  };

  cache.set(councilHash, loaded);
  return loaded;
}

function queueEntryHasQuorum(
  entry: PalletCrosschainTransferCouncilApprovalQueueEntry,
  council: LoadedCouncil,
): boolean {
  let signedWeight = 0n;

  for (const [signer] of entry.signatures.entries()) {
    const signerAddress = getAddress(toHexValue(signer));
    const member = council.members.find(x => x.signer === signerAddress);
    if (!member) {
      throw new Error(`Signature submitted by ${signerAddress}, which is not in the council`);
    }

    signedWeight += member.weight;
  }

  if (signedWeight * 100n >= council.totalWeight * 90n) {
    return true;
  }

  const unsignedMemberCount = council.members.length - entry.signatures.size;
  return unsignedMemberCount <= 2 && signedWeight * 100n >= council.totalWeight * 80n;
}

function councilToSnapshot(council: LoadedCouncil): IEthereumGatewayCouncilSnapshot {
  return {
    signers: council.members.map(member => member.signer),
    weights: council.members.map(member => member.weight),
  };
}

function payloadHashFromActivationPayload(
  hashContext: { chainId: bigint; gatewayAddress: Address },
  target: { microgonCollateral: bigint; micronotCollateral: bigint; signingKey: Address },
): Hex {
  return EvmContracts.hashMintingGatewayActivateMintingAuthority(hashContext, target);
}
/* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */

function calculateExpectedGatewayRelayRepaymentMicrogons(args: {
  relayableUpdates: RelayableGatewayUpdate[];
  relayerArgonAccountId: Hex;
  singleSignatureRepaymentQuoteMicrogons: bigint;
}) {
  const { relayableUpdates, relayerArgonAccountId, singleSignatureRepaymentQuoteMicrogons } = args;
  let totalRepaymentMicrogons = 0n;
  const pendingActivations: RelayableGatewayUpdate[] = [];
  let carriedSignatureCount = 0;
  const lastUpdateIndex = relayableUpdates.length - 1;

  for (let index = 0; index < relayableUpdates.length; index += 1) {
    const relayableUpdate = relayableUpdates[index];
    const { activationSettlement, update } = relayableUpdate;
    if (activationSettlement) {
      pendingActivations.push(relayableUpdate);
    }

    const isBorder =
      update.kind === EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.globalIssuanceCouncilRotate ||
      index === lastUpdateIndex;
    if (!isBorder) {
      continue;
    }

    carriedSignatureCount += update.signatures.length;
    if (!pendingActivations.length) {
      continue;
    }

    for (const pendingActivation of pendingActivations) {
      totalRepaymentMicrogons += calculateExpectedActivationRelayRepaymentMicrogons({
        relayableUpdate: pendingActivation,
        relayerArgonAccountId,
        coactivationCount: pendingActivations.length,
        sharedSignatureCount: carriedSignatureCount,
        singleSignatureRepaymentQuoteMicrogons,
      });
    }

    pendingActivations.length = 0;
    carriedSignatureCount = 0;
  }

  return totalRepaymentMicrogons;
}

function calculateExpectedActivationRelayRepaymentMicrogons(args: {
  relayableUpdate: RelayableGatewayUpdate;
  relayerArgonAccountId: Hex;
  coactivationCount: number;
  sharedSignatureCount: number;
  singleSignatureRepaymentQuoteMicrogons: bigint;
}) {
  const {
    relayableUpdate,
    relayerArgonAccountId,
    coactivationCount,
    sharedSignatureCount,
    singleSignatureRepaymentQuoteMicrogons,
  } = args;
  const { ownerArgonAccountId, activationSettlement } = relayableUpdate;

  if (!activationSettlement) {
    return 0n;
  }

  if (ownerArgonAccountId?.toLowerCase() === relayerArgonAccountId.toLowerCase()) {
    return activationSettlement.heldRepaymentMicrogons;
  }
  if (coactivationCount < 1 || sharedSignatureCount < 1 || singleSignatureRepaymentQuoteMicrogons <= 0n) {
    return 0n;
  }

  const requestedSharedSignatureRepaymentMicrogons = divideCeil(
    singleSignatureRepaymentQuoteMicrogons * BigInt(sharedSignatureCount),
    BigInt(coactivationCount),
  );
  const requestedRepaymentMicrogons =
    activationSettlement.baseRepaymentQuoteMicrogons + requestedSharedSignatureRepaymentMicrogons;

  if (requestedRepaymentMicrogons > activationSettlement.heldRepaymentMicrogons) {
    return activationSettlement.heldRepaymentMicrogons;
  }

  return requestedRepaymentMicrogons;
}

function signingKeyTargetId(signingKey: Address): Hex {
  return `0x${signingKey.slice(2).padStart(64, '0').toLowerCase()}`;
}

function getSortedSignatures(signatures: PalletCrosschainTransferCouncilApprovalQueueEntry['signatures']): Hex[] {
  return [...signatures.entries()]
    .sort(([leftSigner], [rightSigner]) => toHexValue(leftSigner).localeCompare(toHexValue(rightSigner)))
    .map(([, signature]) => toEvmRecoverableSignature(toHexValue(signature)));
}

function toHexValue(value: { toHex(): string }): Hex {
  return value.toHex() as Hex;
}

function toArgonAccountIdHex(address: string): Hex {
  return toHex(decodeAddress(address), { size: 32 });
}

export function toEvmRecoverableSignature(signature: Hex): Hex {
  const bytes = hexToU8a(signature);
  if (bytes.length !== 65) {
    throw new Error(`Expected 65-byte ECDSA signature, received ${bytes.length} bytes.`);
  }
  if (bytes[64] <= 1) {
    bytes[64] += 27;
  }
  return u8aToHex(bytes);
}

function convertWeiToMicrogons(wei: bigint, estimatedMicrogonsPerEth: bigint) {
  return (wei * estimatedMicrogonsPerEth) / 10n ** 18n;
}

function divideCeil(dividend: bigint, divisor: bigint) {
  return (dividend + divisor - 1n) / divisor;
}

async function buildEthereumUnsignedTransaction(args: {
  publicClient: PublicClient;
  from: Address;
  chainId: number;
  to: Address;
  data: Hex;
}): Promise<{ transaction: TransactionSerializableEIP1559; unsignedTransaction: Hex; feeEstimateWei: bigint }> {
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
  const gas = (gasEstimate * 12n) / 10n;
  const maxFeePerGas = fees.maxFeePerGas ?? fallbackGasPrice;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? fallbackGasPrice;

  const transaction: TransactionSerializableEIP1559 = {
    chainId,
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    to,
    value: 0n,
    data,
    type: 'eip1559',
    accessList: [],
  };

  return {
    transaction,
    unsignedTransaction: serializeTransaction(transaction),
    feeEstimateWei: gas * maxFeePerGas,
  };
}

async function estimateEthereumFeeWeiForGas(publicClient: PublicClient, gas: bigint) {
  const fees = await publicClient.estimateFeesPerGas();
  const fallbackGasPrice = fees.gasPrice ?? (await publicClient.getGasPrice());
  return gas * (fees.maxFeePerGas ?? fallbackGasPrice);
}

function estimateFinalizeTransferOutOfArgonGas(data: Hex, authorizationCount: number) {
  const calldataGas = hexToBytes(data).reduce((total, nextByte) => total + (nextByte === 0 ? 4n : 16n), 0n);
  return 21_000n + calldataGas + 145_000n + BigInt(authorizationCount) * 45_000n;
}

export function getEthereumFinalityMillis(): number {
  const raw = SERVER_ENV_VARS.ETHEREUM_FINALITY_MILLIS?.trim();
  const value = Number.parseInt(raw ?? '', 10);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }

  const finalityBlocks = NetworkConfig.get().ethereumNetwork.finalityBlocks;
  if (Number.isFinite(finalityBlocks) && finalityBlocks > 0) {
    return finalityBlocks * 12_000;
  }

  throw new Error('Ethereum finality timing is missing from both the server environment and network config.');
}

export function getTransferToArgonWaitEstimateMs() {
  return getEthereumFinalityMillis() + getArgonFinalityMillis();
}

export function getGatewayActivityWaitEstimateMs() {
  return getTransferToArgonWaitEstimateMs();
}

export function getEthereumUserErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  const shortMessage = getObjectStringProperty(error, 'shortMessage')?.trim();
  if (shortMessage) {
    return shortMessage;
  }

  const firstParagraph = error.message
    .split('\n\n')[0]
    ?.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ');
  if (firstParagraph) {
    return firstParagraph;
  }

  return fallback;
}

export async function submitEthereumTransaction(args: {
  publicClient: IEthereumSubmissionClient;
  serializedTransaction: Hex;
  fallbackErrorMessage: string;
}): Promise<Hash> {
  const { publicClient, serializedTransaction, fallbackErrorMessage } = args;
  const derivedHash = keccak256(serializedTransaction);

  try {
    return await publicClient.sendRawTransaction({ serializedTransaction });
  } catch (error) {
    if (await isSubmittedEthereumTransactionVisible(publicClient, derivedHash)) {
      return derivedHash;
    }

    throw new Error(getEthereumUserErrorMessage(error, fallbackErrorMessage));
  }
}

async function waitForIndexedReceipt(publicClient: PublicClient, hash: Hash): Promise<EthereumExecutionReceipt> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: 500,
        timeout: 5_000,
      });
      if (receipt.blockNumber !== null) {
        return receipt;
      }
    } catch (error) {
      if (!(error instanceof WaitForTransactionReceiptTimeoutError) && !isIndexingInProgressError(error)) {
        throw error;
      }
    }

    const indexedReceipt = await getIndexedReceiptIfAvailable(publicClient, hash);
    if (indexedReceipt) {
      return indexedReceipt;
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for Ethereum receipt ${hash} to include a block number.`);
}

async function getIndexedReceiptIfAvailable(
  publicClient: PublicClient,
  hash: Hash,
): Promise<EthereumExecutionReceipt | undefined> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.blockNumber !== null ? receipt : undefined;
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError || isIndexingInProgressError(error)) {
      return;
    }

    throw error;
  }
}

async function isSubmittedEthereumTransactionVisible(
  publicClient: Pick<IEthereumSubmissionClient, 'getTransaction' | 'getTransactionReceipt'>,
  hash: Hash,
): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await isEthereumTransactionVisibleAtRpc(publicClient, hash)) {
      return true;
    }
    await sleep(500);
  }

  return false;
}

async function isEthereumTransactionVisibleAtRpc(
  publicClient: Pick<IEthereumSubmissionClient, 'getTransaction' | 'getTransactionReceipt'>,
  hash: Hash,
): Promise<boolean> {
  try {
    await publicClient.getTransaction({ hash });
    return true;
  } catch (error) {
    if (!(error instanceof TransactionNotFoundError)) {
      return false;
    }
  }

  try {
    return !!(await publicClient.getTransactionReceipt({ hash }));
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError || isIndexingInProgressError(error)) {
      return false;
    }
  }

  return false;
}

function isIndexingInProgressError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return [error.message, getObjectStringProperty(error, 'details')]
    .filter(Boolean)
    .join(' ')
    .includes('indexing is in progress');
}
