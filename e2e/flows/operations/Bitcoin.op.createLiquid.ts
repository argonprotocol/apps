import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { Operation } from './index.ts';

type ILiquidCreateChainState = {
  activeFissionCount: number;
  activeLiquidCount: number;
  walletAvailableMicrogons: string;
};

type ILiquidCreateUiState = {
  createButtonVisible: boolean;
  creationOverlayVisible: boolean;
  creationSubmitEnabled: boolean;
  creationBlocker?: string;
  detailButtonVisible: boolean;
  detailOverlayVisible: boolean;
};

type ILiquidCreateState = IE2EOperationInspectState<ILiquidCreateChainState, ILiquidCreateUiState>;

const DETAIL_BUTTON = 'Dashboard.selectedDetailLiquid = liquid';

export default new Operation<IBitcoinFlowContext, ILiquidCreateState>(import.meta, {
  async inspect({ flow }) {
    const [
      chainState,
      createButton,
      creationOverlay,
      creationSubmit,
      creationError,
      walletShortfall,
      detailButton,
      detailOverlay,
    ] = await Promise.all([
      flow.queryApp(
        refs => {
          const fissions = refs.getBitcoinFissions();
          return {
            activeFissionCount: fissions.getAll().length,
            activeLiquidCount: fissions.getLiquids().length,
            walletAvailableMicrogons: refs.wallets.defaultArgonWallet.availableMicrogons.toString(),
          };
        },
        { timeoutMs: 20_000 },
      ),
      flow.isVisible('Dashboard.openCreateLiquid()'),
      flow.isVisible('BitcoinLiquidCreationOverlay'),
      flow.isVisible('BitcoinLiquidCreationOverlay.submit()'),
      flow
        .getText(
          { selector: '[role="dialog"][data-testid="BitcoinLiquidCreationOverlay"] .mb-3.bg-yellow-100' },
          { timeoutMs: 250 },
        )
        .catch(() => undefined),
      flow
        .getText(
          {
            selector:
              '[role="dialog"][data-testid="BitcoinLiquidCreationOverlay"] [data-testid="WalletFundingCallout"]',
          },
          { timeoutMs: 250 },
        )
        .catch(() => undefined),
      flow.isVisible(DETAIL_BUTTON),
      flow.isVisible('BitcoinLiquidDetailOverlay'),
    ]);
    const current = chainState ?? { activeFissionCount: 0, activeLiquidCount: 0, walletAvailableMicrogons: '0' };
    const isComplete = current.activeFissionCount === 1 && current.activeLiquidCount === 1 && detailOverlay.visible;
    const creationOverlayMounted = creationOverlay.exists;
    const canRun =
      !isComplete &&
      (creationOverlayMounted ||
        (current.activeLiquidCount === 0 && createButton.clickable) ||
        (current.activeLiquidCount === 1 && detailButton.clickable));
    let state: IE2EOperationState = 'processing';
    if (isComplete) state = 'complete';
    else if (canRun) state = 'runnable';

    const blockers: string[] = [];
    if (current.activeFissionCount > 1) blockers.push('Expected one Fission after allocating one funded Lock.');
    if (current.activeLiquidCount > 1) blockers.push('Expected one Liquid after creating from one funded Lock.');
    if (!isComplete && current.activeLiquidCount === 0 && !createButton.visible && !creationOverlayMounted) {
      blockers.push('Create Liquid is not visible for the funded Bitcoin Lock.');
    }
    if (!isComplete && current.activeLiquidCount === 1 && !detailButton.visible) {
      blockers.push('The created Liquid is not visible on the Bitcoin dashboard.');
    }

    return {
      chainState: current,
      uiState: {
        createButtonVisible: createButton.visible,
        creationOverlayVisible: creationOverlayMounted,
        creationSubmitEnabled: creationSubmit.enabled,
        creationBlocker: creationError ?? walletShortfall,
        detailButtonVisible: detailButton.visible,
        detailOverlayVisible: detailOverlay.visible,
      },
      state: blockers.length && !canRun ? 'uiStateMismatch' : state,
      phase: detailOverlay.visible
        ? 'liquid:details'
        : current.activeLiquidCount
          ? 'liquid:created'
          : creationOverlayMounted
            ? 'liquid:create'
            : undefined,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName }) {
    let state = await flow.inspect<ILiquidCreateState>();
    if (state.chainState.activeLiquidCount === 0) {
      if (!state.uiState.creationOverlayVisible) {
        await flow.click('Dashboard.openCreateLiquid()', { timeoutMs: 20_000 });
        await flow.waitFor('BitcoinLiquidCreationOverlay', { timeoutMs: 20_000 });
      }
      const ready = await flow.poll<ILiquidCreateState>(
        latest => latest.uiState.creationSubmitEnabled || !!latest.uiState.creationBlocker,
        { timeoutMs: 30_000 },
      );
      if (ready.uiState.creationBlocker) {
        throw new Error(`${flowName}: ${ready.uiState.creationBlocker}`);
      }
      await flow.click('BitcoinLiquidCreationOverlay.submit()', { timeoutMs: 20_000 });

      await flow.poll<ILiquidCreateState>(
        latest => latest.chainState.activeLiquidCount === 1 && latest.uiState.detailButtonVisible,
        {
          pollMs: 1_000,
          timeoutMs: 180_000,
          timeoutMessage: `${flowName}: finalized Liquid did not appear on the Bitcoin dashboard.`,
        },
      );
      state = await flow.inspect<ILiquidCreateState>();
    }

    if (!state.uiState.detailOverlayVisible) {
      await flow.click(DETAIL_BUTTON, { timeoutMs: 20_000 });
      await flow.waitFor('BitcoinLiquidDetailOverlay', { timeoutMs: 20_000 });
    }
  },
});
