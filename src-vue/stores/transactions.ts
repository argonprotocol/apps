import { getDbPromise } from './helpers/dbPromise';
import { reactive } from 'vue';
import handleFatalError from './helpers/handleFatalError.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';

let transactionTracker: TransactionTracker;

export function useTransactionTracker(): TransactionTracker {
  if (!transactionTracker) {
    const dbPromise = getDbPromise();
    transactionTracker = new TransactionTracker(dbPromise);
    transactionTracker.data = reactive(transactionTracker.data) as any;
    transactionTracker.load().catch(handleFatalError.bind(transactionTracker));
  }

  return transactionTracker;
}
