import { SATOSHIS_PER_BITCOIN } from '@argonprotocol/apps-core';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { formatUnitsToDecimal } from '../helpers/utils.ts';
import { Operation } from './index.ts';

type ILiquidCreateChainState = {
  activeFissionCount: number;
  activeLiquidCount: number;
  walletAvailableMicrogons: string;
};

type ILiquidCreateUiState = {
  createButtonVisible: boolean;
  creationOverlayVisible: boolean;
  collectArgonsVisible: boolean;
  creationSubmitEnabled: boolean;
  creationBlocker?: string;
  detailButtonVisible: boolean;
  detailOverlayVisible: boolean;
};

type ILiquidCreateState = IE2EOperationInspectState<ILiquidCreateChainState, ILiquidCreateUiState>;

export default new Operation<IBitcoinFlowContext, ILiquidCreateState>(import.meta, {
  async inspect({ flow }) {
    const [
      chainState,
      createButton,
      creationOverlay,
      collectArgons,
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
      flow.isVisible({
        selector: '[data-testid="Dashboard.openCreateLiquid()"], [data-testid="BitcoinLiquids.openCreationOverlay()"]',
      }),
      flow.isVisible({
        selector: '[role="dialog"][data-state="open"][data-testid="BitcoinLiquidCreationOverlay"]',
      }),
      flow.isVisible({
        selector:
          '[role="dialog"][data-testid="BitcoinLiquidCreationOverlay"] [data-testid="BitcoinLiquidCreationOverlay.collectArgons"]',
      }),
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
      flow.isVisible('Dashboard.openLiquidDetails(liquid)'),
      flow.isVisible('BitcoinLiquidDetailOverlay'),
    ]);
    const current = chainState ?? {
      activeFissionCount: 0,
      activeLiquidCount: 0,
      walletAvailableMicrogons: '0',
    };
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
    if (!isComplete && current.activeLiquidCount === 1 && !detailButton.visible && !creationOverlayMounted) {
      blockers.push('The created Liquid is not visible on the Bitcoin dashboard.');
    }

    return {
      chainState: current,
      uiState: {
        createButtonVisible: createButton.visible,
        creationOverlayVisible: creationOverlayMounted,
        collectArgonsVisible: collectArgons.visible,
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
  async run({ flow, flowName, state: flowState }) {
    let state = await flow.inspect<ILiquidCreateState>();
    if (state.chainState.activeLiquidCount === 0) {
      const funding = flowState.lockFundingDetails;
      if (!funding) throw new Error(`${flowName}: funded Bitcoin details are unavailable.`);

      if (!state.uiState.creationOverlayVisible) {
        await flow.click(
          {
            selector:
              '[data-testid="Dashboard.openCreateLiquid()"], [data-testid="BitcoinLiquids.openCreationOverlay()"]',
          },
          { timeoutMs: 20_000 },
        );
        await flow.waitFor(
          {
            selector: '[role="dialog"][data-state="open"][data-testid="BitcoinLiquidCreationOverlay"]',
          },
          { timeoutMs: 20_000 },
        );
      }
      await flow.type(
        {
          selector: '[role="dialog"][data-testid="BitcoinLiquidCreationOverlay"] [data-testid="input-number"]',
        },
        formatUnitsToDecimal(funding.amountSatoshis, SATOSHIS_PER_BITCOIN, `${flowName}.liquidSatoshis`),
        { clear: true, timeoutMs: 3_000 },
      );
      const ready = await flow.poll<ILiquidCreateState>(
        latest => latest.uiState.creationSubmitEnabled || !!latest.uiState.creationBlocker,
        { timeoutMs: 30_000 },
      );
      if (ready.uiState.creationBlocker) {
        throw new Error(`${flowName}: ${ready.uiState.creationBlocker}`);
      }
      await flow.click('BitcoinLiquidCreationOverlay.submit()', { timeoutMs: 20_000 });

      state = await flow.poll<ILiquidCreateState>(
        latest => latest.chainState.activeLiquidCount === 1 && latest.uiState.collectArgonsVisible,
        {
          pollMs: 1_000,
          timeoutMs: 180_000,
          timeoutMessage: `${flowName}: finalized Liquid did not reach the Collect Argons step.`,
        },
      );
    }

    if (state.uiState.creationOverlayVisible) {
      await flow.poll<ILiquidCreateState>(latest => latest.uiState.collectArgonsVisible, {
        timeoutMs: 30_000,
        timeoutMessage: `${flowName}: finalized Liquid did not reach the Collect Argons step.`,
      });
      await flow.click({
        selector:
          '[role="dialog"][data-testid="BitcoinLiquidCreationOverlay"] [data-testid="BitcoinLiquidCreationOverlay.done"]',
      });
      state = await flow.poll<ILiquidCreateState>(
        latest => !latest.uiState.creationOverlayVisible && latest.uiState.detailButtonVisible,
        {
          timeoutMs: 20_000,
          timeoutMessage: `${flowName}: Collect Argons did not close onto the finalized Liquid.`,
        },
      );
    }

    if (!state.uiState.detailOverlayVisible) {
      await flow.poll<ILiquidCreateState>(latest => latest.uiState.detailButtonVisible, {
        timeoutMs: 20_000,
        timeoutMessage: `${flowName}: finalized Liquid did not appear on the Bitcoin dashboard.`,
      });
      await flow.click('Dashboard.openLiquidDetails(liquid)', { timeoutMs: 20_000 });
      await flow.waitFor('BitcoinLiquidDetailOverlay', { timeoutMs: 20_000 });
    }
  },
});
