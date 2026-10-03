import { Vault } from '@argonprotocol/apps-core';

import BigNumber from 'bignumber.js';

export function createScenarioVault(overrides: Partial<Vault> = {}): Vault {
  const vault = new Vault(
    7,
    {
      securitization: 2_000_000_000n,
      securitizationTarget: 2_000_000_000n,
      securitizationLocked: 0n,
      securitizationPendingActivation: 0n,
      securitizationReleaseSchedule: {},
      committedMicrogons: 0n,
      terms: { bitcoinAnnualPercentRate: BigNumber(0.08), bitcoinBaseFee: 0n },
      pendingTerms: null,
      operatorAccountId: '5SyntheticVaultOperator',
      delegateAccountId: null,
      isClosed: false,
      openedTick: 9_000,
      securitizationRatio: BigNumber(1),
      securitizedSatoshis: 0n,
      totalSatoshis: 0n,
      ratioAdjustedSatoshis: 0n,
      flexibleSecuritizationLocked: 0n,
      reservedSecuritizationSpace: 0n,
      flexibleRatioAdjustedSatoshis: 0n,
    },
    60_000,
    52_560,
  );
  return Object.assign(vault, { openedDate: new Date('2026-08-01T16:00:00.000Z'), ...overrides });
}
