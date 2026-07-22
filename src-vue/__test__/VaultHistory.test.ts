import { describe, expect, it, vi } from 'vitest';
import { VaultHistory } from '../lib/recovery/MyVault.ts';
import { VaultFinancials } from '../lib/financials/MyVault.ts';
import { calculatePositionReturn } from '../lib/financials/index.ts';

const vaultFinancials = new VaultFinancials({} as any);

describe('VaultHistory financial positions', () => {
  it('uses the currently configured default account instead of its construction-time address', async () => {
    let accountId = '5initial';
    const fetchAllByWallet = vi.fn(async (_address: string) => []);
    const fetchVaultIds = vi.fn(async (_address: string) => []);
    const history = new VaultHistory(
      Promise.resolve({
        vaultCapitalHistoryTable: { revision: 0, fetchAllByWallet, fetchVaultIds },
        vaultRevenueEventsTable: { revision: 0, fetchAll: vi.fn(async () => []) },
      } as any),
      () => accountId,
    );

    await history.loadPositionHistory();
    accountId = '5configured';
    await history.loadPositionHistory();
    await history.importBlock({ blockNumber: 1 } as any, []);

    expect(fetchAllByWallet.mock.calls.map(([address]) => address)).toEqual(['5initial', '5configured']);
    expect(fetchVaultIds).toHaveBeenCalledWith('5configured');
  });

  it('recovers one stored completed vault and assigns its revenue', async () => {
    const startedAt = new Date('2026-07-01T00:00:00Z');
    const endedAt = new Date('2026-07-03T00:00:00Z');
    const capital = [
      {
        id: 1,
        walletAddress: '5owner',
        vaultId: 7,
        eventType: 'created',
        securitization: 100n,
        blockNumber: 10,
        blockHash: '0x10',
        blockTime: startedAt,
        createdAt: new Date(),
      },
      {
        id: 2,
        walletAddress: '5owner',
        vaultId: 7,
        eventType: 'closed',
        securitizationRemaining: 40n,
        securitizationReleased: 60n,
        blockNumber: 20,
        blockHash: '0x20',
        blockTime: new Date('2026-07-02T00:00:00Z'),
        createdAt: new Date(),
      },
      {
        id: 3,
        walletAddress: '5owner',
        vaultId: 7,
        eventType: 'released',
        securitization: 40n,
        blockNumber: 25,
        blockHash: '0x25',
        blockTime: endedAt,
        createdAt: new Date(),
      },
    ];
    const revenue = [
      {
        id: 1,
        amount: 10n,
        source: 'vaultCollect',
        blockNumber: 15,
        blockHash: '0x15',
        blockTime: new Date('2026-07-01T12:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 2,
        amount: 20n,
        source: 'vaultCollect',
        blockNumber: 35,
        blockHash: '0x35',
        blockTime: new Date('2026-07-05T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const history = new VaultHistory(
      Promise.resolve({
        vaultCapitalHistoryTable: {
          revision: 0,
          fetchAllByWallet: async () => capital,
        },
        vaultRevenueEventsTable: {
          revision: 0,
          fetchAll: async () => revenue,
        },
      } as any),
      '5owner',
    );

    const stored = await history.loadPositionHistory();
    const positions = vaultFinancials.createFinancialPositions({
      hasConfirmedHistoryCoverage: true,
      capitalHistory: stored.capital,
      revenueHistory: stored.revenue,
    });

    expect(positions).toHaveLength(1);
    const position = positions[0];
    expect(position.kind).toBe('vault');
    if (position.kind !== 'vault') throw new Error('Expected a vault investment position');

    expect(position).toMatchObject({
      id: 'vault:7',
      lifecycle: 'completed',
      currentValue: 0n,
      investedCost: 100n,
      paidIncome: 30n,
      settledPrincipalValue: 100n,
      startedAt,
      endedAt,
      capitalFlows: [
        { amount: 100n, occurredAt: startedAt },
        { amount: -60n, occurredAt: new Date('2026-07-02T00:00:00Z') },
        { amount: -40n, occurredAt: endedAt },
      ],
    });
    expect(position.revenueHistory).toEqual(revenue);
  });

  it('keeps lost capital in the return exposure instead of treating it as withdrawn', () => {
    const startedAt = new Date('2026-07-01T00:00:00Z');
    const endedAt = new Date('2026-07-31T00:00:00Z');
    const positions = vaultFinancials.createFinancialPositions({
      hasConfirmedHistoryCoverage: true,
      capitalHistory: [
        {
          vaultId: 7,
          eventType: 'created',
          securitization: 100n,
          blockTime: startedAt,
        },
        {
          vaultId: 7,
          eventType: 'capitalLost',
          amount: 20n,
          blockTime: new Date('2026-07-10T00:00:00Z'),
        },
        {
          vaultId: 7,
          eventType: 'closed',
          securitizationRemaining: 0n,
          securitizationReleased: 80n,
          blockTime: endedAt,
        },
      ] as any,
      revenueHistory: [],
    });

    expect(positions[0]).toMatchObject({
      capitalFlows: [
        { amount: 100n, occurredAt: startedAt },
        { amount: -80n, occurredAt: endedAt },
      ],
    });
    expect(calculatePositionReturn(positions).percent).toBe(-20);
  });

  it('excludes a completed vault until its closing time is known', () => {
    const positions = vaultFinancials.createFinancialPositions({
      hasConfirmedHistoryCoverage: true,
      capitalHistory: [
        {
          vaultId: 7,
          eventType: 'created',
          securitization: 100n,
          blockTime: new Date('2026-07-01T00:00:00Z'),
        },
        {
          vaultId: 7,
          eventType: 'closed',
          securitizationRemaining: 0n,
          securitizationReleased: 100n,
        },
      ] as any,
      revenueHistory: [],
    });

    expect(calculatePositionReturn(positions)).toMatchObject({
      availability: 'unavailable',
      eligiblePositionCount: 0,
    });
  });
});
