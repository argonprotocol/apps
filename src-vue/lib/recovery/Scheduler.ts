export class FinalizedHistoryScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private queuedBlockNumber = 0;
  private processedBlockNumber = 0;
  private forceQueued = false;
  private runningPromise?: Promise<void>;
  private isClosed = false;

  constructor(
    private readonly refresh: (finalizedBlockNumber: number, force: boolean) => Promise<number>,
    private readonly delayMs = 30_000,
  ) {}

  public get processedThroughBlock(): number {
    return this.processedBlockNumber;
  }

  public queue(finalizedBlockNumber: number, force = false): void {
    if (!force && finalizedBlockNumber <= Math.max(this.queuedBlockNumber, this.processedBlockNumber)) return;

    this.queuedBlockNumber = Math.max(this.queuedBlockNumber, finalizedBlockNumber);
    this.forceQueued ||= force;
    this.schedule();
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
    let didFail = false;
    this.forceQueued = false;
    this.runningPromise = (async () => {
      try {
        const reachedBlockNumber = await this.refresh(finalizedBlockNumber, force);
        this.processedBlockNumber = Math.max(
          this.processedBlockNumber,
          Math.min(reachedBlockNumber, finalizedBlockNumber),
        );
      } catch (error) {
        didFail = true;
        if (surfaceError) throw error;
      } finally {
        this.runningPromise = undefined;
        if (this.isClosed) return;

        const hasNewRequest = this.forceQueued || this.queuedBlockNumber > finalizedBlockNumber;
        // A newer finalized block or an explicit retry can try again. Do not
        // hammer the same permanently undecodable block every delay interval.
        if (!didFail || hasNewRequest) this.schedule(hasNewRequest ? 0 : this.delayMs);
      }
    })();
    await this.runningPromise;
  }
}
