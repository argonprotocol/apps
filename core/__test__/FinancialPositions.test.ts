import { describe, expect, it } from 'vitest';
import {
  calculatePrincipalPositionValue,
  calculateMiningPositionValue,
  calculateMiningRewardProjection,
  calculateMiningTermPositionValue,
  calculateVaultPositionValue,
} from '../src/FinancialPositions.ts';

describe('FinancialPositions', () => {
  it('projects the remaining mining mint from the current Argonot value', () => {
    expect(
      calculateMiningRewardProjection({
        bidPrincipal: 100_000_000n,
        microgonsPerTerm: 20_000_000n,
        micronotsPerTerm: 10_000_000n,
        argonotPrice: 3_000_000n,
        percentOfTerm: 70,
      }),
    ).toEqual({
      microgonsMined: 14_000_000n,
      microgonsMinted: 35_000_000n,
      micronotsMined: 7_000_000n,
      microgonValue: 70_000_000n,
    });
  });

  it('amortizes the mining seat from its bid value as the term completes', () => {
    const value = calculateMiningPositionValue({
      isActive: true,
      percentComplete: 60,
      bidPrincipal: 1_000n,
      nativeStakedMicronots: 1_000_000n,
      microgonsMined: 200n,
      microgonsMinted: 100n,
      micronotsMined: 100_000n,
      feeIncome: 10n,
      transactionFees: 5n,
      entryArgonotPrice: 2_000n,
      currentArgonotPrice: 3_000n,
    });

    expect(value).toMatchObject({
      investedCost: 3_005n,
      paidIncome: 610n,
      remainingSeatValue: 400n,
      performanceEndingCapital: 610n,
      currentValue: 3_400n,
    });
  });

  it('keeps the seat mark separate from the current value of earned ARGNOT', () => {
    const appreciated = calculateMiningPositionValue({
      isActive: true,
      percentComplete: 30,
      bidPrincipal: 1_000n,
      nativeStakedMicronots: 0n,
      microgonsMined: 0n,
      microgonsMinted: 0n,
      micronotsMined: 100_000n,
      feeIncome: 0n,
      transactionFees: 0n,
      entryArgonotPrice: 2_000n,
      currentArgonotPrice: 3_000n,
    });
    const depreciated = calculateMiningPositionValue({
      isActive: true,
      percentComplete: 30,
      bidPrincipal: 1_000n,
      nativeStakedMicronots: 0n,
      microgonsMined: 0n,
      microgonsMinted: 0n,
      micronotsMined: 100_000n,
      feeIncome: 0n,
      transactionFees: 0n,
      entryArgonotPrice: 2_000n,
      currentArgonotPrice: 1_000n,
    });

    expect(appreciated).toMatchObject({
      paidIncome: 300n,
      remainingSeatValue: 700n,
      performanceEndingCapital: 300n,
      currentValue: 700n,
    });
    expect(depreciated).toMatchObject({
      paidIncome: 100n,
      remainingSeatValue: 700n,
      performanceEndingCapital: 100n,
      currentValue: 700n,
    });
  });

  it('uses the closing ARGNOT mark and retires the seat value after the term ends', () => {
    const value = calculateMiningPositionValue({
      isActive: false,
      bidPrincipal: 1_000n,
      nativeStakedMicronots: 1_000_000n,
      microgonsMined: 200n,
      microgonsMinted: 100n,
      micronotsMined: 100_000n,
      feeIncome: 10n,
      transactionFees: 5n,
      entryArgonotPrice: 2_000n,
      closingArgonotPrice: 4_000n,
    });

    expect(value).toMatchObject({
      investedCost: 3_005n,
      paidIncome: 710n,
      remainingSeatValue: 0n,
      performanceEndingCapital: 710n,
      currentValue: 0n,
      settledPrincipalValue: 4_000n,
    });
  });

  it('freezes completed mining rewards without treating the returned stake as term proceeds', () => {
    const value = calculateMiningTermPositionValue({
      isActive: false,
      bidPrincipal: 1_000n,
      microgonsMined: 200n,
      microgonsMinted: 100n,
      micronotsMined: 100_000n,
      feeIncome: 10n,
      transactionFees: 5n,
      currentArgonotPrice: 9_000n,
      closingArgonotPrice: 4_000n,
    });

    expect(value).toEqual({
      currentValue: 0n,
      investedCost: 1_005n,
      paidIncome: 710n,
      settledPrincipalValue: 0n,
      recoveredValue: 710n,
      remainingSeatValue: 0n,
      performanceEndingCapital: 710n,
    });
  });

  it('tracks vault deposits and returned capital separately from revenue', () => {
    const value = calculateVaultPositionValue({
      securitization: 160n,
      uncollectedRevenue: 10n,
      capitalHistory: [
        { vaultId: 7, eventType: 'created', securitization: 100n },
        {
          vaultId: 7,
          eventType: 'modified',
          securitization: 100n,
          securitizationTarget: 60n,
        },
        { vaultId: 7, eventType: 'releaseScheduled', securitization: 40n, releaseHeight: 500n },
        { vaultId: 7, eventType: 'released', securitization: 40n },
        {
          vaultId: 7,
          eventType: 'modified',
          securitization: 160n,
          securitizationTarget: 160n,
        },
      ],
      collectedRevenue: [{ amount: 20n }],
    });

    expect(value).toEqual({
      currentValue: 170n,
      investedCost: 200n,
      paidIncome: 20n,
      settledPrincipalValue: 40n,
      hasCompleteCapitalHistory: true,
      remainingPrincipal: 160n,
      capitalDeltas: [100n, 0n, 0n, -40n, 100n],
    });
  });

  it('does not settle vault principal until a release completes', () => {
    expect(
      calculateVaultPositionValue({
        securitization: 100n,
        uncollectedRevenue: 0n,
        capitalHistory: [
          { vaultId: 7, eventType: 'created', securitization: 100n },
          {
            vaultId: 7,
            eventType: 'modified',
            securitization: 100n,
            securitizationTarget: 60n,
          },
        ],
        collectedRevenue: [],
      }),
    ).toMatchObject({
      investedCost: 100n,
      currentValue: 100n,
      settledPrincipalValue: 0n,
      hasCompleteCapitalHistory: true,
    });
  });

  it('recognizes an immediate vault capital decrease as returned principal', () => {
    expect(
      calculateVaultPositionValue({
        securitization: 80n,
        uncollectedRevenue: 0n,
        capitalHistory: [
          { vaultId: 7, eventType: 'created', securitization: 100n },
          {
            vaultId: 7,
            eventType: 'modified',
            securitization: 80n,
            securitizationTarget: 80n,
          },
        ],
        collectedRevenue: [],
      }),
    ).toEqual({
      currentValue: 80n,
      investedCost: 100n,
      paidIncome: 0n,
      settledPrincipalValue: 20n,
      hasCompleteCapitalHistory: true,
      remainingPrincipal: 80n,
      capitalDeltas: [100n, -20n],
    });
  });

  it('combines an immediate return with capital released after a target-only change', () => {
    expect(
      calculateVaultPositionValue({
        securitization: 60n,
        uncollectedRevenue: 0n,
        capitalHistory: [
          { vaultId: 7, eventType: 'created', securitization: 100n },
          {
            vaultId: 7,
            eventType: 'modified',
            securitization: 80n,
            securitizationTarget: 60n,
          },
          { vaultId: 7, eventType: 'releaseScheduled', securitization: 20n, releaseHeight: 500n },
          { vaultId: 7, eventType: 'released', securitization: 20n },
        ],
        collectedRevenue: [],
      }),
    ).toEqual({
      currentValue: 60n,
      investedCost: 100n,
      paidIncome: 0n,
      settledPrincipalValue: 40n,
      hasCompleteCapitalHistory: true,
      remainingPrincipal: 60n,
      capitalDeltas: [100n, -20n, 0n, -20n],
    });
  });

  it('records lost vault capital without treating it as returned principal or negative revenue', () => {
    expect(
      calculateVaultPositionValue({
        securitization: 80n,
        uncollectedRevenue: 0n,
        capitalHistory: [
          { vaultId: 7, eventType: 'created', securitization: 100n },
          { vaultId: 7, eventType: 'capitalLost', amount: 20n },
        ],
        collectedRevenue: [],
      }),
    ).toEqual({
      currentValue: 80n,
      investedCost: 100n,
      paidIncome: 0n,
      settledPrincipalValue: 0n,
      hasCompleteCapitalHistory: true,
      remainingPrincipal: 80n,
      capitalDeltas: [100n, 0n],
    });
  });

  it('adds replacement vault capital to cost basis after a loss', () => {
    expect(
      calculateVaultPositionValue({
        securitization: 100n,
        uncollectedRevenue: 0n,
        capitalHistory: [
          { vaultId: 7, eventType: 'created', securitization: 100n },
          { vaultId: 7, eventType: 'capitalLost', amount: 20n },
          {
            vaultId: 7,
            eventType: 'modified',
            securitization: 100n,
            securitizationTarget: 100n,
          },
        ],
        collectedRevenue: [],
      }),
    ).toEqual({
      currentValue: 100n,
      investedCost: 120n,
      paidIncome: 0n,
      settledPrincipalValue: 0n,
      hasCompleteCapitalHistory: true,
      remainingPrincipal: 100n,
      capitalDeltas: [100n, 0n, 20n],
    });
  });

  it('withholds vault cost basis when loss history does not match current securitization', () => {
    expect(
      calculateVaultPositionValue({
        securitization: 75n,
        uncollectedRevenue: 0n,
        capitalHistory: [
          { vaultId: 7, eventType: 'created', securitization: 100n },
          { vaultId: 7, eventType: 'capitalLost', amount: 20n },
        ],
        collectedRevenue: [],
      }),
    ).toEqual({
      currentValue: 75n,
      investedCost: undefined,
      paidIncome: 0n,
      settledPrincipalValue: undefined,
      hasCompleteCapitalHistory: false,
      remainingPrincipal: 80n,
      capitalDeltas: [100n, 0n],
    });
  });

  it('keeps closed vault capital invested until later releases complete', () => {
    const releasing = calculateVaultPositionValue({
      uncollectedRevenue: 0n,
      capitalHistory: [
        { vaultId: 7, eventType: 'created', securitization: 100n },
        { vaultId: 7, eventType: 'closed', securitizationRemaining: 40n, securitizationReleased: 60n },
      ],
      collectedRevenue: [],
    });
    const completed = calculateVaultPositionValue({
      uncollectedRevenue: 0n,
      capitalHistory: [
        { vaultId: 7, eventType: 'created', securitization: 100n },
        { vaultId: 7, eventType: 'closed', securitizationRemaining: 40n, securitizationReleased: 60n },
        { vaultId: 7, eventType: 'released', securitization: 40n },
      ],
      collectedRevenue: [],
    });

    expect(releasing).toMatchObject({
      currentValue: 40n,
      remainingPrincipal: 40n,
      settledPrincipalValue: 60n,
    });
    expect(completed).toMatchObject({
      currentValue: 0n,
      remainingPrincipal: 0n,
      settledPrincipalValue: 100n,
    });
  });

  it('values ARGNOT bond principal at entry and current prices while retaining the asset', () => {
    expect(
      calculatePrincipalPositionValue({
        nativeAsset: 'ARGNOT',
        nativePrincipal: 2_000_000n,
        cumulativeEarnings: 100n,
        lifecycle: 'active',
        entryArgonotPrice: 2_000n,
        currentArgonotPrice: 3_000n,
      }),
    ).toEqual({
      currentValue: 6_000n,
      investedCost: 4_000n,
      paidIncome: 100n,
      settledPrincipalValue: 0n,
    });
  });
});
