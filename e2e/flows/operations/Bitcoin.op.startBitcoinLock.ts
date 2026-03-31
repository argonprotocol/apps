import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { IBitcoinVaultMismatchState } from '../types/srcVue.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { clickIfVisible, formatUnitsToDecimal, pollEvery, sleep } from '../helpers/utils.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import bitcoinEnsureMismatchActionPanel from './Bitcoin.op.ensureMismatchActionPanel.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';

const SATOSHIS_PER_BTC = 100_000_000n;

type IStartBitcoinLockUiState = {
  lockStartEntryVisible: boolean;
  lockOverlayVisible: boolean;
  lockOverlayState: string | null;
  lockStartVisible: boolean;
  fundingBip21Visible: boolean;
};

type IStartBitcoinLockState = IE2EOperationInspectState<IBitcoinVaultMismatchState, IStartBitcoinLockUiState>;

export default new Operation<IBitcoinFlowContext, IStartBitcoinLockState>(import.meta, {
  async inspect({ flow }) {
    const panelState = await flow.inspect(bitcoinEnsureMismatchActionPanel);
    const [lockStartEntry, lockOverlay, lockStart, fundingBip21] = await Promise.all([
      flow.isVisible({ selector: '[bitcoinmap] .treemap__tile--remainder' }),
      flow.isVisible('BitcoinLockingOverlay'),
      flow.isVisible('LockStart.submitLiquidLock()'),
      flow.isVisible('fundingBip21.copyContent()'),
    ]);
    const lockStartEntryVisible = lockStartEntry.visible;
    const lockOverlayVisible = lockOverlay.visible;
    const lockOverlayState = lockOverlay.visible
      ? await flow.getAttribute('BitcoinLockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const lockStartVisible = lockStart.visible;
    const fundingBip21Visible = fundingBip21.visible;
    const isComplete = panelState.chainState.isPendingFunding || fundingBip21Visible;
    const canRun =
      !isComplete &&
      !panelState.chainState.hasActiveLock &&
      (lockStartEntryVisible || lockOverlayVisible || lockStartVisible);
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (panelState.chainState.hasActiveLock) {
      operationState = 'uiStateMismatch';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && panelState.chainState.hasActiveLock) {
      blockers.push('Another lock is already active.');
    }
    if (!isComplete && !lockStartEntryVisible && !lockOverlayVisible && !lockStartVisible) {
      blockers.push('Bitcoin lock creation UI is not visible.');
    }
    return {
      chainState: panelState.chainState,
      uiState: {
        lockStartEntryVisible,
        lockOverlayVisible,
        lockOverlayState,
        lockStartVisible,
        fundingBip21Visible,
      },
      state: operationState,
      phase:
        lockOverlay.visible && lockOverlayState
          ? `locking:${lockOverlayState}`
          : lockStartEntryVisible
            ? 'dashboard:remainder'
            : undefined,
      blockers: canRun ? [] : blockers,
    };
  },

  async run({ flow, flowName, input }, state) {
    if (state.state === 'complete') return;

    if (!state.uiState.lockOverlayVisible && !state.uiState.lockStartVisible) {
      await flow.run(vaultingActivateTab);
      const opened = await clickDashboardBitcoinRemainder(flow, { timeoutMs: 5_000 });
      if (!opened) {
        throw new Error(`${flowName}: Bitcoin lock entry point is not clickable on the vault dashboard.`);
      }
    }
    if (!state.uiState.lockStartVisible) {
      await flow.waitFor('LockStart.submitLiquidLock()', { timeoutMs: 10_000 });
    }

    if (input.minimumLockMicrogons != null) {
      const argonAmount =
        formatUnitsToDecimal(
          input.minimumLockMicrogons,
          BigInt(MICROGONS_PER_ARGON),
          `${flowName}.minimumLockMicrogons`,
        ).replace(/\.?0+$/, '') || '0';
      await flow.type({ selector: '[data-testid="LockStart.argonAmount"] [data-testid="input-number"]' }, argonAmount, {
        clear: true,
        timeoutMs: 3_000,
      });
      await flow.click(
        { selector: '[data-testid="LockStart.bitcoinAmount"] [data-testid="input-number"]' },
        { timeoutMs: 3_000 },
      );
      await sleep(500);
    } else if (input.minimumLockSatoshis != null) {
      await flow.type(
        { selector: '[data-testid="LockStart.bitcoinAmount"] [data-testid="input-number"]' },
        formatUnitsToDecimal(input.minimumLockSatoshis, SATOSHIS_PER_BTC, `${flowName}.minimumLockSatoshis`),
        {
          clear: true,
          timeoutMs: 3_000,
        },
      );
      await flow.click(
        { selector: '[data-testid="LockStart.argonAmount"] [data-testid="input-number"]' },
        { timeoutMs: 3_000 },
      );
      await sleep(500);
    }

    const didSubmit = await clickIfVisible(flow, 'LockStart.submitLiquidLock()');
    if (!didSubmit) {
      throw new Error(`${flowName}: Bitcoin lock create action is not clickable.`);
    }

    const lockStartError = await flow.getText('LockStart.errorMessage', { timeoutMs: 300 }).catch(() => null);
    const normalizedLockStartError = lockStartError?.replace(/\s+/g, ' ').trim();
    if (normalizedLockStartError) {
      throw new Error(`${flowName}: lock creation failed: ${normalizedLockStartError}`);
    }

    await pollEvery(
      1_000,
      async () => {
        const latest = await flow.inspect(bitcoinEnsureMismatchActionPanel);
        return latest.chainState.isPendingFunding;
      },
      {
        timeoutMs: 60_000,
        timeoutMessage: `${flowName}: Bitcoin lock did not enter pending funding in time.`,
      },
    );
  },
});

async function clickDashboardBitcoinRemainder(
  flow: IBitcoinFlowContext['flow'],
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  return await clickIfVisible(flow, { selector: '[bitcoinmap] .treemap__tile--remainder' }, options);
}
