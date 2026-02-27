import { createBitcoinAddress, mineBitcoinSingleBlock } from '../helpers/bitcoinNode.ts';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { IBitcoinLockFundingDetails, IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { readClipboardWithRetries } from '../helpers/readClipboardWithRetries.ts';
import {
  clickIfVisible,
  formatUnitsToDecimal,
  parseBip21,
  parseDecimalToUnits,
  pollEvery,
  sleep,
} from '../helpers/utils.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';

const SATOSHIS_PER_BTC = 100_000_000n;

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
    const uiState = {
      hasLockFundingDetails,
      lockState: ui.lockState,
      lockingEntryVisible: ui.lockingEntryVisible,
      lockOverlayVisible: ui.lockOverlayVisible,
      fundingBip21Visible: ui.fundingBip21Visible,
    };
    return {
      chainState: { hasLockFundingDetails },
      uiState,
      isRunnable,
      isComplete,
      ...uiState,
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
      const minerAddress = createBitcoinAddress();
      await pollEvery(
        4_000,
        async () => {
          const ui = await readLockFundingUiState(flow);
          if (ui.fundingBip21Visible) {
            return true;
          }

          if (ui.lockingEntryVisible) {
            await clickIfVisible(flow, 'PersonalBitcoin.showLockingOverlay()');
          }

          if ((await flow.isVisible('fundingBip21.copyContent()')).visible) {
            return true;
          }

          const lockStartSubmit = await flow.isVisible('LockStart.submitLiquidLock()');
          if (lockStartSubmit.visible) {
            await applyLockStartMinimumAmount(flow, {
              minimumLockSatoshis: input.minimumLockSatoshis,
              minimumLockMicrogons: input.minimumLockMicrogons,
            });

            if (await clickIfVisible(flow, 'LockStart.submitLiquidLock()')) {
              const lockStartErrorMessage = await readLockStartErrorMessage(flow);
              if (lockStartErrorMessage) {
                throw new Error(`${flowName}: lock creation failed: ${lockStartErrorMessage}`);
              }
            }
          }

          mineBitcoinSingleBlock(minerAddress);
          return false;
        },
        {
          timeoutMs: 180_000,
          timeoutMessage: `${flowName}: lock funding details unavailable after waiting for pending funding state.`,
        },
      );
    }

    if (!(await flow.isVisible('fundingBip21.copyContent()')).visible) {
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
    amountBtc: formatUnitsToDecimal(lockAmountSatoshis, SATOSHIS_PER_BTC, `${flowName}.lockAmountSatoshis`),
    amountSatoshis: lockAmountSatoshis,
  };
}

async function applyLockStartMinimumAmount(
  flow: IBitcoinFlowContext['flow'],
  minimum: { minimumLockSatoshis?: bigint; minimumLockMicrogons?: bigint },
): Promise<void> {
  if (minimum.minimumLockMicrogons != null) {
    const formattedMicrogons = formatUnitsToDecimal(
      minimum.minimumLockMicrogons,
      BigInt(MICROGONS_PER_ARGON),
      'minimumLockMicrogons',
    ).replace(/\.?0+$/, '');
    await flow.type(
      { selector: '[data-testid="LockStart.argonAmount"] [data-testid="input-number"]' },
      formattedMicrogons.length > 0 ? formattedMicrogons : '0',
      {
        clear: true,
        timeoutMs: 3_000,
      },
    );
    await sleep(350);
    return;
  }
  if (minimum.minimumLockSatoshis != null) {
    const formattedSatoshis = formatUnitsToDecimal(
      minimum.minimumLockSatoshis,
      SATOSHIS_PER_BTC,
      'minimumLockSatoshis',
    );
    await flow.type(
      { selector: '[data-testid="LockStart.bitcoinAmount"] [data-testid="input-number"]' },
      formattedSatoshis,
      {
        clear: true,
        timeoutMs: 3_000,
      },
    );
    await sleep(350);
  }
}

async function readLockStartErrorMessage(flow: IBitcoinFlowContext['flow']): Promise<string | null> {
  const message = await flow.getText('LockStart.errorMessage', { timeoutMs: 300 }).catch(() => null);
  const normalized = message?.replace(/\s+/g, ' ').trim();
  return normalized && normalized.length > 0 ? normalized : null;
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
