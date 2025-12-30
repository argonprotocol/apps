import BigNumber from 'bignumber.js';
import { bigNumberToBigInt } from './utils.js';
import { type ApiDecoration, MICROGONS_PER_ARGON, PriceIndex, SATS_PER_BTC } from '@argonprotocol/mainchain';
import { createDeferred } from './Deferred.js';
import type IDeferred from './interfaces/IDeferred.js';
import { NetworkConfig } from './NetworkConfig.js';

const TEN_MINUTES_IN_MILLISECONDS = 10 * 60e3;
const TWENTY_FOUR_HOURS_IN_MILLISECONDS = 24 * 60 * 60e3;

export const SATOSHIS_PER_BITCOIN = SATS_PER_BTC;
export const MICRONOTS_PER_ARGONOT = 1_000_000;

export enum UnitOfMeasurement {
  Microgon = 'Microgon',
  Micronot = 'Micronot',
  Satoshi = 'Satoshi',
  Bitcoin = 'Bitcoin',
  ARGN = 'ARGN',
  ARGNOT = 'ARGNOT',
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  INR = 'INR',
  BTC = 'BTC',
}

export type ICurrencyKey =
  | UnitOfMeasurement.ARGN
  | UnitOfMeasurement.USD
  | UnitOfMeasurement.EUR
  | UnitOfMeasurement.GBP
  | UnitOfMeasurement.INR;

export interface ICurrencyRecord {
  key: ICurrencyKey;
  symbol: string;
  name: string;
}

export type IMicrogonsPer = Record<UnitOfMeasurement, bigint>;

type IRawFiatRates = Record<string, number> | null;

export type IMainchainRates = Record<UnitOfMeasurement.ARGNOT | UnitOfMeasurement.USD | UnitOfMeasurement.BTC, bigint>;

export const defaultMicrogonsPer: IMicrogonsPer = {
  Microgon: 1n,
  Micronot: BigInt(MICROGONS_PER_ARGON),
  Satoshi: BigInt(MICROGONS_PER_ARGON),
  Bitcoin: BigInt(MICROGONS_PER_ARGON),
  ARGN: BigInt(MICROGONS_PER_ARGON),
  ARGNOT: BigInt(MICROGONS_PER_ARGON),
  USD: BigInt(MICROGONS_PER_ARGON),
  EUR: BigInt(MICROGONS_PER_ARGON),
  GBP: BigInt(MICROGONS_PER_ARGON),
  INR: BigInt(MICROGONS_PER_ARGON),
  BTC: BigInt(MICROGONS_PER_ARGON),
};

export class Currency {
  public priceIndex = new PriceIndex();

  // These exchange rates are relative to the argon, which means the ARGN is always 1
  public microgonsPer: IMicrogonsPer = defaultMicrogonsPer;

  public usdTarget = 0;
  public usdTargetOffset = 0;

  public recordsByKey: Record<ICurrencyKey, ICurrencyRecord> = {
    [UnitOfMeasurement.ARGN]: { key: UnitOfMeasurement.ARGN, symbol: '₳', name: 'Argon' },
    [UnitOfMeasurement.USD]: { key: UnitOfMeasurement.USD, symbol: '$', name: 'Dollar' },
    [UnitOfMeasurement.EUR]: { key: UnitOfMeasurement.EUR, symbol: '€', name: 'Euro' },
    [UnitOfMeasurement.GBP]: { key: UnitOfMeasurement.GBP, symbol: '£', name: 'Pound' },
    [UnitOfMeasurement.INR]: { key: UnitOfMeasurement.INR, symbol: '₹', name: 'Rupee' },
  };

  public isLoaded: boolean;
  public isLoadedPromise: Promise<void>;
  private isLoadedDeferred: IDeferred<void>;

  constructor(public client: Promise<ApiDecoration<'promise'>>) {
    this.isLoaded = false;
    this.isLoadedDeferred = createDeferred<void>();
    this.isLoadedPromise = this.isLoadedDeferred.promise;
  }

  public async load() {
    try {
      await Promise.all([this.fetchMainchainRates(undefined, false)]);

      if (!this.isLoaded) {
        this.isLoaded = true;
        this.isLoadedDeferred.resolve();
      }
    } finally {
      setTimeout(() => this.fetchMainchainRates(undefined, false), TEN_MINUTES_IN_MILLISECONDS);
    }
  }

