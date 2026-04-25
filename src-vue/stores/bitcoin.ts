import BitcoinPrices from '../lib/BitcoinPrices';
import BitcoinFees from '../lib/BitcoinFees';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { getDbPromise } from './helpers/dbPromise';
import { reactive } from 'vue';
import handleFatalError from './helpers/handleFatalError.ts';
import { getBlockWatch } from './mainchain.ts';
import { getCurrency, Currency } from './currency.ts';
import { getTransactionTracker } from './transactions.ts';
import { getUpstreamOperatorClient } from './upstreamOperator.ts';
import { getWalletKeys } from './wallets.ts';

const bitcoinPrices = new BitcoinPrices();
const bitcoinFees = new BitcoinFees();

export function getBitcoinPrices() {
  return bitcoinPrices;
}

export function getBitcoinFees() {
  return bitcoinFees;
}

let locks: BitcoinLocks;

export function getBitcoinLocks(): BitcoinLocks {
  if (!locks) {
    const dbPromise = getDbPromise();
    const transactionTracker = getTransactionTracker();
    const keys = getWalletKeys();
    const blockWatch = getBlockWatch();
    locks = new BitcoinLocks(
      dbPromise,
      keys,
      blockWatch,
      getCurrency() as Currency,
      transactionTracker,
      undefined,
      getUpstreamOperatorClient(),
    );
    locks.data = reactive(locks.data) as any;
    locks.utxoTracking.data = reactive(locks.utxoTracking.data) as any;
    locks.load().catch(handleFatalError.bind('useBitcoinLocks'));
  }

  return locks;
}
