import { expect, it } from 'vitest';
import { TransactionInfo } from '../lib/TransactionInfo';
import { ITransactionRecord } from '../lib/db/TransactionsTable';
import { TxResult } from '@argonprotocol/mainchain';
import { createDeferred } from '../lib/Utils';

it('should update progress before the transaction has been added to a block', async () => {
  const progressUpdates: { progressPct: number; confirmations: number }[] = [];
  const txInfo = new TransactionInfo({
    tx: {
      blockHeight: undefined,
    } as ITransactionRecord,
    txResult: {} as TxResult,
    isProcessed: createDeferred(),
  });
  txInfo.finalizedBlockHeight = 95;
  const unsubscribe = txInfo.subscribeToProgress(
    (args: { progressPct: number; confirmations: number; isMaxed: boolean }, error: Error | undefined) => {
      progressUpdates.push(args);
    },
  );

  await new Promise(resolve => setTimeout(resolve, 2_100));
  unsubscribe();

  expect(progressUpdates).toHaveLength(21);
  expect(progressUpdates[0].progressPct).toBeGreaterThan(0);
  expect(progressUpdates[0].progressPct).toBeLessThan(1);
  expect(progressUpdates[0].confirmations).toBe(-1);
});

it('should update progress throughout the entire finalization process', async () => {
  const progressUpdates: { progressPct: number; confirmations: number }[] = [];
  const txInfo = new TransactionInfo({
    tx: {
      blockHeight: undefined,
    } as ITransactionRecord,
    txResult: {} as TxResult,
    isProcessed: createDeferred(),
  });

  let resolve: (value: unknown) => void | undefined;
  let finalizedBlockHeight: number | undefined = undefined;

  txInfo.subscribeToProgress(
    (args: { progressPct: number; confirmations: number; isMaxed: boolean }, error: Error | undefined) => {
      const { progressPct, confirmations, isMaxed } = args;

      if (progressPct === 99) {
        txInfo.tx.isFinalized = true;
      } else if (progressPct === 100) {
        resolve?.(undefined);
      } else if (isMaxed) {
        txInfo.tx.blockHeight = 100;
        finalizedBlockHeight = finalizedBlockHeight ? finalizedBlockHeight + 1 : 95;
      }
      txInfo.finalizedBlockHeight = finalizedBlockHeight!;
      progressUpdates.push(args);
    },
  );

  await new Promise(res => {
    resolve = res;
    setTimeout(res, 20_000);
  });

  expect(progressUpdates).toHaveLength(141);

  const firstProgressUpdate = progressUpdates[0];
  expect(firstProgressUpdate.progressPct).toBeGreaterThan(0);
  expect(firstProgressUpdate.progressPct).toBeLessThan(2);
  expect(firstProgressUpdate.confirmations).toBe(-1);

  const lastProgressUpdate = progressUpdates[progressUpdates.length - 1];
  expect(lastProgressUpdate.progressPct).toBe(100);
  expect(lastProgressUpdate.confirmations).toBe(5);
}, 60_000);
