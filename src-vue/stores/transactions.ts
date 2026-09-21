import { getDbPromise } from './helpers/dbPromise';
import { reactive } from 'vue';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { getBlockWatch } from './mainchain.ts';

let transactionTracker: TransactionTracker;

export function getTransactionTracker(): TransactionTracker {
  if (!transactionTracker) {
    const dbPromise = getDbPromise();
    const blockWatch = getBlockWatch();
    transactionTracker = new TransactionTracker(dbPromise, blockWatch);
    transactionTracker.data = reactive(transactionTracker.data) as any;
    // Operation restoration retries transient tracker-load failures after its owning domains are ready.
    void transactionTracker.load().catch(error => {
      console.warn('[Transactions] Initial transaction load failed; pending operations will retry', error);
    });
  }

  return transactionTracker;
}
