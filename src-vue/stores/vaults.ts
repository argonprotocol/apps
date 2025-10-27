import { Vaults } from '../lib/Vaults';
import { getDbPromise } from './helpers/dbPromise';
import { MyVault } from '../lib/MyVault.ts';
import { reactive } from 'vue';
import { NETWORK_NAME } from './config.ts';
import { getPriceIndex } from './mainchain.ts';

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
    myVault = new MyVault(dbPromise, useVaults());
    myVault.data = reactive(myVault.data) as any;
  }

  return myVault;
}
