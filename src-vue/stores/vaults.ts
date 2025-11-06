import { Vaults } from '../lib/Vaults';
import { getDbPromise } from './helpers/dbPromise';
import { MyVault } from '../lib/MyVault.ts';
import { reactive } from 'vue';
import { NETWORK_NAME } from './config.ts';
import { getPriceIndex } from './mainchain.ts';
import { useTransactionTracker } from './transactions.ts';
import { useBitcoinLocks } from './bitcoin.ts';
import { useWalletKeys } from './wallets.ts';

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
    const transactionTracker = useTransactionTracker();
    const bitcoinLocks = useBitcoinLocks();
    const keys = useWalletKeys();
    myVault = new MyVault(dbPromise, vaults, keys, transactionTracker, bitcoinLocks);
    myVault.data = reactive(myVault.data) as any;
  }

  return myVault;
}
