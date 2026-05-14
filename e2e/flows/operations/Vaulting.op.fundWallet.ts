import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { sudoFundWallet } from '../helpers/sudoFundWallet.ts';
import { parseDecimalToUnits, pollEvery } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import { VaultingSetupStatus, WalletType } from '../types/srcVue.ts';
import appFundWalletFromEthereum from './App.op.fundWalletFromEthereum.ts';

const MICROGONS_PER_ARGON_TEXT = BigInt(MICROGONS_PER_ARGON).toString();
const PROOF_SUBMISSION_FEE_FUNDING_MICROGONS = BigInt(MICROGONS_PER_ARGON);

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
          const availableMicrogons = refs.wallets.vaultingWallet.availableMicrogons ?? 0n;
          const availableMicronots = refs.wallets.vaultingWallet.availableMicronots ?? 0n;

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
    const extraMicrogons = parseDecimalToUnits(
      input.extraFundingArgons ?? '1000',
      BigInt(MICROGONS_PER_ARGON),
      `${flowName}.extraFundingArgons`,
    );

    await ensureVaultProofFunding(flow, flowName);
    await flow.run(
      {
        flow,
        flowName,
        input: {
          targetWalletType: WalletType.vaulting,
          extraMicrogons,
        },
      },
      appFundWalletFromEthereum,
    );

    await flow.poll(
      this,
      nextState =>
        nextState.chainState.walletIsFullyFunded ||
        nextState.uiState.dashboardVisible ||
        nextState.uiState.installingVisible,
      {
        timeoutMs: 120_000,
        timeoutMessage: `${flowName}: vaulting wallet did not become funded after Ethereum funding.`,
      },
    );
  },
});

async function ensureVaultProofFunding(flow: IVaultingFlowContext['flow'], flowName: string): Promise<void> {
  const initialState = await readVaultProofFundingState(flow);
  const proofFundingGapMicrogons = PROOF_SUBMISSION_FEE_FUNDING_MICROGONS - initialState.vaultingMicrogons;

  if (proofFundingGapMicrogons <= 0n) {
    return;
  }

  await sudoFundWallet({
    address: initialState.vaultingAddress,
    microgons: proofFundingGapMicrogons,
    micronots: 0n,
  });

  await pollEvery(
    1_000,
    async () => {
      const nextState = await readVaultProofFundingState(flow);
      return nextState.vaultingMicrogons >= PROOF_SUBMISSION_FEE_FUNDING_MICROGONS;
    },
    {
      timeoutMs: 30_000,
      timeoutMessage: `${flowName}: vaulting wallet did not receive proof-submission funding in time.`,
    },
  );
}

async function readVaultProofFundingState(flow: IVaultingFlowContext['flow']): Promise<{
  vaultingAddress: string;
  vaultingMicrogons: bigint;
}> {
  const state = await flow.queryApp(
    refs => ({
      vaultingAddress: refs.wallets.vaultingWallet.address,
      vaultingMicrogons: refs.wallets.vaultingWallet.availableMicrogons.toString(),
    }),
    { timeoutMs: 30_000 },
  );

  if (!state?.vaultingAddress) {
    throw new Error('Unable to read vault proof-funding state from the app.');
  }

  return {
    vaultingAddress: state.vaultingAddress,
    vaultingMicrogons: BigInt(state.vaultingMicrogons),
  };
}
