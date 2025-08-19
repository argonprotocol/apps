import { JsonExt, u8aToHex } from '@argonprotocol/mainchain';
import { ed25519DeriveHard, keyExtractSuri, mnemonicToMiniSecret } from '@polkadot/util-crypto';
import { jsonParseWithBigIntsEnhanced, jsonStringifyWithBigIntsEnhanced } from '@argonprotocol/commander-calculator';
import { IFieldTypes } from './db/BaseTable.ts';

export function isInt(n: any) {
  if (typeof n === 'string') return !n.includes('.');
  return n % 1 === 0;
}

export function abreviateAddress(address: string, length = 4) {
  return address.slice(0, 6) + '...' + address.slice(-length);
}

export function calculateAPR(costs: bigint, rewards: bigint): number {
  if (costs === 0n && rewards > 0n) return 10_000;
  if (costs === 0n) return 0;

  const tenDayRate = Number(((rewards - costs) * 100_000n) / costs) / 100_000;
  // Compound APR over 36.5 cycles (10-day periods in a year)
  const apr = tenDayRate * 36.5 * 100;
  return Math.max(apr, -100);
}

export function calculateAPY(costs: bigint, rewards: bigint): number {
  if (costs === 0n && rewards > 0n) return 10_000;
  if (costs === 0n) return 0;

  const tenDayRate = Number(((rewards - costs) * 100_000n) / costs) / 100_000;
  // Compound APR over 36.5 cycles (10-day periods in a year)
  const apy = (Math.pow(1 + tenDayRate, 36.5) - 1) * 100;
  if (apy > 10_000) {
    return 10_000;
  }
  return apy;
}

export function convertBigIntStringToNumber(bigIntStr: string | undefined): bigint | undefined {
  if (bigIntStr === undefined) return undefined;
  if (!bigIntStr) return 0n;
  // The string is formatted as "1234567890n"
  return BigInt(bigIntStr.slice(0, -1));
}

export function isBigIntString(value: any): boolean {
  return typeof value === 'string' && /^\d+n$/.test(value);
}

export function toSqlParams(
  params: (bigint | number | string | Uint8Array | boolean | object | undefined)[],
): (string | number | Uint8Array | null)[] {
  return params.map(param => {
    if (param === undefined || param === null) {
      return null; // SQLite uses null for undefined values
    }
    if (typeof param === 'boolean') {
      return toSqliteBoolean(param);
    } else if (typeof param === 'bigint') {
      return param.toString();
    } else if (typeof param === 'object') {
      return jsonStringifyWithBigIntsEnhanced(param);
    }
    return param;
  });
}

export function toSqliteBoolean(bool: boolean): number {
  return bool ? 1 : 0;
}

export function fromSqliteBoolean(num: number): boolean {
  return num === 1;
}

export function toSqliteBigInt(num: bigint): number {
  return Number(num);
}

export function fromSqliteBigInt(num: number): bigint {
  try {
    return BigInt(Math.floor(num));
  } catch (e) {
    console.log('num', num);
    console.error('Error converting sqlite bigint', e);
    throw e;
  }
}

export function convertSqliteBooleans<T = any>(obj: any, booleanFields: string[]): T {
  // Handle array of objects
  if (Array.isArray(obj)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return obj.map(item => convertSqliteBooleans(item, booleanFields)) as T;
  }

  // Handle single object
  return booleanFields.reduce((acc, fieldName) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    if (!(fieldName in obj)) return acc;
    acc[fieldName] = fromSqliteBoolean(obj[fieldName]);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return acc;
  }, obj) as T;
}

export function convertSqliteBigInts<T = any>(obj: any, bigIntFields: string[]): T {
  // Handle array of objects
  if (Array.isArray(obj)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return obj.map(item => convertSqliteBigInts(item, bigIntFields)) as T;
  }

  // Handle single object
  return bigIntFields.reduce((acc, fieldName) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    if (!(fieldName in obj)) return acc;
    acc[fieldName] = fromSqliteBigInt(obj[fieldName]);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return acc;
  }, obj) as T;
}

export function convertFromSqliteFields<T = any>(obj: any, fields: Partial<Record<keyof IFieldTypes, string[]>>): T {
  // Handle array of objects
  if (Array.isArray(obj)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return obj.map(item => convertFromSqliteFields(item, fields)) as T;
  }

  // Handle single object
  for (const [type, fieldNames] of Object.entries(fields)) {
    for (const fieldName of fieldNames) {
      if (!(fieldName in obj)) continue;
      const value = obj[fieldName];
      if (value === null || value === undefined) continue;
      if (type === 'bigint') {
        obj[fieldName] = fromSqliteBigInt(value);
      } else if (type === 'boolean') {
        obj[fieldName] = fromSqliteBoolean(value);
      } else if (type === 'bigintJson') {
        obj[fieldName] = jsonParseWithBigIntsEnhanced(value);
      } else if (type === 'json') {
        obj[fieldName] = JsonExt.parse(value);
      } else if (type === 'date') {
        obj[fieldName] = new Date(value);
      } else {
        throw new Error(`${fieldName} has unknown type: ${type}`);
      }
    }
  }
  return obj as T;
}

export function createDeferred<T = void>(isRunning: boolean = true): IDeferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  let isResolved = false;
  let isRejected = false;

  const promise = new Promise<T>((res, rej) => {
    resolve = (value: T) => {
      isResolved = true;
      isRunning = false;
      res(value);
    };
    reject = (reason?: unknown) => {
      isRejected = true;
      isRunning = false;
      rej(reason);
    };
  });

  const setIsRunning = (x: boolean) => (isRunning = x);

  // Create the object with arrow functions to avoid 'this' binding issues
  const deferred: IDeferred<T> = {
    resolve: (value: T) => resolve(value),
    reject: (reason?: unknown) => reject(reason),
    promise,
    setIsRunning,
    get isResolved() {
      return isResolved;
    },
    get isRejected() {
      return isRejected;
    },
    get isRunning() {
      return isRunning;
    },
    get isSettled() {
      return isResolved || isRejected;
    },
  };

  return deferred;
}

export type IDeferred<T = void> = {
  resolve(this: void, value: T): void;
  reject(this: void, reason?: unknown): void;
  setIsRunning(this: void, isRunning: boolean): void;
  promise: Promise<T>;
  readonly isResolved: boolean;
  readonly isRejected: boolean;
  readonly isRunning: boolean;
  readonly isSettled: boolean;
};

export function ensureOnlyOneInstance(constructor: any) {
  if (constructor.isInitialized) {
    console.log(new Error().stack);
    throw new Error(`${constructor.name} already initialized`);
  }
  constructor.isInitialized = true;
}

export function resetOnlyOneInstance(constructor: any) {
  constructor.isInitialized = false;
}

export function miniSecretFromUri(uri: string, password?: string): string {
  const { phrase, path } = keyExtractSuri(uri);
  let mini = mnemonicToMiniSecret(phrase, password); // base 32B
  for (const j of path) {
    if (!j.isHard) throw new Error('ed25519 soft derivation not supported');
    mini = ed25519DeriveHard(mini, j.chainCode);
  }
  return u8aToHex(mini);
}
