import { ExtrinsicError, TxResult } from '@argonprotocol/mainchain';
import { ITransactionRecord, TransactionStatus } from './db/TransactionsTable';
import { createDeferred, IDeferred } from './Utils.ts';
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

export class TransactionInfo<MetadataType = unknown> {
  public tx: ITransactionRecord<MetadataType>;
  public txResult: TxResult;
  public statusAtLoad?: TransactionStatus;

  public get isPostProcessed(): boolean {
    return this.postProcessor?.isSettled ?? true;
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

    const timeOfLastBlock = args.tx.lastFinalizedBlockTime ? args.tx.lastFinalizedBlockTime : args.tx.createdAt;

    this.blockProgress = new BlockProgress({
      blockHeightGoal: args.tx.blockHeight,
      blockHeightCurrent: args.tx.lastFinalizedBlockHeight,
      minimumConfirmations: REQUIRED_FINALIZATION_BLOCKS,
      millisPerBlock: TICK_MILLIS,
      timeOfLastBlock: dayjs.utc(timeOfLastBlock),
    });
  }

  public createPostProcessor(): IDeferred {
    if (!this.postProcessor) {
      this.postProcessor = createDeferred(false);
      void this.postProcessor.promise.finally(() => this.updateProgress());
    }

    return this.postProcessor;
  }

  public registerDeferredFollowOnTx<L>(): IDeferred<TransactionInfo<L>> {
    if (!this.followOnTxInfoDeferred) {
      this.followOnTxInfoDeferred = createDeferred<TransactionInfo<L>>(false);
      void this.followOnTxInfoDeferred.promise
        .then(x => {
          this.resolvedFollowOnTxInfo = x;
        })
        .finally(() => this.updateProgress());
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

  public set finalizedBlockHeight(value: number) {
    this.blockProgress.setCurrentBlockHeight(value);
  }

  private translateCommonErrors(error: ExtrinsicError | Error): string {
    let errorCode: string | undefined;
    if (error instanceof ExtrinsicError) {
      errorCode = error.errorCode;
      if (errorCode.includes('{')) {
        try {
          const parsed = JSON.parse(errorCode);
          errorCode = Object.values(parsed)[0] as string;

          if (errorCode === 'FundsUnavailable') {
            return 'Transaction failed due to insufficient funds. Please ensure your account has enough balance to cover the transaction fees.';
          }
          if (errorCode === 'BelowMinimum') {
            return 'Transaction failed because this change would leave too little balance in your account afterwards to preserve it.';
          }
          if (errorCode === 'BadOrigin') {
            return 'Transaction failed due to bad origin. Please check your permissions and try again.';
          }
          if (errorCode === 'NonceTooLow') {
            return 'Transaction nonce is too low. This may be due to a pending transaction. Please wait a moment and try again.';
          }
          if (errorCode === 'PriorityTooLow') {
            return 'Transaction priority is too low. Please try increasing the transaction fee or tip to prioritize it.';
          }
          return `Transaction failed with error code: ${errorCode}`;
        } catch (_e) {
          // ignore
        }
      }
      return error.details || `Transaction failed with error code: ${errorCode}`;
    }
    return error.message;
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
    this.blockProgress.setIsFinalized(this.tx.isFinalized);
    this.blockProgress.setBlockHeightGoal(this.tx.blockHeight);
    const progressPct = this.blockProgress.getProgress();
    const confirmations = this.blockProgress.getConfirmations();
    const expectedConfirmations = this.blockProgress.expectedConfirmations;

    const error = this.txResult.submissionError ?? this.txResult.extrinsicError;

    return {
      progressPct,
      confirmations,
      expectedConfirmations,
      error,
      isFinalized: this.tx.isFinalized,
      isMaxed: this.blockProgress.isMaxed,
    };
  }

  private updateProgress() {
    if (!this.progressCallbacks.length) return;

    const status = this.getStatus();

    if (this.followOnTxInfoDeferred && this.resolvedFollowOnTxInfo) {
      const currentBlockHeight = this.blockProgress.blockHeightCurrent;
      if (currentBlockHeight !== undefined) this.resolvedFollowOnTxInfo.finalizedBlockHeight = currentBlockHeight;
      const followOnStatus = this.resolvedFollowOnTxInfo.getStatus();
      console.log('Merging follow-on tx status', { followOnStatus, status });
      if (followOnStatus) {
        status.progressPct = (followOnStatus.progressPct + status.progressPct) / 2;
        status.confirmations = followOnStatus.confirmations;
        status.expectedConfirmations = followOnStatus.expectedConfirmations;
        status.isFinalized &&= followOnStatus.isFinalized;
      }
    }

    if (status.progressPct > 99 && this.postProcessor && !this.postProcessor.isSettled) {
      status.progressPct = 99;
    }

    const progressMessage = this.getWaitingForFinalizationMessage(status);
    const error = status.error;
    const errorMessage = error ? this.translateCommonErrors(error) : undefined;
    for (const { runFn } of this.progressCallbacks) {
      try {
        void runFn({ ...status, progressMessage }, errorMessage ? new Error(errorMessage) : undefined);
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
