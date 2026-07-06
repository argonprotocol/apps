import { isAddress, MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { sudoFundWallet, type ISudoFundWalletInput } from '../helpers/sudoFundWallet.ts';
import { readClipboardWithRetries } from '../helpers/readClipboardWithRetries.ts';
import { parseDecimalToUnits, pollEvery } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import { MiningSetupStatus } from '../types/srcVue.ts';

const DEFAULT_MINING_FUNDING_MULTIPLIER = 10n;
const MICROGONS_PER_ARGON_TEXT = BigInt(MICROGONS_PER_ARGON).toString();

type IFundingState = {
  walletFullyFunded: boolean;
};

type IFundWalletUiState = {
  fundOverlayVisible: boolean;
  walletOverlayVisible: boolean;
  walletFullyFunded: boolean;
  dashboardVisible: boolean;
};

interface IFundWalletState extends IE2EOperationInspectState<IFundingState, IFundWalletUiState> {
  fundOverlayVisible: boolean;
  walletOverlayVisible: boolean;
  walletFullyFunded: boolean;
  dashboardVisible: boolean;
}

export default new Operation<IMiningFlowContext, IFundWalletState>(import.meta, {
  async inspect({ flow }) {
    const [fundingState, fundOverlayEntry, walletOverlayEntry, dashboard] = await Promise.all([
      readFundingState(flow),
      flow.isVisible('SetupChecklist.openFundMiningAccountOverlay()'),
      flow.isVisible('WalletOverlay'),
      flow.isVisible('MiningDashboard'),
    ]);
    const walletFullyFunded = fundingState?.walletFullyFunded ?? false;
    const dashboardVisible = dashboard.visible;
    const isComplete = dashboardVisible || walletFullyFunded;
    const canRun = fundOverlayEntry.visible && !dashboardVisible && !walletFullyFunded;
    let operationState: 'complete' | 'runnable' | 'processing' = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !fundOverlayEntry.visible) blockers.push('Mining fund-wallet checklist step is not visible.');
    return {
      chainState: fundingState ?? {
        walletFullyFunded: false,
      },
      uiState: {
        fundOverlayVisible: fundOverlayEntry.visible,
        walletOverlayVisible: walletOverlayEntry.visible,
        walletFullyFunded,
        dashboardVisible,
      },
      state: operationState,
      fundOverlayVisible: fundOverlayEntry.visible,
      walletOverlayVisible: walletOverlayEntry.visible,
      walletFullyFunded,
      dashboardVisible,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName, input }, state) {
    if (state.walletFullyFunded || state.dashboardVisible || !state.fundOverlayVisible) {
      return;
    }

    await flow.click('SetupChecklist.openFundMiningAccountOverlay()');
    await flow.waitFor('WalletOverlay.micronotsNeeded');
    await flow.waitFor('WalletOverlay.microgonsNeeded');

    const microgonsNeededRaw = await flow.getAttribute('WalletOverlay.microgonsNeeded', 'data-value');
    const micronotsNeededRaw = await flow
      .getAttribute('WalletOverlay.micronotsNeeded', 'data-value', { timeoutMs: 1_000 })
      .catch(() => null);
    const walletAddress = await readClipboardWithRetries(
      flow,
      async () => {
        await flow.click('defaultArgonWalletAddress.openMenu()', { timeoutMs: 5_000 });
        await flow.waitFor('defaultArgonWalletAddress.copyContent()', { timeoutMs: 5_000 });
        await flow.click('defaultArgonWalletAddress.copyContent()', { timeoutMs: 5_000 });
      },
      value => isAddress(value),
      { label: 'default Argon wallet address' },
    );

    if (!walletAddress) {
      throw new Error(`${flowName}: missing default Argon wallet address.`);
    }
    if (!microgonsNeededRaw) {
      throw new Error(`${flowName}: missing mining wallet microgons requirement.`);
    }

    const requiredFunding = {
      address: walletAddress,
      microgons: BigInt(microgonsNeededRaw),
      micronots: BigInt(micronotsNeededRaw ?? '0'),
    };
    const fundingNeeded = requiredFunding.microgons > 0n || requiredFunding.micronots > 0n;
    const funding = fundingNeeded ? deriveMiningFunding(flowName, requiredFunding, input.fundingArgons) : undefined;
    await flow.click('OverlayBase.clickClose()', { timeoutMs: 8_000 });
    await pollEvery(250, async () => !(await flow.inspect(this)).uiState.walletOverlayVisible, {
      timeoutMs: 20_000,
      timeoutMessage: `${flowName}: mining wallet overlay did not close after funding.`,
    });
    if (!funding) return;

    const fundingResult = await sudoFundWallet(funding);
    console.info(`[E2E] ${flowName} funded wallet`, {
      address: fundingResult.address,
      requestedMicrogons: fundingResult.requestedMicrogons.toString(),
      requestedMicronots: fundingResult.requestedMicronots.toString(),
      fundedMicrogons: fundingResult.fundedMicrogons.toString(),
      fundedMicronots: fundingResult.fundedMicronots.toString(),
    });

    await pollEvery(
      1_000,
      async () => {
        const nextState = await flow.inspect(this);
        return (
          nextState.chainState.walletFullyFunded ||
          nextState.uiState.walletFullyFunded ||
          nextState.state === 'complete'
        );
      },
      {
        timeoutMs: 120_000,
        timeoutMessage: `${flowName}: mining wallet funding did not propagate to the UI in time.`,
      },
    );
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

async function readFundingState(flow: IMiningFlowContext['flow']): Promise<IFundingState | undefined> {
  return await flow.queryApp(
    (refs, args: { microgonsPerArgonText: string; finishedSetupStatus: MiningSetupStatus }) => {
      if (!refs.config.hasSavedBiddingRules) {
        return { walletFullyFunded: false };
      }

      const futureTransactionFeeBudgetMicrogons =
        refs.config.miningSetupStatus === args.finishedSetupStatus ? 0n : 2n * BigInt(args.microgonsPerArgonText);
      const availableMicronots =
        refs.wallets.defaultArgonWallet.availableMicronots + refs.wallets.miningBotWallet.availableMicronots;
      const reservedMicronots =
        refs.wallets.defaultArgonWallet.reservedMicronots + refs.wallets.miningBotWallet.reservedMicronots;
      const availableMicrogons = refs.wallets.totalMiningMicrogons ?? 0n;
      const requiredMicrogons =
        (refs.config.biddingRules.initialMicrogonRequirement ?? 0n) + futureTransactionFeeBudgetMicrogons;
      const requiredMicronots = refs.config.biddingRules.initialMicronotRequirement ?? 0n;

      return {
        walletFullyFunded:
          availableMicrogons >= requiredMicrogons && availableMicronots + reservedMicronots >= requiredMicronots,
      };
    },
    {
      timeoutMs: 10_000,
      args: {
        microgonsPerArgonText: MICROGONS_PER_ARGON_TEXT,
        finishedSetupStatus: MiningSetupStatus.Finished,
      },
    },
  );
}
