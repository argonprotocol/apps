import type * as Vue from 'vue';
import type { TransactionInfo } from './TransactionInfo.ts';

export function getActiveTransactionInfos(txInfos: TransactionInfo[]) {
  const uniqueTxInfos = new Map<number, TransactionInfo>();
  for (const txInfo of txInfos) {
    if (txInfo.isPostProcessed) continue;

    uniqueTxInfos.set(txInfo.tx.id, txInfo);
  }

  return [...uniqueTxInfos.values()].sort((left, right) => left.tx.createdAt.getTime() - right.tx.createdAt.getTime());
}

export function trackTransactionProgress(args: {
  txInfos: TransactionInfo[];
  isSubmitting: Vue.Ref<boolean>;
  progressPct: Vue.Ref<number>;
  progressLabel: Vue.Ref<string>;
  activeTransactionCount?: Vue.Ref<number>;
  error: Vue.Ref<string>;
  onComplete?: () => void;
  onError?: (error: Error) => void;
  onIdle?: () => void;
  onCleanup: (cleanupFn: () => void) => void;
}) {
  const {
    txInfos,
    isSubmitting,
    progressPct,
    progressLabel,
    activeTransactionCount,
    error,
    onComplete,
    onError,
    onIdle,
    onCleanup,
  } = args;

  function finishWithError(transactionError: Error): void {
    error.value = transactionError.message;
    isSubmitting.value = false;
    if (activeTransactionCount) activeTransactionCount.value = 0;
    onError?.(transactionError);
  }

  if (txInfos.length > 0) {
    let isCurrent = true;
    const progressByTxId = new Map(
      txInfos.map(txInfo => [
        txInfo.tx.id,
        {
          progressPct: 0,
          progressMessage: 'Preparing transaction...',
        },
      ]),
    );

    error.value = '';
    isSubmitting.value = true;
    if (activeTransactionCount) activeTransactionCount.value = txInfos.length;
    onCleanup(() => {
      isCurrent = false;
    });

    for (const txInfo of txInfos) {
      const unsubscribe = txInfo.subscribeToProgress((progressArgs, progressError) => {
        progressByTxId.set(txInfo.tx.id, {
          progressPct: progressArgs.progressPct,
          progressMessage: progressArgs.progressMessage,
        });

        const slowestProgress = Array.from(progressByTxId.values()).reduce((slowest, current) => {
          if (!slowest || current.progressPct < slowest.progressPct) return current;

          return slowest;
        });

        progressPct.value = slowestProgress?.progressPct ?? 0;
        progressLabel.value =
          txInfos.length > 1
            ? `${slowestProgress?.progressMessage ?? 'Preparing transaction...'} (${txInfos.length} transactions in progress)`
            : (slowestProgress?.progressMessage ?? '');

        if (progressError) error.value = progressError.message;
      });
      onCleanup(unsubscribe);
    }

    if (onComplete || onError) {
      void Promise.all(txInfos.map(txInfo => txInfo.waitForPostProcessing)).then(
        () => {
          if (!isCurrent) return;
          const transactionError = txInfos.map(txInfo => txInfo.getStatus().error).find(Boolean);
          if (transactionError) {
            finishWithError(transactionError);
            return;
          }

          progressPct.value = 100;
          isSubmitting.value = false;
          if (activeTransactionCount) activeTransactionCount.value = 0;
          onComplete?.();
        },
        reason => {
          if (isCurrent) finishWithError(reason as Error);
        },
      );
    }

    return;
  }

  if (activeTransactionCount) activeTransactionCount.value = 0;
  if (!isSubmitting.value) return;

  isSubmitting.value = false;
  progressPct.value = 0;
  progressLabel.value = '';
  onIdle?.();
}
