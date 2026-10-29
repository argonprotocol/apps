import BigNumber from 'bignumber.js';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import {
  getBundledMetadata,
  toPlain,
  type CurrentRuntimeConstants,
  type CurrentRuntimeQueries,
  type RuntimeQueryResult,
} from '@argonprotocol/runtime-client';
import { Metadata } from '@polkadot/types';
import { decorateConstants } from '@polkadot/types/metadata/decorate';
import { describe, expect, it } from 'vitest';
import { TreasuryRewards } from '../src/TreasuryRewards.ts';
import { Vault } from '../src/Vault.ts';

const registry = getOfflineRegistry();
const metadata = new Metadata(registry, Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-160'))![1]);
registry.setMetadata(metadata);
const constants = toPlain(
  decorateConstants(registry, metadata.asLatest, metadata.version).treasury,
) as CurrentRuntimeConstants['treasury'];
const position = {
  operatorAccountId: '5SyntheticOperator',
  securitization: 1_000n,
  activatedSecuritization: 1_000n,
  bitcoinLockedMicrogons: 1_000n,
  activeBondMicrogons: 1_000n,
  argonotSecuritizationInMicrogons: 0n,
  upstreamParticipation: new BigNumber(1),
};
const capital = {
  frameId: 10,
  totalActiveBonds: 1_000n,
  targetSecuritization: 1_000n,
  totalSecuritization: 1_000n,
  vaultSecuritizationPositions: { 4: position },
} satisfies TreasuryRewards['capital'];

describe('Treasury rewards', () => {
  it.each([
    { covered: 0n, locked: 0n, bonds: 10_000_000n, earnings: 6_000_000n },
    { covered: 100_000_000n, locked: 10_000_000n, bonds: 0n, earnings: 46_000_000n },
    { covered: 100_000_000n, locked: 15_000_000n, bonds: 0n, earnings: 41_500_000n },
    { covered: 100_000_000n, locked: 30_000_000n, bonds: 10_000_000n, earnings: 42_000_000n },
  ])(
    'pays frozen coverage $covered, market value $locked and bonds $bonds independently',
    ({ covered, locked, bonds, earnings }) => {
      // Native treasury payout cases: bonds earn without Bitcoin, and excess Bitcoin
      // reduces only its own tier, with the reduction capped at 20%.
      const rewards = new TreasuryRewards({
        capital: {
          ...capital,
          totalActiveBonds: bonds / 1_000_000n,
          targetSecuritization: 10_000_000n,
          totalSecuritization: 10_000_000n,
          vaultSecuritizationPositions: {
            4: {
              ...position,
              securitization: 10_000_000n,
              activatedSecuritization: covered > 0n ? 10_000_000n : 0n,
              bitcoinLockedMicrogons: locked,
              activeBondMicrogons: bonds,
            },
          },
        },
        bitcoin: {
          frameId: capital.frameId,
          totalNetworkSecuritizedSatoshis: covered,
          targetSecuritizedSatoshis: 100_000_000n,
          vaultSecuritizedSatoshis: { 4: covered },
        },
        constants,
        fullBidPool: 100_000_000n,
      });
      expect(rewards.vaultRevenuePotential(4)).toMatchObject({
        actualEarnings: earnings,
        maximumEarnings: 51_000_000n,
      });
      expect(rewards.vaultRevenuePotential(4)?.capturedPercent).toBeCloseTo(Number(earnings) / 510_000, 10);
      expect(rewards.vaultRevenuePotential(4, 0n)?.capturedPercent).toBe(
        rewards.vaultRevenuePotential(4)?.capturedPercent,
      );

      // Bounded-out vaults remain in the network denominator.
      rewards.bitcoin = { ...rewards.bitcoin!, totalNetworkSecuritizedSatoshis: 200_000_000n };
      if (covered > 0n) {
        const bondAndSecuritization = bonds > 0n ? 6_000_000n : 1_000_000n;
        expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(
          (earnings - bondAndSecuritization) / 2n + bondAndSecuritization,
        );
      }

      // No frozen market price means no Bitcoin tier, even with covered Bitcoin.
      rewards.bitcoin = { ...rewards.bitcoin, targetSecuritizedSatoshis: null };
      expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(bonds > 0n ? 6_000_000n : 1_000_000n);
    },
  );

  it('matches native checked division and saturated ceiling for the ARGNOT target', () => {
    const rewards = new TreasuryRewards({
      capital,
      constants: { ...constants, argonotSecuritizationMultiplier: 2 },
      fullBidPool: 100_000n,
      averageMicrogonsPerArgonot: 2_000_000n,
    });
    expect(rewards.argonotSecuritizationTarget(2_400_000_000n)).toBe(2_400_000_000n);
    rewards.averageMicrogonsPerArgonot = 3_000_000n;
    expect(rewards.argonotSecuritizationTarget(10_000_000n)).toBe(6_666_667n);

    // Reference results from sp-arithmetic 28.0.1, used by the pinned runtime.
    rewards.averageMicrogonsPerArgonot = 1_000_000n;
    expect(rewards.argonotSecuritizationTarget(10n ** 21n)).toBe(340_282_366_920_938_463_463n);
    rewards.averageMicrogonsPerArgonot = 1n;
    expect(rewards.argonotSecuritizationTarget(10n ** 21n)).toBe(0n);
    rewards.constants = { ...constants, argonotSecuritizationMultiplier: 1 };
    rewards.averageMicrogonsPerArgonot = 1_999_999_999_999_999_999n;
    expect(rewards.argonotSecuritizationTarget(2_000_000_000_000n)).toBe(1n);

    rewards.averageMicrogonsPerArgonot = undefined;
    expect(rewards.argonotSecuritizationTarget(10n)).toBeUndefined();
    expect(rewards.argonotSecuritizationTarget(0n)).toBe(0n);
    rewards.constants = constants;
    expect(rewards.argonotSecuritizationTarget(10n)).toBe(0n);
  });

  it('matches pinned zero-multiplier payouts and uses the frozen upstream score once', () => {
    const rewards = new TreasuryRewards({ capital, constants, fullBidPool: 100_000n });
    expect(rewards.vaultRevenuePotential(4)).toMatchObject({
      actualEarnings: 51_000n,
      maximumEarnings: 51_000n,
      capturedPercent: 100,
    });
    rewards.capital = { ...capital, vaultSecuritizationPositions: { 4: { ...position, activatedSecuritization: 0n } } };
    expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(1_000n);
    // At the runtime's 5% factor, raw upstream scores of zero and half freeze as 0.95 and 0.975.
    rewards.capital = {
      ...capital,
      vaultSecuritizationPositions: { 4: { ...position, upstreamParticipation: new BigNumber(0.95) } },
    };
    expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(48_500n);
    rewards.capital.vaultSecuritizationPositions[4] = { ...position, upstreamParticipation: new BigNumber(0.975) };
    expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(49_750n);
    rewards.capital = {
      ...capital,
      vaultSecuritizationPositions: { 4: { ...position, upstreamParticipation: new BigNumber(0.5) } },
    };
    expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(26_000n);
    rewards.capital.vaultSecuritizationPositions[4] = {
      ...position,
      activatedSecuritization: 500n,
      upstreamParticipation: new BigNumber(0.5),
    };
    expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(13_500n);
    rewards.capital = { ...capital, targetSecuritization: 3_000n };
    expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(16_999n);
  });

  it('keeps capture independent of the pool balance and the network denominator', () => {
    const rewards = new TreasuryRewards({
      capital,
      constants: { ...constants, argonotSecuritizationMultiplier: 2 },
      fullBidPool: 100_000n,
    });
    const empty = rewards.vaultRevenuePotential(4)!;
    expect(empty.capturedPercent).toBeCloseTo(25.84, 2);
    expect(empty.capturedWithMaximumArgonotsPercent).toBe(100);
    rewards.capital = {
      ...capital,
      vaultSecuritizationPositions: { 4: { ...position, argonotSecuritizationInMicrogons: 1_000n } },
    };
    expect(rewards.vaultRevenuePotential(4)?.capturedPercent).toBeCloseTo(59.17, 2);
    const fullyBacked = { ...position, argonotSecuritizationInMicrogons: 2_000n };
    rewards.capital.vaultSecuritizationPositions[4] = fullyBacked;
    expect(rewards.vaultRevenuePotential(4)?.capturedPercent).toBe(100);
    expect(rewards.vaultRevenuePotential(4)?.maximumEarnings).toBe(empty.maximumEarnings);

    rewards.capital.vaultSecuritizationPositions[4] = { ...fullyBacked, bitcoinLockedMicrogons: 1_200n };
    expect(rewards.vaultRevenuePotential(4)?.capturedPercent).toBeCloseTo(77.85, 2);
    rewards.capital.vaultSecuritizationPositions[4] = {
      ...fullyBacked,
      activatedSecuritization: 0n,
      bitcoinLockedMicrogons: 0n,
    };
    expect(rewards.vaultRevenuePotential(4)?.capturedPercent).toBeCloseTo(5.88, 2);
    rewards.capital.vaultSecuritizationPositions[4] = { ...fullyBacked, activatedSecuritization: 500n };
    expect(rewards.vaultRevenuePotential(4)?.capturedPercent).toBeCloseTo(47.75, 2);

    rewards.capital = { ...capital, targetSecuritization: 2_000n };
    expect(rewards.vaultRevenuePotential(4)?.capturedPercent).toBe(empty.capturedPercent);
    expect(rewards.vaultRevenuePotential(4)?.maximumEarnings).toBeLessThan(empty.maximumEarnings);
    rewards.capital = { ...capital, totalSecuritization: 3_000n };
    expect(rewards.vaultRevenuePotential(4)?.capturedPercent).toBe(empty.capturedPercent);
    expect(rewards.vaultRevenuePotential(4)?.maximumEarnings).toBeLessThan(empty.maximumEarnings);
    expect(rewards.vaultRevenuePotential(4, 0n)).toMatchObject({
      actualEarnings: 0n,
      maximumEarnings: 0n,
      capturedPercent: empty.capturedPercent,
    });
    expect(rewards.vaultRevenuePotential(4, 1n)?.capturedPercent).toBe(empty.capturedPercent);
  });

  it('matches native payout truncation with nonzero backing and a changed vault pool percentage', () => {
    const rewards = new TreasuryRewards({
      capital: {
        ...capital,
        vaultSecuritizationPositions: { 4: { ...position, argonotSecuritizationInMicrogons: 2_000n } },
      },
      constants: { ...constants, argonotSecuritizationMultiplier: 2 },
      fullBidPool: 100_000n,
    });
    expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(50_999n);
    rewards.constants = { ...rewards.constants, percentForVaultPool: new BigNumber(0.57) };
    expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(56_999n);
    rewards.capital.vaultSecuritizationPositions[4] = {
      ...rewards.capital.vaultSecuritizationPositions[4],
      upstreamParticipation: new BigNumber(0.5),
    };
    expect(rewards.vaultRevenuePotential(4)).toMatchObject({
      actualEarnings: 28_999n,
      maximumEarnings: 56_999n,
      upstreamParticipationPercent: 50,
    });
    rewards.capital.vaultSecuritizationPositions[4] = { ...position, upstreamParticipation: new BigNumber(0) };
    expect(rewards.vaultRevenuePotential(4)?.actualEarnings).toBe(1_000n);
  });

  it('separates additional ARGNOT funding from cancelling scheduled withdrawals', () => {
    const rewards = new TreasuryRewards({
      capital,
      constants: { ...constants, argonotSecuritizationMultiplier: 2 },
      fullBidPool: 100_000n,
      averageMicrogonsPerArgonot: 2_000_000n,
    });
    const vault = new Vault(
      4,
      toPlain(
        registry.createType('ArgonPrimitivesVault', {
          securitization: 1_000_000_000n,
          securitizationTarget: 400_000_000n,
          securitizationReleaseSchedule: { 1000: { argonotWithdrawals: 200_000_000n } },
        }),
      ) as NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['vaults']['vaultsById']>>,
      60_000,
    );
    const argonotSecuritization = {
      heldMicronots: 400_000_000n,
      committedMicronots: 300_000_000n,
      encumberedMicronots: 100_000_000n,
    };
    expect(rewards.argonotRewardBacking({ vault, argonotSecuritization })).toEqual({
      totalMicronots: 1_000_000_000n,
      additionalMicronots: 600_000_000n,
      withdrawalCancellationMicronots: 200_000_000n,
    });
    expect(
      rewards.argonotRewardBacking({
        vault,
        argonotSecuritization: { ...argonotSecuritization, heldMicronots: 1_000_000_000n },
        securitizationMicrogons: vault.securitizationTarget,
      }),
    ).toEqual({
      totalMicronots: 1_000_000_000n,
      additionalMicronots: 0n,
      withdrawalCancellationMicronots: 200_000_000n,
    });
  });
});
