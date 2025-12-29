import { getDbPromise } from './helpers/dbPromise';
import { reactive } from 'vue';
import handleFatalError from './helpers/handleFatalError.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { getBlockWatch } from './mainchain.ts';

let transactionTracker: TransactionTracker;

export function getTransactionTracker(): TransactionTracker {
  if (!transactionTracker) {
    const dbPromise = getDbPromise();
    const blockWatch = getBlockWatch();
    transactionTracker = new TransactionTracker(dbPromise, blockWatch);
    transactionTracker.data = reactive(transactionTracker.data) as any;
    transactionTracker.load().catch(handleFatalError.bind(transactionTracker));
  }

  return transactionTracker;
}
