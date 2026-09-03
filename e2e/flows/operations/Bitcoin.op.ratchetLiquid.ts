import { Keyring, toFixedNumber } from '@argonprotocol/mainchain';
import { getTestMainchainClient, submitAndFinalize } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';

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

const DETAIL_BUTTON = 'Dashboard.selectedDetailLiquid = liquid';
const OPEN_RATCHET_REVIEW = 'BitcoinLiquidDetailOverlay.openRatchetReview';

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
      flow.isVisible(OPEN_RATCHET_REVIEW),
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
      (detailOverlay.visible || (await flow.isVisible(DETAIL_BUTTON)).clickable);
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
      await flow.click(DETAIL_BUTTON, { timeoutMs: 20_000 });
      await flow.waitFor('BitcoinLiquidDetailOverlay', { timeoutMs: 20_000 });
    }

    await submitBitcoinPrice(150_000);

    await flow.click('OverlayBase.clickClose()', { timeoutMs: 10_000 });
    await flow.click(DETAIL_BUTTON, { timeoutMs: 20_000 });
    state = await flow.poll<ILiquidRatchetState>(latest => latest.uiState.ratchetReviewEnabled, {
      pollMs: 1_000,
      timeoutMs: 45_000,
      timeoutMessage: `${flowName}: the Liquid did not become ratchetable after the Bitcoin price update.`,
    });

    if (!state.uiState.ratchetSubmitEnabled) {
      await flow.click(OPEN_RATCHET_REVIEW, { timeoutMs: 20_000 });
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

async function submitBitcoinPrice(btcUsdPrice: number): Promise<void> {
  const override = JSON.parse(process.env.ARGON_NETWORK_CONFIG_OVERRIDE ?? '{}') as { archiveUrl?: string };
  if (!override.archiveUrl) throw new Error('Bitcoin Liquid E2E requires an isolated Argon test-network archive URL.');

  const client = await getTestMainchainClient(override.archiveUrl);
  try {
    const initialSnapshot = await client.at(await client.rpc.chain.getFinalizedHead());
    const currentPrice = await initialSnapshot.query.priceIndex.current();
    const tick = await waitFor(30_000, 'fresh price tick', async () => {
      const currentTick = await client.query.ticks.currentTick();
      if (currentTick <= (currentPrice?.tick ?? 0)) return;
      return currentTick;
    });
    await submitAndFinalize(
      client,
      client.tx.priceIndex.submit(
        {
          btcUsdPrice: toFixedNumber(btcUsdPrice, 18),
          argonUsdPrice: toFixedNumber(1.06, 18),
          argonotUsdPrice: toFixedNumber(0.05, 18),
          argonUsdTargetPrice: toFixedNumber(1.06, 18),
          argonTimeWeightedAverageLiquidity: toFixedNumber(100_000_000, 18),
          tick: BigInt(tick),
        },
        null,
      ),
      new Keyring({ type: 'sr25519' }).addFromUri('//Eve//oracle'),
    );
    await waitFor(30_000, `Bitcoin price ${btcUsdPrice}`, async () => {
      const snapshot = await client.at(await client.rpc.chain.getFinalizedHead());
      const [publishedPrice, rateHistory] = await Promise.all([
        snapshot.query.priceIndex.current(),
        snapshot.query.bitcoinLocks.microgonPerBtcHistory(),
      ]);
      if (!publishedPrice?.btcUsdPrice.isEqualTo(btcUsdPrice)) return;
      if (Number(rateHistory?.at(-1)?.[0] ?? 0) < tick) return;
      return true;
    });
  } finally {
    await client.disconnect();
  }
}
