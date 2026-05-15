#!/usr/bin/env tsx

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getClient } from '@argonprotocol/mainchain';
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  http,
  isAddress,
  parseAbiItem,
  parseUnits,
  type Address,
} from 'viem';
import {
  DEV_ETHEREUM_ADMIN_ACCOUNT,
  resolveDevEthereumRpcUrl,
  sendDevEthereumAdminTransaction,
} from '../devEthereum.ts';
import { sudoFundWallet } from '../../core/__test__/helpers/sudoFundWallet.ts';

const defaultArchiveUrl = 'ws://127.0.0.1:9944';
const ethereumRuntimeToErc20Scale = 10n ** 12n;

type SupportedToken = 'ARGN' | 'ARGNOT';

type CliArgs = {
  token?: string;
  to?: string;
  from?: string;
  rpc?: string;
  archive?: string;
  amount?: string;
  baseUnits?: string;
  help?: boolean;
};

type EthereumChainConfig = {
  gatewayAddress: Address;
  argonTokenAddress: Address;
  argonotTokenAddress: Address;
};

type MintDevEthereumTokenArgs = {
  token: SupportedToken;
  to: string;
  from?: string;
  rpcUrl?: string;
  archiveUrl?: string;
  runtimeAmount?: bigint;
  amountBaseUnits?: bigint;
};

type MintDevEthereumTokenResult = {
  rpcUrl: string;
  archiveUrl: string;
  chainId: number;
  token: SupportedToken;
  tokenAddress: Address;
  gatewayAddress: Address;
  adminSender: Address;
  recipient: Address;
  amountBaseUnits: bigint;
  runtimeAmount: bigint;
  ethereumMintHash: Hash;
  argonBump: Awaited<ReturnType<typeof bumpArgonBurnAccount>>;
};

const mintingGatewayAbi = [
  parseAbiItem('function adminMintBatch(address token, address[] recipients, uint256[] amounts)'),
] as const;

const currentFilePath = fileURLToPath(import.meta.url);
const isDirectExecution = !!process.argv[1] && path.resolve(process.argv[1]) === currentFilePath;

