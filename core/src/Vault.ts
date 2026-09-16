import type {
  VaultsVaultsByIdResult,
  VaultsVaultsByIdResultSpec157Variant13,
  VaultsVaultsByIdResultSpec158Variant14,
  VaultsVaultsByIdResultSpec159Variant15,
} from '@argonprotocol/runtime-client';
import BigNumber from 'bignumber.js';
import type { ArgonQueryClient } from './MainchainClients.js';
import { bigIntMax } from './utils.js';

const FixedU128BigNumber = BigNumber.clone({
  DECIMAL_PLACES: 18,
  ROUNDING_MODE: BigNumber.ROUND_HALF_DOWN,
});

type RuntimeVault = NonNullable<
  | VaultsVaultsByIdResultSpec157Variant13
  | VaultsVaultsByIdResultSpec158Variant14
  | VaultsVaultsByIdResultSpec159Variant15
>;

export class Vault {
  public securitization!: bigint;
  public securitizationTarget!: bigint;
  public securitizationLocked!: bigint;
  public securitizationPendingActivation!: bigint;
  /**
   * Map of bitcoin height to amount of securitization released at that height
   */
  public securitizationReleaseSchedule: Map<number, bigint>;
  public terms!: ITerms;
  public operatorAccountId!: string;
  public isClosed!: boolean;
  public vaultId: number;
  public pendingTerms?: ITerms;
  public pendingTermsChangeTick?: number;
  public openedDate: Date;
  public openedTick: number;
  public securitizationRatio!: number;

  public securitizedSatoshis!: bigint;
  public ratioAdjustedSatoshis!: bigint;
  public flexibleSecuritizationLocked!: bigint;
  public reservedSecuritizationSpace!: bigint;
  public flexibleRatioAdjustedSatoshis!: bigint;
  public delegateAccountId?: string;
  public operationalMinimumReleaseTick?: number;

  constructor(
    id: number,
    vault: RuntimeVault,
    public tickDuration: number,
  ) {
    const compatibleVault = vault as NonNullable<VaultsVaultsByIdResult>;
    this.vaultId = id;
    this.openedTick = vault.openedTick;
    this.openedDate = new Date(this.openedTick * this.tickDuration);
    this.securitizationReleaseSchedule = new Map();

    this.securitization = vault.securitization;
    this.securitizationTarget = vault.securitizationTarget;
    this.securitizationRatio = vault.securitizationRatio.toNumber();
    this.securitizationLocked = vault.securitizationLocked;
    this.securitizationPendingActivation = vault.securitizationPendingActivation;
    for (const [bitcoinHeight, amount] of Object.entries(vault.securitizationReleaseSchedule)) {
      this.securitizationReleaseSchedule.set(Number(bitcoinHeight), amount);
    }
    this.terms = {
      bitcoinAnnualPercentRate: vault.terms.bitcoinAnnualPercentRate,
      bitcoinBaseFee: vault.terms.bitcoinBaseFee,
      treasuryProfitSharing: vault.terms.treasuryProfitSharing,
    };
    this.securitizedSatoshis = compatibleVault.lockedSatoshis ?? vault.securitizedSatoshis;
    this.ratioAdjustedSatoshis = compatibleVault.ratioAdjustedSatoshis ?? vault.securitizedSatoshis;
    this.flexibleSecuritizationLocked =
      compatibleVault.flexibleSecuritizationLocked ?? compatibleVault.backfillSecuritizationLocked!;
    this.reservedSecuritizationSpace =
      compatibleVault.reservedSecuritizationSpace ?? compatibleVault.backfillSecuritizationReserved!;
    this.flexibleRatioAdjustedSatoshis =
      compatibleVault.flexibleRatioAdjustedSatoshis ??
      compatibleVault.flexibleSecuritizedSatoshis ??
      compatibleVault.backfillSecuritizedSatoshis!;

    this.operatorAccountId = vault.operatorAccountId;
    this.isClosed = vault.isClosed;
    this.pendingTerms = undefined;
    this.pendingTermsChangeTick = undefined;
    this.delegateAccountId = undefined;
    if (vault.pendingTerms) {
      const [tickApply, terms] = vault.pendingTerms;
      this.pendingTermsChangeTick = Number(tickApply);
      this.pendingTerms = {
        bitcoinAnnualPercentRate: terms.bitcoinAnnualPercentRate,
        bitcoinBaseFee: terms.bitcoinBaseFee,
        treasuryProfitSharing: terms.treasuryProfitSharing,
      };
    }
    this.delegateAccountId = vault.delegateAccountId ?? undefined;
    this.operationalMinimumReleaseTick = vault.operationalMinimumReleaseTick ?? undefined;
  }

