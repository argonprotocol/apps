import BigNumber from 'bignumber.js';
import { createDeferred, type IDeferred } from './Deferred.js';

export { formatArgons } from '@argonprotocol/mainchain';

export function formatPercent(x: BigNumber | undefined): string {
  if (!x) return 'na';
  return `${x.times(100).toFixed(3)}%`;
}

export function bigIntMin(...args: Array<bigint | null>): bigint {
  if (args.length === 0) return 0n;
  return args.filter(x => x !== null).reduce((min, current) => (current < min ? current : min)) ?? 0n;
}

export function bigIntMax(...args: Array<bigint | null>): bigint {
  if (args.length === 0) return 0n;
  return args.filter(x => x !== null).reduce((max, current) => (current > max ? current : max)) ?? 0n;
}

export function bigIntCeil(x: bigint, unit: bigint): bigint {
  return ((x + unit - 1n) / unit) * unit;
}

export function bigIntAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export function roundTo(x: number | bigint, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(Number(x) * factor) / factor;
}

export function ceilTo(x: number | bigint, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.ceil(Number(x) * factor) / factor;
}

export function bigNumberToInteger(bn: BigNumber): number {
  return bn.integerValue(BigNumber.ROUND_DOWN).toNumber();
}

export function bigNumberToBigInt(bn: BigNumber): bigint {
  return BigInt(bn.integerValue(BigNumber.ROUND_DOWN).toString());
}

export function convertBigIntStringToNumber(bigIntStr: string | undefined): bigint | undefined {
  if (bigIntStr === undefined) return undefined;
  if (!bigIntStr) return 0n;
  // The string is formatted as "1234567890n"
  return BigInt(bigIntStr.slice(0, -1));
}

/**
 * JSON with support for BigInt in JSON.stringify and JSON.parse
 */
export class JsonExt {
  public static stringify(obj: any, space?: number): string {
    return JSON.stringify(
      obj,
      (_, v) => {
        if (typeof v === 'bigint') {
          return `${v}n`; // Append 'n' to indicate BigInt
        }
        // convert Uint8Array objects to a JSON representation
        if (v instanceof Uint8Array) {
          return {
            type: 'Buffer',
            data: Array.from(v), // Convert Uint8Array to an array of numbers
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return v;
      },
      space,
    );
  }

  public static parse<T = any>(str: string): T {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return JSON.parse(str, (_, v) => {
      if (typeof v === 'string' && v.match(/^-?\d+n$/)) {
        return BigInt(v.slice(0, -1));
      }
      // rehydrate Uint8Array objects
      if (typeof v === 'object' && v !== null && v.type === 'Buffer' && Array.isArray(v.data)) {
        return Uint8Array.from(v.data);
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return v;
    });
  }
}

export function getPercent(value: bigint | number, total: bigint | number): number {
  if (total === 0n || total === 0 || value === 0n || value === 0) return 0;
  return BigNumber(value).dividedBy(total).multipliedBy(100).toNumber();
}

export function percentOf(value: bigint | number, percentOf100: number | bigint): bigint {
  return bigNumberToBigInt(BigNumber(value).multipliedBy(percentOf100).dividedBy(100));
}

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

export function createTypedEventEmitter<Events extends EventsMap = DefaultEvents>(): TypedEmitter<Events> {
  return new TypedEmitter<Events>();
}

export class TypedEmitter<Events extends EventsMap = DefaultEvents> {
  private events: Partial<{ [E in keyof Events]: Events[E][] }> = {};

  public emit<K extends keyof Events>(this: this, event: K, ...args: Parameters<Events[K]>): void {
    for (const cb of this.events[event] || []) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      cb(...args);
    }
  }

  public on<K extends keyof Events>(this: this, event: K, cb: Events[K]): () => void {
    (this.events[event] ||= []).push(cb);
    return () => {
      this.events[event] = this.events[event]?.filter(i => cb !== i);
    };
  }
}

interface EventsMap {
  [event: string]: any;
}

interface DefaultEvents extends EventsMap {
  [event: string]: (...args: any) => void;
}

type NonNullableProps<T> = {
  [K in keyof T]-?: Exclude<T[K], undefined | null>;
};

export function filterUndefined<T extends Record<string, any>>(obj: Partial<T>): NonNullableProps<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, value]) => value !== undefined && value !== null),
  ) as NonNullableProps<T>;
}
