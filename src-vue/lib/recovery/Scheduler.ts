export class FinalizedHistoryScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private queuedBlockNumber = 0;
  private processedBlockNumber = 0;
  private forceQueued = false;
  private runningPromise?: Promise<void>;
  private isClosed = false;
  private retryAttempts = 0;

  constructor(
    private readonly refresh: (finalizedBlockNumber: number, force: boolean) => Promise<number>,
    private readonly delayMs = 30_000,
  ) {}

  public get processedThroughBlock(): number {
    return this.processedBlockNumber;
  }

  public queue(finalizedBlockNumber: number, force = false): void {
    if (!force && finalizedBlockNumber <= Math.max(this.queuedBlockNumber, this.processedBlockNumber)) return;

    const shouldInterruptRetry = this.retryAttempts > 0;
    this.queuedBlockNumber = Math.max(this.queuedBlockNumber, finalizedBlockNumber);
    this.forceQueued ||= force;
    if (shouldInterruptRetry && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedule(shouldInterruptRetry ? 0 : this.delayMs);
  }

  public async runNow(finalizedBlockNumber: number, force = false): Promise<void> {
    this.queue(finalizedBlockNumber, force);
    if (this.runningPromise) {
      await this.runningPromise;
    }
    if (this.isClosed || (!this.forceQueued && this.queuedBlockNumber <= this.processedBlockNumber)) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.run(true);
  }

  public async close(): Promise<void> {
    this.isClosed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.runningPromise;
  }

  private schedule(delayMs = this.delayMs): void {
    if (
      this.isClosed ||
      this.timer ||
      this.runningPromise ||
      (!this.forceQueued && this.queuedBlockNumber <= this.processedBlockNumber)
    ) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delayMs);
  }

  private async run(surfaceError = false): Promise<void> {
    if (this.isClosed) return;
    if (this.runningPromise) return this.runningPromise;

    const finalizedBlockNumber = this.queuedBlockNumber;
    const force = this.forceQueued;
    let nextDelayMs: number | undefined;
    this.forceQueued = false;
    this.runningPromise = (async () => {
      try {
        const reachedBlockNumber = await this.refresh(finalizedBlockNumber, force);
        this.retryAttempts = 0;
        nextDelayMs = this.delayMs;
        this.processedBlockNumber = Math.max(
          this.processedBlockNumber,
          Math.min(reachedBlockNumber, finalizedBlockNumber),
        );
      } catch (error) {
        if (isRetryableHistoryRecoveryError(error)) {
          this.retryAttempts += 1;
          nextDelayMs = this.delayMs * 2 ** Math.min(this.retryAttempts - 1, 2);
        }
        if (surfaceError) throw error;
      } finally {
        this.runningPromise = undefined;
        if (this.isClosed) return;

        const hasNewRequest = this.forceQueued || this.queuedBlockNumber > finalizedBlockNumber;
        if (hasNewRequest) {
          this.schedule(0);
        } else if (nextDelayMs !== undefined) {
          this.schedule(nextDelayMs);
        }
      }
    })();
    await this.runningPromise;
  }
}

function isRetryableHistoryRecoveryError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError' || error instanceof TypeError) return true;

  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|network|timed? out|timeout|unavailable|disconnect|connection|socket|\brpc\b|\b50[0234]\b/i.test(
    message,
  );
}
