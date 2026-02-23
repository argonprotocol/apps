import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { IE2EFlowRuntime } from '../types.ts';
import { normalizeAmountInput, parseDecimalToUnits, parsePositiveBigIntInput } from '../helpers/utils.ts';
import type { IOperationInputDefinition } from '../operations/index.ts';

export interface IBitcoinLockFundingDetails {
  address: string;
  amountBtc: string;
  amountSatoshis: bigint;
}

export interface IBitcoinFlowInput {
  minimumLockSatoshis?: bigint;
  minimumLockMicrogons?: bigint;
}

export interface IBitcoinFlowState {
  lockFundingDetails?: IBitcoinLockFundingDetails;
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
];

export function createBitcoinFlowContext(flow: IE2EFlowRuntime, flowName: string): IBitcoinFlowContext {
  return {
    flow,
    flowName,
    input: parseBitcoinFlowInput(flow, flowName),
    state: {},
  };
}

function parseBitcoinFlowInput(flow: IE2EFlowRuntime, flowName: string): IBitcoinFlowInput {
  const minimumLockArgons = normalizeAmountInput(
    flow.input.minimumLockArgons ?? process.env.BITCOIN_MINIMUM_LOCK_ARGONS,
    `${flowName}.minimumLockArgons`,
  );
  return {
    minimumLockSatoshis: parsePositiveBigIntInput(
      flow.input.minimumLockSatoshis ?? process.env.BITCOIN_MINIMUM_LOCK_SATOSHIS,
      `${flowName}.minimumLockSatoshis`,
    ),
    minimumLockMicrogons: minimumLockArgons
      ? parseDecimalToUnits(minimumLockArgons, BigInt(MICROGONS_PER_ARGON), `${flowName}.minimumLockArgons`)
      : undefined,
  };
}
