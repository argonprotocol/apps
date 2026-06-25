import { Vaults } from '../lib/Vaults';
import { getDbPromise } from './helpers/dbPromise';
import { MyVault } from '../lib/MyVault.ts';
import { reactive } from 'vue';
import { getConfig, NETWORK_NAME } from './config.ts';
import { getMiningFrames } from './mainchain.ts';
import { getCurrency } from './currency.ts';
import { getTransactionTracker } from './transactions.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getWalletKeys } from './wallets.ts';
import { GlobalCouncil } from '../lib/GlobalCouncil.ts';
import { MintingAuthorities } from '../lib/MintingAuthorities.ts';
import { getServerApiClient } from './server.ts';
import { getUpstreamOperatorClient } from './upstreamOperator.ts';

export { type Vaults };

let vaults: Vaults;
let myVault: MyVault;

export function getVaults(): Vaults {
  if (!vaults) {
    vaults = new Vaults(NETWORK_NAME, getCurrency(), getMiningFrames());
  }

  return vaults;
}

export function getMyVault(): MyVault {
  if (!myVault) {
    const config = getConfig();
    const dbPromise = getDbPromise();
    const vaults = getVaults();
    const transactionTracker = getTransactionTracker();
    const bitcoinLocks = getBitcoinLocks();
    const keys = getWalletKeys();
    const miningFrames = getMiningFrames();
    const globalCouncil = new GlobalCouncil(dbPromise, keys, miningFrames, () => config.ethereumExecutionRpcUrl);
    globalCouncil.data = reactive(globalCouncil.data) as any;

    const mintingAuthorities = new MintingAuthorities(dbPromise, keys, miningFrames, transactionTracker, async () => {
      await config.isLoadedPromise;
      return {
        serverApiClient: config.serverDetails.ipAddress ? getServerApiClient() : undefined,
        upstreamOperatorClient: getUpstreamOperatorClient(),
      };
    });
    mintingAuthorities.data = reactive(mintingAuthorities.data) as any;

    myVault = new MyVault(
      dbPromise,
      vaults,
      keys,
      transactionTracker,
      bitcoinLocks,
      miningFrames,
      globalCouncil,
      mintingAuthorities,
    );
    myVault.data = reactive(myVault.data) as any;
  }

  return myVault;
}
