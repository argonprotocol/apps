import { promises as Fs } from 'node:fs';

import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import { Operation } from './index.ts';

type ILiquidRatchetState = IE2EOperationInspectState<
  {
    activeFissionCount: number;
    activeLiquidCount: number;
    ratchetNumber: number;
    ratchetHistoryCount: number;
  },
  {
    detailOverlayVisible: boolean;
    ratchetReviewEnabled: boolean;
    ratchetSubmitEnabled: boolean;
  }
>;

export default new Operation<IBitcoinFlowContext, ILiquidRatchetState>(import.meta, {
  async inspect({ flow }) {
    const [chainState, detailOverlay, ratchetReview, ratchetSubmit] = await Promise.all([
      flow.queryApp(refs => {
        const fissions = refs.getBitcoinFissions();
        const activeLiquids = fissions.getLiquids().filter(liquid => !liquid.isClosed);
        const activeLiquid = activeLiquids[0];
        return {
          activeFissionCount: fissions.getAll().length,
          activeLiquidCount: activeLiquids.length,
          ratchetNumber: activeLiquid ? Math.max(...activeLiquid.fissions.map(fission => fission.ratchetNumber)) : 0,
          ratchetHistoryCount: activeLiquid?.history.filter(entry => entry.kind === 'ratchet').length ?? 0,
        };
      }),
      flow.isVisible('BitcoinLiquidDetailOverlay'),
      flow.isVisible('BitcoinLiquidDetailOverlay.openRatchetReview'),
      flow.isVisible('BitcoinLiquidDetailOverlay.confirmRatchet()'),
    ]);
    const current = chainState ?? {
      activeFissionCount: 0,
      activeLiquidCount: 0,
      ratchetNumber: 0,
      ratchetHistoryCount: 0,
    };
    const isComplete =
      current.activeFissionCount === 1 &&
      current.activeLiquidCount === 1 &&
      current.ratchetNumber === 1 &&
      current.ratchetHistoryCount === 1;
    const canRun =
      !isComplete &&
      current.activeFissionCount === 1 &&
      current.activeLiquidCount === 1 &&
      current.ratchetNumber === 0 &&
      current.ratchetHistoryCount === 0 &&
      (detailOverlay.visible || (await flow.isVisible('Dashboard.openLiquidDetails(liquid)')).clickable);
    let state: IE2EOperationState = 'processing';
    if (isComplete) state = 'complete';
    else if (canRun) state = 'runnable';

    const blockers: string[] = [];
    if (current.activeFissionCount !== 1) blockers.push('Expected one active Fission before ratcheting.');
    if (current.activeLiquidCount !== 1) blockers.push('Expected one active Liquid before ratcheting.');
    if (current.ratchetNumber > 1 || current.ratchetHistoryCount > 1) {
      blockers.push('Expected the E2E Liquid to have at most one completed ratchet.');
    }

    return {
      chainState: current,
      uiState: {
        detailOverlayVisible: detailOverlay.visible,
        ratchetReviewEnabled: ratchetReview.enabled,
        ratchetSubmitEnabled: ratchetSubmit.enabled,
      },
      state: blockers.length && !canRun ? 'uiStateMismatch' : state,
      phase: ratchetSubmit.visible
        ? 'liquid:ratchet-review'
        : ratchetReview.enabled
          ? 'liquid:ratchet-ready'
          : isComplete
            ? 'liquid:ratcheted'
            : 'liquid:awaiting-ratchet',
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName }) {
    let state = await flow.inspect<ILiquidRatchetState>();
    if (!state.uiState.detailOverlayVisible) {
      await flow.click('Dashboard.openLiquidDetails(liquid)', { timeoutMs: 20_000 });
      await flow.waitFor('BitcoinLiquidDetailOverlay', { timeoutMs: 20_000 });
    }

    const priceIndexFilePath = flow.getData<string>('priceIndexFilePath');
    if (!priceIndexFilePath) throw new Error(`${flowName}: isolated Bitcoin price input is unavailable.`);
    const priceIndex = JSON.parse(await Fs.readFile(priceIndexFilePath, 'utf8')) as Record<string, number>;
    priceIndex.btc_usd_price = 150_000;
    await Fs.writeFile(priceIndexFilePath, `${JSON.stringify(priceIndex, null, 2)}\n`);

    await flow.click('OverlayBase.clickClose()', { timeoutMs: 10_000 });
    await flow.click('Dashboard.openLiquidDetails(liquid)', { timeoutMs: 20_000 });
    state = await flow.poll<ILiquidRatchetState>(latest => latest.uiState.ratchetReviewEnabled, {
      pollMs: 1_000,
      timeoutMs: 45_000,
      timeoutMessage: `${flowName}: the Liquid did not become ratchetable after the Bitcoin price update.`,
    });

    if (!state.uiState.ratchetSubmitEnabled) {
      await flow.click('BitcoinLiquidDetailOverlay.openRatchetReview', { timeoutMs: 20_000 });
      await flow.poll<ILiquidRatchetState>(latest => latest.uiState.ratchetSubmitEnabled, {
        pollMs: 500,
        timeoutMs: 30_000,
        timeoutMessage: `${flowName}: the ratchet review did not become submittable.`,
      });
    }
    await flow.click('BitcoinLiquidDetailOverlay.confirmRatchet()', { timeoutMs: 20_000 });
    await flow.poll<ILiquidRatchetState>(
      latest => latest.chainState.ratchetNumber === 1 && latest.chainState.ratchetHistoryCount === 1,
      {
        pollMs: 1_000,
        timeoutMs: 180_000,
        timeoutMessage: `${flowName}: the ratchet did not finalize and appear in Liquid history.`,
      },
    );
  },
});
