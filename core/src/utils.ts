import BigNumber from 'bignumber.js';
import { isEthereumAddress, isEthereumChecksum } from '@polkadot/util-crypto';
import { decodeAddress, encodeAddress } from '@argonprotocol/mainchain';

export { formatArgons } from '@argonprotocol/mainchain';

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

export function getPercent(value: bigint | number, total: bigint | number): number {
  if (total === 0n || total === 0 || value === 0n || value === 0) return 0;
  return BigNumber(value).dividedBy(total).multipliedBy(100).toNumber();
}

export function percentOf(value: bigint | number, percentOf100: number | bigint): bigint {
  return bigNumberToBigInt(BigNumber(value).multipliedBy(percentOf100).dividedBy(100));
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

export function isValidArgonAccountAddress(address: string): boolean {
  try {
    encodeAddress(decodeAddress(address));
    return true;
  } catch (error) {
    return false;
  }
}

export function ethAddressToH256(address: string): `0x${string}` {
  // normalize
  const hex = address.toLowerCase().replace(/^0x/, '');

  if (hex.length !== 40) {
    throw new Error('Invalid Ethereum address');
  }

  // 20 bytes
  const bytePairs = hex.match(/.{2}/g);
  if (!bytePairs) {
    throw new Error('Invalid Ethereum address');
  }
  const bytes = Uint8Array.from(bytePairs.map(b => parseInt(b, 16)));

  // 32-byte buffer
  const padded = new Uint8Array(32);
  padded.set(bytes, 12); // left-pad with zeros (32 - 20 = 12)

  const paddedAddress = Array.from(padded)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `0x${paddedAddress}`;
}

export function isValidEthereumAddress(address: string): { valid: boolean; checksum: boolean } {
  try {
    const isValid = isEthereumAddress(address);
    const isChecksum = isEthereumChecksum(address);
    return { valid: isValid, checksum: isChecksum };
  } catch (error) {
    return { valid: false, checksum: false };
  }
}

export function debounce<T extends (...args: any[]) => void>(args: { wait: number; maxWait?: number }, fn: T) {
  let t: any;
  let lastInvoke = 0;
  const { wait, maxWait } = args;

  return (...args: Parameters<T>) => {
    const now = Date.now();

    // hard guarantee: send if we've waited too long
    if (maxWait !== undefined && now - lastInvoke >= maxWait) {
      lastInvoke = now;
      clearTimeout(t);
      void fn(...args);
      return;
    }

    clearTimeout(t);
    t = setTimeout(() => {
      lastInvoke = Date.now();
      void fn(...args);
    }, wait).unref();
  };
}
