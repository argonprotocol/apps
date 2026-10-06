import type { IE2EFlowRuntime } from '../types.ts';
import { normalizeAmountInput } from '../helpers/utils.ts';
import type { IOperationInputDefinition } from '../operations/index.ts';

export interface IVaultingFlowInput {
  serverTab: string;
  extraFundingArgons: string | null;
  securitizationArgons: string | null;
  securitizationArgonots: string | null;
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
  { key: 'securitizationArgons', description: 'Vault ARGN securitization.' },
  { key: 'securitizationArgonots', description: 'Vault ARGNOT securitization.' },
  {
    key: 'extraFundingArgons',
    description: 'Extra vaulting wallet funding amount in ARGON.',
  },
];

export function createVaultingFlowContext(flow: IE2EFlowRuntime, flowName: string): IVaultingFlowContext {
  const input = flow.input as Partial<IVaultingFlowInput>;

  return {
    flow,
    flowName,
    input: {
      serverTab: input.serverTab ?? 'local',
      securitizationArgons: normalizeAmountInput(input.securitizationArgons, `${flowName}.securitizationArgons`),
      securitizationArgonots: normalizeAmountInput(input.securitizationArgonots, `${flowName}.securitizationArgonots`),
      extraFundingArgons: normalizeAmountInput(input.extraFundingArgons, `${flowName}.extraFundingArgons`) ?? '1000',
    },
    state: {},
  };
}
