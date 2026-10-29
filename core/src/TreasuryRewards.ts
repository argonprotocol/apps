import type {
  CurrentRuntimeConstants,
  CurrentRuntimeQueries,
  LiveQueryRecord,
  RuntimeQueryResult,
} from '@argonprotocol/runtime-client';
import { stringToU8a, u8aConcat, u8aToU8a } from '@polkadot/util';
import BigNumber from 'bignumber.js';
import type { ArgonCurrentQueryClient, ArgonQueryClient } from './MainchainClients.js';
import type { Vault } from './Vault.js';
import { bigIntMax, bigIntMin, bigNumberToBigInt } from './utils.js';
import { FIXED_U128_ONE, U128_MAX, fixedU128Divide, fixedU128Multiply, fixedU128Rational } from './FixedU128.js';

type FrameCapital = NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['treasury']['currentFrameVaultCapital']>>;
type FrameBitcoin = NonNullable<LiveQueryRecord<'treasury', 'currentFrameVaultBitcoin'>>;
type VaultPosition = FrameCapital['vaultSecuritizationPositions'][string];
type RewardConstants = CurrentRuntimeConstants['treasury'];
type ArgonotSecuritization = NonNullable<LiveQueryRecord<'vaults', 'argonotSecuritizationByVaultId'>>;

/** Reward projections from one runtime's frozen frame capital and reward constants. */
export class TreasuryRewards {
  public capital: FrameCapital;
  public bitcoin?: FrameBitcoin;
  public constants: RewardConstants;
  public fullBidPool: bigint;
  public averageMicrogonsPerArgonot?: bigint;

  constructor({
    capital,
    bitcoin,
    constants,
    fullBidPool,
    averageMicrogonsPerArgonot,
  }: {
    capital: FrameCapital;
    bitcoin?: FrameBitcoin;
    constants: RewardConstants;
    fullBidPool: bigint;
    averageMicrogonsPerArgonot?: bigint;
  }) {
    this.capital = capital;
    this.bitcoin = bitcoin;
    this.constants = constants;
    this.fullBidPool = fullBidPool;
    this.averageMicrogonsPerArgonot = averageMicrogonsPerArgonot;
  }

  public static async read(client: ArgonCurrentQueryClient): Promise<TreasuryRewards | undefined> {
    const constants = client.consts.treasury;
    if (!('percentForVaultPool' in constants)) return;

    const capital = await client.query.treasury.currentFrameVaultCapital();
    if (!capital || !('vaultSecuritizationPositions' in capital)) return;

    const [bitcoin, prices, account] = await Promise.all([
      client.query.treasury.currentFrameVaultBitcoin?.(),
      client.query.priceIndex.historicArgonotAverageByFrame(),
      client.query.system.account(this.getBidPoolAccountId(client)),
    ]);
    return new TreasuryRewards({
      capital,
      bitcoin: bitcoin?.frameId === capital.frameId ? bitcoin : undefined,
      constants,
      fullBidPool: account.data.free,
      averageMicrogonsPerArgonot: prices?.[Math.max(0, capital.frameId - 1)],
    });
  }

  public static getBidPoolAccountId(client: ArgonQueryClient): Uint8Array {
    const palletId = u8aToU8a(client.consts.treasury.palletId);
    const raw = u8aConcat(stringToU8a('modl'), palletId, new Uint8Array(32 - 4 - palletId.length));
    return client.registry.createType('AccountId32', raw).toU8a();
  }

