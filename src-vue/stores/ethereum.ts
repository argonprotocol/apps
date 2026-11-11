import { EthereumClient, getEthereumExecutionRpcUrl } from '../lib/EthereumClient.ts';
import { getConfig } from './config.ts';
import { getWalletKeys } from './wallets.ts';

export function createEthereumClient(): EthereumClient | undefined {
  const executionRpcUrl = getEthereumExecutionRpcUrl(getConfig().ethereumExecutionRpcUrl);
  if (!executionRpcUrl) return;
  return new EthereumClient(
    getWalletKeys(),
    () => getEthereumExecutionRpcUrl(getConfig().ethereumExecutionRpcUrl) ?? '',
  );
}
