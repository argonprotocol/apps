import { reactive } from 'vue';
import { EthereumInboundTransferTracker } from '../lib/EthereumInboundTransferTracker.ts';
import { EthereumClient, getEthereumExecutionRpcUrl } from '../lib/EthereumClient.ts';
import { getConfig } from './config.ts';
import { getServerApiClient } from './server.ts';
import { getBlockWatch } from './mainchain.ts';
import { getTransactionTracker } from './transactions.ts';
import { getUpstreamOperatorClient } from './upstreamOperator.ts';
import { getWalletKeys } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getMyVault } from './vaults.ts';

let ethereumMoveTracker: EthereumInboundTransferTracker;

export function getEthereumMoveTracker(): EthereumInboundTransferTracker {
  if (!ethereumMoveTracker) {
    const config = getConfig();
    const walletKeys = getWalletKeys();
    const transactionTracker = getTransactionTracker();
    const dbPromise = getDbPromise();
    const executionRpcUrl = getEthereumExecutionRpcUrl(config.ethereumExecutionRpcUrl);
    const ethereumClient = executionRpcUrl ? new EthereumClient(walletKeys, executionRpcUrl) : undefined;
    const upstreamOperatorClient = getUpstreamOperatorClient();
    const myVault = getMyVault();

    ethereumMoveTracker = new EthereumInboundTransferTracker(
      dbPromise,
      transactionTracker,
      getBlockWatch(),
      walletKeys,
      ethereumClient,
      () => (config.serverDetails.ipAddress ? getServerApiClient() : undefined),
      upstreamOperatorClient,
      myVault,
    );
    ethereumMoveTracker.data = reactive(ethereumMoveTracker.data) as any;
    // Startup RPC/read failures are retryable. The wallet status tray presents
    // the load error and lets the user retry without restarting the app.
    ethereumMoveTracker.load().catch(error => {
      console.warn('[EthereumInboundTransferTracker] Unable to load inbound transfers; retry is available.', error);
    });
  }

  return ethereumMoveTracker;
}
