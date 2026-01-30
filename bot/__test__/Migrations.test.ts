import { teardown } from '@argonprotocol/testing';
import { afterAll, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import { Storage } from '../src/Storage.ts';

afterEach(teardown);
afterAll(teardown);

it('can autobid and store stats', async () => {
  const botDataDir = fs.mkdtempSync('/tmp/bot-storage-');
  await fs.promises.rm(botDataDir, { recursive: true, force: true });

  const storage = new Storage(botDataDir);
  await expect(storage.version).resolves.toBe(0);
  await expect(storage.migrate()).resolves.toBeUndefined();
  await expect(storage.version).resolves.toBe(1);
});