  public availableBitcoinSpace(lockOwner?: string): bigint {
    const availableSecuritization = this.availableSecuritizationSpace(lockOwner);
    const microgons = BigNumber(availableSecuritization).div(this.securitizationRatioBN());
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
    return [...this.securitizationReleaseSchedule.values()].reduce((acc, val) => acc + val, 0n);
  }

  public securitizationRatioBN(): BigNumber {
    return new BigNumber(this.securitizationRatio);
  }

  public activatedSecuritization(): bigint {
    return bigIntMax(0n, this.securitizationLocked - this.securitizationPendingActivation);
  }

  /**
   * Returns the ratio-adjusted Bitcoin that can support Treasury bonds. Regular Bitcoin always
   * counts; flexible Bitcoin counts only in proportion to its collateral that has not been
   * displaced when activated securitization exceeds the vault's securitization.
   */
  public bondEligibleSatoshis(): bigint {
    if (this.flexibleSecuritizationLocked === 0n) return this.ratioAdjustedSatoshis;

    const activatedSecuritization = this.activatedSecuritization();
    const displacedFlexibleCollateral = bigIntMax(0n, activatedSecuritization - this.securitization);
    const eligibleFlexibleCollateral = bigIntMax(0n, this.flexibleSecuritizationLocked - displacedFlexibleCollateral);
    // Flexible Bitcoin counts only in proportion to its collateral that has not been displaced.
    // FixedU128::from_rational rounds this fraction to 18 places, preferring down on a tie.
    const eligibleFlexibleFraction = new FixedU128BigNumber(eligibleFlexibleCollateral).dividedBy(
      this.flexibleSecuritizationLocked,
    );
    const eligibleFlexibleSatoshis = eligibleFlexibleFraction.multipliedBy(this.flexibleRatioAdjustedSatoshis);

    const eligibleRegularSatoshis = bigIntMax(0n, this.ratioAdjustedSatoshis - this.flexibleRatioAdjustedSatoshis);

    return bigNumberToBigInt(new BigNumber(eligibleRegularSatoshis).plus(eligibleFlexibleSatoshis));
  }

  public calculateBitcoinFee(amount: bigint): bigint {
    const feeBn = this.terms.bitcoinAnnualPercentRate.multipliedBy(amount).integerValue(BigNumber.ROUND_CEIL);
    return BigInt(feeBn.toString()) + this.terms.bitcoinBaseFee;
  }

  public static async get(client: ArgonQueryClient, vaultId: number, tickDurationMillis?: number): Promise<Vault> {
    const rawVault = await client.query.vaults.vaultsById(vaultId);
    if (!rawVault) {
      throw new Error(`Vault with id ${vaultId} not found`);
    }
    const compatibleVault = rawVault as NonNullable<VaultsVaultsByIdResult>;
    if (
      rawVault.securitization === undefined ||
      rawVault.securitizationLocked === undefined ||
      rawVault.securitizationPendingActivation === undefined ||
      rawVault.securitizedSatoshis === undefined ||
      rawVault.securitizationReleaseSchedule === undefined ||
      rawVault.securitizationRatio === undefined ||
      rawVault.openedTick === undefined ||
      !rawVault.terms ||
      (compatibleVault.flexibleSecuritizationLocked === undefined &&
        compatibleVault.backfillSecuritizationLocked === undefined)
    ) {
      throw new Error(`Vault ${vaultId} predates the supported runtime compatibility window`);
    }
    const tickDuration =
      tickDurationMillis ?? (await client.query.ticks.genesisTicker().then(x => x.tickDurationMillis))!;
    return new Vault(vaultId, rawVault as RuntimeVault, tickDuration);
  }
}

export interface ITerms {
  readonly bitcoinAnnualPercentRate: BigNumber;
  readonly bitcoinBaseFee: bigint;
  readonly treasuryProfitSharing: BigNumber;
}

function bigNumberToBigInt(bn: BigNumber): bigint {
  return BigInt(bn.integerValue(BigNumber.ROUND_DOWN).toString());
}
