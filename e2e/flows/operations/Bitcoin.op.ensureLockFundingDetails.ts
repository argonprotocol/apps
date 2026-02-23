import { createBitcoinAddress, mineBitcoinSingleBlock } from '../helpers/bitcoinNode.ts';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { IBitcoinLockFundingDetails, IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { readClipboardWithRetries } from '../helpers/readClipboardWithRetries.ts';
import { clickIfVisible, parseBip21, parseDecimalToUnits, pollEvery, sleep } from '../helpers/utils.ts';
import type { E2ETarget, IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';

const SATOSHIS_PER_BTC = 100_000_000n;
const MICROGONS_PER_ARGON_BIGINT = BigInt(MICROGONS_PER_ARGON);
const LOCK_READY_FOR_BITCOIN_TIMEOUT_MS = 180_000;
const LOCK_READY_FOR_BITCOIN_POLL_MS = 4_000;
const LOCK_START_INPUT_DEBOUNCE_WAIT_MS = 350;
const LOCK_START_ERROR_TIMEOUT_MS = 300;
const LOCK_START_BTC_INPUT_SELECTOR = '[data-testid="LockStart.bitcoinAmount"] [data-testid="input-number"]';
const LOCK_START_ARGON_INPUT_SELECTOR = '[data-testid="LockStart.argonAmount"] [data-testid="input-number"]';

type IEnsureLockFundingDetailsChainState = {
  hasLockFundingDetails: boolean;
};

type IEnsureLockFundingDetailsUiState = {
  hasLockFundingDetails: boolean;
  lockState: string | null;
  lockingEntryVisible: boolean;
  lockOverlayVisible: boolean;
  fundingBip21Visible: boolean;
};

interface IEnsureLockFundingDetailsState
  extends IE2EOperationInspectState<IEnsureLockFundingDetailsChainState, IEnsureLockFundingDetailsUiState> {
  hasLockFundingDetails: boolean;
  lockState: string | null;
  lockingEntryVisible: boolean;
  lockOverlayVisible: boolean;
  fundingBip21Visible: boolean;
  runnable: boolean;
  blockers: string[];
}

export default new Operation<IBitcoinFlowContext, IEnsureLockFundingDetailsState>(import.meta, {
  async inspect({ flow, state: flowState }) {
    const hasLockFundingDetails = !!flowState.lockFundingDetails;
    const ui = await readLockFundingUiState(flow);
    const canCollectFundingDetails = ui.fundingBip21Visible || ui.lockOverlayVisible || ui.lockingEntryVisible;
    const runnable = !hasLockFundingDetails && canCollectFundingDetails;
    const isComplete = hasLockFundingDetails;
    const isRunnable = !isComplete && runnable;
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !canCollectFundingDetails) {
      blockers.push('Lock funding UI entry point is not visible.');
    }
    return {
      chainState: {
        hasLockFundingDetails,
      },
      uiState: {
        hasLockFundingDetails,
        lockState: ui.lockState,
        lockingEntryVisible: ui.lockingEntryVisible,
        lockOverlayVisible: ui.lockOverlayVisible,
        fundingBip21Visible: ui.fundingBip21Visible,
      },
      isRunnable,
      isComplete,
      hasLockFundingDetails,
      lockState: ui.lockState,
      lockingEntryVisible: ui.lockingEntryVisible,
      lockOverlayVisible: ui.lockOverlayVisible,
      fundingBip21Visible: ui.fundingBip21Visible,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flow, flowName, state: flowState, input }, state, api) {
    if (state.hasLockFundingDetails) {
      return;
    }

    if (!state.fundingBip21Visible) {
      // Only switch tabs when there is no visible lock-funding entrypoint.
      if (!state.lockOverlayVisible && !state.lockingEntryVisible) {
        await api.run(vaultingActivateTab);
      }
      await waitForPersonalLockState(flow, 'LockReadyForBitcoin', {
        flowName,
        timeoutMs: LOCK_READY_FOR_BITCOIN_TIMEOUT_MS,
        minimumLockSatoshis: input.minimumLockSatoshis,
        minimumLockMicrogons: input.minimumLockMicrogons,
      });
      await clickIfVisible(flow, 'PersonalBitcoin.showLockingOverlay()');
    }

    const fundingBip21 = await flow.isVisible('fundingBip21.copyContent()');
    if (!fundingBip21.visible) {
      throw new Error(`${flowName}: lock funding details unavailable (missing fundingBip21.copyContent()).`);
    }

    flowState.lockFundingDetails = await readBitcoinLockFundingDetailsFromOverlay(flow, flowName);
  },
});

async function readBitcoinLockFundingDetailsFromOverlay(
  flow: IBitcoinFlowContext['flow'],
  flowName: string,
): Promise<IBitcoinLockFundingDetails> {
  const bip21 = await readClipboardWithRetries(
    flow,
    () => flow.click('fundingBip21.copyContent()'),
    value => value.startsWith('bitcoin:'),
  );

  const { address: lockAddress, amount: lockAmount } = parseBip21(bip21);
  if (!lockAddress) {
    throw new Error(`${flowName}: missing lock address`);
  }
  if (!lockAmount) {
    throw new Error(`${flowName}: missing lock amount`);
  }

  const lockAmountSatoshis = parseDecimalToUnits(lockAmount, SATOSHIS_PER_BTC, `${flowName}.lockAmount`);
  return {
    address: lockAddress,
    amountBtc: satoshisToBtc(lockAmountSatoshis),
    amountSatoshis: lockAmountSatoshis,
  };
}

async function waitForPersonalLockState(
  flow: IBitcoinFlowContext['flow'],
  stateName: string,
  options: {
    timeoutMs?: number;
    flowName?: string;
    minimumLockSatoshis?: bigint;
    minimumLockMicrogons?: bigint;
  } = {},
): Promise<void> {
  const {
    timeoutMs = LOCK_READY_FOR_BITCOIN_TIMEOUT_MS,
    flowName = 'Vaulting.flow.onboarding',
    minimumLockSatoshis,
    minimumLockMicrogons,
  } = options;
  const lockTarget = personalLockStatus(stateName);
  const readyStepName = stateName === 'LockReadyForBitcoin' ? 'ReadyForBitcoin' : undefined;
  const lockReadyOverlayTarget = readyStepName
    ? ({ selector: `BitcoinLockingOverlay[data-e2e-state="${readyStepName}"]` } as const)
    : undefined;
  const minerAddress = createBitcoinAddress();

  await pollEvery(
    LOCK_READY_FOR_BITCOIN_POLL_MS,
    async () => {
      const lockStateCount = await flow.count(lockTarget);
      if (lockStateCount > 0) {
        if (stateName === 'LockReadyForBitcoin') {
          const bip21CopyVisible = await flow.isVisible('fundingBip21.copyContent()');
          if (bip21CopyVisible.visible) {
            return true;
          }
        } else {
          return true;
        }
      }

      if (lockReadyOverlayTarget) {
        const overlayStepVisible = await flow.isVisible(lockReadyOverlayTarget);
        if (overlayStepVisible.visible) {
          return true;
        }
      }

      const lockOverlayVisible = await flow.isVisible('BitcoinLockingOverlay');
      if (lockOverlayVisible.visible) {
        const bip21CopyVisible = await flow.isVisible('fundingBip21.copyContent()');
        if (bip21CopyVisible.visible) {
          return true;
        }
      }

      const lockOverlayEntry = await flow.isVisible('PersonalBitcoin.showLockingOverlay()');
      if (lockOverlayEntry.visible) {
        try {
          await flow.click('PersonalBitcoin.showLockingOverlay()', { timeoutMs: 1_000 });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes('Timed out waiting for clickable')) {
            throw error;
          }
        }
      }

      if (stateName === 'LockReadyForBitcoin') {
        await clickIfVisible(flow, 'PersonalBitcoin.showLockingOverlay()');
        const lockStartSubmit = await flow.isVisible('LockStart.submitLiquidLock()');
        if (lockStartSubmit.visible) {
          await applyLockStartMinimumAmount(flow, {
            minimumLockSatoshis,
            minimumLockMicrogons,
          });

          const didSubmit = await clickIfVisible(flow, 'LockStart.submitLiquidLock()');
          if (didSubmit) {
            const lockStartErrorMessage = await readLockStartErrorMessage(flow);
            if (lockStartErrorMessage) {
              throw new Error(`${flowName}: lock creation failed: ${lockStartErrorMessage}`);
            }
          }
        }
      }

      mineBitcoinSingleBlock(minerAddress);
      return false;
    },
    {
      timeoutMs,
      timeoutMessage: `${flowName}: Lock state "${stateName}" not reached within ${timeoutMs}ms.`,
    },
  );
}

