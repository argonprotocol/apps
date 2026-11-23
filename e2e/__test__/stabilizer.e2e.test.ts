import { expect, it } from 'vitest';
import { FlowSession } from '../FlowSession.ts';
import '../flows/index.ts';
import stabilizerBuyFlow, { stabilizerBuySessionOptions } from '../flows/operations/App.flow.stabilizerBuyAndBid.ts';
import liquidRepaymentFlow from '../flows/operations/Bitcoin.flow.liquidRepayment.ts';
import type { MainchainWsProvider } from '../../core/src/MainchainRpcProvider.ts';

it('buys below target and submits and revises a reward bid through the desktop', { timeout: 45 * 60_000 }, async () => {
  const session = await FlowSession.start({
    useTestNetwork: true,
    sessionName: 'stabilizer-buy-and-bid',
    appLogsMode: 'quiet',
    ...stabilizerBuySessionOptions,
  });

  try {
    await session.run(stabilizerBuyFlow.name);
    expect(session.frontendErrors.filter(error => error.includes('Fatal error ('))).toEqual([]);
  } finally {
    await session.close();
  }
});

it('attaches a Liquid through the desktop and shows its completed paydown', { timeout: 45 * 60_000 }, async () => {
  const session = await FlowSession.start({
    useTestNetwork: true,
    useDevUpstream: true,
    appConnectTimeoutMs: 30 * 60_000,
    ticksBetweenSlots: 6,
    sessionName: 'stabilizer-liquid-repayment',
    appEnv: stabilizerBuySessionOptions.appEnv,
  });
  try {
    await session.run('App.flow.claimDevUpstream');
    const { data } = await session.run(liquidRepaymentFlow.name, { minimumLockSatoshis: 2_000_000 });
    const channelRpcStats = data.bitcoinChannelRpcStats as Record<
      'archive' | 'preferred',
      MainchainWsProvider['stats']
    >;
    for (const client of [channelRpcStats.archive, channelRpcStats.preferred]) {
      expect(client.calls.storage['miningSlot.minersByCohort'] ?? 0).toBe(0);
    }
  } finally {
    await session.close();
  }
});
