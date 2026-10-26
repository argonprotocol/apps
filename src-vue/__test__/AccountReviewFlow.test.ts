import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NetworkConfig } from '@argonprotocol/apps-core';
import accountReview from '../../e2e/flows/operations/App.flow.accountReview.ts';
import { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';
import { reduceFinancialPositions } from '../lib/financials/index.ts';
import type { IAppQueryFn } from '../interfaces/IAppQueryRefs.ts';
import type { IBitcoinLiquidFinancialPosition } from '../interfaces/IFinancialPosition.ts';
import type { IE2EQueryAppOptions } from '../../e2e/flows/types.ts';

let previousNetwork = NetworkConfig.networkName;

beforeEach(() => {
  previousNetwork = NetworkConfig.networkName;
  NetworkConfig.setNetwork('dev-docker');
});

afterEach(() => {
  NetworkConfig.networkName = previousNetwork;
  vi.unstubAllGlobals();
});

it.each([
  { isArchived: false, displayIsCurrent: true },
  { isArchived: true, displayIsCurrent: true },
  { isArchived: false, displayIsCurrent: false },
  { isArchived: true, displayIsCurrent: false },
])(
  'reviews a Liquid across a mint payout (archived=$isArchived, current UI=$displayIsCurrent)',
  async ({ isArchived, displayIsCurrent }) => {
    let position: IBitcoinLiquidFinancialPosition = {
      id: 'bitcoin-liquid:1',
      label: 'Bitcoin Liquid #1',
      kind: 'bitcoin-liquid',
      group: 'bitcoin',
      lifecycle: isArchived ? 'completed' : 'active',
      liquidId: 1,
      liquid: BitcoinLiquid.create({ liquidId: 1, fissions: [] }),
      locks: [],
      startedAt: new Date('2026-10-23T00:00:00Z'),
      investedCost: 100_000_000n,
      paidIncome: 0n,
      settledPrincipalValue: 0n,
      currentValue: 110_000_000n,
      // A down-ratchet retained 20 while recycling 100 through the mint queue.
      receivedLiquidity: 20_000_000n,
      pendingLiquidity: 100_000_000n,
      repaymentAmount: 100_000_000n,
      // This cached value can lag the position's capital and profit facts.
      totalReturn: 25,
      totalFees: 1_000_000n,
    };
    const snapshot = () =>
      reduceFinancialPositions([
        { group: 'bitcoin', state: 'ready', positions: [position], observation: { observedAt: new Date() } },
      ]);
    const ready = {
      chainState: {
        bitcoinLiquidIds: [1],
        archivedBitcoinLiquidIds: isArchived ? [1] : [],
        financialSnapshot: snapshot(),
      },
      uiState: {
        dataReady: true,
        expectedArchivedBitcoinLiquidIds: [],
        hasTreasuryAccess: false,
        expectationFailures: [],
      },
      blockers: [],
    };
    const texts: Record<string, string> = {
      'BitcoinLiquid.grantedLiquidity-1': displayIsCurrent ? '₳120.00' : '₳20.00',
      'BitcoinLiquid.details.receivedLiquidity': displayIsCurrent ? '₳60.00' : '₳20.00',
      'BitcoinLiquid.details.return': '10%',
      'BitcoinLiquid.details.totalFees': '₳1.00',
      BitcoinLiquidDetailOverlay: 'Bitcoin Liquid Details',
    };
    vi.stubGlobal('document', {
      querySelector: (selector: string) => ({ textContent: texts[selector.match(/data-testid="([^"]+)"/)?.[1] ?? ''] }),
    });

    const data = new Map<string, unknown>();
    const flow = {
      input: {},
      poll: async () => ready,
      isVisible: async () => {
        // A payout publishes after readiness, before navigation and detail inspection.
        position = { ...position, receivedLiquidity: 60_000_000n, pendingLiquidity: 60_000_000n };
        return { visible: true };
      },
      click: async () => undefined,
      waitFor: async () => undefined,
      getText: async (testId: string) => texts[testId],
      queryApp: async <T, A extends Record<string, unknown>>(
        query: IAppQueryFn<T, A>,
        options: IE2EQueryAppOptions<A>,
      ) => await query({ getFinancials: () => ({ financialPositionAggregate: snapshot() }) } as never, options.args!),
      setData: (key: string, value: unknown) => data.set(key, value),
    };
    const context = { flow: flow as never };
    const review = accountReview.run(context, ready as never);
    if (displayIsCurrent) {
      await review;
      expect(data.get('App.flow.accountReview.uiValidated')).toBe(true);
    } else {
      await expect(review).rejects.toThrow(/instead of its (financial position value|granted amount)/);
      expect(data.has('App.flow.accountReview.uiValidated')).toBe(false);
    }
  },
);
