import type { IE2EFlowRuntime } from '../types.ts';
import { normalizeAmountInput } from '../helpers/utils.ts';
import type { IOperationInputDefinition } from '../operations/index.ts';

export interface IVaultingFlowInput {
  extraFundingArgons: string | null;
}

export type IVaultingFlowState = Record<string, never>;

export interface IVaultingFlowContext {
  flow: IE2EFlowRuntime;
  flowName: string;
  input: IVaultingFlowInput;
  state: IVaultingFlowState;
}

export const VAULTING_FLOW_INPUT_DEFINITIONS: ReadonlyArray<IOperationInputDefinition> = [
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
      extraFundingArgons:
        normalizeAmountInput(
          flow.input.extraFundingArgons ?? process.env.VAULTING_EXTRA_FUNDING_ARGONS,
          `${flowName}.extraFundingArgons`,
        ) ?? '1000',
    },
    state: {},
  };
}
