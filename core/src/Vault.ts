import type { CurrentRuntimeQueries, LiveQueryRecord, RuntimeQueryResult } from '@argonprotocol/runtime-client';
import type { ArgonClient, ArgonCurrentQueryClient, ArgonQueryClient } from './MainchainClients.js';
import type { PreviousRuntimeSpec as RuntimeSpec159 } from './runtimeCompatibility.js';
import BigNumber from 'bignumber.js';
import {
  FIXED_U128_DECIMALS,
  PERMILL_DECIMALS,
  toFixedNumber,
  type ArgonPrimitivesVaultVaultTerms,
  type PriceIndex,
} from '@argonprotocol/mainchain';
import { bigNumberToBigInt, bigIntMax, bigIntMin } from './utils.js';
import { fixedU128Rational, fixedU128Multiply } from './FixedU128.js';

type RuntimeVault = NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['vaults']['vaultsById']>>;
type SecuritizationScheduleEntry = RuntimeVault['securitizationReleaseSchedule'][string];

export class Vault implements Omit<RuntimeVault, 'securitizationReleaseSchedule'> {
  public operatorAccountId: RuntimeVault['operatorAccountId'];
  public delegateAccountId: RuntimeVault['delegateAccountId'];
  public securitization: RuntimeVault['securitization'];
  public securitizationTarget: RuntimeVault['securitizationTarget'];
  public securitizationLocked: RuntimeVault['securitizationLocked'];
  public flexibleSecuritizationLocked: RuntimeVault['flexibleSecuritizationLocked'];
  public reservedSecuritizationSpace: RuntimeVault['reservedSecuritizationSpace'];
  public securitizationPendingActivation: RuntimeVault['securitizationPendingActivation'];
  public securitizedSatoshis: RuntimeVault['securitizedSatoshis'];
  public totalSatoshis: RuntimeVault['totalSatoshis'];
  public ratioAdjustedSatoshis: RuntimeVault['ratioAdjustedSatoshis'];
  public flexibleRatioAdjustedSatoshis: RuntimeVault['flexibleRatioAdjustedSatoshis'];
  public committedMicrogons: RuntimeVault['committedMicrogons'];
  public securitizationRatio: RuntimeVault['securitizationRatio'];
  public isClosed: RuntimeVault['isClosed'];
  public terms: RuntimeVault['terms'];
  public pendingTerms: RuntimeVault['pendingTerms'];
  public openedTick: RuntimeVault['openedTick'];

  public openedDate: Date;
  public securitizationReleaseSchedule: Map<number, SecuritizationScheduleEntry>;
  /** Deployed-runtime bonds share vault income; the new vault pool pays operators directly. */
  public bondProfitSharing?: BigNumber;
  public operationalMinimumReleaseTick?: number | null;
  public bondCapacitySource: 'Securitization' | 'Bitcoin' = 'Securitization';

  constructor(
    public vaultId: number,
    vault: RuntimeVault,
    public tickDuration: number,
    public securitizationExitNoticeBlocks?: number,
  ) {
    this.operatorAccountId = vault.operatorAccountId;
    this.delegateAccountId = vault.delegateAccountId;
    this.securitization = vault.securitization;
    this.securitizationTarget = vault.securitizationTarget;
    this.securitizationLocked = vault.securitizationLocked;
    this.flexibleSecuritizationLocked = vault.flexibleSecuritizationLocked;
    this.reservedSecuritizationSpace = vault.reservedSecuritizationSpace;
    this.securitizationPendingActivation = vault.securitizationPendingActivation;
    this.securitizedSatoshis = vault.securitizedSatoshis;
    this.totalSatoshis = vault.totalSatoshis;
    this.ratioAdjustedSatoshis = vault.ratioAdjustedSatoshis;
    this.flexibleRatioAdjustedSatoshis = vault.flexibleRatioAdjustedSatoshis;
    this.committedMicrogons = vault.committedMicrogons;
    this.securitizationRatio = vault.securitizationRatio;
    this.isClosed = vault.isClosed;
    this.terms = vault.terms;
    this.pendingTerms = vault.pendingTerms;
    this.openedTick = vault.openedTick;
    this.openedDate = new Date(this.openedTick * tickDuration);
    this.securitizationReleaseSchedule = new Map(
      Object.entries(vault.securitizationReleaseSchedule).map(([height, entry]) => [Number(height), entry]),
    );
  }