  public vaultRevenuePotential(vaultId: number, fullBidPool = this.fullBidPool) {
    const position = this.capital.vaultSecuritizationPositions[vaultId];
    if (!position) return;

    const multiplier = BigInt(this.constants.argonotSecuritizationMultiplier);
    const maximumPosition = {
      ...position,
      activatedSecuritization: position.securitization,
      bitcoinLockedMicrogons: position.securitization,
      activeBondMicrogons: position.securitization,
      argonotSecuritizationInMicrogons: bigIntMin(U128_MAX, position.securitization * multiplier),
      upstreamParticipation: new BigNumber(1),
    };
    const maximumArgonotPosition = {
      ...position,
      argonotSecuritizationInMicrogons: maximumPosition.argonotSecuritizationInMicrogons,
    };

    let maximumBitcoin = this.bitcoin;
    if (maximumBitcoin) {
      const covered = maximumBitcoin.vaultSecuritizedSatoshis[vaultId] ?? 0n;
      let maximumCovered = covered;
      if (maximumBitcoin.targetSecuritizedSatoshis !== null && this.capital.targetSecuritization > 0n) {
        maximumCovered = bigIntMax(
          covered,
          (position.securitization * maximumBitcoin.targetSecuritizedSatoshis) / this.capital.targetSecuritization,
        );
      }
      maximumBitcoin = {
        ...maximumBitcoin,
        totalNetworkSecuritizedSatoshis: maximumBitcoin.totalNetworkSecuritizedSatoshis + maximumCovered - covered,
        vaultSecuritizedSatoshis: { ...maximumBitcoin.vaultSecuritizedSatoshis, [vaultId]: maximumCovered },
      };
    }
    const maximumActiveBonds =
      this.capital.totalActiveBonds +
      bigIntMax(0n, position.securitization - position.activeBondMicrogons) / 1_000_000n;
    const actualRate = this.vaultEarningsRate(vaultId, position);
    const maximumRate = this.vaultEarningsRate(vaultId, maximumPosition, maximumBitcoin, maximumActiveBonds);
    const maximumArgonotRate = this.vaultEarningsRate(vaultId, maximumArgonotPosition);

    let capturedPercent: number | undefined;
    let capturedWithMaximumArgonotsPercent: number | undefined;
    if (maximumRate > 0n) {
      capturedPercent = BigNumber(actualRate).div(maximumRate).times(100).toNumber();
      capturedWithMaximumArgonotsPercent = BigNumber(maximumArgonotRate).div(maximumRate).times(100).toNumber();
    }

    return {
      actualEarnings: fixedU128Multiply(actualRate, fullBidPool),
      maximumEarnings: fixedU128Multiply(maximumRate, fullBidPool),
      upstreamParticipationPercent: position.upstreamParticipation.times(100).toNumber(),
      capturedPercent,
      capturedWithMaximumArgonotsPercent,
    };
  }

  public argonotSecuritizationTarget(securitizationMicrogons: bigint): bigint | undefined {
    const multiplier = this.constants.argonotSecuritizationMultiplier;
    if (multiplier === 0 || securitizationMicrogons <= 0n) return 0n;

    const price = this.averageMicrogonsPerArgonot;
    if (!price || price <= 0n) return;

    const capacity = bigIntMin(U128_MAX, securitizationMicrogons * FIXED_U128_ONE * BigInt(multiplier));
    const microgonsPerMicronot = fixedU128Rational(price, 1_000_000n);
    const required = fixedU128Divide(capacity, microgonsPerMicronot) ?? 0n;
    const roundedUp = ((required + FIXED_U128_ONE - 1n) / FIXED_U128_ONE) * FIXED_U128_ONE;
    // FixedU128::ceil saturates before saturating_mul_int(1) removes the fixed-point scale.
    return bigIntMin(U128_MAX, roundedUp) / FIXED_U128_ONE;
  }