function satoshisToBtc(amountSatoshis: bigint): string {
  if (amountSatoshis <= 0n) {
    throw new Error('Bitcoin amount must be positive');
  }
  const integerPart = amountSatoshis / SATOSHIS_PER_BTC;
  const fractionalPart = (amountSatoshis % SATOSHIS_PER_BTC).toString().padStart(8, '0');
  return `${integerPart}.${fractionalPart}`;
}

async function applyLockStartMinimumAmount(
  flow: IBitcoinFlowContext['flow'],
  minimum: { minimumLockSatoshis?: bigint; minimumLockMicrogons?: bigint },
): Promise<void> {
  if (minimum.minimumLockMicrogons != null) {
    await flow.type({ selector: LOCK_START_ARGON_INPUT_SELECTOR }, microgonsToArgons(minimum.minimumLockMicrogons), {
      clear: true,
      timeoutMs: 3_000,
    });
    await sleep(LOCK_START_INPUT_DEBOUNCE_WAIT_MS);
    return;
  }
  if (minimum.minimumLockSatoshis != null) {
    await flow.type({ selector: LOCK_START_BTC_INPUT_SELECTOR }, satoshisToBtc(minimum.minimumLockSatoshis), {
      clear: true,
      timeoutMs: 3_000,
    });
    await sleep(LOCK_START_INPUT_DEBOUNCE_WAIT_MS);
  }
}

