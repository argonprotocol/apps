import type { E2ETarget, E2EFlowRuntime } from '../types.js';

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

export interface PollEveryOptions {
  timeoutMs: number;
  timeoutMessage?: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pollEvery(
  intervalMs: number,
  check: () => Promise<boolean>,
  options: PollEveryOptions,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= options.timeoutMs) {
    if (await check()) return;
    await sleep(intervalMs);
  }

  throw new Error(options.timeoutMessage ?? `Timed out after ${options.timeoutMs}ms`);
}

export function normalizeAmountInput(value: unknown, label: string): string | null {
  if (value == null) return null;

  const raw = typeof value === 'number' ? String(value) : String(value);
  const normalized = raw.replace(/,/g, '').trim();
  if (!normalized) return null;

  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new Error(`${label}: expected a positive decimal`);
  }
  return normalized;
}

export function parseRequiredNumber(value: string | null, label: string): number {
  if (!value) {
    throw new Error(`${label}: expected a value`);
  }
  const parsed = Number(value.replace(/,/g, ''));
  if (Number.isNaN(parsed)) {
    throw new Error(`${label}: expected a numeric value`);
  }
  return parsed;
}

export function parseRequiredBigInt(value: string | null, label: string): bigint {
  if (!value) {
    throw new Error(`${label}: expected a value`);
  }
  return BigInt(value);
}

function getScaleDecimals(unitScale: bigint, label: string): number {
  const raw = unitScale.toString();
  if (raw === '0') {
    throw new Error(`${label}: unit scale must be > 0`);
  }
  if (!/^10*$/.test(raw)) {
    throw new Error(`${label}: unit scale must be a power of ten`);
  }
  return raw.length - 1;
}

export function parseDecimalToUnits(value: string | number, unitScale: bigint, label: string): bigint {
  const rawInput = typeof value === 'number' ? String(value) : value;
  const normalized = rawInput.replace(/,/g, '').trim();

  if (normalized.length === 0) {
    throw new Error(`${label}: value is required`);
  }
  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new Error(`${label}: expected a positive decimal`);
  }

  const [wholePart, fractionalPart = ''] = normalized.split('.');
  const decimals = getScaleDecimals(unitScale, label);
  if (fractionalPart.length > decimals) {
    throw new Error(`${label}: supports at most ${decimals} decimal place${decimals === 1 ? '' : 's'}`);
  }

  const paddedFraction = fractionalPart.padEnd(decimals, '0');
  const whole = BigInt(wholePart || '0') * unitScale;
  const fraction = decimals === 0 ? 0n : BigInt(paddedFraction || '0');

  return whole + fraction;
}

export interface Bip21Details {
  address: string;
  amount: string | null;
}

export function parseBip21(uri: string): Bip21Details {
  const trimmed = uri.trim();
  if (!trimmed.startsWith('bitcoin:')) {
    throw new Error('BIP21: expected bitcoin: URI');
  }

  const withoutScheme = trimmed.slice('bitcoin:'.length);
  const [rawAddress, rawQuery = ''] = withoutScheme.split('?', 2);
  const address = decodeURIComponent(rawAddress).trim();

  if (address.length === 0) {
    throw new Error('BIP21: missing destination address');
  }

  const params = new URLSearchParams(rawQuery);
  const amount = params.get('amount')?.trim() || null;

  return {
    address,
    amount,
  };
}

export async function clickIfVisible(flow: E2EFlowRuntime, target: E2ETarget): Promise<boolean> {
  const state = await flow.isVisible(target);
  if (!state.visible) return false;
  await flow.click(target);
  return true;
}
