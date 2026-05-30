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
  type Hash,
  http,
  isAddress,
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

type MintDevEthereumTokensArgs = {
  to: string;
  from?: string;
  rpcUrl?: string;
  archiveUrl?: string;
  argnRuntimeAmount?: bigint;
  argnotRuntimeAmount?: bigint;
};

type MintDevEthereumTokensResult = {
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
  adminSender?: Address;
  ethereumMintHash?: Hash;
  argonBump?: Awaited<ReturnType<typeof bumpArgonBurnAccount>>;
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
    console.error(`[mint-dev-ethereum-token] ${(error as Error).message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      token: { type: 'string' },
      to: { type: 'string' },
      from: { type: 'string' },
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

  const result = await mintDevEthereumTokens({
    to: parseAddressArg(values.to, 'Missing required --to address'),
    from: values.from,
    rpcUrl: values.rpc,
    archiveUrl: values.archive,
    argnRuntimeAmount: token === 'ARGN' ? genericRuntimeAmount : parseRuntimeAmountArg(values.argons),
    argnotRuntimeAmount: token === 'ARGNOT' ? genericRuntimeAmount : parseRuntimeAmountArg(values.argonots),
  });

  console.info(`[mint-dev-ethereum-token] RPC: ${result.rpcUrl}`);
  console.info(`[mint-dev-ethereum-token] Archive: ${result.archiveUrl}`);
  console.info(`[mint-dev-ethereum-token] Chain ID: ${result.chainId}`);
  console.info(`[mint-dev-ethereum-token] Gateway Address: ${result.gatewayAddress}`);
  console.info(`[mint-dev-ethereum-token] ARGN Token Address: ${result.argonTokenAddress}`);
  console.info(`[mint-dev-ethereum-token] ARGNOT Token Address: ${result.argonotTokenAddress}`);
  console.info(`[mint-dev-ethereum-token] Recipient: ${result.recipient}`);
  console.info(`[mint-dev-ethereum-token] ARGN Amount (Argon runtime units): ${result.argnRuntimeAmount}`);
  console.info(`[mint-dev-ethereum-token] ARGN Amount (ERC20 base units): ${result.argnAmountBaseUnits}`);
  console.info(`[mint-dev-ethereum-token] ARGNOT Amount (Argon runtime units): ${result.argnotRuntimeAmount}`);
  console.info(`[mint-dev-ethereum-token] ARGNOT Amount (ERC20 base units): ${result.argnotAmountBaseUnits}`);

  if (result.ethereumMintHash) {
    console.info(`[mint-dev-ethereum-token] Admin Sender: ${result.adminSender}`);
    console.info(`[mint-dev-ethereum-token] Ethereum Migration Tx: ${result.ethereumMintHash}`);
  } else {
    console.info(
      '[mint-dev-ethereum-token] Migration already completed; existing seeded balances satisfied this request.',
    );
  }

  if (result.argonBump) {
    console.info(`[mint-dev-ethereum-token] Argon Burn Account: ${result.argonBump.burnAccount}`);
    console.info(
      `[mint-dev-ethereum-token] Burn Account Balances: ${result.argonBump.microgons} microgons, ${result.argonBump.micronots} micronots`,
    );
  }
}

export async function mintDevEthereumTokens(args: MintDevEthereumTokensArgs): Promise<MintDevEthereumTokensResult> {
  const recipient = parseAddressArg(args.to, 'Missing required recipient address');
  const argnRuntimeAmount = resolveRuntimeAmount(args.argnRuntimeAmount, 'ARGN');
  const argnotRuntimeAmount = resolveRuntimeAmount(args.argnotRuntimeAmount, 'ARGNOT');
  if (argnRuntimeAmount === 0n && argnotRuntimeAmount === 0n) {
    throw new Error('Provide an ARGN or ARGNOT amount to seed on the dev Ethereum gateway.');
  }

  const argnAmountBaseUnits = convertRuntimeAmountToErc20Amount(argnRuntimeAmount);
  const argnotAmountBaseUnits = convertRuntimeAmountToErc20Amount(argnotRuntimeAmount);
  const rpcUrl = await resolveDevEthereumRpcUrl({
    rpcUrl: args.rpcUrl,
    logPrefix: 'mint-dev-ethereum-token',
  });
  const archiveUrl = args.archiveUrl?.trim() || process.env.ARGON_ARCHIVE_URL?.trim() || defaultArchiveUrl;
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 15_000 }),
  });

  const [chainId, chainConfig] = await Promise.all([publicClient.getChainId(), loadEthereumChainConfig(archiveUrl)]);
  const migrationCompleted = await publicClient.readContract({
    address: chainConfig.gatewayAddress,
    abi: EvmContracts.mintingGatewayArtifact.abi,
    functionName: 'migrationCompleted',
  });

  let adminSender: Address | undefined;
  let ethereumMintHash: Hash | undefined;
  let argonBump: Awaited<ReturnType<typeof bumpArgonBurnAccount>> | undefined;

  if (migrationCompleted) {
    const [argonBalance, argonotBalance] = await Promise.all([
      publicClient.readContract({
        address: chainConfig.argonTokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [recipient],
      }),
      publicClient.readContract({
        address: chainConfig.argonotTokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [recipient],
      }),
    ]);

    if (argonBalance < argnAmountBaseUnits || argonotBalance < argnotAmountBaseUnits) {
      throw new Error(
        'MintingGateway migration balances have already been seeded on this dev chain. Restart the dev Ethereum fixture before seeding additional balances.',
      );
    }
  } else {
    const mintData = encodeFunctionData({
      abi: EvmContracts.mintingGatewayArtifact.abi,
      functionName: 'migrate',
      args: [
        {
          recipients: argnAmountBaseUnits > 0n ? [recipient] : [],
          amounts: argnAmountBaseUnits > 0n ? [argnAmountBaseUnits] : [],
        },
        {
          recipients: argnotAmountBaseUnits > 0n ? [recipient] : [],
          amounts: argnotAmountBaseUnits > 0n ? [argnotAmountBaseUnits] : [],
        },
      ],
    });

    const sent = await sendMintTransaction({
      rpcUrl,
      gatewayAddress: chainConfig.gatewayAddress,
      mintData,
      from: args.from,
    });
    adminSender = sent.adminSender;
    ethereumMintHash = sent.ethereumMintHash;

    const ethereumReceipt = await publicClient.waitForTransactionReceipt({ hash: ethereumMintHash });
    if (ethereumReceipt.status !== 'success') {
      throw new Error(`Ethereum migration transaction failed: ${ethereumMintHash}`);
    }

    argonBump = await bumpArgonBurnAccount({
      archiveUrl,
      microgons: argnRuntimeAmount,
      micronots: argnotRuntimeAmount,
    });
  }

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
    adminSender,
    ethereumMintHash,
    argonBump,
  };
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
  return runtimeAmount * ethereumRuntimeToErc20Scale;
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

async function sendMintTransaction(args: {
  rpcUrl: string;
  gatewayAddress: Address;
  mintData: `0x${string}`;
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

async function bumpArgonBurnAccount(args: { archiveUrl: string; microgons: bigint; micronots: bigint }): Promise<{
  burnAccount: string;
  microgons: bigint;
  micronots: bigint;
}> {
  const client = await getClient(args.archiveUrl);

  try {
    const burnAccount = client.consts.crosschainTransfer.ethereumBurnAccount.toString();
    const [currentMicrogons, currentMicronots] = await Promise.all([
      client.query.system.account(burnAccount).then(x => x.data.free.toBigInt()),
      client.query.ownership.account(burnAccount).then(x => x.free.toBigInt()),
    ]);

    const { fundedMicrogons, fundedMicronots } = await sudoFundWallet({
      address: burnAccount,
      archiveUrl: args.archiveUrl,
      microgons: currentMicrogons + args.microgons,
      micronots: currentMicronots + args.micronots,
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
  yarn dev:ethereum:add-argn --to 0xRecipient --amount 100
  yarn dev:ethereum:add-argnot --to 0xRecipient --amount 25.5
  yarn dev:ethereum:add-argn --from 0xAdmin --to 0xRecipient --amount 1

Direct:
  yarn exec tsx e2e/scripts/mintDevEthereumTokens.ts --to 0xRecipient --argons 100 --argonots 25.5

Notes:
  - Uses MintingGatewayV2.migrate on the configured Ethereum gateway.
  - Migration seeding is one-time per dev chain; restart the dev Ethereum fixture to seed different balances later.
  - Also sudo-bumps the Argon crosschain burn-account liquidity for the seeded assets.
  - Resolves gateway, ARGN, and ARGNOT addresses from Argon runtime Ethereum chain config.
  - Uses --rpc, ETH_RPC, ETHEREUM_EXECUTION_RPC_URL, or the latest dev Ethereum runtime state.
  - Uses ARGON_ARCHIVE_URL if set, otherwise defaults to ws://127.0.0.1:9944.
  - Uses the built-in local dev admin account if --from is omitted.
  - --amount is a 6-decimal Argon runtime amount for the token selected by the package script.
  - --argons and --argonots are 6-decimal Argon runtime amounts.
  - Example: --argons 1 seeds 1_000_000 microgons.
`);
}
