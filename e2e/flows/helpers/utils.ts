import type { E2ECommandArgs, E2ETarget, IE2EFlowRuntime } from '../types.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
export const OPEN_LOCKING_OVERLAY_SELECTOR = '[role="dialog"][data-testid="BitcoinLockingOverlay"]';
const OPEN_LOCKING_OVERLAY_CLOSE_SELECTOR = `${OPEN_LOCKING_OVERLAY_SELECTOR} button[class*="border-slate-400"]`;

export interface IPollEveryOptions {
  timeoutMs: number;
  timeoutMessage?: string;
}

export interface IClickIfVisibleOptions {
  timeoutMs?: number;
}

export interface IInspectCommandResult<T = unknown> {
  ok?: boolean;
  value?: T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pollEvery(
  intervalMs: number,
  check: () => Promise<boolean>,
  options: IPollEveryOptions,
): Promise<void> {
  await waitFor<void>(options.timeoutMs, 'pollEvery', async () => ((await check()) ? true : undefined), {
    pollMs: intervalMs,
    retryErrors: false,
    timeoutMessage: options.timeoutMessage,
  });
}

export function normalizeAmountInput(value: unknown, label: string): string | null {
  if (value == null) return null;

  let raw: string;
  if (typeof value === 'string') {
    raw = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label}: expected a finite number`);
    }
    raw = value.toString();
  } else if (typeof value === 'bigint') {
    raw = value.toString();
  } else {
    throw new Error(`${label}: expected a string or number`);
  }
  const normalized = raw.replace(/,/g, '').trim();
  if (!normalized) return null;

  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new Error(`${label}: expected a positive decimal`);
  }
  return normalized;
}

export function parsePositiveBigIntInput(value: unknown, label: string): bigint | undefined {
  if (value == null) return undefined;

  if (typeof value === 'bigint') {
    if (value <= 0n) throw new Error(`${label} must be a positive integer`);
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive integer`);
    }
    return BigInt(value);
  }

  if (typeof value !== 'string') {
    throw new Error(`${label} must be a positive integer`);
  }

  const normalized = value.trim();
  if (!/^[0-9]+$/.test(normalized) || normalized === '0') {
    throw new Error(`${label} must be a positive integer`);
  }
  return BigInt(normalized);
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

export function parseOptionalPositiveInteger(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
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

export function formatUnitsToDecimal(units: bigint, unitScale: bigint, label: string): string {
  if (units < 0n) {
    throw new Error(`${label}: expected a non-negative integer`);
  }
  const decimals = getScaleDecimals(unitScale, label);
  if (decimals === 0) {
    return units.toString();
  }
  const wholePart = units / unitScale;
  const fractionalPart = (units % unitScale).toString().padStart(decimals, '0');
  return `${wholePart}.${fractionalPart}`;
}

export interface IBip21Details {
  address: string;
  amount: string | null;
}

export function parseBip21(uri: string): IBip21Details {
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

export async function runInspect<T>(
  flow: IE2EFlowRuntime,
  fn: string,
  timeoutMs: number,
  args: E2ECommandArgs = {},
): Promise<T | undefined> {
  const result = await flow
    .command<IInspectCommandResult<T>>('command.inspect', {
      fn,
      timeoutMs,
      args,
    })
    .catch(() => undefined);
  return result?.ok ? result.value : undefined;
}

export async function clickIfVisible(
  flow: IE2EFlowRuntime,
  target: E2ETarget,
  options: IClickIfVisibleOptions = {},
): Promise<boolean> {
  const state = await flow.isVisible(target);
  if (!state.clickable) return false;

  try {
    await flow.click(target, { timeoutMs: options.timeoutMs ?? 1_500 });
    return true;
  } catch (error) {
    if (isTransientClickFailure(error)) return false;
    throw error;
  }
}

export async function dismissOpenLockingOverlay(
  flow: IE2EFlowRuntime,
  preferredCloseTarget?: E2ETarget,
): Promise<boolean> {
  const openDialogs = await flow.count({ selector: OPEN_LOCKING_OVERLAY_SELECTOR });
  if (openDialogs === 0) return false;

  if (preferredCloseTarget && (await clickIfVisible(flow, preferredCloseTarget))) {
    await waitForOpenDialogCountBelow(flow, openDialogs);
    return (await flow.count({ selector: OPEN_LOCKING_OVERLAY_SELECTOR })) < openDialogs;
  }

  for (let index = 0; index < openDialogs; index += 1) {
    if (await clickIfVisible(flow, { selector: OPEN_LOCKING_OVERLAY_CLOSE_SELECTOR, index })) {
      await waitForOpenDialogCountBelow(flow, openDialogs);
      return (await flow.count({ selector: OPEN_LOCKING_OVERLAY_SELECTOR })) < openDialogs;
    }
  }
  return (await flow.count({ selector: OPEN_LOCKING_OVERLAY_SELECTOR })) === 0;
}

function isTransientClickFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Timed out waiting for clickable') ||
    message.includes('not_found') ||
    (message.includes('Target') && message.includes('not found'))
  );
}

async function waitForOpenDialogCountBelow(flow: IE2EFlowRuntime, maxCountExclusive: number): Promise<void> {
  await pollEvery(
    200,
    async () => (await flow.count({ selector: OPEN_LOCKING_OVERLAY_SELECTOR })) < maxCountExclusive,
    {
      timeoutMs: 2_000,
      timeoutMessage: 'Timed out waiting for locking dialog count to decrease.',
    },
  ).catch(() => null);
}
