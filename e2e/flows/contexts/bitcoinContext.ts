import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { IE2EFlowRuntime } from '../types.ts';
import { normalizeAmountInput, parseDecimalToUnits, parsePositiveBigIntInput } from '../helpers/utils.ts';
import type { IOperationInputDefinition } from '../operations/index.ts';

export interface IBitcoinLockFundingDetails {
  address: string;
  amountBtc: string;
  amountSatoshis: bigint;
}

export type MismatchDirection = 'below' | 'above';

export interface IBitcoinFlowInput {
  minimumLockSatoshis?: bigint;
  minimumLockMicrogons?: bigint;
  mismatchDirection: MismatchDirection;
  mismatchOffsetSatoshis?: bigint;
  enforceOutsideAutoAccept: boolean;
  ensurePostFirstUnlock: boolean;
}

export interface IBitcoinFlowState {
  isCompleted?: boolean;
  lockFundingDetails?: IBitcoinLockFundingDetails;
  mismatchAmountSatoshis?: bigint;
}

export interface IBitcoinFlowContext {
  flow: IE2EFlowRuntime;
  flowName: string;
  input: IBitcoinFlowInput;
  state: IBitcoinFlowState;
}

export const BITCOIN_FLOW_INPUT_DEFINITIONS: ReadonlyArray<IOperationInputDefinition> = [
  {
    key: 'minimumLockArgons',
    description: 'Minimum lock amount to submit (in ARGON).',
  },
  {
    key: 'minimumLockSatoshis',
    description: 'Minimum lock amount to submit (in satoshis).',
  },
  {
    key: 'mismatchDirection',
    description: 'Mismatch direction ("below" or "above").',
  },
  {
    key: 'mismatchOffsetSatoshis',
    description: 'Mismatch offset to add/subtract from lock funding amount (satoshis).',
  },
  {
    key: 'enforceOutsideAutoAccept',
    description: 'Require mismatch offset outside auto-accept variance.',
  },
  {
    key: 'ensurePostFirstUnlock',
    description: 'Run mismatch flow only after one completed lock/unlock cycle.',
  },
];

interface ICreateBitcoinFlowContextOptions {
  mismatchDirectionDefault?: MismatchDirection;
  ensurePostFirstUnlockDefault?: boolean;
}

export function createBitcoinFlowContext(
  flow: IE2EFlowRuntime,
  flowName: string,
  options: ICreateBitcoinFlowContextOptions = {},
): IBitcoinFlowContext {
  return {
    flow,
    flowName,
    input: parseBitcoinFlowInput(flow, flowName, options),
    state: {},
  };
}

function parseBitcoinFlowInput(
  flow: IE2EFlowRuntime,
  flowName: string,
  options: ICreateBitcoinFlowContextOptions,
): IBitcoinFlowInput {
  const minimumLockArgons =
    normalizeAmountInput(
      flow.input.minimumLockArgons ?? process.env.BITCOIN_MINIMUM_LOCK_ARGONS,
      `${flowName}.minimumLockArgons`,
    ) || '50';
  const mismatchDirection = parseStringChoice(
    pickUnknown(flow.input.mismatchDirection, process.env.BITCOIN_MISMATCH_DIRECTION),
    options.mismatchDirectionDefault ?? 'below',
    ['below', 'above'],
    `${flowName}.mismatchDirection`,
  );
  return {
    minimumLockSatoshis: parsePositiveBigIntInput(
      flow.input.minimumLockSatoshis ?? process.env.BITCOIN_MINIMUM_LOCK_SATOSHIS,
      `${flowName}.minimumLockSatoshis`,
    ),
    minimumLockMicrogons: minimumLockArgons
      ? parseDecimalToUnits(minimumLockArgons, BigInt(MICROGONS_PER_ARGON), `${flowName}.minimumLockArgons`)
      : undefined,
    mismatchDirection,
    mismatchOffsetSatoshis: parsePositiveBigIntInput(
      pickUnknown(flow.input.mismatchOffsetSatoshis, process.env.BITCOIN_MISMATCH_OFFSET_SATOSHIS),
      `${flowName}.mismatchOffsetSatoshis`,
    ),
    enforceOutsideAutoAccept: parseBooleanInput(
      pickUnknown(flow.input.enforceOutsideAutoAccept, process.env.BITCOIN_ENFORCE_OUTSIDE_AUTO_ACCEPT),
      true,
    ),
    ensurePostFirstUnlock: parseBooleanInput(
      pickUnknown(flow.input.ensurePostFirstUnlock, process.env.BITCOIN_ENSURE_POST_FIRST_UNLOCK),
      options.ensurePostFirstUnlockDefault ?? false,
    ),
  };
}

function pickUnknown(primary: unknown, fallback: string | undefined): unknown {
  if (primary != null) return primary;
  return fallback;
}

function parseBooleanInput(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected boolean input, received ${typeof value}`);
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error(`Expected boolean input, received '${value}'`);
}

function parseStringChoice<T extends string>(value: unknown, fallback: T, options: readonly T[], label: string): T {
  if (value == null) return fallback;
  if (typeof value !== 'string') {
    throw new Error(`${label}: expected one of ${options.join(', ')}`);
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if ((options as readonly string[]).includes(normalized)) {
    return normalized as T;
  }
  throw new Error(`${label}: expected one of ${options.join(', ')}`);
}