  public argonotRewardBacking({
    vault,
    argonotSecuritization,
    securitizationMicrogons = vault.securitization,
  }: {
    vault: Vault;
    argonotSecuritization: ArgonotSecuritization;
    securitizationMicrogons?: bigint;
  }) {
    const totalMicronots = this.argonotSecuritizationTarget(bigIntMax(securitizationMicrogons, vault.securitization));
    if (totalMicronots === undefined) return;

    let pendingWithdrawals = 0n;
    for (const entry of vault.securitizationReleaseSchedule.values()) pendingWithdrawals += entry.argonotWithdrawals;
    const { heldMicronots } = argonotSecuritization;
    const requestedMicronots = heldMicronots - pendingWithdrawals;
    return {
      totalMicronots,
      additionalMicronots: bigIntMax(totalMicronots - heldMicronots, 0n),
      withdrawalCancellationMicronots: bigIntMax(bigIntMin(totalMicronots, heldMicronots) - requestedMicronots, 0n),
    };
  }

  private vaultEarningsRate(
    vaultId: number,
    position: VaultPosition,
    bitcoin = this.bitcoin,
    totalActiveBonds = this.capital.totalActiveBonds,
  ): bigint {
    if (position.securitization <= 0n) return 0n;

    const denominator = bigIntMax(this.capital.targetSecuritization, this.capital.totalSecuritization);
    const coverage = fixedU128Rational(position.securitization, denominator);
    if (!bitcoin) return fixedU128Multiply(coverage, this.vaultRewardRateWithoutBitcoinSnapshot(position));

    let bitcoinShare = 0n;
    if (bitcoin.targetSecuritizedSatoshis !== null) {
      const bitcoinDenominator = bigIntMax(bitcoin.targetSecuritizedSatoshis, bitcoin.totalNetworkSecuritizedSatoshis);
      if (bitcoinDenominator > 0n) {
        bitcoinShare = fixedU128Rational(bitcoin.vaultSecuritizedSatoshis[vaultId] ?? 0n, bitcoinDenominator);
      }
    }
    const bondDenominator = bigIntMax(
      this.capital.targetSecuritization,
      bigIntMin(U128_MAX, totalActiveBonds * 1_000_000n),
    );
    let bondShare = 0n;
    if (bondDenominator > 0n) bondShare = fixedU128Rational(position.activeBondMicrogons, bondDenominator);

    const minimumRate = bigNumberToBigInt(this.constants.minimumVaultProfitPercent.times(FIXED_U128_ONE));
    const variableRate = bigIntMax(
      0n,
      bigNumberToBigInt(this.constants.percentForVaultPool.times(FIXED_U128_ONE)) - minimumRate,
    );
    const bitcoinRate = fixedU128Multiply(variableRate, (9n * FIXED_U128_ONE) / 10n);
    const bondRate = variableRate - bitcoinRate;

    const multiplier = BigInt(this.constants.argonotSecuritizationMultiplier);
    const argonotCapacity = bigIntMin(U128_MAX, position.securitization * multiplier);
    const argonotValue = bigIntMin(position.argonotSecuritizationInMicrogons, argonotCapacity);
    let argonotBonusRate = 0n;
    let argonotUtilization = 0n;
    if (multiplier > 0n) argonotBonusRate = (29n * FIXED_U128_ONE) / 100n;
    if (argonotCapacity > 0n) argonotUtilization = fixedU128Rational(argonotValue, argonotCapacity);
    const maximumBacking = fixedU128Multiply((1n + multiplier) * FIXED_U128_ONE, FIXED_U128_ONE + argonotBonusRate);
    const backing = fixedU128Rational(
      bigIntMin(U128_MAX, position.securitization + argonotValue),
      position.securitization,
    );
    const bonus = FIXED_U128_ONE + fixedU128Multiply(argonotBonusRate, argonotUtilization);

    const excessBitcoin = bigIntMax(0n, position.bitcoinLockedMicrogons - position.securitization);
    const excessRatio = fixedU128Rational(bigIntMin(excessBitcoin, position.securitization), position.securitization);
    const bitcoinRewardFactor = FIXED_U128_ONE - fixedU128Multiply(excessRatio, FIXED_U128_ONE / 5n);
    const bitcoinEarnings = fixedU128Multiply(
      fixedU128Multiply(bitcoinShare, fixedU128Divide(bitcoinRate, maximumBacking) ?? 0n),
      bitcoinRewardFactor,
    );
    const bondEarnings = fixedU128Multiply(bondShare, fixedU128Divide(bondRate, maximumBacking) ?? 0n);
    const backedEarnings = fixedU128Multiply(fixedU128Multiply(bitcoinEarnings + bondEarnings, backing), bonus);
    const participation = bigNumberToBigInt(position.upstreamParticipation.times(FIXED_U128_ONE));
    return fixedU128Multiply(coverage, minimumRate) + fixedU128Multiply(backedEarnings, participation);
  }

