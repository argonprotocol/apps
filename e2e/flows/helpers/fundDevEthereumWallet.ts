import { createPublicClient, http, type Address } from 'viem';
import { sendDevEthereumAdminTransaction } from '../../devEthereum.ts';
import { mintDevEthereumTokens } from '../../scripts/mintDevEthereumTokens.ts';

const MIN_DEV_ETHEREUM_GAS_WEI = 10n ** 17n;

export async function fundDevEthereumWallet(args: {
  to: string;
  archiveUrl?: string;
  ethereumRpcUrl?: string;
  microgons?: bigint;
  micronots?: bigint;
  minGasWei?: bigint;
}): Promise<void> {
  const { to, archiveUrl, microgons, micronots } = args;
  let recipient: Address | undefined;
  let rpcUrl: string | undefined;

  if ((microgons ?? 0n) > 0n || (micronots ?? 0n) > 0n) {
    const result = await mintDevEthereumTokens({
      to,
      archiveUrl,
      rpcUrl: args.ethereumRpcUrl,
      argnRuntimeAmount: microgons,
      argnotRuntimeAmount: micronots,
    });
    recipient = result.recipient;
    rpcUrl = result.rpcUrl;
  }

  if (!recipient || !rpcUrl) {
    return;
  }

  await ensureDevEthereumGas({
    rpcUrl,
    recipient,
    minGasWei: args.minGasWei ?? MIN_DEV_ETHEREUM_GAS_WEI,
  });
}

async function ensureDevEthereumGas(args: { rpcUrl: string; recipient: Address; minGasWei: bigint }): Promise<void> {
  const { rpcUrl, recipient, minGasWei } = args;
  const publicClient = createPublicClient({
    transport: http(rpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const currentBalance = await publicClient.getBalance({ address: recipient });
  if (currentBalance >= minGasWei) {
    return;
  }

  const { hash } = await sendDevEthereumAdminTransaction({
    rpcUrl,
    to: recipient,
    value: minGasWei - currentBalance,
  });

  await publicClient.waitForTransactionReceipt({ hash });
}
