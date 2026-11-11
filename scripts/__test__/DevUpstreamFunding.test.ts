import { describe, expect, it } from 'vitest';
import { planDevUpstreamFunding } from '../../e2e/scripts/devUpstreamServer.ts';
import { minimumVaultDelegateBalance } from '@argonprotocol/apps-core';

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
      delegate: {
        address: 'delegate',
        microgons: 0n,
        micronots: 0n,
      },
    });

    expect(funding).toEqual([
      { address: 'mining-bot', microgons: 1_000_000_000n, micronots: 1_000_000_000n },
      { address: 'treasury', microgons: 10_000_000n, micronots: 0n },
      { address: 'delegate', microgons: minimumVaultDelegateBalance * 2n, micronots: 0n },
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
      delegate: {
        address: 'delegate',
        microgons: minimumVaultDelegateBalance,
        micronots: 17n,
      },
    });

    expect(funding).toEqual([]);
  });

  it('tops up a depleted relay delegate without changing its ARGNOT balance', () => {
    const funding = planDevUpstreamFunding({
      miningBot: { address: 'mining-bot', microgons: 1n, micronots: 1n },
      treasury: { address: 'treasury', microgons: 1n, micronots: 1n },
      delegate: { address: 'delegate', microgons: minimumVaultDelegateBalance - 1n, micronots: 17n },
    });

    expect(funding).toEqual([{ address: 'delegate', microgons: minimumVaultDelegateBalance * 2n, micronots: 17n }]);
  });
});
