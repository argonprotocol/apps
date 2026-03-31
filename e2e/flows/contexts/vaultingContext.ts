import type { IE2EFlowRuntime } from '../types.ts';
import { normalizeAmountInput } from '../helpers/utils.ts';
import type { IOperationInputDefinition } from '../operations/index.ts';

export interface IVaultingFlowInput {
  serverTab: string;
  extraFundingArgons: string | null;
}

export interface IVaultingFlowState {
  connectedServerTab?: string;
}

export interface IVaultingFlowContext {
  flow: IE2EFlowRuntime;
  flowName: string;
  input: IVaultingFlowInput;
  state: IVaultingFlowState;
}

export const VAULTING_FLOW_INPUT_DEFINITIONS: ReadonlyArray<IOperationInputDefinition> = [
  {
    key: 'serverTab',
    description: 'Server tab for connect step ("local" or "remote").',
  },
  {
    key: 'extraFundingArgons',
    description: 'Extra vaulting wallet funding amount in ARGON.',
  },
];

export function createVaultingFlowContext(flow: IE2EFlowRuntime, flowName: string): IVaultingFlowContext {
  return {
    flow,
    flowName,
    input: {
      serverTab: pickString(flow.input.serverTab, process.env.VAULTING_SERVER_TAB) || 'local',
      extraFundingArgons:
        normalizeAmountInput(
          flow.input.extraFundingArgons ?? process.env.VAULTING_EXTRA_FUNDING_ARGONS,
          `${flowName}.extraFundingArgons`,
        ) ?? '1000',
    },
    state: {},
  };
}

function pickString(primary: unknown, fallback: string | undefined): string {
  if (typeof primary === 'string' && primary.trim()) {
    return primary.trim();
  }
  return fallback?.trim() ?? '';
}
