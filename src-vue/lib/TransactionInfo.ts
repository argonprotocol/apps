import { ITransactionRecord, TransactionStatus } from './db/TransactionsTable';
import { createDeferred, IDeferred, TxResult } from '@argonprotocol/apps-core';
import { TICK_MILLIS } from './Env.ts';
import { BlockProgress } from './BlockProgress.ts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

type IProgressCallbackArgs = {
  progressPct: number;
  progressMessage: string;
  confirmations: number;
  expectedConfirmations: number;
  isMaxed: boolean;
};
type IProgressCallback = (args: IProgressCallbackArgs, error?: Error) => void | Promise<void>;

const REQUIRED_FINALIZATION_BLOCKS = 4;

export function getArgonFinalityBlocks() {
  return REQUIRED_FINALIZATION_BLOCKS;
}

export function getArgonFinalityMillis() {
  return getArgonFinalityBlocks() * TICK_MILLIS;
}

export class TransactionInfo<MetadataType = unknown> {
  public tx: ITransactionRecord<MetadataType>;
  public txResult: TxResult;
  public statusAtLoad?: TransactionStatus;

  public get isPostProcessed(): boolean {
    return this.postProcessor?.isSettled ?? true;
  }

  public get hasPendingPostProcessing(): boolean {
    return this.postProcessor ? !this.postProcessor.isSettled : false;
  }

  public get hasFailedPostProcessing(): boolean {
    return this.postProcessor?.isRejected ?? false;
  }

  public get waitForPostProcessing(): Promise<void> {
    return this.postProcessor?.promise ?? this.txResult.waitForFinalizedBlock.then(() => undefined);
  }

  public get followOnTxInfo(): Promise<TransactionInfo | undefined> {
    return this.followOnTxInfoDeferred?.promise ?? Promise.resolve(undefined);
  }

  private postProcessor?: IDeferred;
  private followOnTxInfoDeferred?: IDeferred<TransactionInfo>;
  private resolvedFollowOnTxInfo?: TransactionInfo;

  private progressCallbacks: { runFn: IProgressCallback; unsubscribeFn: () => void }[] = [];
  private blockProgress: BlockProgress;

  constructor(args: { tx: ITransactionRecord; txResult: TxResult }) {
    this.tx = args.tx;
    this.txResult = args.txResult;
    this.statusAtLoad = args.tx.status;

    const timeOfLastBlock = args.tx.finalizedHeadTime ? args.tx.finalizedHeadTime : args.tx.createdAt;
    const includedAtBlockHeight = args.tx.blockHeight;
    const finalizedHeadHeight = args.tx.finalizedHeadHeight;

    this.blockProgress = new BlockProgress({
      blockHeightGoal: includedAtBlockHeight,
      blockHeightCurrent: finalizedHeadHeight,
      minimumConfirmations: REQUIRED_FINALIZATION_BLOCKS,
      millisPerBlock: TICK_MILLIS,
      timeOfLastBlock: dayjs.utc(timeOfLastBlock),
    });
  }

  public createPostProcessor(): IDeferred {
    if (!this.postProcessor || this.postProcessor.isRejected) {
      this.postProcessor = createDeferred(false);
      void this.postProcessor.promise.then(
        () => this.updateProgress(),
        () => this.updateProgress(),
      );
    }

    return this.postProcessor;
  }

  public registerDeferredFollowOnTx<L>(): IDeferred<TransactionInfo<L>> {
    if (!this.followOnTxInfoDeferred) {
      this.followOnTxInfoDeferred = createDeferred<TransactionInfo<L>>(false);
      void this.followOnTxInfoDeferred.promise
        .then(x => {
          this.resolvedFollowOnTxInfo = x;
          this.updateProgress();
        })
        .catch(() => {
          this.updateProgress();
        });
    }

    return this.followOnTxInfoDeferred as IDeferred<TransactionInfo<L>>;
  }

  public subscribeToProgress(callback: IProgressCallback): () => void {
    if (!this.progressCallbacks.length) {
      this.blockProgress.resetTimeOfLastBlock();
      setTimeout(() => this.updateProgress(), 0);
    }

    const runFn = (args: IProgressCallbackArgs, error?: Error) => callback(args, error);
    const unsubscribeFn = () => {
      const index = this.progressCallbacks.findIndex(x => x.runFn === runFn);
      if (index !== -1) {
        this.progressCallbacks.splice(index, 1);
      }
    };

    this.progressCallbacks.push({ runFn, unsubscribeFn });

    return unsubscribeFn;
  }

