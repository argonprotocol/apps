import { TxResult } from '@argonprotocol/mainchain';
import { ITransactionRecord, TransactionStatus } from './db/TransactionsTable';
import { IDeferred } from './Utils.ts';
import { TICK_MILLIS } from './Env.ts';
import { BlockProgress } from './BlockProgress.ts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

type IProgressCallbackArgs = {
  progress: number;
  confirmations: number;
  isMaxed: boolean;
};
type IProgressCallback = (args: IProgressCallbackArgs, error?: Error) => void;

const REQUIRED_FINALIZATION_BLOCKS = 4;

export class TransactionInfo {
  public tx: ITransactionRecord;
  public txResult: TxResult;
  public isProcessed: IDeferred;
  public statusAtLoad?: TransactionStatus;

  private progressCallbacks: { runFn: IProgressCallback; unsubscribeFn: () => void }[] = [];
  private blockProgress: BlockProgress;

  constructor(args: { tx: ITransactionRecord; txResult: TxResult; isProcessed: IDeferred }) {
    this.tx = args.tx;
    this.txResult = args.txResult;
    this.statusAtLoad = args.tx.status;
    this.isProcessed = args.isProcessed;

    const timeOfLastBlock = args.tx.lastFinalizedBlockTime ? args.tx.lastFinalizedBlockTime : args.tx.createdAt;

    this.blockProgress = new BlockProgress({
      blockHeightGoal: args.tx.blockHeight,
      blockHeightCurrent: args.tx.lastFinalizedBlockHeight,
      minimumConfirmations: REQUIRED_FINALIZATION_BLOCKS,
      millisPerBlock: TICK_MILLIS,
      timeOfLastBlock: dayjs.utc(timeOfLastBlock),
    });
  }

  public subscribeToProgress(callback: IProgressCallback): () => void {
    if (!this.progressCallbacks.length) {
      this.blockProgress.resetTimeOfLastBlock();
      setTimeout(() => this.updateProgress(), 0);
    }

    const runFn = (args: IProgressCallbackArgs, error?: Error) => callback(args, error);
    const unsubscribeFn = () => {
      this.progressCallbacks = this.progressCallbacks.filter(x => x.runFn !== runFn);
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

  private updateProgress() {
    if (!this.progressCallbacks.length) return;

    this.blockProgress.setIsFinalized(this.tx.isFinalized);
    this.blockProgress.setBlockHeightGoal(this.tx.blockHeight);

    const progress = this.blockProgress.getProgress();
    const confirmations = this.blockProgress.getConfirmations();

    for (const { runFn } of this.progressCallbacks) {
      runFn({ progress, confirmations, isMaxed: this.blockProgress.isMaxed });
    }

    if (progress === 100) {
      this.unsubscribeFromProgress();
    } else {
      const milliPerInterval = Math.max(100, Math.ceil(TICK_MILLIS / 60));
      setTimeout(() => this.updateProgress(), milliPerInterval);
    }
  }
}
