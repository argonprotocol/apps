import { createDeferred, getPercent, IDeferred, JsonExt, percentOf } from '@argonprotocol/apps-core';
import { IFieldTypes } from './db/BaseTable.ts';
import { INSTANCE_NAME, IS_TEST, NETWORK_NAME } from './Env.ts';
import { appConfigDir, join } from '@tauri-apps/api/path';

export { createDeferred, type IDeferred, getPercent, percentOf };

export function isInt(n: any) {
  if (typeof n === 'string') return !n.includes('.');
  return n % 1 === 0;
}

export async function getInstanceConfigDir(): Promise<string> {
  return await join(await appConfigDir(), NETWORK_NAME, INSTANCE_NAME);
}

export function abbreviateAddress(address: string, length = 4) {
  return address.slice(0, 6) + '...' + address.slice(-length);
}

export function calculateProfitPct(costs: bigint, rewards: bigint): number {
  if (costs === 0n && rewards > 0n) return 100_000_000;
  if (costs === 0n) return 0;

  return Number(((rewards - costs) * 100_000n) / costs) / 100_000;
}

export function compoundXTimes(rate: number, times: number): number {
  return Math.pow(1 + rate, times) - 1;
}

export function calculateAPR(costs: bigint, rewards: bigint): number {
  const tenDayRate = calculateProfitPct(costs, rewards);

  // Compound APR over 36.5 cycles (10-day periods in a year)
  const apr = tenDayRate * 36.5 * 100;
  return Math.max(apr, -100);
}

/**
 * Calculates the actual APY based on costs, rewards, and remaining compounding periods.
 * @param costs - The total costs incurred.
 * @param rewards - The total rewards earned.
 * @param activeDays - The number of days this investment reflects
 */
export function calculateAPY(costs: bigint, rewards: bigint, activeDays?: number): number {
  if (rewards === 0n) return 0;
  const roi = calculateProfitPct(costs, rewards);
  const elapsedDenominator = activeDays ? activeDays : 1;
  const dailyRate = Math.pow(1 + roi, 1 / elapsedDenominator) - 1;

  return compoundXTimes(dailyRate, 365) * 100;
}

export function toSqlParams(
  params: (bigint | number | string | Uint8Array | Date | boolean | object | undefined)[],
): (string | number | Uint8Array | null | Date)[] {
  return params.map(param => {
    if (param === undefined || param === null) {
      return null; // SQLite uses null for undefined values
    }
    if (typeof param === 'boolean') {
      return toSqliteBoolean(param);
    } else if (typeof param === 'bigint') {
      return param.toString();
    } else if (typeof param === 'object' && !(param instanceof Uint8Array) && !(param instanceof Date)) {
      return JsonExt.stringify(param);
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
      } else if (type === 'bigintJson' || type === 'json') {
        obj[fieldName] = JsonExt.parse(value);
      } else if (type === 'date') {
        obj[fieldName] = new Date(value);
      } else if (type === 'uint8array') {
        obj[fieldName] = Uint8Array.from(value);
      } else {
        throw new Error(`${fieldName} has unknown type: ${type}`);
      }
    }
  }
  return obj as T;
}

export const instanceChecks = new WeakSet<any>();

export function ensureOnlyOneInstance(constructor: any) {
  if (IS_TEST) return; // Skip in CI to allow tests to run
  if (instanceChecks.has(constructor)) {
    console.log(new Error().stack);
    throw new Error(`${constructor.name} already initialized`);
  }
  instanceChecks.add(constructor);
}

export function resetOnlyOneInstance(constructor: any) {
  constructor.isInitialized = false;
}

export function getOrdinalSuffix(n: number): string {
  // Handle special teen cases: 11th, 12th, 13th
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) {
    return 'th';
  }

  // Otherwise, use last digit
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

export function generateProgressLabel(
  blockCount: number,
  expectedBlockCount: number,
  options: { prefix?: string; blockType?: 'Argon' | 'Bitcoin' } = {},
) {
  const prefix = options.prefix ? `${options.prefix}... ` : '';
  const blockType = options.blockType ? `${options.blockType} ` : '';
  if (blockCount === expectedBlockCount) {
    return `${prefix}Waiting for ${blockType}Finalization...`;
  }

  const num = Math.max(-1, blockCount) + 2;
  const ordinalSuffix = getOrdinalSuffix(num);
  return `${prefix}Waiting for ${num}${ordinalSuffix} ${blockType}Block...`;
}
