import { describe, expect, it } from 'vitest';
import { planDevUpstreamFunding } from '../../e2e/scripts/devUpstreamServer.ts';

describe('dev upstream funding', () => {
  it('seeds a fresh upstream with modest mining funds', () => {
    const funding = planDevUpstreamFunding({
      miningBot: {
        address: 'mining-bot',
        microgons: 0n,
        micronots: 0n,
      },
      treasury: {
        address: 'treasury',
        microgons: 0n,
        micronots: 0n,
      },
    });

    expect(funding).toEqual([
      { address: 'mining-bot', microgons: 1_000_000_000n, micronots: 1_000_000_000n },
      { address: 'treasury', microgons: 10_000_000n, micronots: 0n },
    ]);
  });

  it('preserves funded accounts when a worker reattaches to a running stack', () => {
    const funding = planDevUpstreamFunding({
      miningBot: {
        address: 'mining-bot',
        microgons: 99_999_999_266_250n,
        micronots: 100_000_000_000_000n,
      },
      treasury: {
        address: 'treasury',
        microgons: 9_999_999_500n,
        micronots: 42n,
      },
    });

    expect(funding).toEqual([]);
  });
});
