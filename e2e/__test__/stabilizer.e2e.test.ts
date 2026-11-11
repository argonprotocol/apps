import { it } from 'vitest';
import { FlowSession } from '../FlowSession.ts';
import '../flows/index.ts';
import stabilizerBuyFlow, { stabilizerBuySessionOptions } from '../flows/operations/App.flow.stabilizerBuyAndBid.ts';
import liquidRepaymentFlow from '../flows/operations/Bitcoin.flow.liquidRepayment.ts';

it('buys below target and submits and revises a reward bid through the desktop', { timeout: 45 * 60_000 }, async () => {
  const session = await FlowSession.start({
    useTestNetwork: true,
    sessionName: 'stabilizer-buy-and-bid',
    ...stabilizerBuySessionOptions,
  });

  try {
    await session.run(stabilizerBuyFlow.name);
  } finally {
    await session.close();
  }
});

// Keep this scenario for the repayment UI pass; current boundary coverage lives in BitcoinLiquids.integration.test.ts.
it.skip('disables Liquid actions until an Ethereum repayment purchase settles', { timeout: 45 * 60_000 }, async () => {
  const session = await FlowSession.start({
    useTestNetwork: true,
    useDevUpstream: true,
    ticksBetweenSlots: 12,
    sessionName: 'stabilizer-liquid-repayment',
    appEnv: stabilizerBuySessionOptions.appEnv,
  });
  try {
    await session.run('App.flow.claimDevUpstream');
    await session.run(liquidRepaymentFlow.name, { minimumLockSatoshis: 2_000_000 });
  } finally {
    await session.close();
  }
});
