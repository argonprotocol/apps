import * as fs from 'node:fs';
import { JsonExt } from '@argonprotocol/commander-core';
import type { ILastModifiedAt } from './interfaces/ILastModified.ts';
import Queue from 'p-queue';

export class JsonStore<T extends Record<string, any> & ILastModifiedAt> {
  private data: T | undefined;
  private defaults!: Omit<T, 'lastModified'>;
  private saveQueue = new Queue({ concurrency: 1 });

  constructor(
    private path: string,
    private defaultsFn: () => Omit<T, 'lastModified'> | Promise<Omit<T, 'lastModified'>>,
  ) {}

  public async mutate(mutateFn: (data: T) => boolean | void | Promise<boolean | void>): Promise<boolean> {
    const result = await this.saveQueue.add(async () => {
      await this.load();
      if (!this.data) {
        this.data = structuredClone(this.defaults) as T;
      }
      const result = await mutateFn(this.data);
      if (result === false) return false;
      this.data.lastModifiedAt = new Date();
      // filter non properties
      this.data = Object.fromEntries(Object.entries(this.data).filter(([key]) => key in this.defaults)) as T;
      await atomicWrite(this.path, JsonExt.stringify(this.data, 2));
      return true;
    });
    return result ?? false;
  }

  public async exists(): Promise<boolean> {
    try {
      const stats = await fs.promises.stat(this.path);
      return stats.isFile();
    } catch (e) {
      return false;
    }
  }

  public async get(): Promise<T | undefined> {
    await this.load();
    return structuredClone(this.data || (this.defaults as T));
  }

  public async close(): Promise<void> {
    await this.saveQueue.onIdle();
  }

  private async load(): Promise<void> {
    this.defaults = await this.defaultsFn();
    if (this.data === undefined) {
      try {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const data = (await fs.promises.readFile(this.path, 'utf-8').then(JsonExt.parse)) as T;
        if (data.lastModifiedAt) {
          data.lastModifiedAt = new Date(data.lastModifiedAt);
        }
        this.data = data;
      } catch {}
    }
  }
}

async function atomicWrite(path: string, contents: string) {
  const tmp = `${path}.tmp`;
  await fs.promises.writeFile(tmp, contents);
  try {
    await fs.promises.rename(tmp, path);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
      console.log(`It seems ${tmp} was already saved... nothing to worry about `);
    } else {
      throw e;
    }
  }
}
