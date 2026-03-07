import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { getWalletOverlayFundingNeeded, sudoFundWallet } from '../helpers/sudoFundWallet.ts';
import { parseDecimalToUnits, pollEvery } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type IVaultingFundingInspect = {
  walletIsFullyFunded: boolean;
  overlayIsOpen: boolean;
  availableMicrogons: string;
  availableMicronots: string;
  requiredMicrogons: string;
  requiredMicronots: string;
};

type IFundVaultingWalletUiState = {
  lockOverlayVisible: boolean;
  dashboardVisible: boolean;
  fundOverlayVisible: boolean;
  createVaultVisible: boolean;
  createVaultClickable: boolean;
  installingVisible: boolean;
};

type IFundVaultingWalletState = IE2EOperationInspectState<IVaultingFundingInspect, IFundVaultingWalletUiState>;

export default new Operation<IVaultingFlowContext, IFundVaultingWalletState>(import.meta, {
  async inspect({ flow }) {
    const [fundingState, lockOverlayEntry, dashboard, fundOverlayEntry, createVaultEntry, installingState] =
      await Promise.all([
        flow.queryApp<IVaultingFundingInspect>(
          ((refs: {
            config: {
              vaultingRules?: {
                baseMicrogonCommitment?: bigint;
                baseMicronotCommitment?: bigint;
              } | null;
            };
            wallets: {
              vaultingWallet: {
                availableMicrogons: bigint;
                availableMicronots: bigint;
              };
            };
            controller: {
              overlayIsOpen: boolean;
            };
          }) => {
            const requiredMicrogons = refs.config.vaultingRules?.baseMicrogonCommitment ?? 0n;
            const requiredMicronots = refs.config.vaultingRules?.baseMicronotCommitment ?? 0n;
            const availableMicrogons = refs.wallets.vaultingWallet.availableMicrogons ?? 0n;
            const availableMicronots = refs.wallets.vaultingWallet.availableMicronots ?? 0n;

            return {
              walletIsFullyFunded: availableMicrogons >= requiredMicrogons && availableMicronots >= requiredMicronots,
              overlayIsOpen: refs.controller.overlayIsOpen,
              availableMicrogons: availableMicrogons.toString(),
              availableMicronots: availableMicronots.toString(),
              requiredMicrogons: requiredMicrogons.toString(),
              requiredMicronots: requiredMicronots.toString(),
            };
          }).toString(),
          { timeoutMs: 10_000 },
        ),
        flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
        flow.isVisible('VaultingDashboard'),
        flow.isVisible('SetupChecklist.openFundVaultingAccountOverlay()'),
        flow.isVisible('SetupChecklist.startCreateVault()'),
        flow.isVisible({ selector: '.VaultIsInstalling' }),
      ]);
    const createVaultVisible = createVaultEntry.visible;
    const createVaultClickable = createVaultEntry.clickable;
    const installingVisible = installingState.visible;
    const walletIsFullyFunded = fundingState?.walletIsFullyFunded ?? false;
    const isComplete = walletIsFullyFunded || installingVisible || lockOverlayEntry.visible || dashboard.visible;
    const canRun =
      fundOverlayEntry.visible &&
      !walletIsFullyFunded &&
      !installingVisible &&
      !lockOverlayEntry.visible &&
      !dashboard.visible;
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
        overlayIsOpen: false,
        availableMicrogons: '0',
        availableMicronots: '0',
        requiredMicrogons: '0',
        requiredMicronots: '0',
      },
      uiState: {
        lockOverlayVisible: lockOverlayEntry.visible,
        dashboardVisible: dashboard.visible,
        fundOverlayVisible: fundOverlayEntry.visible,
        createVaultVisible,
        createVaultClickable,
        installingVisible,
      },
      state: operationState,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName, input }, state) {
    if (
      (state.uiState.createVaultVisible && state.uiState.createVaultClickable) ||
      state.uiState.installingVisible ||
      state.uiState.lockOverlayVisible ||
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
    await pollEvery(250, async () => !(await flow.inspect(this)).chainState.overlayIsOpen, {
      timeoutMs: 20_000,
      timeoutMessage: `${flowName}: vaulting wallet overlay did not close after funding.`,
    });

    await pollEvery(
      1_000,
      async () => {
        const nextState = await flow.inspect(this);
        return (
          nextState.chainState.walletIsFullyFunded ||
          nextState.uiState.lockOverlayVisible ||
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
