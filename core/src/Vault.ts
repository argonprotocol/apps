// Source: @argonprotocol/mainchain 1.4.12, the last release that exported this model.
import {
  type ArgonClient,
  type ArgonPrimitivesVault,
  FIXED_U128_DECIMALS,
  fromFixedNumber,
  PERMILL_DECIMALS,
} from '@argonprotocol/mainchain';
import BigNumber from 'bignumber.js';
import type { ApiDecoration } from '@polkadot/api/types';
import type { Bytes } from '@polkadot/types-codec';
import type { RuntimeSpec157 } from './runtimeCompatibility.js';

type RuntimeVault = ArgonPrimitivesVault | RuntimeSpec157.ArgonPrimitivesVault;

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

  public lockedSatoshis!: number;
  public securitizedSatoshis!: number;
  public flexibleSecuritizationLocked!: bigint;
  public reservedSecuritizationSpace!: bigint;
  public flexibleSecuritizedSatoshis!: number;
  public name?: string;
  public lastNameChangeTick?: number;
  public delegateAccountId?: string;

  constructor(
    id: number,
    vault: RuntimeVault,
    public tickDuration: number,
  ) {
    this.vaultId = id;
    this.openedTick = vault.openedTick.toNumber();
    this.openedDate = new Date(this.openedTick * this.tickDuration);
    this.securitizationReleaseSchedule = new Map();

    this.securitization = vault.securitization.toBigInt();
    this.securitizationRatio = fromFixedNumber(vault.securitizationRatio.toBigInt(), FIXED_U128_DECIMALS).toNumber();
    this.securitizationLocked = vault.securitizationLocked.toBigInt();
    this.securitizationPendingActivation = vault.securitizationPendingActivation.toBigInt();
    const schedule = vault.securitizationReleaseSchedule;
    if (schedule.size > 0) {
      for (const [bitcoinHeight, amount] of schedule.entries()) {
        this.securitizationReleaseSchedule.set(bitcoinHeight.toNumber(), amount.toBigInt());
      }
    }
    this.terms = {
      bitcoinAnnualPercentRate: fromFixedNumber(vault.terms.bitcoinAnnualPercentRate.toBigInt(), FIXED_U128_DECIMALS),
      bitcoinBaseFee: vault.terms.bitcoinBaseFee.toBigInt(),
      treasuryProfitSharing: fromFixedNumber(vault.terms.treasuryProfitSharing.toBigInt(), PERMILL_DECIMALS),
    };
    this.lockedSatoshis = vault.lockedSatoshis.toNumber();
    this.securitizedSatoshis = vault.securitizedSatoshis.toNumber();
    if ('flexibleSecuritizationLocked' in vault) {
      this.flexibleSecuritizationLocked = vault.flexibleSecuritizationLocked.toBigInt();
      this.reservedSecuritizationSpace = vault.reservedSecuritizationSpace.toBigInt();
      this.flexibleSecuritizedSatoshis = vault.flexibleSecuritizedSatoshis.toNumber();
    } else {
      this.flexibleSecuritizationLocked = vault.backfillSecuritizationLocked.toBigInt();
      this.reservedSecuritizationSpace = vault.backfillSecuritizationReserved.toBigInt();
      this.flexibleSecuritizedSatoshis = vault.backfillSecuritizedSatoshis.toNumber();
    }

    this.operatorAccountId = vault.operatorAccountId.toString();
    this.isClosed = vault.isClosed.valueOf();
    this.pendingTerms = undefined;
    this.pendingTermsChangeTick = undefined;
    this.name = undefined;
    this.lastNameChangeTick = undefined;
    this.delegateAccountId = undefined;
    if (vault.pendingTerms.isSome) {
      const [tickApply, terms] = vault.pendingTerms.value;
      this.pendingTermsChangeTick = tickApply.toNumber();
      this.pendingTerms = {
        bitcoinAnnualPercentRate: fromFixedNumber(terms.bitcoinAnnualPercentRate.toBigInt(), FIXED_U128_DECIMALS),
        bitcoinBaseFee: terms.bitcoinBaseFee.toBigInt(),
        treasuryProfitSharing: fromFixedNumber(terms.treasuryProfitSharing.toBigInt(), PERMILL_DECIMALS),
      };
    }
    if ('name' in vault && vault.name.isSome) {
      this.name = decodeVaultName(vault.name.unwrap());
    }
    if ('lastNameChangeTick' in vault && vault.lastNameChangeTick.isSome) {
      this.lastNameChangeTick = vault.lastNameChangeTick.unwrap().toNumber();
    }
    if (vault.delegateAccountId.isSome) {
      this.delegateAccountId = vault.delegateAccountId.unwrap().toHuman();
    }
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

  public static async get(
    client: ArgonClient | ApiDecoration<'promise'>,
    vaultId: number,
    tickDurationMillis?: number,
  ): Promise<Vault> {
    const rawVault = await client.query.vaults.vaultsById(vaultId);
    if (rawVault.isNone) {
      throw new Error(`Vault with id ${vaultId} not found`);
    }
    const tickDuration =
      tickDurationMillis ?? (await client.query.ticks.genesisTicker().then(x => x.tickDurationMillis.toNumber()))!;
    return new Vault(vaultId, rawVault.unwrap() as RuntimeVault, tickDuration);
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

function decodeVaultName(name: Bytes): string {
  return new TextDecoder().decode(Uint8Array.from(name));
}
