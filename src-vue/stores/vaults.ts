import { Vaults } from '../lib/Vaults';
import { getDbPromise } from './helpers/dbPromise';
import { MyVault } from '../lib/MyVault.ts';
import { reactive } from 'vue';
import { NETWORK_NAME, useConfig, Config } from './config.ts';
import { getPriceIndex } from './mainchain.ts';
import { useTransactionTracker } from './transactions.ts';
import { useBitcoinLocks } from './bitcoin.ts';

export type { Vaults };

let vaults: Vaults;
let myVault: MyVault;

export function useVaults(): Vaults {
  if (!vaults) {
    vaults = new Vaults(NETWORK_NAME, getPriceIndex());
  }

  return vaults;
}

export function useMyVault(): MyVault {
  if (!myVault) {
    const dbPromise = getDbPromise();
    const vaults = useVaults();
    const config = useConfig();
    const transactionTracker = useTransactionTracker();
    const bitcoinLocks = useBitcoinLocks();
    myVault = new MyVault(dbPromise, vaults, config as Config, transactionTracker, bitcoinLocks);
    myVault.data = reactive(myVault.data) as any;
  }

  return myVault;
}
