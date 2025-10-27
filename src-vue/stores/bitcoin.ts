import BitcoinPrices from '../lib/BitcoinPrices';
import BitcoinFees from '../lib/BitcoinFees';
import BitcoinLocksStore from '../lib/BitcoinLocksStore.ts';
import { getDbPromise } from './helpers/dbPromise';
import { reactive } from 'vue';
import handleFatalError from './helpers/handleFatalError.ts';
import { getPriceIndex } from './mainchain.ts';

const bitcoinPrices = new BitcoinPrices();
const bitcoinFees = new BitcoinFees();

export function getBitcoinPrices() {
  return bitcoinPrices;
}

export function getBitcoinFees() {
  return bitcoinFees;
}

let locks: BitcoinLocksStore;

export function useBitcoinLocks(): BitcoinLocksStore {
  if (!locks) {
    const dbPromise = getDbPromise();
    locks = new BitcoinLocksStore(dbPromise, getPriceIndex());
    locks.data = reactive(locks.data) as any;
    locks.load().catch(handleFatalError.bind('useBitcoinLocks'));
  }

  return locks;
}
