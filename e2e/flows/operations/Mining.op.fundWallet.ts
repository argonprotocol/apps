import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { getWalletOverlayFundingNeeded, sudoFundWallet, type ISudoFundWalletInput } from '../helpers/sudoFundWallet.ts';
import { parseDecimalToUnits, pollEvery } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

const DEFAULT_MINING_FUNDING_MULTIPLIER = 10n;

type IFundingState = {
  walletFullyFunded: boolean;
};

type IMiningFundingQueryRefs = {
  config: {
    hasSavedBiddingRules: boolean;
    biddingRules: {
      initialMicrogonRequirement?: bigint;
      initialMicronotRequirement?: bigint;
    };
  };
  wallets: {
    miningHoldWallet: {
      availableMicronots: bigint;
      reservedMicronots: bigint;
    };
    miningBotWallet: {
      availableMicronots: bigint;
      reservedMicronots: bigint;
    };
    totalMiningMicrogons?: bigint;
  };
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
      flow.isVisible('WalletOverlay.closeOverlay()'),
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

    const requiredFunding = await getWalletOverlayFundingNeeded(flow);
    const fundingNeeded = requiredFunding.microgons > 0n || requiredFunding.micronots > 0n;
    const funding = fundingNeeded ? deriveMiningFunding(flowName, requiredFunding, input.fundingArgons) : undefined;
    await flow.click('WalletOverlay.closeOverlay()', { timeoutMs: 8_000 });
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
        return nextState.chainState.walletFullyFunded || nextState.uiState.walletFullyFunded || nextState.state === 'complete';
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
  return await flow.queryApp<IFundingState>(
    (({ config, wallets }: IMiningFundingQueryRefs): IFundingState => {
      if (!config.hasSavedBiddingRules) {
        return { walletFullyFunded: false };
      }

      const availableMicronots =
        wallets.miningHoldWallet.availableMicronots + wallets.miningBotWallet.availableMicronots;
      const reservedMicronots =
        wallets.miningHoldWallet.reservedMicronots + wallets.miningBotWallet.reservedMicronots;
      const availableMicrogons = wallets.totalMiningMicrogons ?? 0n;
      const requiredMicrogons = config.biddingRules.initialMicrogonRequirement ?? 0n;
      const requiredMicronots = config.biddingRules.initialMicronotRequirement ?? 0n;

      return {
        walletFullyFunded:
          availableMicrogons >= requiredMicrogons && availableMicronots + reservedMicronots >= requiredMicronots,
      };
    }).toString(),
    { timeoutMs: 10_000 },
  );
}
