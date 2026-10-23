import { NetworkConfig } from '@argonprotocol/apps-core';
import { createPublicClient, encodeFunctionData, erc20Abi, getAddress, http, isAddress, type Address } from 'viem';
import {
  readDevEthereumRuntimeState,
  resolveDevEthereumRpcUrl,
  sendDevEthereumAdminTransaction,
} from '../../e2e/devEthereum.ts';

type SupportedToken = 'ETH' | 'USDC';

type FundDevEthereumAccountArgs = {
  to: string;
  rpcUrl?: string;
  token?: SupportedToken;
  amountBaseUnits: bigint;
  tokenAddress?: string;
};

export async function fundDevEthereumAccount({
  to,
  rpcUrl: requestedRpcUrl,
  token = 'ETH',
  amountBaseUnits,
  tokenAddress: requestedTokenAddress,
}: FundDevEthereumAccountArgs): Promise<void> {
  const recipient = parseAddressArg(to, 'Missing required recipient address');
  const rpcUrl = await resolveDevEthereumRpcUrl({
    rpcUrl: requestedRpcUrl,
    logPrefix: 'fund-dev-ethereum-account',
  });
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  let tokenAddress: Address | undefined;
  if (token === 'USDC') {
    tokenAddress = await resolveUsdcTokenAddress(requestedTokenAddress);
    const code = await publicClient.getCode({ address: tokenAddress });
    if (!code || code === '0x') {
      throw new Error(
        `No USDC contract code found at ${tokenAddress}. Restart the dev Ethereum fixture or pass --token-address.`,
      );
    }
  }
  let transaction;
  if (token === 'ETH') {
    transaction = await sendDevEthereumAdminTransaction({ rpcUrl, to: recipient, value: amountBaseUnits });
  } else {
    transaction = await sendDevEthereumAdminTransaction({
      rpcUrl,
      to: tokenAddress!,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, amountBaseUnits] }),
    });
  }

  const { hash } = transaction;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${token} funding transaction failed: ${hash}`);
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
