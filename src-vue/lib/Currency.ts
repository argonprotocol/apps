import BigNumber from 'bignumber.js';
import { MICROGONS_PER_ARGON, SATS_PER_BTC, PriceIndex as PriceIndexModel } from '@argonprotocol/mainchain';
import { bigNumberToBigInt, CurrencyKey, ICurrencyKey, IExchangeRates, PriceIndex } from '@argonprotocol/apps-core';
import IDeferred from '../interfaces/IDeferred';
import { createDeferred } from './Utils';
import { Config } from './Config';

export const SATOSHIS_PER_BITCOIN = SATS_PER_BTC;
export { MICROGONS_PER_ARGON };
export const MICRONOTS_PER_ARGONOT = 1_000_000;
export { CurrencyKey, type ICurrencyKey, type IExchangeRates };

export interface ICurrencyRecord {
  key: ICurrencyKey;
  symbol: string;
  name: string;
}

const EXCHANGE_RATE_CACHE_DURATION = 24 * 60 * 60e3; // 24 hours in milliseconds

export class Currency {
  // These exchange rates are relative to the argon, which means the ARGN is always 1
  public microgonExchangeRateTo: IExchangeRates = {
    ARGN: BigInt(MICROGONS_PER_ARGON),
    ARGNOT: BigInt(MICROGONS_PER_ARGON),
    USD: BigInt(MICROGONS_PER_ARGON),
    EUR: BigInt(MICROGONS_PER_ARGON),
    GBP: BigInt(MICROGONS_PER_ARGON),
    INR: BigInt(MICROGONS_PER_ARGON),
    BTC: BigInt(MICROGONS_PER_ARGON),
  };

  public microgonTargetForArgon: bigint;

  public usdForArgon: number;
  public usdTargetForArgon: number;

  public recordsByKey: Record<ICurrencyKey, ICurrencyRecord> = {
    [CurrencyKey.ARGN]: { key: CurrencyKey.ARGN, symbol: '₳', name: 'Argon' },
    [CurrencyKey.USD]: { key: CurrencyKey.USD, symbol: '$', name: 'Dollar' },
    [CurrencyKey.EUR]: { key: CurrencyKey.EUR, symbol: '€', name: 'Euro' },
    [CurrencyKey.GBP]: { key: CurrencyKey.GBP, symbol: '£', name: 'Pound' },
    [CurrencyKey.INR]: { key: CurrencyKey.INR, symbol: '₹', name: 'Rupee' },
  };

  public record!: ICurrencyRecord;
  public symbol!: string;
  public priceIndex: PriceIndex;

  public isLoaded: boolean;
  public isLoadedPromise: Promise<void>;

  private config: Config;
  private isLoadedDeferred: IDeferred<void>;
  private nextLoadTimeout?: number;
  private lastExchangeRateCheckTime?: number;
  private lastExchangeRate?: {
    EUR: number;
    GBP: number;
    INR: number;
  };

  constructor(config: Config, priceIndex: PriceIndex) {
    this.config = config;

    this.isLoaded = false;
    this.isLoadedDeferred = createDeferred<void>();
    this.isLoadedPromise = this.isLoadedDeferred.promise;
    this.priceIndex = priceIndex;
    this.usdForArgon = 0;
    this.usdTargetForArgon = 0;
    this.microgonTargetForArgon = BigInt(MICROGONS_PER_ARGON);
  }

  private async updateExchangeRates() {
    // only update exchange rates daily
    if (this.lastExchangeRateCheckTime && Date.now() - this.lastExchangeRateCheckTime < EXCHANGE_RATE_CACHE_DURATION) {
      return;
    }
    try {
      const exchangeRate = fetch('https://open.er-api.com/v6/latest/USD');
      const data = await (await exchangeRate).json();
      if (data && data.rates) {
        this.lastExchangeRate = data.rates;
        this.lastExchangeRateCheckTime = Date.now();
      }
    } catch (e) {
      // ignore
    }
  }

