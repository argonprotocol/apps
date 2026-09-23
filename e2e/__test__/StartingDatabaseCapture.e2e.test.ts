import { describe, expect, it } from 'vitest';
import {
  isStartingDatabaseComplete,
  type StartingDatabaseInspection,
} from '../local-mainnet/StartingDatabaseInspection.ts';

describe('starting database capture', () => {
  it('requires every recovery domain to reach the pinned block without partial or pending work', () => {
    const complete: StartingDatabaseInspection = {
      quickCheck: 'ok',
      walletHistoryThroughBlock: 100,
      financialDomains: ['bitcoin', 'bonds', 'vaulting'],
      partialFinancialDomains: [],
      pendingBitcoinLocks: 0,
      bondLotIds: [],
      stakeLotIds: [],
      configuredServer: false,
      operations: false,
      treasury: false,
      upstream: false,
    };

    expect(isStartingDatabaseComplete(complete, 100)).toBe(true);
    expect(isStartingDatabaseComplete({ ...complete, walletHistoryThroughBlock: 99 }, 100)).toBe(false);
    expect(isStartingDatabaseComplete({ ...complete, financialDomains: ['bitcoin', 'bonds'] }, 100)).toBe(false);
    expect(isStartingDatabaseComplete({ ...complete, partialFinancialDomains: ['vaulting'] }, 100)).toBe(false);
    expect(isStartingDatabaseComplete({ ...complete, pendingBitcoinLocks: 1 }, 100)).toBe(false);
  });
});
