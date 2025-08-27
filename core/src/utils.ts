import BigNumber from 'bignumber.js';

export { formatArgons } from '@argonprotocol/mainchain';

export function formatArgonots(x: bigint | number): number {
  const isNegative = x < 0;
  const [whole, decimal] = (Math.abs(Number(x)) / 1e6).toFixed(2).split('.');
  if (decimal === '00') {
    return Number(`${isNegative ? '-' : ''}${BigInt(whole)}`);
  }
  const wholeNumber = BigInt(whole);
  return Number(`${isNegative ? '-' : ''}${wholeNumber}.${decimal}`);
}

export function formatPercent(x: BigNumber | undefined): string {
  if (!x) return 'na';
  return `${x.times(100).toFixed(3)}%`;
}

export function bigIntMin(...args: Array<bigint | null>): bigint {
  if (args.length === 0) throw new Error('minBigInt requires at least one argument');
  return args.filter(x => x !== null).reduce((min, current) => (current < min ? current : min));
}

export function bigIntMax(...args: Array<bigint | null>): bigint {
  if (args.length === 0) throw new Error('bigIntMax requires at least one argument');
  return args.filter(x => x !== null).reduce((max, current) => (current > max ? current : max));
}

export function bigIntAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
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

export function createNanoEvents<Events extends EventsMap = DefaultEvents>(): TypedEmitter<Events> {
  return new TypedEmitter<Events>();
}

export class TypedEmitter<Events extends EventsMap = DefaultEvents> {
  private events: Partial<{ [E in keyof Events]: Events[E][] }> = {};

  emit<K extends keyof Events>(this: this, event: K, ...args: Parameters<Events[K]>): void {
    for (const cb of this.events[event] || []) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      cb(...args);
    }
  }

  on<K extends keyof Events>(this: this, event: K, cb: Events[K]): () => void {
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