async function readLockStartErrorMessage(flow: IBitcoinFlowContext['flow']): Promise<string | null> {
  const message = await flow
    .getText('LockStart.errorMessage', { timeoutMs: LOCK_START_ERROR_TIMEOUT_MS })
    .catch(() => null);
  const normalized = message?.replace(/\s+/g, ' ').trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function microgonsToArgons(microgons: bigint): string {
  if (microgons <= 0n) return '0';
  const whole = microgons / MICROGONS_PER_ARGON_BIGINT;
  const fraction = (microgons % MICROGONS_PER_ARGON_BIGINT).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function personalLockStatus(name: string): E2ETarget {
  return {
    selector: `[data-testid="PersonalBitcoin"][data-lock-state="${name}"]`,
  };
}

async function readLockFundingUiState(flow: IE2EFlowRuntime): Promise<{
  lockState: string | null;
  lockingEntryVisible: boolean;
  lockOverlayVisible: boolean;
  fundingBip21Visible: boolean;
}> {
  const [personal, lockingEntry, lockOverlay, fundingBip21] = await Promise.all([
    flow.isVisible('PersonalBitcoin'),
    flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
    flow.isVisible('BitcoinLockingOverlay'),
    flow.isVisible('fundingBip21.copyContent()'),
  ]);
  const lockState = personal.exists
    ? await flow.getAttribute('PersonalBitcoin', 'data-lock-state', { timeoutMs: 1_000 }).catch(() => null)
    : null;
  return {
    lockState: lockState?.trim() || null,
    lockingEntryVisible: lockingEntry.visible,
    lockOverlayVisible: lockOverlay.visible,
    fundingBip21Visible: fundingBip21.visible,
  };
}
