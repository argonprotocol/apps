import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { getWalletOverlayFundingNeeded, sudoFundWallet } from '../helpers/sudoFundWallet.ts';
import { parseDecimalToUnits, pollEvery } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

const MICROGONS_PER_ARGON_TEXT = BigInt(MICROGONS_PER_ARGON).toString();

type IVaultingFundingInspect = {
  walletIsFullyFunded: boolean;
};

type IFundVaultingWalletUiState = {
  dashboardVisible: boolean;
  fundOverlayVisible: boolean;
  installingVisible: boolean;
};

type IFundVaultingWalletState = IE2EOperationInspectState<IVaultingFundingInspect, IFundVaultingWalletUiState>;

export default new Operation<IVaultingFlowContext, IFundVaultingWalletState>(import.meta, {
  async inspect({ flow }) {
    const [fundingState, dashboard, fundOverlayEntry, installingState] = await Promise.all([
      flow.queryApp<IVaultingFundingInspect>(
        `(({ config, wallets }) => {
          const futureTransactionFeeBudgetMicrogons = 2n * BigInt('${MICROGONS_PER_ARGON_TEXT}');
          const treasuryBondSuggestionIncrementMicrogons = 100n * BigInt('${MICROGONS_PER_ARGON_TEXT}');
          const baseRequiredMicrogons = config.vaultingRules?.baseMicrogonCommitment ?? 0n;
          const suggestedTreasuryMicrogons = baseRequiredMicrogons / 20n;
          const treasuryBondSuggestionMicrogons =
            config.vaultingSetupStatus === 'Finished' || suggestedTreasuryMicrogons <= 0n
              ? 0n
              : ((suggestedTreasuryMicrogons + treasuryBondSuggestionIncrementMicrogons - 1n) /
                  treasuryBondSuggestionIncrementMicrogons) *
                treasuryBondSuggestionIncrementMicrogons;
          const requiredMicrogons =
            baseRequiredMicrogons +
            (config.vaultingSetupStatus === 'Finished'
              ? 0n
              : futureTransactionFeeBudgetMicrogons + treasuryBondSuggestionMicrogons);
          const requiredMicronots = config.vaultingRules?.baseMicronotCommitment ?? 0n;
          const availableMicrogons = wallets.vaultingWallet.availableMicrogons ?? 0n;
          const availableMicronots = wallets.vaultingWallet.availableMicronots ?? 0n;

          return {
            walletIsFullyFunded: availableMicrogons >= requiredMicrogons && availableMicronots >= requiredMicronots,
          };
        })`,
        { timeoutMs: 10_000 },
      ),
      flow.isVisible('VaultingDashboard'),
      flow.isVisible('SetupChecklist.openFundVaultingAccountOverlay()'),
      flow.isVisible({ selector: '.VaultIsInstalling' }),
    ]);
    const installingVisible = installingState.visible;
    const walletIsFullyFunded = fundingState?.walletIsFullyFunded ?? false;
    const isComplete = walletIsFullyFunded || installingVisible || dashboard.visible;
    const canRun = fundOverlayEntry.visible && !walletIsFullyFunded && !installingVisible && !dashboard.visible;
    let operationState: 'complete' | 'runnable' | 'processing' = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !fundOverlayEntry.visible) blockers.push('Vaulting fund-wallet step is not visible.');
    return {
      chainState: fundingState ?? {
        walletIsFullyFunded: false,
      },
      uiState: {
        dashboardVisible: dashboard.visible,
        fundOverlayVisible: fundOverlayEntry.visible,
        installingVisible,
      },
      state: operationState,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName, input }, state) {
    if (
      state.chainState.walletIsFullyFunded ||
      state.uiState.installingVisible ||
      state.uiState.dashboardVisible ||
      !state.uiState.fundOverlayVisible
    ) {
      return;
    }

    await flow.click('SetupChecklist.openFundVaultingAccountOverlay()');
    const { address, microgons, micronots } = await getWalletOverlayFundingNeeded(flow);
    const extraMicrogons = parseDecimalToUnits(
      input.extraFundingArgons ?? '1000',
      BigInt(MICROGONS_PER_ARGON),
      `${flowName}.extraFundingArgons`,
    );

    const fundingResult = await sudoFundWallet({
      address,
      microgons: microgons + extraMicrogons,
      micronots,
    });
    console.info(`[E2E] ${flowName} funded vaulting wallet`, {
      address: fundingResult.address,
      requestedMicrogons: fundingResult.requestedMicrogons.toString(),
      requestedMicronots: fundingResult.requestedMicronots.toString(),
      fundedMicrogons: fundingResult.fundedMicrogons.toString(),
      fundedMicronots: fundingResult.fundedMicronots.toString(),
    });

    if (microgons > 0n) {
      await flow.waitFor('Received.argons', { timeoutMs: 120_000 });
    }
    if (micronots > 0n) {
      await flow.waitFor('Received.argonots', { timeoutMs: 120_000 });
    }

    await flow.click('WalletOverlay.closeOverlay()', { timeoutMs: 8_000 });
    await pollEvery(250, async () => !(await flow.inspect(this)).uiState.fundOverlayVisible, {
      timeoutMs: 20_000,
      timeoutMessage: `${flowName}: vaulting wallet overlay did not close after funding.`,
    });

    await pollEvery(
      1_000,
      async () => {
        const nextState = await flow.inspect(this);
        return (
          nextState.chainState.walletIsFullyFunded ||
          nextState.uiState.dashboardVisible ||
          nextState.uiState.installingVisible
        );
      },
      {
        timeoutMs: 120_000,
        timeoutMessage: `${flowName}: vaulting wallet did not become funded after sudo funding.`,
      },
    );
  },
});
