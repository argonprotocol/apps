import BitcoinPrices from '../lib/BitcoinPrices';
import BitcoinFees from '../lib/BitcoinFees';
import BitcoinLocksStore from '../lib/BitcoinLocksStore.ts';
import { getDbPromise } from './helpers/dbPromise';
import { reactive } from 'vue';
import handleFatalError from './helpers/handleFatalError.ts';
import { getBlockWatch } from './mainchain.ts';
import { getCurrency, Currency } from './currency.ts';
import { getTransactionTracker } from './transactions.ts';
import { getWalletKeys } from './wallets.ts';

const bitcoinPrices = new BitcoinPrices();
const bitcoinFees = new BitcoinFees();

export function getBitcoinPrices() {
  return bitcoinPrices;
}

export function getBitcoinFees() {
  return bitcoinFees;
}

let locks: BitcoinLocksStore;

export function getBitcoinLocks(): BitcoinLocksStore {
  if (!locks) {
    const dbPromise = getDbPromise();
    const transactionTracker = getTransactionTracker();
    const keys = getWalletKeys();
    const blockWatch = getBlockWatch();
    locks = new BitcoinLocksStore(dbPromise, keys, blockWatch, getCurrency() as Currency, transactionTracker);
    locks.data = reactive(locks.data) as any;
    locks.load().catch(handleFatalError.bind('useBitcoinLocks'));
  }

  return locks;
}
