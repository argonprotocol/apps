import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { getWalletOverlayFundingNeeded, sudoFundWallet, type ISudoFundWalletInput } from '../helpers/sudoFundWallet.ts';
import { parseDecimalToUnits } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

const DEFAULT_MINING_FUNDING_MULTIPLIER = 10n;

type IFundWalletUiState = {
  fundOverlayVisible: boolean;
  walletFullyFunded: boolean;
};

interface IFundWalletState extends IE2EOperationInspectState<Record<string, never>, IFundWalletUiState> {
  fundOverlayVisible: boolean;
  walletFullyFunded: boolean;
  runnable: boolean;
  blockers: string[];
}

export default new Operation<IMiningFlowContext, IFundWalletState>(import.meta, {
  async inspect({ flow }) {
    const fundOverlayEntry = await flow.isVisible('FinalSetupChecklist.openFundMiningAccountOverlay()');
    const fundingText = await flow
      .getText('FinalSetupChecklist.openFundMiningAccountOverlay()', { timeoutMs: 2_000 })
      .catch(() => null);
    const walletFullyFunded = (fundingText ?? '').toLowerCase().includes('fully funded');
    const runnable = fundOverlayEntry.visible && !walletFullyFunded;
    const isComplete = walletFullyFunded;
    const isRunnable = !isComplete && runnable;
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !fundOverlayEntry.visible) blockers.push('Mining fund-wallet checklist step is not visible.');
    return {
      chainState: {},
      uiState: {
        fundOverlayVisible: fundOverlayEntry.visible,
        walletFullyFunded,
      },
      isRunnable,
      isComplete,
      fundOverlayVisible: fundOverlayEntry.visible,
      walletFullyFunded,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flow, flowName, input }) {
    await flow.click('FinalSetupChecklist.openFundMiningAccountOverlay()');
    await flow.waitFor('WalletOverlay.micronotsNeeded');
    await flow.waitFor('WalletOverlay.microgonsNeeded');

    const requiredFunding = await getWalletOverlayFundingNeeded(flow);
    const fundingNeeded = requiredFunding.microgons > 0n || requiredFunding.micronots > 0n;
    const funding = fundingNeeded ? deriveMiningFunding(flowName, requiredFunding, input.fundingArgons) : undefined;
    await flow.click('WalletOverlay.closeOverlay()', { timeoutMs: 8_000 });
    await flow.waitFor('WalletOverlay.closeOverlay()', { state: 'missing', timeoutMs: 20_000 });
    if (!funding) return;

    const fundingResult = await sudoFundWallet(funding);
    console.info(`[E2E] ${flowName} funded wallet`, {
      address: fundingResult.address,
      requestedMicrogons: fundingResult.requestedMicrogons.toString(),
      requestedMicronots: fundingResult.requestedMicronots.toString(),
      fundedMicrogons: fundingResult.fundedMicrogons.toString(),
      fundedMicronots: fundingResult.fundedMicronots.toString(),
    });
  },
});

function deriveMiningFunding(
  flowName: string,
  baseFunding: ISudoFundWalletInput,
  fundingArgons: string | null,
): ISudoFundWalletInput {
  if (!fundingArgons) {
    return {
      ...baseFunding,
      microgons: baseFunding.microgons * DEFAULT_MINING_FUNDING_MULTIPLIER,
      micronots: baseFunding.micronots * DEFAULT_MINING_FUNDING_MULTIPLIER,
    };
  }

  const targetMicrogons = parseDecimalToUnits(fundingArgons, BigInt(MICROGONS_PER_ARGON), `${flowName}.fundingArgons`);

  if (targetMicrogons <= baseFunding.microgons) {
    return baseFunding;
  }

  if (baseFunding.microgons <= 0n) {
    throw new Error(`${flowName}: expected microgons requirement > 0`);
  }

  const scaledMicronots =
    (baseFunding.micronots * targetMicrogons + baseFunding.microgons - 1n) / baseFunding.microgons;

  return {
    ...baseFunding,
    microgons: targetMicrogons,
    micronots: scaledMicronots > baseFunding.micronots ? scaledMicronots : baseFunding.micronots,
  };
}
