import * as fs from 'node:fs';
import { type ILastModifiedAt, JsonExt } from '@argonprotocol/apps-core';
import Queue from 'p-queue';
import Path from 'node:path';

export class JsonStore<T extends Record<string, any> & ILastModifiedAt> {
  public onMutate: ((data: T) => any)[] = [];
  private data: T | undefined;
  private defaults!: Omit<T, 'lastModified'>;
  private saveQueue = new Queue({ concurrency: 1 });
  private readonly path: string;

  constructor(
    private basedir: string,
    public key: string,
    private defaultsFn: () => Omit<T, 'lastModified'> | Promise<Omit<T, 'lastModified'>>,
    private shouldLog = Boolean(JSON.parse(process.env.ARGON_LOG_STORAGE ?? '0')),
  ) {
    const keyPath = key.endsWith('.json') ? key : `${key}.json`;
    this.path = Path.join(this.basedir, keyPath);
  }

  public async mutate(mutateFn: (data: T) => boolean | void | Promise<boolean | void>): Promise<boolean> {
    const result = await this.saveQueue.add(async () => {
      await this.load();
      const data = structuredClone(this.data ?? this.defaults) as T;
      const result = await mutateFn(data);
      if (result === false) return false;
      data.lastModifiedAt = new Date();
      // filter non properties
      const newData = {} as any;
      const changesProps = {} as any;
      for (const key of Object.keys(this.defaults) as (keyof T)[]) {
        newData[key] = data[key];
        if (this.shouldLog) {
          const oldValue = this.data?.[key];
          if (oldValue !== newData[key] && JsonExt.stringify(oldValue) !== JsonExt.stringify(newData[key])) {
            changesProps[key] = [oldValue, newData[key]];
          }
        }
      }
      if (this.shouldLog) {
        console.log(`[JsonStore]: Saving changes to ${this.key}:`, changesProps);
      }
      this.data = newData;
      for (const fn of this.onMutate) {
        fn(newData);
      }
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

  public async get(): Promise<T> {
    await this.load();
    return structuredClone(this.data || (this.defaults as T));
  }

  public async close(): Promise<void> {
    await this.saveQueue.onIdle();
  }

  private async load(): Promise<void> {
    this.defaults ??= await this.defaultsFn();
    if (this.data === undefined) {
      try {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const data = (await fs.promises.readFile(this.path, 'utf-8').then(JsonExt.parse)) as T;
        if (data.lastModifiedAt) {
          data.lastModifiedAt = new Date(data.lastModifiedAt);
        }
        for (const [key, value] of Object.entries(this.defaults)) {
          if (value instanceof Date && data[key]) {
            (data as any)[key] = new Date(value);
          }
        }
        this.data = data;
      } catch {}
    }
  }
}

export async function atomicWrite(path: string, contents: string) {
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