  public static fromRuntime(
    id: number,
    vault: NonNullable<LiveQueryRecord<'vaults', 'vaultsById'>>,
    tickDuration: number,
    constants: ArgonQueryClient['consts']['vaults'],
  ): Vault {
    if ('committedMicrogons' in vault) {
      const securitizationExitNoticeBlocks =
        'securitizationExitNoticeBlocks' in constants ? constants.securitizationExitNoticeBlocks : undefined;
      return new Vault(id, vault, tickDuration, securitizationExitNoticeBlocks);
    }
    const { treasuryProfitSharing, ...terms } = vault.terms;
    let pendingTerms: RuntimeVault['pendingTerms'] = vault.pendingTerms;
    if (vault.pendingTerms) {
      const [applyTick, { treasuryProfitSharing: pendingProfitSharing, ...bitcoinTerms }] = vault.pendingTerms;
      pendingTerms = [applyTick, bitcoinTerms];
    }
    const schedule = Object.fromEntries(
      Object.entries(vault.securitizationReleaseSchedule).map(([height, amount]) => [
        height,
        {
          lockedCommitments: 0n,
          relockableCommitments: amount,
          argonWithdrawals: 0n,
          argonotWithdrawals: 0n,
        },
      ]),
    );
    const normalized = new Vault(
      id,
      {
        ...vault,
        terms,
        pendingTerms,
        committedMicrogons: 0n,
        securitizationReleaseSchedule: schedule,
      },
      tickDuration,
    );
    normalized.operationalMinimumReleaseTick = vault.operationalMinimumReleaseTick;
    normalized.bondProfitSharing = treasuryProfitSharing;
    normalized.bondCapacitySource = 'Bitcoin';
    return normalized;
  }

  /**
   * ARGN scheduled to leave the vault, in microgons, keyed by its earliest Bitcoin release height.
   * On the deployed runtime, scheduled collateral releases are still relockable until that height.
   */
  public get scheduledArgonWithdrawals(): readonly (readonly [bitcoinHeight: number, microgons: bigint])[] {
    return [...this.securitizationReleaseSchedule].map(([height, entry]) => [
      height,
      this.securitizationExitNoticeBlocks === undefined ? entry.relockableCommitments : entry.argonWithdrawals,
    ]);
  }

  public get pendingTermsChangeTick(): number | undefined {
    return this.pendingTerms ? Number(this.pendingTerms[0]) : undefined;
  }

  public bondCapacityMicrogons(
    priceIndex: Pick<PriceIndex, 'btcUsdPrice' | 'argonUsdPrice' | 'getSatoshiPriceInMarketMicrogons'>,
  ): bigint {
    if (this.isClosed) return 0n;
    if (this.bondCapacitySource === 'Securitization') return this.securitization;
    if (!priceIndex.btcUsdPrice?.gt(0) || !priceIndex.argonUsdPrice?.gt(0)) return 0n;
    return priceIndex.getSatoshiPriceInMarketMicrogons(this.bondEligibleSatoshis());
  }

  public availableBitcoinSpace(lockOwner?: string): bigint {
    const availableSecuritization = this.availableSecuritizationSpace(lockOwner);
    const microgons = BigNumber(availableSecuritization).div(this.securitizationRatio);
    return bigNumberToBigInt(microgons);
  }

  public availableSecuritizationSpace(lockOwner?: string): bigint {
    const regularSecuritizationLocked =
      this.securitizationLocked > this.flexibleSecuritizationLocked
        ? this.securitizationLocked - this.flexibleSecuritizationLocked
        : 0n;
    const securitizationSpace =
      this.securitization > regularSecuritizationLocked ? this.securitization - regularSecuritizationLocked : 0n;
    const available =
      securitizationSpace > this.reservedSecuritizationSpace
        ? securitizationSpace - this.reservedSecuritizationSpace
        : 0n;

    if (lockOwner === this.operatorAccountId) {
      const physicallyAvailable =
        this.securitization > this.securitizationLocked ? this.securitization - this.securitizationLocked : 0n;
      return available < physicallyAvailable ? available : physicallyAvailable;
    }

    return available;
  }

  public getRelockCapacity(): bigint {
    return [...this.securitizationReleaseSchedule.values()].reduce((acc, val) => acc + val.relockableCommitments, 0n);
  }

  public activatedSecuritization(): bigint {
    return bigIntMax(0n, this.securitizationLocked - this.securitizationPendingActivation);
  }

