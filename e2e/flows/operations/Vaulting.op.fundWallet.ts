import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { sudoFundWallet } from '../helpers/sudoFundWallet.ts';
import { parseDecimalToUnits, pollEvery } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import { VaultingSetupStatus } from '../types/srcVue.ts';

const MICROGONS_PER_ARGON_TEXT = BigInt(MICROGONS_PER_ARGON).toString();

type IVaultingFundingInspect = {
  walletIsFullyFunded: boolean;
};

type IFundVaultingWalletUiState = {
  dashboardVisible: boolean;
  fundOverlayVisible: boolean;
  walletOverlayVisible: boolean;
  installingVisible: boolean;
};

type IFundVaultingWalletState = IE2EOperationInspectState<IVaultingFundingInspect, IFundVaultingWalletUiState>;

export default new Operation<IVaultingFlowContext, IFundVaultingWalletState>(import.meta, {
  async inspect({ flow }) {
    const [fundingState, dashboard, fundOverlayEntry, walletOverlayEntry, installingState] = await Promise.all([
      flow.queryApp(
        (
          refs,
          args: {
            microgonsPerArgonText: string;
            finishedSetupStatus: VaultingSetupStatus;
          },
        ) => {
          const futureTransactionFeeBudgetMicrogons = 2n * BigInt(args.microgonsPerArgonText);
          const treasuryBondSuggestionIncrementMicrogons = 100n * BigInt(args.microgonsPerArgonText);
          const baseRequiredMicrogons = refs.config.vaultingRules?.baseMicrogonCommitment ?? 0n;
          const suggestedTreasuryMicrogons = baseRequiredMicrogons / 20n;
          const treasuryBondSuggestionMicrogons =
            refs.config.vaultingSetupStatus === args.finishedSetupStatus || suggestedTreasuryMicrogons <= 0n
              ? 0n
              : ((suggestedTreasuryMicrogons + treasuryBondSuggestionIncrementMicrogons - 1n) /
                  treasuryBondSuggestionIncrementMicrogons) *
                treasuryBondSuggestionIncrementMicrogons;
          const requiredMicrogons =
            baseRequiredMicrogons +
            (refs.config.vaultingSetupStatus === args.finishedSetupStatus
              ? 0n
              : futureTransactionFeeBudgetMicrogons + treasuryBondSuggestionMicrogons);
          const requiredMicronots = refs.config.vaultingRules?.baseMicronotCommitment ?? 0n;
          const availableMicrogons = refs.wallets.defaultArgonWallet.availableMicrogons ?? 0n;
          const availableMicronots = refs.wallets.defaultArgonWallet.availableMicronots ?? 0n;

          return {
            walletIsFullyFunded: availableMicrogons >= requiredMicrogons && availableMicronots >= requiredMicronots,
          };
        },
        {
          timeoutMs: 10_000,
          args: {
            microgonsPerArgonText: MICROGONS_PER_ARGON_TEXT,
            finishedSetupStatus: VaultingSetupStatus.Finished,
          },
        },
      ),
      flow.isVisible('VaultingDashboard'),
      flow.isVisible('SetupChecklist.openFundVaultingAccountOverlay()'),
      flow.isVisible('WalletOverlay'),
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
        walletOverlayVisible: walletOverlayEntry.visible,
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
    await flow.waitFor('WalletOverlay.micronotsNeeded', { state: 'exists' });
    await flow.waitFor('WalletOverlay.microgonsNeeded', { state: 'exists' });

    const microgonsNeededRaw = await flow.getAttribute('WalletOverlay.microgonsNeeded', 'data-value');
    const micronotsNeededRaw = await flow
      .getAttribute('WalletOverlay.micronotsNeeded', 'data-value', { timeoutMs: 1_000 })
      .catch(() => null);
    const walletAddress = await flow.queryApp(refs => refs.wallets.defaultArgonWallet.address, {
      timeoutMs: 10_000,
    });

    if (!walletAddress) {
      throw new Error(`${flowName}: missing vaulting wallet address.`);
    }
    if (!microgonsNeededRaw) {
      throw new Error(`${flowName}: missing vaulting wallet microgons requirement.`);
    }

    const extraMicrogons = parseDecimalToUnits(
      input.extraFundingArgons ?? '1000',
      BigInt(MICROGONS_PER_ARGON),
      `${flowName}.extraFundingArgons`,
    );
    const requiredMicrogons = BigInt(microgonsNeededRaw);
    const requiredMicronots = BigInt(micronotsNeededRaw ?? '0');
    const fundingNeeded = requiredMicrogons > 0n || requiredMicronots > 0n;

    await flow.click('NavHeader.close()', { timeoutMs: 8_000 });
    await pollEvery(250, async () => !(await flow.inspect(this)).uiState.walletOverlayVisible, {
      timeoutMs: 20_000,
      timeoutMessage: `${flowName}: vaulting wallet overlay did not close after funding.`,
    });

    if (fundingNeeded) {
      const fundingResult = await sudoFundWallet({
        address: walletAddress,
        microgons: requiredMicrogons + extraMicrogons,
        micronots: requiredMicronots,
      });

      console.info(`[E2E] ${flowName} funded wallet`, {
        address: fundingResult.address,
        requestedMicrogons: fundingResult.requestedMicrogons.toString(),
        requestedMicronots: fundingResult.requestedMicronots.toString(),
        fundedMicrogons: fundingResult.fundedMicrogons.toString(),
        fundedMicronots: fundingResult.fundedMicronots.toString(),
      });
    }

    await flow.poll(
      this,
      nextState =>
        nextState.chainState.walletIsFullyFunded ||
        nextState.uiState.dashboardVisible ||
        nextState.uiState.installingVisible,
      {
        timeoutMs: 120_000,
        timeoutMessage: `${flowName}: vaulting wallet did not become funded in time.`,
      },
    );
  },
});
