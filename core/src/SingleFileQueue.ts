import { createDeferred, type IDeferred } from './Deferred.js';

export class SingleFileQueue {
  private isRunning: boolean = false;
  private isStopped: boolean = false;
  private queue: { fn: () => Promise<any>; deferred: IDeferred; timeoutMs?: number }[] = [];

  public add<T>(fn: () => Promise<T>, options?: { timeoutMs?: number }): IDeferred<T> {
    const deferred = createDeferred<any>(false);
    if (this.isStopped) {
      deferred.reject(new Error('Queue is stopped'));
      return deferred;
    }
    deferred.promise.catch(err => {
      // Prevent unhandled promise rejection
      if (!this.isStopped) {
        console.error('Error in Queue task:', err);
      }
    });
    this.queue.push({ deferred, fn, timeoutMs: options?.timeoutMs });
    void this.run();
    return deferred;
  }

  public clear(): void {
    this.queue.length = 0;
  }

  public async stop(waitForCompletion: boolean = false): Promise<void> {
    this.isStopped = true;
    if (waitForCompletion) {
      await Promise.allSettled(this.queue.map(x => x.deferred.promise));
    }
    this.queue.length = 0;
  }

  private async runWithTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return promise;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Queue task timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async run() {
    if (this.isRunning) return;
    this.isRunning = true;

    while (this.queue.length > 0) {
      const task = this.queue[0];
      try {
        const result = await this.runWithTimeout(task.fn(), task.timeoutMs);
        task.deferred.resolve(result);
      } catch (err) {
        task.deferred.reject(err);
      } finally {
        this.queue.shift();
      }
      if (this.isStopped) break;
      if (this.queue.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    this.isRunning = false;
  }
}
