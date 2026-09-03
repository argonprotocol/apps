import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { IE2EFlowRuntime } from '../types.ts';
import { normalizeAmountInput, parseDecimalToUnits, parsePositiveBigIntInput } from '../helpers/utils.ts';
import type { IOperationInputDefinition } from '../operations/index.ts';
import type { IBitcoinUnlockReleaseState } from '../types/srcVue.ts';

export interface IBitcoinLockFundingDetails {
  lockUuid: string;
  address: string;
  amountSatoshis: bigint;
}

export interface IBitcoinFlowInput {
  minimumLockSatoshis?: bigint;
  minimumLockMicrogons?: bigint;
}

export interface IBitcoinFlowState {
  lockFundingDetails?: IBitcoinLockFundingDetails;
  orphanDepositTxid?: string;
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

export type IBitcoinFlowLockState = IBitcoinUnlockReleaseState & {
  isSelectedLockActive: boolean;
  releaseTxid?: string;
};

export async function readBitcoinLockState(flow: IE2EFlowRuntime, lockUuid?: string): Promise<IBitcoinFlowLockState> {
  const state = await flow.queryApp(
    async (refs, args: { lockUuid?: string }) => {
      await refs.bitcoinLocks.load();
      const lock = args.lockUuid
        ? refs.bitcoinLocks.getLockByUuid(args.lockUuid)
        : refs.bitcoinLocks.getActiveLocks()[0];
      if (args.lockUuid && !lock) {
        throw new Error(`Bitcoin channel ${args.lockUuid} is missing from the loaded store.`);
      }
      const releaseState = refs.bitcoinLocks.getLockUnlockReleaseState(lock);
      const fundingRecord = lock ? refs.bitcoinLocks.getAcceptedFundingRecord(lock) : undefined;
      return {
        ...releaseState,
        isSelectedLockActive: !!lock && !refs.bitcoinLocks.isTerminalLock(lock),
        releaseTxid: fundingRecord?.releaseTxid,
      };
    },
    { args: { lockUuid }, timeoutMs: 20_000 },
  );
  if (!state) throw new Error('Unable to read Bitcoin channel state from the app.');
  return state;
}

function parseBitcoinFlowInput(flow: IE2EFlowRuntime, flowName: string): IBitcoinFlowInput {
  const minimumLockSatoshis = parsePositiveBigIntInput(
    flow.input.minimumLockSatoshis ?? process.env.BITCOIN_MINIMUM_LOCK_SATOSHIS,
    `${flowName}.minimumLockSatoshis`,
  );
  const configuredMinimumLockArgons = normalizeAmountInput(
    flow.input.minimumLockArgons ?? process.env.BITCOIN_MINIMUM_LOCK_ARGONS,
    `${flowName}.minimumLockArgons`,
  );
  const minimumLockArgons = configuredMinimumLockArgons || (minimumLockSatoshis == null ? '50' : '');
  return {
    minimumLockSatoshis,
    minimumLockMicrogons: minimumLockArgons
      ? parseDecimalToUnits(minimumLockArgons, BigInt(MICROGONS_PER_ARGON), `${flowName}.minimumLockArgons`)
      : undefined,
  };
}
