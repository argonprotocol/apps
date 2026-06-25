import { reactive } from 'vue';
import { EthereumClient, getEthereumExecutionRpcUrl } from '../lib/EthereumClient.ts';
import { EthereumOutboundTransferTracker } from '../lib/EthereumOutboundTransferTracker.ts';
import { getConfig } from './config.ts';
import handleFatalError from './helpers/handleFatalError.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getBlockWatch } from './mainchain.ts';
import { getTransactionTracker } from './transactions.ts';
import { getMyVault } from './vaults.ts';
import { getWalletKeys } from './wallets.ts';

let ethereumOutboundTransferTracker: EthereumOutboundTransferTracker;

export function getEthereumOutboundTransferTracker(): EthereumOutboundTransferTracker {
  if (!ethereumOutboundTransferTracker) {
    const walletKeys = getWalletKeys();
    const executionRpcUrl = getEthereumExecutionRpcUrl(getConfig().ethereumExecutionRpcUrl);
    if (!executionRpcUrl) {
      throw new Error('Ethereum execution RPC is not configured for this app instance.');
    }

    ethereumOutboundTransferTracker = new EthereumOutboundTransferTracker(
      getDbPromise(),
      getTransactionTracker(),
      getBlockWatch(),
      walletKeys,
      new EthereumClient(walletKeys, executionRpcUrl),
      executionRpcUrl,
      getMyVault().mintingAuthorities,
    );
    ethereumOutboundTransferTracker.data = reactive(ethereumOutboundTransferTracker.data) as any;
    ethereumOutboundTransferTracker.load().catch(handleFatalError.bind(ethereumOutboundTransferTracker));
  }

  return ethereumOutboundTransferTracker;
}
