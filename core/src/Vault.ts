// Source: @argonprotocol/mainchain 1.4.12, the last release that exported this model.
import type {
  VaultsVaultsByIdResultSpec157Variant13,
  VaultsVaultsByIdResultSpec158Variant14,
} from '@argonprotocol/runtime-client';
import BigNumber from 'bignumber.js';
import type { ArgonQueryClient } from './MainchainClients.js';

type RuntimeVault = NonNullable<VaultsVaultsByIdResultSpec157Variant13 | VaultsVaultsByIdResultSpec158Variant14>;

export class Vault {
  public securitization!: bigint;
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

  public lockedSatoshis!: bigint;
  public securitizedSatoshis!: bigint;
  public flexibleSecuritizationLocked!: bigint;
  public reservedSecuritizationSpace!: bigint;
  public flexibleSecuritizedSatoshis!: bigint;
  public delegateAccountId?: string;

  constructor(
    id: number,
    vault: RuntimeVault,
    public tickDuration: number,
  ) {
    this.vaultId = id;
    this.openedTick = vault.openedTick;
    this.openedDate = new Date(this.openedTick * this.tickDuration);
    this.securitizationReleaseSchedule = new Map();

    this.securitization = vault.securitization;
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
    this.lockedSatoshis = vault.lockedSatoshis;
    this.securitizedSatoshis = vault.securitizedSatoshis;
    if ('flexibleSecuritizationLocked' in vault) {
      this.flexibleSecuritizationLocked = vault.flexibleSecuritizationLocked;
      this.reservedSecuritizationSpace = vault.reservedSecuritizationSpace;
      this.flexibleSecuritizedSatoshis = vault.flexibleSecuritizedSatoshis;
    } else {
      this.flexibleSecuritizationLocked = vault.backfillSecuritizationLocked;
      this.reservedSecuritizationSpace = vault.backfillSecuritizationReserved;
      this.flexibleSecuritizedSatoshis = vault.backfillSecuritizedSatoshis;
    }

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
    return this.securitizationLocked - this.securitizationPendingActivation;
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
    if (
      rawVault.securitization === undefined ||
      rawVault.securitizationLocked === undefined ||
      rawVault.securitizationPendingActivation === undefined ||
      rawVault.lockedSatoshis === undefined ||
      rawVault.securitizedSatoshis === undefined ||
      rawVault.securitizationReleaseSchedule === undefined ||
      rawVault.securitizationRatio === undefined ||
      rawVault.openedTick === undefined ||
      !rawVault.terms ||
      (!('flexibleSecuritizationLocked' in rawVault) && !('backfillSecuritizationLocked' in rawVault))
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
