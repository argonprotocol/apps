import { createDeferred, type IDeferred } from './Deferred.js';

export class SingleFileQueue {
  private isRunning: boolean = false;
  private isStopped: boolean = false;
  private queue: { fn: () => Promise<any>; deferred: IDeferred }[] = [];

  public add<T>(fn: () => Promise<T>): IDeferred<T> {
    const deferred = createDeferred<any>(false);
    if (this.isStopped) {
      deferred.reject(new Error('Queue is stopped'));
      return deferred;
    }
    this.queue.push({ deferred, fn });
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

  private async run() {
    if (this.isRunning) return;
    this.isRunning = true;

    while (this.queue.length > 0) {
      const task = this.queue[0];
      try {
        const result = await task.fn();
        task.deferred.resolve(result);
      } catch (err) {
        task.deferred.reject(err);
      }
      this.queue.shift();
    }

    this.isRunning = false;
  }
}