  public flexibleSecuritizationDisplacementPercent(): number | undefined {
    if (this.flexibleSecuritizationLocked === 0n) return;

    return new BigNumber(this.displacedFlexibleSecuritization())
      .div(this.flexibleSecuritizationLocked.toString())
      .multipliedBy(100)
      .toNumber();
  }

  /**
   * Returns the ratio-adjusted Bitcoin that can support Treasury bonds. Regular Bitcoin always
   * counts; flexible Bitcoin counts only in proportion to its collateral that has not been
   * displaced when activated securitization exceeds the vault's securitization.
   */
  public bondEligibleSatoshis(): bigint {
    if (this.flexibleSecuritizationLocked === 0n) return this.ratioAdjustedSatoshis;

    const displacedFlexibleCollateral = this.displacedFlexibleSecuritization();
    const eligibleFlexibleCollateral = bigIntMax(0n, this.flexibleSecuritizationLocked - displacedFlexibleCollateral);
    // Flexible Bitcoin counts only in proportion to its collateral that has not been displaced.
    // FixedU128::from_rational rounds this fraction to 18 places, preferring down on a tie.
    const eligibleFlexibleFraction = fixedU128Rational(eligibleFlexibleCollateral, this.flexibleSecuritizationLocked);
    const eligibleFlexibleSatoshis = fixedU128Multiply(eligibleFlexibleFraction, this.flexibleRatioAdjustedSatoshis);
    return bigIntMax(0n, this.ratioAdjustedSatoshis - this.flexibleRatioAdjustedSatoshis) + eligibleFlexibleSatoshis;
  }

  public calculateBitcoinFee(amount: bigint): bigint {
    const feeBn = this.terms.bitcoinAnnualPercentRate.multipliedBy(amount).integerValue(BigNumber.ROUND_CEIL);
    return BigInt(feeBn.toString()) + this.terms.bitcoinBaseFee;
  }

  /** Encode current Bitcoin terms against the connected runtime's actual terms schema. */
  public static encodeTerms(registry: ArgonClient['registry'], terms: RuntimeVault['terms']) {
    return registry.createType<ArgonPrimitivesVaultVaultTerms | RuntimeSpec159.ArgonPrimitivesVaultVaultTerms>(
      'ArgonPrimitivesVaultVaultTerms',
      {
        bitcoinAnnualPercentRate: toFixedNumber(terms.bitcoinAnnualPercentRate, FIXED_U128_DECIMALS),
        bitcoinBaseFee: terms.bitcoinBaseFee,
        // The deployed terms schema still requires this field; the new schema omits it.
        treasuryProfitSharing: toFixedNumber(0.1, PERMILL_DECIMALS),
      },
    );
  }

  public static async get(
    client: ArgonCurrentQueryClient,
    vaultId: number,
    tickDurationMillis?: number,
  ): Promise<Vault> {
    const rawVault = await client.query.vaults.vaultsById(vaultId);
    if (!rawVault) {
      throw new Error(`Vault with id ${vaultId} not found`);
    }
    const tickDuration =
      tickDurationMillis ?? (await client.query.ticks.genesisTicker().then(x => x.tickDurationMillis))!;
    return Vault.fromRuntime(vaultId, rawVault, tickDuration, client.consts.vaults);
  }

  public static async getArgonotSecuritization(client: ArgonQueryClient, vaultId: number) {
    if ('argonotSecuritizationByVaultId' in client.raw.query.vaults) {
      return await client.query.vaults.argonotSecuritizationByVaultId(vaultId);
    }
    const commitment = await client.query.vaults.argonotCommitmentByVaultId(vaultId);
    return commitment
      ? {
          heldMicronots: commitment.committedMicronots,
          committedMicronots: 0n,
          encumberedMicronots: commitment.encumberedMicronots,
        }
      : null;
  }

  public static buildSetArgonotSecuritizationTx(client: ArgonClient, amount: bigint) {
    const vaultTx = client.tx.vaults as typeof client.tx.vaults | RuntimeSpec159.Transactions<'promise'>['vaults'];
    return 'setArgonotSecuritization' in vaultTx
      ? vaultTx.setArgonotSecuritization(amount)
      : vaultTx.setCommittedArgonots(amount);
  }
  private displacedFlexibleSecuritization(): bigint {
    return bigIntMin(
      this.flexibleSecuritizationLocked,
      bigIntMax(0n, this.activatedSecuritization() - this.securitization),
    );
  }
}

export type ITerms = RuntimeVault['terms'];
