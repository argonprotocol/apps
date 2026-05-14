import { createPublicClient, defineChain, http, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const DEV_ETHEREUM_ADMIN_ACCOUNT = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  balance: '100ETH',
} as const;

export async function sendDevEthereumAdminTransaction(args: {
  rpcUrl: string;
  to: Address;
  value?: bigint;
  data?: Hex;
}): Promise<{ hash: Hash; sender: Address }> {
  const { rpcUrl, to, data, value = 0n } = args;
  const account = privateKeyToAccount(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey);
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: 'argon-dev-ethereum',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: [rpcUrl],
      },
    },
  });
  const nonce = await publicClient.getTransactionCount({
    address: account.address,
  });
  const gas = await publicClient.estimateGas({
    account: account.address,
    to,
    value,
    data,
  });
  const fees = await publicClient.estimateFeesPerGas({
    chain,
    type: 'eip1559',
  });
  if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null) {
    throw new Error('Unable to estimate EIP-1559 fees for the local dev Ethereum network.');
  }
  const serializedTransaction = await account.signTransaction({
    type: 'eip1559',
    chain,
    chainId,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    to,
    value,
    data,
  });

  const hash = await publicClient.sendRawTransaction({
    serializedTransaction,
  });

  return {
    hash,
    sender: account.address,
  };
}
