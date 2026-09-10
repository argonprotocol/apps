import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

export class BlockProgress {
  public blockHeightCurrent: number | undefined;
  private minimumConfirmations: number;
  private millisPerBlock: number;
  private blockHeightGoal: number | undefined;

  private timeOfLastBlock: dayjs.Dayjs;

  private isFinalized: boolean = false;
  private expectedConfirmationsAtInclusion: number | undefined;

  constructor(args: {
    blockHeightGoal: number | undefined;
    blockHeightCurrent?: number;
    minimumConfirmations: number;
    millisPerBlock: number;
    timeOfLastBlock?: dayjs.Dayjs;
  }) {
    this.blockHeightGoal = args.blockHeightGoal;
    this.blockHeightCurrent = args.blockHeightCurrent;
    this.minimumConfirmations = args.minimumConfirmations;
    this.millisPerBlock = args.millisPerBlock;
    this.timeOfLastBlock = args.timeOfLastBlock || dayjs().utc();
    this.captureExpectedConfirmations();
  }

  public get expectedConfirmations(): number {
    return this.expectedConfirmationsAtInclusion ?? this.minimumConfirmations;
  }

  public setCurrentBlockHeight(value: number) {
    if (value === this.blockHeightCurrent) return;
    this.blockHeightCurrent = value;
    this.captureExpectedConfirmations();
    this.resetTimeOfLastBlock();
  }

  public setIsFinalized(value: boolean) {
    this.isFinalized = value;
  }

  public setBlockHeightGoal(value: number | undefined) {
    if (value) {
      this.blockHeightGoal = value;
      this.captureExpectedConfirmations();
    }
  }

  public getProgress(): { progressPct: number; isMaxed: boolean } {
    if (!this.blockHeightCurrent || !this.blockHeightGoal) {
      const maxPercentBeforeBlockHeight = 10;
      return this.calculateProgress(0, maxPercentBeforeBlockHeight);
    }
    if (this.isFinalized) {
      return { progressPct: 100, isMaxed: true };
    }

    const confirmations = this.getConfirmations();
    const requiredFinalizationSteps = this.expectedConfirmations + 1; // +1 for the block the transaction was included in
    const minBlockPercent = ((100 * confirmations) / requiredFinalizationSteps) * 0.9 + 10;
    const maxBlockPercent = ((100 * (confirmations + 1)) / requiredFinalizationSteps) * 0.9 + 10;

    return this.calculateProgress(minBlockPercent, maxBlockPercent);
  }

  public getConfirmations(): number {
    if (!this.blockHeightCurrent || !this.blockHeightGoal) {
      return -1;
    }

    if (this.isFinalized) {
      return this.expectedConfirmations;
    }

    const elapsedBlocksSince = this.blockHeightCurrent - (this.blockHeightGoal - this.expectedConfirmations);

    return Math.max(0, elapsedBlocksSince);
  }

  public resetTimeOfLastBlock() {
    this.timeOfLastBlock = dayjs().utc();
  }

  private calculateProgress(minPercent: number, maxPercent: number): { progressPct: number; isMaxed: boolean } {
    // Clamp elapsed time to 0-1 minute range
    const now = dayjs().utc();
    const elapsedMillis = now.diff(this.timeOfLastBlock, 'millisecond');
    const elapsedBlocks = elapsedMillis / this.millisPerBlock;
    const clampedMillis = Math.min(1, Math.max(0, elapsedBlocks));

    // Linear interpolation: 0 minutes -> minPercent, 1 minute -> maxPercent
    const progressTmp = minPercent + clampedMillis * (maxPercent - minPercent);
    const progressPct = Math.min(99, Math.max(minPercent, progressTmp));
    const isMaxed = progressPct === 99 || progressPct >= maxPercent;

    return { progressPct, isMaxed };
  }

  private captureExpectedConfirmations(): void {
    if (this.expectedConfirmationsAtInclusion !== undefined || !this.blockHeightCurrent || !this.blockHeightGoal)
      return;
    const elapsedBlocks = this.blockHeightGoal - this.blockHeightCurrent;
    this.expectedConfirmationsAtInclusion = Math.max(elapsedBlocks, this.minimumConfirmations);
  }
}
