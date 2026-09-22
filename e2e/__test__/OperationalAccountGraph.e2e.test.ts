import { describe, expect, it } from 'vitest';
import { OperationalAccountGraph, type OperationalAccountGraphNode } from '../local-mainnet/OperationalAccountGraph.ts';

describe('OperationalAccountGraph', () => {
  it('selects a connected scenario set that covers every release-review feature', () => {
    const node = (
      operationalAccountId: string,
      features: OperationalAccountGraphNode['features'],
      upstreamOperationalAccountId?: string,
    ): OperationalAccountGraphNode => ({
      operationalAccountId,
      upstreamOperationalAccountId,
      features,
      identity: {
        operatorName: '',
        operationalAccountId,
        defaultAccountId: `${operationalAccountId}-default`,
        miningAccountId: `${operationalAccountId}-mining`,
      },
    });
    const graph = new OperationalAccountGraph([
      node('root', ['bonds', 'vault']),
      node('bitcoin-child', ['bitcoin', 'upstream'], 'root'),
      node('mining-child', ['mining', 'upstream'], 'bitcoin-child'),
      node('unrelated', ['bitcoin']),
    ]);

    expect(graph.selectConnectedScenarios(3).map(x => x.operationalAccountId)).toEqual([
      'bitcoin-child',
      'root',
      'mining-child',
    ]);
    expect(() => graph.selectConnectedScenarios(2)).toThrow('does not cover: mining');
  });
});
