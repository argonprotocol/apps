#!/usr/bin/env tsx

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NetworkConfig } from '@argonprotocol/apps-core';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseEther,
  parseUnits,
  type Address,
} from 'viem';
import {
  readDevEthereumRuntimeState,
  resolveDevEthereumRpcUrl,
  sendDevEthereumAdminTransaction,
} from '../devEthereum.ts';

type SupportedToken = 'ETH' | 'USDC';

type FundDevEthereumAccountArgs = {
  to: string;
  rpcUrl?: string;
  token?: SupportedToken;
  amountBaseUnits: bigint;
  tokenAddress?: string;
};

type FundDevEthereumAccountResult = {
  token: SupportedToken;
  rpcUrl: string;
  chainId: number;
  sender: Address;
  recipient: Address;
  amountBaseUnits: bigint;
  tokenAddress?: Address;
  transactionHash: `0x${string}`;
};

const currentFilePath = fileURLToPath(import.meta.url);
const isDirectExecution = !!process.argv[1] && path.resolve(process.argv[1]) === currentFilePath;

if (isDirectExecution) {
  void main().catch(error => {
    console.error(`[fund-dev-ethereum-account] ${(error as Error).message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      to: { type: 'string' },
      rpc: { type: 'string' },
      token: { type: 'string' },
      'token-address': { type: 'string' },
      amount: { type: 'string' },
      wei: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const token = values.token ? parseTokenArg(values.token) : 'ETH';
  const result = await fundDevEthereumAccount({
    to: parseAddressArg(values.to, 'Missing required --to address'),
    rpcUrl: values.rpc,
    token,
    tokenAddress: values['token-address'],
    amountBaseUnits: parseAmountArg(token, values.amount, values.wei),
  });

  console.info(`[fund-dev-ethereum-account] RPC: ${result.rpcUrl}`);
  console.info(`[fund-dev-ethereum-account] Chain ID: ${result.chainId}`);
  console.info(`[fund-dev-ethereum-account] Admin Sender: ${result.sender}`);
  console.info(`[fund-dev-ethereum-account] Recipient: ${result.recipient}`);
  console.info(`[fund-dev-ethereum-account] Token: ${result.token}`);
  if (result.tokenAddress) {
    console.info(`[fund-dev-ethereum-account] Token Address: ${result.tokenAddress}`);
  }
  console.info(
    `[fund-dev-ethereum-account] Amount (${result.token}): ${formatTokenAmount(result.token, result.amountBaseUnits)}`,
  );
  console.info(`[fund-dev-ethereum-account] Amount (base units): ${result.amountBaseUnits}`);
  console.info(`[fund-dev-ethereum-account] Transfer Tx: ${result.transactionHash}`);
}

export async function fundDevEthereumAccount(args: FundDevEthereumAccountArgs): Promise<FundDevEthereumAccountResult> {
  const recipient = parseAddressArg(args.to, 'Missing required recipient address');
  const token = args.token ?? 'ETH';
  const rpcUrl = await resolveDevEthereumRpcUrl({
    rpcUrl: args.rpcUrl,
    logPrefix: 'fund-dev-ethereum-account',
  });
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const chainId = await publicClient.getChainId();
  const tokenAddress = token === 'USDC' ? await resolveUsdcTokenAddress(args.tokenAddress) : undefined;
  if (tokenAddress) {
    const code = await publicClient.getCode({ address: tokenAddress });
    if (!code || code === '0x') {
      throw new Error(
        `No USDC contract code found at ${tokenAddress}. Restart the dev Ethereum fixture or pass --token-address.`,
      );
    }
  }
  const { hash, sender } =
    token === 'ETH'
      ? await sendDevEthereumAdminTransaction({
          rpcUrl,
          to: recipient,
          value: args.amountBaseUnits,
        })
      : await sendDevEthereumAdminTransaction({
          rpcUrl,
          to: tokenAddress!,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [recipient, args.amountBaseUnits],
          }),
        });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${token} funding transaction failed: ${hash}`);
  }

  return {
    token,
    rpcUrl,
    chainId,
    sender,
    recipient,
    amountBaseUnits: args.amountBaseUnits,
    tokenAddress,
    transactionHash: hash,
  };
}

function parseTokenArg(value: string | undefined): SupportedToken {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'ETH' || normalized === 'USDC') {
    return normalized;
  }

  throw new Error('Provide --token ETH or --token USDC');
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

function parseAmountArg(token: SupportedToken, amount: string | undefined, wei: string | undefined): bigint {
  if (token === 'USDC' && wei) {
    throw new Error('Use --amount <decimal USDC> when funding USDC.');
  }
  if (!amount && !wei) {
    throw new Error(
      token === 'ETH' ? 'Provide either --amount <decimal ETH> or --wei <integer>' : 'Provide --amount <decimal USDC>',
    );
  }
  if (amount && wei) {
    throw new Error('Provide only one of --amount or --wei');
  }
  if (wei) {
    if (!/^\d+$/.test(wei)) {
      throw new Error(`--wei must be an integer string: ${wei}`);
    }
    return BigInt(wei);
  }

  return token === 'ETH' ? parseEther(amount!) : parseUnits(amount!, 6);
}

function formatTokenAmount(token: SupportedToken, amountBaseUnits: bigint): string {
  return formatUnits(amountBaseUnits, token === 'ETH' ? 18 : 6);
}

async function resolveUsdcTokenAddress(tokenAddress: string | undefined): Promise<Address> {
  if (tokenAddress) {
    return parseAddressArg(tokenAddress, 'Missing --token-address');
  }

  const envAddress = process.env.DEV_ETHEREUM_USDC_ADDRESS?.trim();
  if (envAddress) {
    return parseAddressArg(envAddress, 'Invalid DEV_ETHEREUM_USDC_ADDRESS');
  }

  const runtimeState = await readDevEthereumRuntimeState();
  if (runtimeState?.usdcTokenAddress) {
    return getAddress(runtimeState.usdcTokenAddress);
  }

  const networkName = process.env.ARGON_NETWORK_NAME ?? process.env.ARGON_CHAIN;
  if (networkName) {
    NetworkConfig.setNetwork(networkName as any);
    return getAddress(NetworkConfig.get().ethereumNetwork.usdcTokenAddress);
  }

  throw new Error(
    'Unable to resolve dev USDC token address. Start the dev Ethereum fixture first, pass --token-address, or set DEV_ETHEREUM_USDC_ADDRESS.',
  );
}

function printUsage(): void {
  console.info(`Usage:
  yarn dev:ethereum:add-eth --to 0xRecipient --amount 1
  yarn dev:ethereum:add-eth --to 0xRecipient --amount 0.1
  yarn dev:ethereum:add-eth --to 0xRecipient --wei 100000000000000000
  yarn dev:ethereum:add-usdc --to 0xRecipient --amount 100

Notes:
  - Sends raw ETH from the built-in local dev admin account.
  - Sends USDC from the local dev mock USDC contract when --token USDC is provided.
  - USDC uses 6-decimal base units.
  - Reads the mock USDC address from e2e/artifacts/dev-ethereum.json, DEV_ETHEREUM_USDC_ADDRESS, or --token-address.
  - Uses ETH_RPC or ETHEREUM_EXECUTION_RPC_URL if set, otherwise probes local Kurtosis execution RPC ports.
  - Waits for the funding transaction receipt before returning.
`);
}
