import { reactive } from 'vue';
import { EthereumInboundTransferTracker } from '../lib/EthereumInboundTransferTracker.ts';
import { EthereumClient, getEthereumExecutionRpcUrl } from '../lib/EthereumClient.ts';
import handleFatalError from './helpers/handleFatalError.ts';
import { getTransactionTracker } from './transactions.ts';
import { getWalletKeys } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise.ts';

let ethereumMoveTracker: EthereumInboundTransferTracker;

export function getEthereumMoveTracker(): EthereumInboundTransferTracker {
  if (!ethereumMoveTracker) {
    const walletKeys = getWalletKeys();
    const transactionTracker = getTransactionTracker();
    const dbPromise = getDbPromise();
    const executionRpcUrl = getEthereumExecutionRpcUrl();
    if (!executionRpcUrl) {
      throw new Error('Ethereum execution RPC is not configured for this app instance.');
    }
    const ethereumClient = new EthereumClient(walletKeys, executionRpcUrl);

    ethereumMoveTracker = new EthereumInboundTransferTracker(dbPromise, transactionTracker, walletKeys, ethereumClient);
    ethereumMoveTracker.data = reactive(ethereumMoveTracker.data) as any;
    ethereumMoveTracker.load().catch(handleFatalError.bind(ethereumMoveTracker));
  }

  return ethereumMoveTracker;
}