  public adjustByTargetOffset(value: number): number {
    return value * (1 + this.usdTargetOffset);
  }

  public convertMicrogonTo(microgons: bigint, to: UnitOfMeasurement.Microgon): bigint;
  public convertMicrogonTo(microgons: bigint, to: UnitOfMeasurement.Micronot): bigint;
  public convertMicrogonTo(microgons: bigint, to: UnitOfMeasurement): number;
  public convertMicrogonTo(microgons: bigint, to: UnitOfMeasurement): number | bigint {
    if (to == UnitOfMeasurement.Microgon) {
      return microgons;
    } else if (to === UnitOfMeasurement.Micronot) {
      return bigNumberToBigInt(BigNumber(microgons).dividedBy(this.microgonsPer.Micronot));
    } else if (to === UnitOfMeasurement.USD) {
      return BigNumber(microgons).dividedBy(this.microgonsPer.USD).toNumber();
    } else if (to === UnitOfMeasurement.EUR) {
      return BigNumber(microgons).dividedBy(this.microgonsPer.EUR).toNumber();
    } else if (to === UnitOfMeasurement.GBP) {
      return BigNumber(microgons).dividedBy(this.microgonsPer.GBP).toNumber();
    } else if (to === UnitOfMeasurement.INR) {
      return BigNumber(microgons).dividedBy(this.microgonsPer.INR).toNumber();
    } else if (to === UnitOfMeasurement.ARGN) {
      return Number(microgons) / MICROGONS_PER_ARGON;
    } else if (to === UnitOfMeasurement.ARGNOT) {
      return Number(microgons) / MICROGONS_PER_ARGON;
    } else if (to === UnitOfMeasurement.BTC) {
      const bitcoinsBn = BigNumber(microgons).dividedBy(this.microgonsPer.BTC);
      return bitcoinsBn.toNumber();
    } else {
      throw new Error(`Unsupported UnitOfMeasurement: ${to}`);
    }
  }

  public convertMicronotTo(micronots: bigint, to: UnitOfMeasurement.Microgon): bigint;
  public convertMicronotTo(micronots: bigint, to: UnitOfMeasurement.Micronot): bigint;
  public convertMicronotTo(micronots: bigint, to: UnitOfMeasurement): number;
  public convertMicronotTo(micronots: bigint, to: UnitOfMeasurement): number | bigint {
    if (to === UnitOfMeasurement.ARGNOT) {
      const argonotsBn = BigNumber(micronots).dividedBy(MICRONOTS_PER_ARGONOT);
      return argonotsBn.toNumber();
    }

    const argonotsBn = BigNumber(micronots).dividedBy(MICRONOTS_PER_ARGONOT);
    const microgonsBn = argonotsBn.multipliedBy(this.microgonsPer.ARGNOT);
    const microgons = bigNumberToBigInt(microgonsBn);

    if (to === UnitOfMeasurement.Microgon) {
      return microgons;
    } else {
      return this.convertMicrogonTo(microgons, to);
    }
  }

  public convertSatToBtc(satoshis: bigint): number {
    if (!satoshis) return 0;
    return Number(satoshis) / Number(SATOSHIS_PER_BITCOIN);
  }

  public convertBtcToMicrogon(bitcoins: number): bigint {
    const microgonsBn = BigNumber(bitcoins).multipliedBy(this.microgonsPer.BTC);
    return BigInt(Math.floor(microgonsBn.toNumber()));
  }

  public async fetchMicrogonsInCirculation(api?: ApiDecoration<'promise'>): Promise<bigint> {
    const client = api ?? (await this.client);
    return (await client.query.balances.totalIssuance()).toBigInt();
  }

  public async fetchMicronotsInCirculation(): Promise<bigint> {
    const client = await this.client;
    return (await client.query.ownership.totalIssuance()).toBigInt();
  }

  public async fetchBitcoinLiquidityReceived(): Promise<bigint> {
    const client = await this.client;
    return (await client.query.mint.mintedBitcoinMicrogons()).toBigInt();
  }