  /** Runtime 160 and frames frozen before the Bitcoin snapshot retain the utilization formula. */
  private vaultRewardRateWithoutBitcoinSnapshot(position: VaultPosition): bigint {
    const {
      securitization,
      activatedSecuritization,
      bitcoinLockedMicrogons,
      activeBondMicrogons,
      argonotSecuritizationInMicrogons,
      upstreamParticipation,
    } = position;
    if (securitization <= 0n) return 0n;

    const excessBitcoinValue = bigIntMax(0n, bitcoinLockedMicrogons - securitization);
    const activatedBitcoin = bigIntMin(activatedSecuritization, securitization);
    const bitcoinUtilization = fixedU128Rational(bigIntMax(0n, activatedBitcoin - excessBitcoinValue), securitization);
    const bondUtilization = fixedU128Rational(bigIntMin(activeBondMicrogons, securitization), securitization);

    const multiplier = BigInt(this.constants.argonotSecuritizationMultiplier);
    const argonotCapacity = bigIntMin(U128_MAX, securitization * multiplier);
    const argonotValue = bigIntMin(argonotSecuritizationInMicrogons, argonotCapacity);
    let argonotUtilization = 0n;
    if (argonotCapacity > 0n) argonotUtilization = fixedU128Rational(argonotValue, argonotCapacity);

    const maximumRate = bigNumberToBigInt(this.constants.percentForVaultPool.times(FIXED_U128_ONE));
    const minimumRate = bigNumberToBigInt(this.constants.minimumVaultProfitPercent.times(FIXED_U128_ONE));
    let maximumCoreRate = maximumRate;
    if (multiplier > 0n) {
      const maximumMultiplier = ((1n + multiplier) * 129n * FIXED_U128_ONE) / 100n;
      maximumCoreRate = fixedU128Divide(maximumRate, maximumMultiplier) ?? 0n;
    }

    const bondWeight = fixedU128Multiply(FIXED_U128_ONE / 10n, bondUtilization);
    const coreUtilization = fixedU128Multiply(bitcoinUtilization, (9n * FIXED_U128_ONE) / 10n + bondWeight);
    const variableRate = fixedU128Multiply(coreUtilization, bigIntMax(0n, maximumCoreRate - minimumRate));
    const coreRate = minimumRate + variableRate;

    const backedCapital = bigIntMin(U128_MAX, securitization + argonotValue);
    const capitalMultiplier = fixedU128Rational(backedCapital, securitization);
    const argonotBonusRate = fixedU128Multiply((29n * FIXED_U128_ONE) / 100n, argonotUtilization);
    const argonotBonus = FIXED_U128_ONE + fixedU128Multiply(argonotBonusRate, bitcoinUtilization);
    const capitalAdjustedRate = fixedU128Multiply(coreRate, capitalMultiplier);
    const profitRate = bigIntMin(maximumRate, fixedU128Multiply(capitalAdjustedRate, argonotBonus));

    // The frame already includes the upstream factor in this effective participation score.
    const participation = bigNumberToBigInt(upstreamParticipation.times(FIXED_U128_ONE));
    const profitAboveMinimum = bigIntMax(0n, profitRate - minimumRate);
    return minimumRate + fixedU128Multiply(participation, profitAboveMinimum);
  }
}