if (isDirectExecution) {
  void main().catch(error => {
    console.error(`[mint-dev-ethereum-token] ${(error as Error).message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const result = await mintDevEthereumToken({
    token: parseTokenArg(args.token),
    to: parseAddressArg(args.to, 'Missing required --to address'),
    from: args.from,
    rpcUrl: args.rpc,
    archiveUrl: args.archive,
    amountBaseUnits: parseAmountArg(args.amount, args.baseUnits),
  });

  console.info(`[mint-dev-ethereum-token] RPC: ${result.rpcUrl}`);
  console.info(`[mint-dev-ethereum-token] Archive: ${result.archiveUrl}`);
  console.info(`[mint-dev-ethereum-token] Chain ID: ${result.chainId}`);
  console.info(`[mint-dev-ethereum-token] Token: ${result.token}`);
  console.info(`[mint-dev-ethereum-token] Token Address: ${result.tokenAddress}`);
  console.info(`[mint-dev-ethereum-token] Gateway Address: ${result.gatewayAddress}`);
  console.info(`[mint-dev-ethereum-token] Admin Sender: ${result.adminSender}`);
  console.info(`[mint-dev-ethereum-token] Recipient: ${result.recipient}`);
  console.info(`[mint-dev-ethereum-token] Amount (Argon runtime units): ${result.runtimeAmount}`);
  console.info(`[mint-dev-ethereum-token] Amount (ERC20 base units): ${result.amountBaseUnits}`);
  console.info(`[mint-dev-ethereum-token] Ethereum Mint Tx: ${result.ethereumMintHash}`);
  console.info(`[mint-dev-ethereum-token] Argon Burn Account: ${result.argonBump.burnAccount}`);
  console.info(
    `[mint-dev-ethereum-token] Burn Account Balances: ${result.argonBump.microgons} microgons, ${result.argonBump.micronots} micronots`,
  );
}

export async function mintDevEthereumToken(args: MintDevEthereumTokenArgs): Promise<MintDevEthereumTokenResult> {
  const token = args.token;
  const recipient = parseAddressArg(args.to, 'Missing required recipient address');
  const amountBaseUnits = resolveAmountBaseUnits(args);
  const runtimeAmount = convertErc20AmountToRuntimeAmount(amountBaseUnits);
  const rpcUrl = await resolveRpcUrl(args.rpcUrl);
  const archiveUrl = resolveArchiveUrl(args.archiveUrl);
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 15_000 }),
  });

  const [chainId, chainConfig] = await Promise.all([publicClient.getChainId(), loadEthereumChainConfig(archiveUrl)]);
  const tokenAddress = token === 'ARGNOT' ? chainConfig.argonotTokenAddress : chainConfig.argonTokenAddress;

  // adminMintBatch accepts Argon runtime base units, not ERC20 token base units.
  const mintData = encodeFunctionData({
    abi: mintingGatewayAbi,
    functionName: 'adminMintBatch',
    args: [tokenAddress, [recipient], [runtimeAmount]],
  });

  const { adminSender, ethereumMintHash } = await sendMintTransaction({
    rpcUrl,
    gatewayAddress: chainConfig.gatewayAddress,
    mintData,
    from: args.from,
  });

  const ethereumReceipt = await publicClient.waitForTransactionReceipt({ hash: ethereumMintHash });
  if (ethereumReceipt.status !== 'success') {
    throw new Error(`Ethereum mint transaction failed: ${ethereumMintHash}`);
  }

  const argonBump = await bumpArgonBurnAccount({
    archiveUrl,
    token,
    runtimeAmount,
  });

  return {
    rpcUrl,
    archiveUrl,
    chainId,
    token,
    tokenAddress,
    gatewayAddress: chainConfig.gatewayAddress,
    adminSender,
    recipient,
    amountBaseUnits,
    runtimeAmount,
    ethereumMintHash,
    argonBump,
  };
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    const next = argv[i + 1];
    if (!next) {
      throw new Error(`Missing value for ${arg}`);
    }

    switch (arg) {
      case '--token':
        args.token = next;
        break;
      case '--to':
        args.to = next;
        break;
      case '--from':
        args.from = next;
        break;
      case '--rpc':
        args.rpc = next;
        break;
      case '--archive':
        args.archive = next;
        break;
      case '--amount':
        args.amount = next;
        break;
      case '--base-units':
        args.baseUnits = next;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }

    i += 1;
  }

  return args;
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

function parseAmountArg(amount: string | undefined, baseUnits: string | undefined): bigint {
  if (!amount && !baseUnits) {
    throw new Error('Provide either --amount <decimal> or --base-units <integer>');
  }
  if (amount && baseUnits) {
    throw new Error('Provide only one of --amount or --base-units');
  }
  if (baseUnits) {
    if (!/^\d+$/.test(baseUnits)) {
      throw new Error(`--base-units must be an integer string: ${baseUnits}`);
    }
    return BigInt(baseUnits);
  }

  return parseUnits(amount!, 18);
}

function resolveAmountBaseUnits(args: MintDevEthereumTokenArgs): bigint {
  const hasBaseUnits = args.amountBaseUnits != null;
  const hasRuntimeAmount = args.runtimeAmount != null;

  if (hasBaseUnits === hasRuntimeAmount) {
    throw new Error('Provide exactly one of amountBaseUnits or runtimeAmount');
  }

  if (hasBaseUnits) {
    return args.amountBaseUnits!;
  }

  const runtimeAmount = args.runtimeAmount!;
  if (runtimeAmount < 0n) {
    throw new Error(`Runtime amount must be non-negative: ${runtimeAmount}`);
  }

  return runtimeAmount * ethereumRuntimeToErc20Scale;
}

function convertErc20AmountToRuntimeAmount(amountBaseUnits: bigint): bigint {
  if (amountBaseUnits % ethereumRuntimeToErc20Scale !== 0n) {
    throw new Error(
      `Amount ${amountBaseUnits} is not representable on Argon. Use a value aligned to 6 runtime decimals (multiple of ${ethereumRuntimeToErc20Scale}).`,
    );
  }

  return amountBaseUnits / ethereumRuntimeToErc20Scale;
}

function resolveArchiveUrl(value: string | undefined): string {
  return value?.trim() || process.env.ARGON_ARCHIVE_URL?.trim() || defaultArchiveUrl;
}

async function loadEthereumChainConfig(archiveUrl: string): Promise<EthereumChainConfig> {
  const client = await getClient(archiveUrl);

  try {
    const config = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
    if (config.isNone || !config.unwrap().isEthereum) {
      throw new Error('Ethereum chain config is not available on this Argon network.');
    }

    const ethereumConfig = config.unwrap().asEthereum;
    return {
      gatewayAddress: getAddress(ethereumConfig.gateway.toHex()),
      argonTokenAddress: getAddress(ethereumConfig.argonToken.toHex()),
      argonotTokenAddress: getAddress(ethereumConfig.argonotToken.toHex()),
    };
  } finally {
    await client.disconnect();
  }
}

async function resolveRpcUrl(value: string | undefined): Promise<string> {
  return resolveDevEthereumRpcUrl({
    rpcUrl: value,
    logPrefix: 'mint-dev-ethereum-token',
  });
}

async function sendMintTransaction(args: {
  rpcUrl: string;
  gatewayAddress: Address;
  mintData: Hex;
  from?: string;
}): Promise<{ adminSender: Address; ethereumMintHash: Hash }> {
  const { rpcUrl, gatewayAddress, mintData, from } = args;
  const requestedFrom = from?.trim() ? parseAddressArg(from, 'Missing --from address') : undefined;

  if (!requestedFrom || requestedFrom.toLowerCase() === DEV_ETHEREUM_ADMIN_ACCOUNT.address.toLowerCase()) {
    const { hash, sender } = await sendDevEthereumAdminTransaction({
      rpcUrl,
      to: gatewayAddress,
      data: mintData,
    });

    return {
      adminSender: sender,
      ethereumMintHash: hash,
    };
  }

  const ethereumMintHash = await rpcCall<Hash>(rpcUrl, 'eth_sendTransaction', [
    {
      from: requestedFrom,
      to: gatewayAddress,
      value: '0x0',
      data: mintData,
    },
  ]);

  return {
    adminSender: requestedFrom,
    ethereumMintHash,
  };
}

async function bumpArgonBurnAccount(args: {
  archiveUrl: string;
  token: SupportedToken;
  runtimeAmount: bigint;
}): Promise<{
  burnAccount: string;
  microgons: bigint;
  micronots: bigint;
}> {
  const { archiveUrl, token, runtimeAmount } = args;
  const client = await getClient(archiveUrl);

  try {
    const burnAccount = client.consts.crosschainTransfer.ethereumBurnAccount.toString();
    const [currentMicrogons, currentMicronots] = await Promise.all([
      client.query.system.account(burnAccount).then(x => x.data.free.toBigInt()),
      client.query.ownership.account(burnAccount).then(x => x.free.toBigInt()),
    ]);

    const nextMicrogons = token === 'ARGN' ? currentMicrogons + runtimeAmount : currentMicrogons;
    const nextMicronots = token === 'ARGNOT' ? currentMicronots + runtimeAmount : currentMicronots;
    const { fundedMicrogons, fundedMicronots } = await sudoFundWallet({
      address: burnAccount,
      archiveUrl,
      microgons: nextMicrogons,
      micronots: nextMicronots,
    });

    return {
      burnAccount,
      microgons: fundedMicrogons,
      micronots: fundedMicronots,
    };
  } finally {
    await client.disconnect();
  }
}

async function rpcCall<TResult>(rpcUrl: string, method: string, params: unknown[] = []): Promise<TResult> {
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
    throw new Error(`${method} failed (${body.error.code ?? 'unknown'}): ${body.error.message ?? 'unknown error'}`);
  }

  return body.result as TResult;
}

function printUsage(): void {
  console.info(`Usage:
  yarn dev:eth:mint --token ARGN --to 0xRecipient --amount 100
  yarn dev:eth:mint --token ARGNOT --to 0xRecipient --amount 25.5
  yarn dev:eth:mint --token ARGN --from 0xAdmin --to 0xRecipient --base-units 1000000000000000000

Notes:
  - Uses MintingGateway.adminMintBatch on the configured Ethereum gateway.
  - Also sudo-bumps the Argon crosschain burn-account liquidity for the matching asset.
  - Resolves gateway, ARGN, and ARGNOT addresses from Argon runtime Ethereum chain config.
  - Uses ETH_RPC if set, otherwise probes local geth dev ports.
  - Uses ARGON_ARCHIVE_URL if set, otherwise defaults to ws://127.0.0.1:9944.
  - Uses the first unlocked devnet account if --from is omitted.
  - The Ethereum sender must be the gateway admin on the local devnet.
  - Amounts must align to 6 Argon runtime decimals.
`);
}
