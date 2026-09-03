import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import { Operation } from './index.ts';

type ILiquidCloseState = IE2EOperationInspectState<
  {
    activeFissionCount: number;
    activeLiquidCount: number;
    archivedLiquidCount: number;
    archivedCloseHistoryCount: number;
  },
  {
    detailOverlayVisible: boolean;
    closeReviewVisible: boolean;
    closeSubmitEnabled: boolean;
  }
>;

const DETAIL_BUTTON = 'Dashboard.selectedDetailLiquid = liquid';
const OPEN_CLOSE_REVIEW = 'BitcoinLiquidDetailOverlay.openCloseReview';

export default new Operation<IBitcoinFlowContext, ILiquidCloseState>(import.meta, {
  async inspect({ flow }) {
    const [chainState, detailOverlay, closeReview, closeSubmit] = await Promise.all([
      flow.queryApp(refs => {
        const fissions = refs.getBitcoinFissions();
        const liquids = fissions.getLiquids();
        const archived = liquids.filter(liquid => liquid.isClosed);
        return {
          activeFissionCount: fissions.getAll().length,
          activeLiquidCount: liquids.filter(liquid => !liquid.isClosed).length,
          archivedLiquidCount: archived.length,
          archivedCloseHistoryCount: archived.filter(liquid => liquid.closeHistoryEntry !== undefined).length,
        };
      }),
      flow.isVisible('BitcoinLiquidDetailOverlay'),
      flow.isVisible(OPEN_CLOSE_REVIEW),
      flow.isVisible('BitcoinLiquidDetailOverlay.confirmClose()'),
    ]);
    const current = chainState ?? {
      activeFissionCount: 0,
      activeLiquidCount: 0,
      archivedLiquidCount: 0,
      archivedCloseHistoryCount: 0,
    };
    const isComplete =
      current.activeFissionCount === 0 &&
      current.activeLiquidCount === 0 &&
      current.archivedLiquidCount === 1 &&
      current.archivedCloseHistoryCount === 1;
    const canRun =
      !isComplete &&
      current.activeFissionCount === 1 &&
      current.activeLiquidCount === 1 &&
      (detailOverlay.visible || (await flow.isVisible(DETAIL_BUTTON)).clickable);
    let state: IE2EOperationState = 'processing';
    if (isComplete) state = 'complete';
    else if (canRun) state = 'runnable';

    const blockers: string[] = [];
    if (current.activeFissionCount > 1) blockers.push('Expected at most one active Fission in the isolated flow.');
    if (current.activeLiquidCount > 1) blockers.push('Expected at most one active Liquid in the isolated flow.');
    if (current.activeLiquidCount && current.archivedLiquidCount) {
      blockers.push('The isolated Liquid appears in both active and archived state.');
    }
    if (current.archivedLiquidCount > 1) blockers.push('Expected at most one archived Liquid in the isolated flow.');

    return {
      chainState: current,
      uiState: {
        detailOverlayVisible: detailOverlay.visible,
        closeReviewVisible: closeReview.visible,
        closeSubmitEnabled: closeSubmit.enabled,
      },
      state: blockers.length && !canRun ? 'uiStateMismatch' : state,
      phase: closeSubmit.visible
        ? 'liquid:close-review'
        : isComplete
          ? 'liquid:closed'
          : closeReview.visible
            ? 'liquid:close-ready'
            : 'liquid:awaiting-close',
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName }) {
    const state = await flow.inspect<ILiquidCloseState>();
    if (!state.uiState.detailOverlayVisible) {
      await flow.click(DETAIL_BUTTON, { timeoutMs: 20_000 });
      await flow.waitFor('BitcoinLiquidDetailOverlay', { timeoutMs: 20_000 });
    }
    if (!state.uiState.closeSubmitEnabled) {
      await flow.click(OPEN_CLOSE_REVIEW, { timeoutMs: 20_000 });
      await flow.poll<ILiquidCloseState>(latest => latest.uiState.closeSubmitEnabled, {
        pollMs: 500,
        timeoutMs: 30_000,
        timeoutMessage: `${flowName}: the close review did not become submittable.`,
      });
    }
    await flow.click('BitcoinLiquidDetailOverlay.confirmClose()', { timeoutMs: 20_000 });
    await flow.poll<ILiquidCloseState>(
      latest =>
        latest.chainState.activeFissionCount === 0 &&
        latest.chainState.archivedLiquidCount === 1 &&
        latest.chainState.archivedCloseHistoryCount === 1,
      {
        pollMs: 1_000,
        timeoutMs: 180_000,
        timeoutMessage: `${flowName}: the Liquid did not close and appear in archived history.`,
      },
    );
  },
});
