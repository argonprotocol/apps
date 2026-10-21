import { EvmContracts, getClient } from '@argonprotocol/mainchain';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  type Address,
  type PublicClient,
} from 'viem';
import {
  DEV_ETHEREUM_ADMIN_ACCOUNT,
  resolveDevEthereumRpcUrl,
  sendDevEthereumAdminTransaction,
} from '../../e2e/devEthereum.ts';
import type { IEthereumChainConfig } from '../../src-vue/lib/EthereumClient.ts';

const defaultArchiveUrl = 'ws://127.0.0.1:9944';

type SupportedToken = 'ARGN' | 'ARGNOT';

type FundDevEthereumTokensArgs = {
  to: string;
  rpcUrl?: string;
  archiveUrl?: string;
  argnRuntimeAmount?: bigint;
  argnotRuntimeAmount?: bigint;
};

export async function fundDevEthereumTokens(
  args: FundDevEthereumTokensArgs,
): Promise<{ rpcUrl: string; recipient: Address }> {
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

  const chainConfig = await loadEthereumChainConfig(archiveUrl);
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

  await transferReserveToken({
    publicClient,
    rpcUrl,
    tokenAddress: chainConfig.argonTokenAddress,
    recipient,
    amount: argnAmountBaseUnits,
    label: 'ARGN',
  });
  await transferReserveToken({
    publicClient,
    rpcUrl,
    tokenAddress: chainConfig.argonotTokenAddress,
    recipient,
    amount: argnotAmountBaseUnits,
    label: 'ARGNOT',
  });

  return { rpcUrl, recipient };
}

async function transferReserveToken(args: {
  publicClient: Pick<PublicClient, 'waitForTransactionReceipt'>;
  rpcUrl: string;
  tokenAddress: Address;
  recipient: Address;
  amount: bigint;
  label: SupportedToken;
}): Promise<void> {
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

async function loadEthereumChainConfig(
  archiveUrl: string,
): Promise<Pick<IEthereumChainConfig, 'argonTokenAddress' | 'argonotTokenAddress'>> {
  const client = await getClient(archiveUrl);

  try {
    return await waitFor(45e3, 'Ethereum chain config', async () => {
      const config = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
      if (config.isNone || !config.unwrap().isEvm) return;

      const ethereumConfig = config.unwrap().asEvm;
      return {
        argonTokenAddress: getAddress(ethereumConfig.argonToken.toHex()),
        argonotTokenAddress: getAddress(ethereumConfig.argonotToken.toHex()),
      };
    });
  } finally {
    await client.disconnect();
  }
}