  public unsubscribeFromProgress() {
    if (!this.progressCallbacks.length) return;
    this.progressCallbacks = [];
  }

  public set finalizedHeadHeight(value: number) {
    this.blockProgress.setCurrentBlockHeight(value);
  }

  private getWaitingForFinalizationMessage(status: {
    expectedConfirmations: number;
    confirmations: number;
    isFinalized: boolean;
  }): string {
    const { expectedConfirmations, confirmations, isFinalized } = status;
    if (isFinalized) {
      return `Finalized in Block #${this.tx.blockHeight}`;
    }

    if (confirmations === -1) {
      if (this.tx.blockHeight) {
        return `Included in Block #${this.tx.blockHeight} · Waiting for Finalization...`;
      }
      return 'Waiting for 1st Block...';
    } else if (confirmations === 0 && expectedConfirmations > 0) {
      return 'Waiting for 2nd Block...';
    } else if (confirmations === 1 && expectedConfirmations > 1) {
      return 'Waiting for 3rd Block...';
    } else if (confirmations === 2 && expectedConfirmations > 2) {
      return 'Waiting for 4th Block...';
    } else if (confirmations === 3 && expectedConfirmations > 3) {
      return 'Waiting for 5th Block...';
    } else if (confirmations === 4 && expectedConfirmations > 4) {
      return 'Waiting for 6th Block...';
    } else if (confirmations === 5 && expectedConfirmations > 5) {
      return 'Waiting for 7th Block...';
    } else if (confirmations === 6 && expectedConfirmations > 6) {
      return 'Waiting for 8th Block...';
    } else {
      return 'Waiting for Finalization...';
    }
  }

  public getStatus() {
    const isFinalized = this.tx.isFinalized || this.txResult.isFinalized;

    this.blockProgress.setIsFinalized(isFinalized);
    this.blockProgress.setBlockHeightGoal(this.tx.blockHeight);
    const progress = this.blockProgress.getProgress();
    let progressPct = progress.progressPct;
    const confirmations = this.blockProgress.getConfirmations();
    const expectedConfirmations = this.blockProgress.expectedConfirmations;

    if (progressPct > 99 && this.postProcessor && !this.postProcessor.isSettled) {
      progressPct = 99;
    }

    const error = this.txResult.submissionError ?? this.txResult.extrinsicError;
    return {
      progressPct,
      confirmations,
      expectedConfirmations,
      error,
      isFinalized,
      isMaxed: progress.isMaxed,
    };
  }

  private updateProgress() {
    if (!this.progressCallbacks.length) return;

    const status = this.getStatus();

    if (this.followOnTxInfoDeferred && this.resolvedFollowOnTxInfo) {
      const currentBlockHeight = this.blockProgress.blockHeightCurrent;
      if (currentBlockHeight !== undefined) this.resolvedFollowOnTxInfo.finalizedHeadHeight = currentBlockHeight;
      const followOnStatus = this.resolvedFollowOnTxInfo.getStatus();
      console.log('Merging follow-on tx status', { followOnStatus, status });
      if (followOnStatus) {
        status.progressPct = (followOnStatus.progressPct + status.progressPct) / 2;
        status.confirmations = followOnStatus.confirmations;
        status.expectedConfirmations = followOnStatus.expectedConfirmations;
        status.isFinalized &&= followOnStatus.isFinalized;
      }
    }

    const progressMessage = this.getWaitingForFinalizationMessage(status);
    for (const { runFn } of this.progressCallbacks) {
      try {
        void runFn({ ...status, progressMessage }, status.error);
      } catch (e) {
        console.error('Error in transaction progress callback', e);
      }
    }

    if (status.progressPct === 100) {
      this.unsubscribeFromProgress();
    } else {
      const milliPerInterval = Math.max(100, Math.ceil(TICK_MILLIS / 60));
      setTimeout(() => this.updateProgress(), milliPerInterval);
    }
  }
}

export function getTransactionFailureMessage(txInfo?: TransactionInfo): string | undefined {
  if (!txInfo) return undefined;

  const submissionError = txInfo.txResult.submissionError;
  if (submissionError) return submissionError.message || String(submissionError);

  const extrinsicError = txInfo.txResult.extrinsicError;
  if (extrinsicError) {
    return extrinsicError.message || String(extrinsicError);
  }

  if ([TransactionStatus.Error, TransactionStatus.TimedOutWaitingForBlock].includes(txInfo.tx.status)) {
    return `Transaction ended with status ${txInfo.tx.status}.`;
  }

  return undefined;
}
