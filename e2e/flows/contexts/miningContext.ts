import type { IE2EFlowRuntime } from '../types.ts';
import { normalizeAmountInput } from '../helpers/utils.ts';
import type { IOperationInputDefinition } from '../operations/index.ts';

export interface IMiningFlowInput {
  serverTab: string;
  startingBidArgons: string | null;
  maximumBidArgons: string | null;
  fundingArgons: string | null;
}

export interface IMiningFlowState {
  connectedServerTab?: string;
}

export interface IMiningFlowContext {
  flow: IE2EFlowRuntime;
  flowName: string;
  input: IMiningFlowInput;
  state: IMiningFlowState;
}

export const MINING_FLOW_INPUT_DEFINITIONS: ReadonlyArray<IOperationInputDefinition> = [
  {
    key: 'serverTab',
    description: 'Server tab for connect step ("local" or "remote").',
  },
  {
    key: 'startingBidArgons',
    description: 'Custom starting bid amount in ARGON.',
  },
  {
    key: 'maximumBidArgons',
    description: 'Custom maximum bid amount in ARGON.',
  },
  {
    key: 'fundingArgons',
    description: 'Mining wallet funding target in ARGON.',
  },
];

export function createMiningFlowContext(flow: IE2EFlowRuntime, flowName: string): IMiningFlowContext {
  const requestedServerTab = pickString(flow.input.serverTab, process.env.MINING_SERVER_TAB);
  const serverTab = requestedServerTab || 'local';

  return {
    flow,
    flowName,
    input: {
      serverTab,
      startingBidArgons: normalizeAmountInput(
        pickUnknown(flow.input.startingBidArgons, process.env.MINING_STARTING_BID_ARGONS),
        `${flowName}.startingBidArgons`,
      ),
      maximumBidArgons: normalizeAmountInput(
        pickUnknown(flow.input.maximumBidArgons, process.env.MINING_MAXIMUM_BID_ARGONS),
        `${flowName}.maximumBidArgons`,
      ),
      fundingArgons: normalizeAmountInput(
        pickUnknown(flow.input.fundingArgons, process.env.MINING_FUNDING_ARGONS),
        `${flowName}.fundingArgons`,
      ),
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

function pickUnknown(primary: unknown, fallback: string | undefined): unknown {
  if (primary != null) return primary;
  return fallback;
}
