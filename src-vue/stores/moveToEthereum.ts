import { reactive } from 'vue';
import { createEthereumClient } from './ethereum.ts';
import { EthereumOutboundTransferTracker } from '../lib/EthereumOutboundTransferTracker.ts';
import handleFatalError from './helpers/handleFatalError.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getBlockWatch } from './mainchain.ts';
import { getTransactionTracker } from './transactions.ts';
import { getMyVault } from './vaults.ts';
import { getAccountSecurity, getWalletKeys, getWalletsForEthereum } from './wallets.ts';

let ethereumOutboundTransferTracker: EthereumOutboundTransferTracker;

export function getEthereumOutboundTransferTracker(): EthereumOutboundTransferTracker {
  if (!ethereumOutboundTransferTracker) {
    const walletKeys = getWalletKeys();
    const security = getAccountSecurity();
    const ethereumClient = createEthereumClient();

    ethereumOutboundTransferTracker = new EthereumOutboundTransferTracker(
      getDbPromise(),
      getTransactionTracker(),
      getBlockWatch(),
      walletKeys,
      security.createBatch.bind(security),
      ethereumClient,
      getMyVault().mintingAuthorities,
      ethereumClient?.executionRpcUrl,
      address => getWalletsForEthereum().resolve(address),
    );
    ethereumOutboundTransferTracker.data = reactive(ethereumOutboundTransferTracker.data) as any;
    ethereumOutboundTransferTracker.load().catch(handleFatalError.bind(ethereumOutboundTransferTracker));
  }

  return ethereumOutboundTransferTracker;
}
