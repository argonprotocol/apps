#!/usr/bin/env tsx

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EvmContracts, getClient } from '@argonprotocol/mainchain';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem';
import {
  DEV_ETHEREUM_ADMIN_ACCOUNT,
  resolveDevEthereumRpcUrl,
  sendDevEthereumAdminTransaction,
} from '../devEthereum.ts';

const defaultArchiveUrl = 'ws://127.0.0.1:9944';

type SupportedToken = 'ARGN' | 'ARGNOT';

type FundDevEthereumTokensArgs = {
  to: string;
  rpcUrl?: string;
  archiveUrl?: string;
  argnRuntimeAmount?: bigint;
  argnotRuntimeAmount?: bigint;
};

type FundDevEthereumTokensResult = {
  rpcUrl: string;
  archiveUrl: string;
  chainId: number;
  gatewayAddress: Address;
  argonTokenAddress: Address;
  argonotTokenAddress: Address;
  recipient: Address;
  argnAmountBaseUnits: bigint;
  argnotAmountBaseUnits: bigint;
  argnRuntimeAmount: bigint;
  argnotRuntimeAmount: bigint;
  argonTransferHash?: Hash;
  argonotTransferHash?: Hash;
};

type EthereumChainConfig = {
  gatewayAddress: Address;
  argonTokenAddress: Address;
  argonotTokenAddress: Address;
};

const currentFilePath = fileURLToPath(import.meta.url);
const isDirectExecution = !!process.argv[1] && path.resolve(process.argv[1]) === currentFilePath;

if (isDirectExecution) {
  void main().catch(error => {
    console.error(`[fund-dev-ethereum-token] ${(error as Error).message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      token: { type: 'string' },
      to: { type: 'string' },
      rpc: { type: 'string' },
      archive: { type: 'string' },
      amount: { type: 'string' },
      argons: { type: 'string' },
      argonots: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const token = values.token ? parseTokenArg(values.token) : undefined;
  const genericRuntimeAmount = parseRuntimeAmountArg(values.amount);
  if (token && (values.argons || values.argonots)) {
    throw new Error('Use either --token with --amount, or the explicit --argons / --argonots flags. Do not mix both.');
  }
  if (!token && values.amount) {
    throw new Error('Provide --token when using --amount.');
  }

  const result = await fundDevEthereumTokens({
    to: parseAddressArg(values.to, 'Missing required --to address'),
    rpcUrl: values.rpc,
    archiveUrl: values.archive,
    argnRuntimeAmount: token === 'ARGN' ? genericRuntimeAmount : parseRuntimeAmountArg(values.argons),
    argnotRuntimeAmount: token === 'ARGNOT' ? genericRuntimeAmount : parseRuntimeAmountArg(values.argonots),
  });

  console.info(`[fund-dev-ethereum-token] RPC: ${result.rpcUrl}`);
  console.info(`[fund-dev-ethereum-token] Archive: ${result.archiveUrl}`);
  console.info(`[fund-dev-ethereum-token] Chain ID: ${result.chainId}`);
  console.info(`[fund-dev-ethereum-token] Gateway Address: ${result.gatewayAddress}`);
  console.info(`[fund-dev-ethereum-token] ARGN Token Address: ${result.argonTokenAddress}`);
  console.info(`[fund-dev-ethereum-token] ARGNOT Token Address: ${result.argonotTokenAddress}`);
  console.info(`[fund-dev-ethereum-token] Recipient: ${result.recipient}`);
  console.info(`[fund-dev-ethereum-token] ARGN Amount (Argon runtime units): ${result.argnRuntimeAmount}`);
  console.info(`[fund-dev-ethereum-token] ARGN Amount (ERC20 base units): ${result.argnAmountBaseUnits}`);
  console.info(`[fund-dev-ethereum-token] ARGNOT Amount (Argon runtime units): ${result.argnotRuntimeAmount}`);
  console.info(`[fund-dev-ethereum-token] ARGNOT Amount (ERC20 base units): ${result.argnotAmountBaseUnits}`);

  if (result.argonTransferHash) {
    console.info(`[fund-dev-ethereum-token] ARGN Transfer Tx: ${result.argonTransferHash}`);
  }
  if (result.argonotTransferHash) {
    console.info(`[fund-dev-ethereum-token] ARGNOT Transfer Tx: ${result.argonotTransferHash}`);
  }
}

export async function fundDevEthereumTokens(args: FundDevEthereumTokensArgs): Promise<FundDevEthereumTokensResult> {
  const recipient = parseAddressArg(args.to, 'Missing required recipient address');
  const argnRuntimeAmount = resolveRuntimeAmount(args.argnRuntimeAmount, 'ARGN');
  const argnotRuntimeAmount = resolveRuntimeAmount(args.argnotRuntimeAmount, 'ARGNOT');
  if (argnRuntimeAmount === 0n && argnotRuntimeAmount === 0n) {
    throw new Error('Provide an ARGN or ARGNOT amount to fund on dev Ethereum.');
  }

  const argnAmountBaseUnits = convertRuntimeAmountToErc20Amount(argnRuntimeAmount);
  const argnotAmountBaseUnits = convertRuntimeAmountToErc20Amount(argnotRuntimeAmount);
  const rpcUrl = await resolveDevEthereumRpcUrl({
    rpcUrl: args.rpcUrl,
    logPrefix: 'fund-dev-ethereum-token',
  });
  const archiveUrl = args.archiveUrl?.trim() || process.env.ARGON_ARCHIVE_URL?.trim() || defaultArchiveUrl;
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 15_000 }),
  });

  const [chainId, chainConfig] = await Promise.all([publicClient.getChainId(), loadEthereumChainConfig(archiveUrl)]);
  const rootAccount = getAddress(DEV_ETHEREUM_ADMIN_ACCOUNT.address);
  const [argonReserve, argonotReserve] = await Promise.all([
    publicClient.readContract({
      address: chainConfig.argonTokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [rootAccount],
    }),
    publicClient.readContract({
      address: chainConfig.argonotTokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [rootAccount],
    }),
  ]);

  if (argonReserve < argnAmountBaseUnits) {
    throw new Error(
      `Dev Ethereum root ARGN reserve is insufficient: requested ${argnAmountBaseUnits}, available ${argonReserve}.`,
    );
  }
  if (argonotReserve < argnotAmountBaseUnits) {
    throw new Error(
      `Dev Ethereum root ARGNOT reserve is insufficient: requested ${argnotAmountBaseUnits}, available ${argonotReserve}.`,
    );
  }

  const argonTransferHash = await transferReserveToken({
    publicClient,
    rpcUrl,
    tokenAddress: chainConfig.argonTokenAddress,
    recipient,
    amount: argnAmountBaseUnits,
    label: 'ARGN',
  });
  const argonotTransferHash = await transferReserveToken({
    publicClient,
    rpcUrl,
    tokenAddress: chainConfig.argonotTokenAddress,
    recipient,
    amount: argnotAmountBaseUnits,
    label: 'ARGNOT',
  });

  return {
    rpcUrl,
    archiveUrl,
    chainId,
    gatewayAddress: chainConfig.gatewayAddress,
    argonTokenAddress: chainConfig.argonTokenAddress,
    argonotTokenAddress: chainConfig.argonotTokenAddress,
    recipient,
    argnAmountBaseUnits,
    argnotAmountBaseUnits,
    argnRuntimeAmount,
    argnotRuntimeAmount,
    argonTransferHash,
    argonotTransferHash,
  };
}

async function transferReserveToken(args: {
  publicClient: Pick<PublicClient, 'waitForTransactionReceipt'>;
  rpcUrl: string;
  tokenAddress: Address;
  recipient: Address;
  amount: bigint;
  label: SupportedToken;
}): Promise<Hash | undefined> {
  if (args.amount === 0n) {
    return;
  }

  const { hash } = await sendDevEthereumAdminTransaction({
    rpcUrl: args.rpcUrl,
    to: args.tokenAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [args.recipient, args.amount],
    }),
  });
  const receipt = await args.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Dev Ethereum ${args.label} reserve transfer failed: ${hash}`);
  }
  return hash;
}

function parseTokenArg(value: string | undefined): SupportedToken {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'ARGN' || normalized === 'ARGNOT') {
    return normalized;
  }

  throw new Error('Provide --token ARGN or --token ARGNOT');
}