  public async load() {
    clearTimeout(this.nextLoadTimeout);
    try {
      const [_, microgonExchangeRateTo] = await Promise.all([
        this.updateExchangeRates(),
        this.priceIndex.fetchMicrogonExchangeRatesTo(),
      ]);

      const priceIndexRaw: PriceIndexModel = this.priceIndex.current;
      this.usdForArgon = priceIndexRaw.argonUsdPrice?.toNumber() ?? 0;
      this.usdTargetForArgon = priceIndexRaw.argonUsdTargetPrice?.toNumber() ?? 0;
      this.microgonTargetForArgon = microgonExchangeRateTo.USDTarget;

      this.microgonExchangeRateTo.USD = microgonExchangeRateTo.USD;
      this.microgonExchangeRateTo.ARGNOT = microgonExchangeRateTo.ARGNOT;
      this.microgonExchangeRateTo.BTC = microgonExchangeRateTo.BTC;
      if (this.lastExchangeRate) {
        this.microgonExchangeRateTo.EUR = this.otherExchangeRateToMicrogons(this.lastExchangeRate.EUR);
        this.microgonExchangeRateTo.GBP = this.otherExchangeRateToMicrogons(this.lastExchangeRate.GBP);
        this.microgonExchangeRateTo.INR = this.otherExchangeRateToMicrogons(this.lastExchangeRate.INR);
      }

      if (!this.isLoaded) {
        await this.config.isLoadedPromise;
        this.setCurrencyKey(this.config.defaultCurrencyKey, false);
        this.isLoaded = true;
        this.isLoadedDeferred.resolve();
      }
    } finally {
      this.nextLoadTimeout = setTimeout(() => this.load(), 10 * 60e3) as unknown as number; // refresh every 10 minutes
    }
  }

  public setCurrencyKey(currencyKey: ICurrencyKey, saveToConfig: boolean = true) {
    this.record = this.recordsByKey[currencyKey];
    this.symbol = this.record.symbol;
    if (saveToConfig) this.config.defaultCurrencyKey = currencyKey;
  }

  public microgonToArgon(microgons: bigint): number {
    if (!microgons) return 0;
    return Number(microgons) / MICROGONS_PER_ARGON;
  }

  public microgonTo(microgons: bigint, key?: CurrencyKey): number {
    key ??= this.record?.key;
    if (!key) throw new Error('Currency not loaded');
    if (key === CurrencyKey.USD) {
      return BigNumber(microgons).dividedBy(this.microgonExchangeRateTo.USD).toNumber();
    } else if (key === CurrencyKey.EUR) {
      return BigNumber(microgons).dividedBy(this.microgonExchangeRateTo.EUR).toNumber();
    } else if (key === CurrencyKey.GBP) {
      return BigNumber(microgons).dividedBy(this.microgonExchangeRateTo.GBP).toNumber();
    } else if (key === CurrencyKey.INR) {
      return BigNumber(microgons).dividedBy(this.microgonExchangeRateTo.INR).toNumber();
    } else {
      return this.microgonToArgon(microgons);
    }
  }

  public micronotToMicrogon(micronots: bigint, microgonsPerArgonot?: bigint): bigint {
    if (!micronots) return 0n;
    const argonotsBn = BigNumber(micronots).dividedBy(MICRONOTS_PER_ARGONOT);
    const microgonsBn = argonotsBn.multipliedBy(microgonsPerArgonot ?? this.microgonExchangeRateTo.ARGNOT);
    return BigInt(Math.round(microgonsBn.toNumber()));
  }

  public micronotToArgonot(micronots: bigint): number {
    if (!micronots) return 0;
    return Number(micronots) / MICRONOTS_PER_ARGONOT;
  }

  public micronotToArgon(micronots: bigint) {
    const microgons = this.micronotToMicrogon(micronots);
    return this.microgonToArgon(microgons);
  }

  public micronotTo(micronots: bigint): number {
    const microgons = this.micronotToMicrogon(micronots);
    return this.microgonTo(microgons);
  }

  public satsToBtc(satoshis: bigint): number {
    if (!satoshis) return 0;
    return Number(satoshis) / Number(SATOSHIS_PER_BITCOIN);
  }

  public btcToMicrogon(bitcoins: number): bigint {
    const microgonsBn = BigNumber(bitcoins).multipliedBy(this.microgonExchangeRateTo.BTC);
    return BigInt(Math.floor(microgonsBn.toNumber()));
  }

  public microgonToBtc(microgons: bigint): number {
    const bitcoinsBn = BigNumber(microgons).dividedBy(this.microgonExchangeRateTo.BTC);
    return bitcoinsBn.toNumber();
  }

  private otherExchangeRateToMicrogons(otherExchangeRate: number): bigint {
    const dollarsRequiredBn = BigNumber(1).dividedBy(otherExchangeRate);
    const microgonsRequiredBn = dollarsRequiredBn.multipliedBy(this.microgonExchangeRateTo.USD);
    return bigNumberToBigInt(microgonsRequiredBn);
  }
}
