#!/usr/bin/env tsx

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, getAddress, http, isAddress, parseEther, type Address } from 'viem';
import { resolveDevEthereumRpcUrl, sendDevEthereumAdminTransaction } from '../devEthereum.ts';

type FundDevEthereumAccountArgs = {
  to: string;
  rpcUrl?: string;
  amountWei: bigint;
};

type FundDevEthereumAccountResult = {
  rpcUrl: string;
  chainId: number;
  sender: Address;
  recipient: Address;
  amountWei: bigint;
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

  const result = await fundDevEthereumAccount({
    to: parseAddressArg(values.to, 'Missing required --to address'),
    rpcUrl: values.rpc,
    amountWei: parseAmountArg(values.amount, values.wei),
  });

  console.info(`[fund-dev-ethereum-account] RPC: ${result.rpcUrl}`);
  console.info(`[fund-dev-ethereum-account] Chain ID: ${result.chainId}`);
  console.info(`[fund-dev-ethereum-account] Admin Sender: ${result.sender}`);
  console.info(`[fund-dev-ethereum-account] Recipient: ${result.recipient}`);
  console.info(`[fund-dev-ethereum-account] Amount (ETH): ${formatEthAmount(result.amountWei)}`);
  console.info(`[fund-dev-ethereum-account] Amount (wei): ${result.amountWei}`);
  console.info(`[fund-dev-ethereum-account] Ethereum Transfer Tx: ${result.transactionHash}`);
}

export async function fundDevEthereumAccount(args: FundDevEthereumAccountArgs): Promise<FundDevEthereumAccountResult> {
  const recipient = parseAddressArg(args.to, 'Missing required recipient address');
  const rpcUrl = await resolveDevEthereumRpcUrl({
    rpcUrl: args.rpcUrl,
    logPrefix: 'fund-dev-ethereum-account',
  });
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const chainId = await publicClient.getChainId();
  const { hash, sender } = await sendDevEthereumAdminTransaction({
    rpcUrl,
    to: recipient,
    value: args.amountWei,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Ethereum funding transaction failed: ${hash}`);
  }

  return {
    rpcUrl,
    chainId,
    sender,
    recipient,
    amountWei: args.amountWei,
    transactionHash: hash,
  };
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

function parseAmountArg(amount: string | undefined, wei: string | undefined): bigint {
  if (!amount && !wei) {
    throw new Error('Provide either --amount <decimal ETH> or --wei <integer>');
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

  return parseEther(amount!);
}

function formatEthAmount(amountWei: bigint): string {
  const whole = amountWei / 10n ** 18n;
  const fractional = amountWei % 10n ** 18n;
  if (fractional === 0n) {
    return whole.toString();
  }

  return `${whole}.${fractional.toString().padStart(18, '0').replace(/0+$/, '')}`;
}

function printUsage(): void {
  console.info(`Usage:
  yarn dev:eth:fund --to 0xRecipient --amount 1
  yarn dev:eth:fund --to 0xRecipient --amount 0.1
  yarn dev:eth:fund --to 0xRecipient --wei 100000000000000000

Notes:
  - Sends raw ETH from the built-in local dev admin account.
  - Uses ETH_RPC or ETHEREUM_EXECUTION_RPC_URL if set, otherwise probes local Kurtosis execution RPC ports.
  - Waits for the funding transaction receipt before returning.
`);
}
