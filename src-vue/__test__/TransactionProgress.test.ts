import * as Vue from 'vue';
import { TxResult, type ArgonClient } from '@argonprotocol/apps-core';

import { describe, expect, it, vi } from 'vitest';
import { getActiveTransactionInfos, trackTransactionProgress } from '../lib/TransactionProgress.ts';
import { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { ITransactionRecord } from '../lib/db/TransactionsTable.ts';

describe('TransactionProgress', () => {
  it('tracks each active transaction once and restores the idle state after the batch finishes', () => {
    const progressCallbacks = new Map<number, Parameters<TransactionInfo['subscribeToProgress']>[0]>();
    const createPendingTransaction = (id: number, createdAt: Date) => {
      const txInfo = new TransactionInfo({
        tx: { id, createdAt } as ITransactionRecord,
        txResult: {} as TxResult,
      });
      txInfo.createPostProcessor();
      vi.spyOn(txInfo, 'subscribeToProgress').mockImplementation(callback => {
        progressCallbacks.set(id, callback);
        return vi.fn();
      });
      return txInfo;
    };

    const laterTransaction = createPendingTransaction(2, new Date('2026-08-15T12:01:00Z'));
    const earlierTransaction = createPendingTransaction(1, new Date('2026-08-15T12:00:00Z'));
    const activeTransactions = getActiveTransactionInfos([laterTransaction, earlierTransaction, laterTransaction]);
    const isSubmitting = Vue.ref(false);
    const progressPct = Vue.ref(0);
    const progressLabel = Vue.ref('');
    const activeTransactionCount = Vue.ref(0);
    const error = Vue.ref('');
    const onIdle = vi.fn();

    expect(activeTransactions.map(({ tx }) => tx.id)).toEqual([1, 2]);

    trackTransactionProgress({
      txInfos: activeTransactions,
      isSubmitting,
      progressPct,
      progressLabel,
      activeTransactionCount,
      error,
      onIdle,
      onCleanup: vi.fn(),
    });
    progressCallbacks.get(1)!({
      progressPct: 80,
      progressMessage: 'Waiting for finalization...',
      confirmations: 3,
      expectedConfirmations: 4,
      isMaxed: false,
    });
    progressCallbacks.get(2)!({
      progressPct: 30,
      progressMessage: 'Waiting for inclusion...',
      confirmations: -1,
      expectedConfirmations: 4,
      isMaxed: false,
    });

    expect(isSubmitting.value).toBe(true);
    expect(activeTransactionCount.value).toBe(2);
    expect(progressPct.value).toBe(30);
    expect(progressLabel.value).toBe('Waiting for inclusion... (2 transactions in progress)');

    trackTransactionProgress({
      txInfos: [],
      isSubmitting,
      progressPct,
      progressLabel,
      activeTransactionCount,
      error,
      onIdle,
      onCleanup: vi.fn(),
    });

    expect(isSubmitting.value).toBe(false);
    expect(progressPct.value).toBe(0);
    expect(progressLabel.value).toBe('');
    expect(activeTransactionCount.value).toBe(0);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('does not complete a transaction until its post-processing has finished', async () => {
    const createdAt = new Date('2026-08-28T12:00:00Z');
    const txResult = new TxResult({} as ArgonClient, {
      signedHash: '0x09',
      method: {},
      submittedTime: createdAt,
      submittedAtBlockNumber: 10,
      accountAddress: 'owner',
      nonce: 1,
    });
    const txInfo = new TransactionInfo({
      tx: {
        id: 9,
        accountAddress: 'owner',
        isFinalized: true,
        blockHeight: 12,
        finalizedHeadHeight: 16,
        createdAt,
      } as ITransactionRecord,
      txResult,
    });
    const postProcessor = txInfo.createPostProcessor();
    const isSubmitting = Vue.ref(false);
    const progressPct = Vue.ref(0);
    const progressLabel = Vue.ref('');
    const error = Vue.ref('');
    const cleanupFns: (() => void)[] = [];
    let complete: () => void = () => undefined;
    const completed = new Promise<void>(resolve => {
      complete = resolve;
    });

    trackTransactionProgress({
      txInfos: [txInfo],
      isSubmitting,
      progressPct,
      progressLabel,
      error,
      onComplete: complete,
      onCleanup: cleanupFn => cleanupFns.push(cleanupFn),
    });

    expect(isSubmitting.value).toBe(true);
    expect(progressPct.value).not.toBe(100);

    postProcessor.resolve();
    await completed;

    expect(isSubmitting.value).toBe(false);
    expect(progressPct.value).toBe(100);
    expect(error.value).toBe('');
    cleanupFns.forEach(cleanup => cleanup());
  });
});