function parseAddressArg(value: string | undefined, missingMessage: string): Address {
  if (!value) {
    throw new Error(missingMessage);
  }
  if (!isAddress(value)) {
    throw new Error(`Invalid Ethereum address: ${value}`);
  }
  return getAddress(value);
}

function parseRuntimeAmountArg(amount: string | undefined): bigint | undefined {
  if (!amount) {
    return;
  }

  return parseUnits(amount, 6);
}

function resolveRuntimeAmount(runtimeAmount: bigint | undefined, label: string): bigint {
  if (runtimeAmount !== undefined) {
    if (runtimeAmount < 0n) {
      throw new Error(`${label} runtime amount must be non-negative: ${runtimeAmount}`);
    }
    return runtimeAmount;
  }

  return 0n;
}

function convertRuntimeAmountToErc20Amount(runtimeAmount: bigint): bigint {
  return runtimeAmount * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
}

async function loadEthereumChainConfig(archiveUrl: string): Promise<EthereumChainConfig> {
  const client = await getClient(archiveUrl);

  try {
    const config = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
    if (config.isNone || !config.unwrap().isEvm) {
      throw new Error('Ethereum chain config is not available on this Argon network.');
    }

    const ethereumConfig = config.unwrap().asEvm;
    return {
      gatewayAddress: getAddress(ethereumConfig.gateway.toHex()),
      argonTokenAddress: getAddress(ethereumConfig.argonToken.toHex()),
      argonotTokenAddress: getAddress(ethereumConfig.argonotToken.toHex()),
    };
  } finally {
    await client.disconnect();
  }
}

function printUsage(): void {
  console.info(`Usage:
  yarn dev:ethereum:add-argn --to 0xRecipient --amount 100
  yarn dev:ethereum:add-argnot --to 0xRecipient --amount 25.5

Direct:
  yarn exec tsx e2e/scripts/fundDevEthereumTokens.ts --to 0xRecipient --argons 100 --argonots 25.5

Notes:
  - Transfers ARGN and ARGNOT from the local dev root account's 10,000-token bootstrap reserves.
  - Does not mint tokens or change the Argon burn-account backing after bootstrap.
  - Resolves gateway, ARGN, and ARGNOT addresses from Argon runtime Ethereum chain config.
  - Uses --rpc, ETH_RPC, ETHEREUM_EXECUTION_RPC_URL, or the latest dev Ethereum runtime state.
  - Uses ARGON_ARCHIVE_URL if set, otherwise defaults to ws://127.0.0.1:9944.
  - --amount is a 6-decimal Argon runtime amount for the token selected by the package script.
  - --argons and --argonots are 6-decimal Argon runtime amounts.
  - Example: --argons 1 transfers 1_000_000 microgons.
`);
}
