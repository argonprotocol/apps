import * as fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { expect, it } from 'vitest';
import { type IBotStateFile, JsonExt } from '@argonprotocol/apps-core';
import { JsonStore } from '../src/JsonStore.ts';

it('preserves the checkpoint after a failed write and publishes a successful retry', async () => {
  const basedir = fs.mkdtempSync(Path.join(os.tmpdir(), 'bot-checkpoint-write-'));
  const defaults = () => ({ lastProcessedBlockNumber: 100, lastProcessedBlockHash: 'hash-100' });
  const store = new JsonStore<Pick<IBotStateFile, 'lastProcessedBlockNumber' | 'lastProcessedBlockHash'>>(
    basedir,
    'bot-state',
    defaults,
  );
  const statePath = Path.join(basedir, 'bot-state.json');
  const pendingPath = `${statePath}.tmp`;
  const published: number[] = [];

  try {
    await store.mutate(() => undefined);
    const saved = await store.get();
    store.onMutate.push(state => published.push(state.lastProcessedBlockNumber));

    fs.mkdirSync(pendingPath);

    await expect(
      store.mutate(state => {
        state.lastProcessedBlockNumber += 1;
        state.lastProcessedBlockHash = `hash-${state.lastProcessedBlockNumber}`;
      }),
    ).rejects.toThrow();
    expect(await store.get()).toEqual(saved);
    expect(JsonExt.parse(fs.readFileSync(statePath, 'utf8'))).toEqual(saved);
    expect(published).toEqual([]);

    fs.rmSync(pendingPath, { recursive: true, force: true });
    await store.mutate(state => {
      state.lastProcessedBlockNumber += 1;
      state.lastProcessedBlockHash = `hash-${state.lastProcessedBlockNumber}`;
    });
    expect(published).toEqual([101]);

    const restarted = new JsonStore(basedir, 'bot-state', defaults);
    expect(await restarted.get()).toEqual({ lastProcessedBlockNumber: 101, lastProcessedBlockHash: 'hash-101' });
    await restarted.close();
  } finally {
    await store.close();
    fs.rmSync(basedir, { recursive: true, force: true });
  }
});
