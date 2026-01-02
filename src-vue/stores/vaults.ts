import { Vaults } from '../lib/Vaults';
import { getDbPromise } from './helpers/dbPromise';
import { MyVault } from '../lib/MyVault.ts';
import { reactive } from 'vue';
import { NETWORK_NAME } from './config.ts';
import { getMiningFrames } from './mainchain.ts';
import { getCurrency, Currency } from './currency.ts';
import { getTransactionTracker } from './transactions.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getWalletKeys } from './wallets.ts';

export type { Vaults };

let vaults: Vaults;
let myVault: MyVault;

export function getVaults(): Vaults {
  if (!vaults) {
    vaults = new Vaults(NETWORK_NAME, getCurrency() as Currency, getMiningFrames());
  }

  return vaults;
}

export function getMyVault(): MyVault {
  if (!myVault) {
    const dbPromise = getDbPromise();
    const vaults = getVaults();
    const transactionTracker = getTransactionTracker();
    const bitcoinLocks = getBitcoinLocks();
    const keys = getWalletKeys();
    const miningFrames = getMiningFrames();
    myVault = new MyVault(dbPromise, vaults, keys, transactionTracker, bitcoinLocks, miningFrames);
    myVault.data = reactive(myVault.data) as any;
  }

  return myVault;
}
