import * as fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { expect, it, vi } from 'vitest';
import { type IBotStateFile, JsonExt } from '@argonprotocol/apps-core';
import { JsonStore } from '../src/JsonStore.ts';

it.for(['EISDIR', 'ENOENT'])('preserves the checkpoint after %s and publishes a successful retry', async errorCode => {
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

    if (errorCode === 'EISDIR') {
      fs.mkdirSync(pendingPath);
    } else {
      const rename = fs.promises.rename;
      vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => {
        await fs.promises.rm(from, { force: true });
        await rename(from, to);
      });
    }

    const saving = store.mutate(state => {
      state.lastProcessedBlockNumber += 1;
      state.lastProcessedBlockHash = `hash-${state.lastProcessedBlockNumber}`;
    });
    if (errorCode === 'ENOENT') await expect(saving).resolves.toBe(false);
    else await expect(saving).rejects.toThrow();
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
    vi.restoreAllMocks();
    await store.close();
    fs.rmSync(basedir, { recursive: true, force: true });
  }
});