  public async fetchMainchainRates(api?: ApiDecoration<'promise'>, ignoreCache = true): Promise<IMainchainRates> {
    api ??= await this.client;
    await this.priceIndex.load(api);

    if (this.priceIndex.argonUsdPrice) {
      // These exchange rates should be relative to the argon
      const usdForArgonBn = this.priceIndex.argonUsdPrice;

      this.microgonsPer.USD = this.calculateExchangeRateInMicrogons(BigNumber(1), usdForArgonBn);
      this.microgonsPer.BTC = this.calculateExchangeRateInMicrogons(this.priceIndex.btcUsdPrice!, usdForArgonBn);
      this.microgonsPer.ARGNOT = this.calculateExchangeRateInMicrogons(this.priceIndex.argonotUsdPrice!, usdForArgonBn);

      const networkIsLocal = NetworkConfig.networkName === 'dev-docker' || NetworkConfig.networkName === 'localnet';
      if (this.priceIndex.argonotUsdPrice! === BigNumber(0) && networkIsLocal) {
        this.microgonsPer.ARGNOT = this.microgonsPer.ARGNOT / 10n;
      }

      await this.updateFiatRates(ignoreCache);
      this.updateTargetOffset(this.priceIndex.argonUsdPrice, this.priceIndex.argonUsdTargetPrice);
    }

    return {
      ARGNOT: this.microgonsPer.ARGNOT,
      BTC: this.microgonsPer.BTC,
      USD: this.microgonsPer.USD,
    };
  }

  public calculateTargetOffset(price: BigNumber | undefined, targetPrice: BigNumber | undefined): number | null {
    if (!price || price.isZero()) return null;
    if (!targetPrice || targetPrice.isZero()) return null;
    return price.minus(targetPrice).dividedBy(targetPrice).toNumber();
  }

  private updateTargetOffset(argonUsdPrice: BigNumber | undefined, argonUsdTargetPrice: BigNumber | undefined): void {
    const targetOffset = this.calculateTargetOffset(argonUsdPrice, argonUsdTargetPrice);
    if (targetOffset === null) return;
    this.usdTargetOffset = targetOffset;
    this.usdTarget = argonUsdTargetPrice?.toNumber() ?? 0;
  }

  private calculateExchangeRateInMicrogons(usdAmountBn: BigNumber, usdForArgonBn: BigNumber): bigint {
    const oneArgonInMicrogons = BigInt(MICROGONS_PER_ARGON);
    if (usdAmountBn.isZero() || usdForArgonBn.isZero()) return oneArgonInMicrogons;

    const argonsRequired = usdAmountBn.dividedBy(usdForArgonBn);
    return bigNumberToBigInt(argonsRequired.multipliedBy(MICROGONS_PER_ARGON));
  }

  private async updateFiatRates(ignoreCache = true): Promise<void> {
    const rawRates = await fetchRawFiatRates(ignoreCache);
    if (!rawRates) return;

    if (rawRates?.GBP) {
      this.microgonsPer.GBP = this.convertRawFiatExchangeRateToMicrogons(rawRates.GBP);
    }
    if (rawRates?.EUR) {
      this.microgonsPer.EUR = this.convertRawFiatExchangeRateToMicrogons(rawRates.EUR);
    }
    if (rawRates?.INR) {
      this.microgonsPer.INR = this.convertRawFiatExchangeRateToMicrogons(rawRates.INR);
    }
  }

  private convertRawFiatExchangeRateToMicrogons(otherExchangeRate: number): bigint {
    const dollarsRequiredBn = BigNumber(1).dividedBy(otherExchangeRate);
    const microgonsRequiredBn = dollarsRequiredBn.multipliedBy(this.microgonsPer.USD);
    return bigNumberToBigInt(microgonsRequiredBn);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Fetch Methods Across Instances /////////

let fiatRatesCache: Record<string, number> = {};
let lastFiatCheckTime: number | undefined;

async function fetchRawFiatRates(ignoreCache = true): Promise<IRawFiatRates> {
  if (ignoreCache || !lastFiatCheckTime || Date.now() - lastFiatCheckTime >= TWENTY_FOUR_HOURS_IN_MILLISECONDS) {
    try {
      const response = await fetch('https://open.er-api.com/v6/latest/USD');
      const data = (await response.json()) as { rates: Record<string, number> };
      if (data && data.rates) {
        fiatRatesCache = data.rates;
        lastFiatCheckTime = Date.now();
      }
    } catch (e) {
      return null;
    }
  }
  return fiatRatesCache;
}
