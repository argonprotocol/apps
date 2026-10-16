import type {
  CurrentRuntimeConstants,
  CurrentRuntimeQueries,
  LiveQueryRecord,
  RuntimeQueryResult,
} from '@argonprotocol/runtime-client';
import { hexToU8a, stringToU8a, u8aConcat } from '@polkadot/util';
import BigNumber from 'bignumber.js';
import type { ArgonCurrentQueryClient, ArgonQueryClient } from './MainchainClients.js';
import type { Vault } from './Vault.js';
import { bigIntMax, bigIntMin, bigNumberToBigInt } from './utils.js';
import { FIXED_U128_ONE, U128_MAX, fixedU128Divide, fixedU128Multiply, fixedU128Rational } from './FixedU128.js';

type FrameCapital = NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['treasury']['currentFrameVaultCapital']>>;
type VaultPosition = FrameCapital['vaultSecuritizationPositions'][string];
type RewardConstants = CurrentRuntimeConstants['treasury'];
type ArgonotSecuritization = NonNullable<LiveQueryRecord<'vaults', 'argonotSecuritizationByVaultId'>>;

/** Reward projections from one runtime's frozen frame capital and reward constants. */
export class TreasuryRewards {
  public capital: FrameCapital;
  public constants: RewardConstants;
  public fullBidPool: bigint;
  public averageMicrogonsPerArgonot?: bigint;

  constructor({
    capital,
    constants,
    fullBidPool,
    averageMicrogonsPerArgonot,
  }: {
    capital: FrameCapital;
    constants: RewardConstants;
    fullBidPool: bigint;
    averageMicrogonsPerArgonot?: bigint;
  }) {
    this.capital = capital;
    this.constants = constants;
    this.fullBidPool = fullBidPool;
    this.averageMicrogonsPerArgonot = averageMicrogonsPerArgonot;
  }

  public static async read(client: ArgonCurrentQueryClient): Promise<TreasuryRewards | undefined> {
    const constants = client.consts.treasury;
    if (!('percentForVaultPool' in constants)) return;

    const capital = await client.query.treasury.currentFrameVaultCapital();
    if (!capital || !('vaultSecuritizationPositions' in capital)) return;

    const [prices, account] = await Promise.all([
      client.query.priceIndex.historicArgonotAverageByFrame(),
      client.query.system.account(this.getBidPoolAccountId(client)),
    ]);
    return new TreasuryRewards({
      capital,
      constants,
      fullBidPool: account.data.free,
      averageMicrogonsPerArgonot: prices?.[Math.max(0, capital.frameId - 1)],
    });
  }

  public static getBidPoolAccountId(client: ArgonQueryClient): Uint8Array {
    const palletId = hexToU8a(client.consts.treasury.palletId);
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

    const actualRate = this.vaultRewardRate(position);
    const maximumRate = this.vaultRewardRate(maximumPosition);
    const maximumArgonotRate = this.vaultRewardRate(maximumArgonotPosition);
    const denominator = bigIntMax(this.capital.targetSecuritization, this.capital.totalSecuritization);
    let coverage = 0n;
    if (denominator > 0n) coverage = fixedU128Rational(position.securitization, denominator);

    let capturedPercent: number | undefined;
    let capturedWithMaximumArgonotsPercent: number | undefined;
    if (maximumRate > 0n) {
      capturedPercent = BigNumber(actualRate).div(maximumRate).times(100).toNumber();
      capturedWithMaximumArgonotsPercent = BigNumber(maximumArgonotRate).div(maximumRate).times(100).toNumber();
    }

    return {
      actualEarnings: fixedU128Multiply(fixedU128Multiply(coverage, actualRate), fullBidPool),
      maximumEarnings: fixedU128Multiply(fixedU128Multiply(coverage, maximumRate), fullBidPool),
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

  private vaultRewardRate(position: VaultPosition): bigint {
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
