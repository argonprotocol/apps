import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { SingleFileQueue } from '../src/SingleFileQueue.ts';

describe('SingleFileQueue', () => {
  it('rejects queued tasks on stop(true) while allowing the active task to finish', async () => {
    const queue = new SingleFileQueue();
    let resolveFirst!: () => void;

    const first = queue.add(
      () =>
        new Promise<void>(resolve => {
          resolveFirst = resolve;
        }),
    );
    const second = queue.add(async () => 'second');

    const stopPromise = queue.stop(true);
    await sleep(0);

    await expect(second.promise).rejects.toThrow('Queue is stopped');

    resolveFirst();

    await expect(first.promise).resolves.toBeUndefined();
    await expect(stopPromise).resolves.toBeUndefined();
  });
});
