import BigNumber from 'bignumber.js';
import { bigNumberToBigInt } from './utils.js';
import {
  type ApiDecoration,
  type ArgonClient,
  FIXED_U128_DECIMALS,
  fromFixedNumber,
  MICROGONS_PER_ARGON,
  PriceIndex,
  SATS_PER_BTC,
} from '@argonprotocol/mainchain';
import { createDeferred } from './Deferred.js';
import type IDeferred from './interfaces/IDeferred.js';
import { NetworkConfig } from './NetworkConfig.js';
import type { MainchainClients } from './MainchainClients.ts';
import type { IBlockHeaderInfo } from './BlockWatch.js';
import { fetch } from './fetch.js';

const TWENTY_FOUR_HOURS_IN_MILLISECONDS = 24 * 60 * 60e3;
const HISTORICAL_MAINCHAIN_RATE_CACHE_SIZE = 256;

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
  USDC = 'USDC',
  USDT = 'USDT',
  USDE = 'USDE',
  ETH = 'ETH',
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
type IRawEthRates = Record<string, number> | null;

export type IMainchainRates = Record<UnitOfMeasurement.ARGNOT | UnitOfMeasurement.USD | UnitOfMeasurement.BTC, bigint>;

export interface IMiningRewardsAtPrice {
  microgonsMined: bigint;
  microgonsMinted: bigint;
  micronotsMined: bigint;
  argonotPrice: bigint;
}

export interface IMiningRewardsWithFloor extends IMiningRewardsAtPrice {
  microgonFloor: bigint;
}

export interface IFetchMainchainRatesOptions {
  ignoreCache?: boolean;
  updateOffchainRates?: boolean;
}

type IRawPriceIndex = {
  btcUsdPrice: { toBigInt(): bigint };
  argonotUsdPrice: { toBigInt(): bigint };
  argonUsdPrice: { toBigInt(): bigint };
  argonUsdTargetPrice: { toBigInt(): bigint };
  argonTimeWeightedAverageLiquidity: { toBigInt(): bigint };
  tick: { toNumber(): number };
};

type IRawPriceIndexOption = {
  isSome: boolean;
  unwrap(): IRawPriceIndex;
  toHex?(): string;
};

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

  USDC: BigInt(MICROGONS_PER_ARGON),
  USDT: BigInt(MICROGONS_PER_ARGON),
  USDE: BigInt(MICROGONS_PER_ARGON),

  ETH: BigInt(MICROGONS_PER_ARGON),
};

// Promise<ApiDecoration<'promise'>>

export class Currency {
  public priceIndex = new PriceIndex();

  // These exchange rates are relative to the argon, which means the ARGN is always 1
  public microgonsPer: IMicrogonsPer = defaultMicrogonsPer;

  public usdTarget = 0;
  public targetOffset = 0;

  public recordsByKey: Record<ICurrencyKey, ICurrencyRecord> = {
    [UnitOfMeasurement.ARGN]: { key: UnitOfMeasurement.ARGN, symbol: '₳', name: 'Argon' },
    [UnitOfMeasurement.USD]: { key: UnitOfMeasurement.USD, symbol: '$', name: 'Dollar' },
    [UnitOfMeasurement.EUR]: { key: UnitOfMeasurement.EUR, symbol: '€', name: 'Euro' },
    [UnitOfMeasurement.GBP]: { key: UnitOfMeasurement.GBP, symbol: '£', name: 'Pound' },
    [UnitOfMeasurement.INR]: { key: UnitOfMeasurement.INR, symbol: '₹', name: 'Rupee' },
  };

  public isLoaded: boolean;
  public isLoadedPromise: Promise<void>;
  protected isLoadedDeferred: IDeferred<void>;
  private offchainRatesTimeout?: number;
  private priceIndexSubscription?: () => void;
  private priceIndexSubscriptionPromise?: Promise<void>;
  private lastPriceIndexStorageValue?: string;
  private initialLoadPromise?: Promise<void>;
  private historicalMainchainRates = new Map<string, Promise<IMainchainRates>>();

  constructor(public clients: MainchainClients) {
    this.isLoaded = false;
    this.isLoadedDeferred = createDeferred<void>(false);
    this.isLoadedPromise = this.isLoadedDeferred.promise;
    void this.isLoadedPromise.catch(() => undefined);
    this.clients.events.on('on-pruned-client', client => {
      if (!this.priceIndexSubscription && !this.priceIndexSubscriptionPromise) return;
      void this.replacePriceIndexSubscription(client).catch(e =>
        console.error('[Currency] Error switching price index subscription client', e),
      );
    });
  }

  public async load(skipCache = false): Promise<void> {
    const isInitialLoad = !this.isLoaded;
    if (isInitialLoad) {
      if (this.initialLoadPromise) return await this.initialLoadPromise;
      if (this.isLoadedDeferred.isRejected) {
        this.isLoadedDeferred = createDeferred<void>(false);
        this.isLoadedPromise = this.isLoadedDeferred.promise;
        void this.isLoadedPromise.catch(() => undefined);
      }
    }

    const loadPromise = (async () => {
      const loadStartedAt = Date.now();
      let stage = 'fetchMainchainRates';
      try {
        await this.fetchMainchainRates(undefined, { ignoreCache: skipCache });

        if (!this.isLoaded) {
          this.isLoaded = true;
          this.isLoadedDeferred.resolve();
        }
        stage = 'subscribeToPriceIndex';
        await this.subscribeToPriceIndex();
      } catch (error) {
        console.error(`[Currency] Load failed at ${stage} after ${Date.now() - loadStartedAt}ms`, error);
        if (isInitialLoad && !this.isLoaded) {
          this.isLoadedDeferred.reject(error as Error);
        }
        throw error;
      } finally {
        this.scheduleOffchainRatesRefresh();
      }
    })();

    if (isInitialLoad) {
      const trackedLoadPromise = loadPromise.finally(() => {
        if (this.initialLoadPromise === trackedLoadPromise) {
          this.initialLoadPromise = undefined;
        }
      });
      this.initialLoadPromise = trackedLoadPromise;
      return await trackedLoadPromise;
    }

    await loadPromise;
  }

  public adjustByTargetOffset(value: bigint): bigint;
  public adjustByTargetOffset(value: number): number;
  public adjustByTargetOffset(value: number | bigint): number | bigint {
    const factorBn = BigNumber(this.targetOffset).plus(1);
    const adjustedValueBn = BigNumber(value).multipliedBy(factorBn);
    if (typeof value === 'bigint') {
      return bigNumberToBigInt(adjustedValueBn);
    }
    return adjustedValueBn.toNumber();
  }

  public static convertMicronotToMicrogonAtPrice(micronots: bigint, argonotPriceMicrogons: bigint): bigint {
    return bigNumberToBigInt(BigNumber(micronots).dividedBy(MICRONOTS_PER_ARGONOT).multipliedBy(argonotPriceMicrogons));
  }

  public static microgonValueOfMiningRewards(rewards: IMiningRewardsAtPrice): bigint {
    return (
      rewards.microgonsMined +
      rewards.microgonsMinted +
      this.convertMicronotToMicrogonAtPrice(rewards.micronotsMined, rewards.argonotPrice)
    );
  }

  public static microgonsMintedForMiningFloor(rewards: IMiningRewardsWithFloor): bigint {
    const shortfall = rewards.microgonFloor - this.microgonValueOfMiningRewards(rewards);
    return shortfall > 0n ? shortfall : 0n;
  }

  public convertMicrogonTo(microgons: bigint, to: UnitOfMeasurement.Microgon): bigint;
  public convertMicrogonTo(microgons: bigint, to: UnitOfMeasurement.Micronot): bigint;
  public convertMicrogonTo(microgons: bigint, to: UnitOfMeasurement): number;
  public convertMicrogonTo(microgons: bigint, to: UnitOfMeasurement): number | bigint {
    if (to == UnitOfMeasurement.Microgon) {
      return microgons;
    } else if (to === UnitOfMeasurement.Micronot) {
      return bigNumberToBigInt(BigNumber(microgons).dividedBy(this.microgonsPer.Micronot));
    } else if (
      [UnitOfMeasurement.USD, UnitOfMeasurement.USDC, UnitOfMeasurement.USDE, UnitOfMeasurement.USDT].includes(to)
    ) {
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
    } else if (to === UnitOfMeasurement.ETH) {
      const ethBn = BigNumber(microgons).dividedBy(this.microgonsPer.ETH);
      return ethBn.toNumber();
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

  public convertSatToBtc(sats: bigint): number {
    if (!sats) return 0;
    return Number(sats) / Number(SATOSHIS_PER_BITCOIN);
  }

  public convertBtcToMicrogon(bitcoins: number): bigint {
    const microgonsBn = BigNumber(bitcoins).multipliedBy(this.microgonsPer.BTC);
    return BigInt(Math.floor(microgonsBn.toNumber()));
  }

  public convertOtherUnitizedTokenToMicrogon(unitizedToken: number, unit: UnitOfMeasurement): bigint {
    const microgonsBn = BigNumber(unitizedToken).multipliedBy(this.microgonsPer[unit]);
    return BigInt(Math.floor(microgonsBn.toNumber()));
  }

  public async fetchMicrogonsInCirculation(api?: ApiDecoration<'promise'>): Promise<bigint> {
    const client = api ?? (await this.clients.prunedClientOrArchivePromise);
    return (await client.query.balances.totalIssuance()).toBigInt();
  }

  public async fetchMicronotsInCirculation(): Promise<bigint> {
    const client = await this.clients.prunedClientOrArchivePromise;
    return (await client.query.ownership.totalIssuance()).toBigInt();
  }

  public async fetchBitcoinLiquidityReceived(): Promise<bigint> {
    const client = await this.clients.prunedClientOrArchivePromise;
    return (await client.query.mint.mintedBitcoinMicrogons()).toBigInt();
  }

  public async fetchMainchainRates(
    api?: ApiDecoration<'promise'>,
    options: IFetchMainchainRatesOptions = {},
  ): Promise<IMainchainRates> {
    api ??= await this.clients.prunedClientOrArchivePromise;
    const current = await api.query.priceIndex.current();

    return await this.updateMainchainRatesFromPriceIndex(current as IRawPriceIndexOption, options);
  }

  public fetchMainchainRatesAtBlock(args: {
    api: ApiDecoration<'promise'>;
    block: Pick<IBlockHeaderInfo, 'blockHash'>;
  }): Promise<IMainchainRates> {
    const { api, block } = args;
    const blockHash = block.blockHash.toLowerCase();
    const cached = this.historicalMainchainRates.get(blockHash);
    if (cached) {
      this.historicalMainchainRates.delete(blockHash);
      this.historicalMainchainRates.set(blockHash, cached);
      return cached;
    }

    const ratesPromise = api.query.priceIndex
      .current()
      .then(current => this.calculateMainchainRates(current as IRawPriceIndexOption));
    this.historicalMainchainRates.set(blockHash, ratesPromise);

    if (this.historicalMainchainRates.size > HISTORICAL_MAINCHAIN_RATE_CACHE_SIZE) {
      const oldestBlockHash = this.historicalMainchainRates.keys().next().value;
      if (oldestBlockHash) this.historicalMainchainRates.delete(oldestBlockHash);
    }

    void ratesPromise.catch(() => {
      if (this.historicalMainchainRates.get(blockHash) === ratesPromise) {
        this.historicalMainchainRates.delete(blockHash);
      }
    });
    return ratesPromise;
  }

  private async subscribeToPriceIndex(client?: ArgonClient): Promise<void> {
    if (this.priceIndexSubscription) return;
    if (this.priceIndexSubscriptionPromise) return this.priceIndexSubscriptionPromise;

    this.priceIndexSubscriptionPromise = this.startPriceIndexSubscription(client).catch(e => {
      this.priceIndexSubscriptionPromise = undefined;
      throw e;
    });

    return this.priceIndexSubscriptionPromise;
  }

  private async replacePriceIndexSubscription(client: ArgonClient): Promise<void> {
    if (this.priceIndexSubscription) {
      this.priceIndexSubscription();
    } else if (this.priceIndexSubscriptionPromise) {
      await this.priceIndexSubscriptionPromise;
      const unsubscribe = this.priceIndexSubscription as (() => void) | undefined;
      unsubscribe?.();
    }

    this.priceIndexSubscription = undefined;
    this.priceIndexSubscriptionPromise = undefined;
    await this.subscribeToPriceIndex(client);
  }

  private async startPriceIndexSubscription(client?: ArgonClient): Promise<void> {
    const subscriptionClient = client ?? (await this.clients.prunedClientOrArchivePromise);
    const unsubscribe = await subscriptionClient.query.priceIndex.current(current => {
      const storageValue = this.getPriceIndexStorageValue(current as IRawPriceIndexOption);
      if (storageValue && storageValue === this.lastPriceIndexStorageValue) return;

      void this.updateMainchainRatesFromPriceIndex(current as IRawPriceIndexOption, { ignoreCache: false }).catch(e =>
        console.error('[Currency] Error updating subscribed price index', e),
      );
    });
    this.priceIndexSubscription = () => {
      unsubscribe();
      this.priceIndexSubscription = undefined;
      this.priceIndexSubscriptionPromise = undefined;
    };
  }

  private async updateMainchainRatesFromPriceIndex(
    current: IRawPriceIndexOption,
    options: IFetchMainchainRatesOptions = {},
  ): Promise<IMainchainRates> {
    const { ignoreCache = true, updateOffchainRates = true } = options;
    const mainchainRates = this.calculateMainchainRates(current);
    this.loadPriceIndex(current);

    if (this.priceIndex.argonUsdTargetPrice) {
      this.microgonsPer.USD = mainchainRates.USD;
      this.microgonsPer.BTC = mainchainRates.BTC;
      this.microgonsPer.ARGNOT = mainchainRates.ARGNOT;

      if (updateOffchainRates) {
        await Promise.all([this.updateFiatRates(ignoreCache), this.updateEthTokenPrices(ignoreCache)]);
      }
      this.updateFiatStablecoinPrices();
      this.updateTargetOffset(this.priceIndex.argonUsdPrice, this.priceIndex.argonUsdTargetPrice);
    }

    return {
      ARGNOT: this.microgonsPer.ARGNOT,
      BTC: this.microgonsPer.BTC,
      USD: this.microgonsPer.USD,
    };
  }

  private calculateMainchainRates(current: IRawPriceIndexOption): IMainchainRates {
    const rates = {
      ARGNOT: BigInt(MICROGONS_PER_ARGON),
      BTC: BigInt(MICROGONS_PER_ARGON),
      USD: BigInt(MICROGONS_PER_ARGON),
    };
    if (!current.isSome) return rates;

    const priceIndex = current.unwrap();
    const argonUsdTargetPrice = fromFixedNumber(priceIndex.argonUsdTargetPrice.toBigInt(), FIXED_U128_DECIMALS);
    const argonotUsdPrice = fromFixedNumber(priceIndex.argonotUsdPrice.toBigInt(), FIXED_U128_DECIMALS);
    rates.USD = this.calculateExchangeRateInMicrogons(BigNumber(1), argonUsdTargetPrice);
    rates.BTC = this.calculateExchangeRateInMicrogons(
      fromFixedNumber(priceIndex.btcUsdPrice.toBigInt(), FIXED_U128_DECIMALS),
      argonUsdTargetPrice,
    );
    rates.ARGNOT = this.calculateExchangeRateInMicrogons(argonotUsdPrice, argonUsdTargetPrice);

    const networkIsLocal = NetworkConfig.networkName === 'dev-docker' || NetworkConfig.networkName === 'localnet';
    if (argonotUsdPrice.isZero() && networkIsLocal) rates.ARGNOT /= 10n;
    return rates;
  }

  private loadPriceIndex(current: IRawPriceIndexOption): void {
    this.lastPriceIndexStorageValue = this.getPriceIndexStorageValue(current);

    if (!current.isSome) {
      this.priceIndex.argonUsdPrice = undefined;
      this.priceIndex.argonotUsdPrice = undefined;
      this.priceIndex.btcUsdPrice = undefined;
      this.priceIndex.argonUsdTargetPrice = undefined;
      this.priceIndex.argonTimeWeightedAverageLiquidity = undefined;
      this.priceIndex.lastUpdatedTick = undefined;
      return;
    }

    const value = current.unwrap();
    this.priceIndex.btcUsdPrice = fromFixedNumber(value.btcUsdPrice.toBigInt(), FIXED_U128_DECIMALS);
    this.priceIndex.argonotUsdPrice = fromFixedNumber(value.argonotUsdPrice.toBigInt(), FIXED_U128_DECIMALS);
    this.priceIndex.argonUsdPrice = fromFixedNumber(value.argonUsdPrice.toBigInt(), FIXED_U128_DECIMALS);
    this.priceIndex.argonUsdTargetPrice = fromFixedNumber(value.argonUsdTargetPrice.toBigInt(), FIXED_U128_DECIMALS);
    this.priceIndex.argonTimeWeightedAverageLiquidity = fromFixedNumber(
      value.argonTimeWeightedAverageLiquidity.toBigInt(),
      FIXED_U128_DECIMALS,
    );
    this.priceIndex.lastUpdatedTick = value.tick.toNumber();
  }

  private getPriceIndexStorageValue(current: IRawPriceIndexOption): string | undefined {
    return current.toHex?.();
  }

  private scheduleOffchainRatesRefresh(): void {
    clearTimeout(this.offchainRatesTimeout);
    this.offchainRatesTimeout = setTimeout(() => {
      void this.fetchMainchainRates(undefined, { ignoreCache: false }).finally(() =>
        this.scheduleOffchainRatesRefresh(),
      );
    }, TWENTY_FOUR_HOURS_IN_MILLISECONDS) as unknown as number;
  }

  public calculateTargetOffset(price: BigNumber | undefined, targetPrice: BigNumber | undefined): number | null {
    if (!price || price.isZero()) return null;
    if (!targetPrice || targetPrice.isZero()) return null;
    return price.minus(targetPrice).dividedBy(targetPrice).toNumber();
  }

  private updateTargetOffset(argonUsdPrice: BigNumber | undefined, argonUsdTargetPrice: BigNumber | undefined): void {
    const targetOffset = this.calculateTargetOffset(argonUsdPrice, argonUsdTargetPrice);
    if (targetOffset === null) return;
    this.targetOffset = targetOffset;
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

  private updateFiatStablecoinPrices(): void {
    this.microgonsPer.USDC = this.microgonsPer.USD;
    this.microgonsPer.USDT = this.microgonsPer.USD;
    this.microgonsPer.USDE = this.microgonsPer.USD;
  }

  private async updateEthTokenPrices(ignoreCache = true): Promise<void> {
    const rawRates = await fetchRawEthRates(ignoreCache);
    if (!rawRates) return;

    if (rawRates?.ETH) {
      this.microgonsPer.ETH = this.convertRawFiatExchangeRateToMicrogons(1 / rawRates.ETH);
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

let ethRatesCache: Record<string, number> = {};
let lastEthCheckTime: number | undefined;

async function fetchRawEthRates(ignoreCache = true): Promise<IRawEthRates> {
  if (ignoreCache || !lastEthCheckTime || Date.now() - lastEthCheckTime >= TWENTY_FOUR_HOURS_IN_MILLISECONDS) {
    try {
      const ethRate = (await fetchCoinbaseEthUsdPrice()) ?? (await fetchKrakenEthUsdPrice());
      if (ethRate) {
        ethRatesCache = { ETH: ethRate };
        lastEthCheckTime = Date.now();
      }
    } catch (e) {
      return null;
    }
  }
  return ethRatesCache;
}

async function fetchCoinbaseEthUsdPrice(): Promise<number | null> {
  try {
    const response = await fetch('https://api.exchange.coinbase.com/products/ETH-USD/ticker');
    if (!response.ok) return null;

    const payload = (await response.json()) as { price?: string };
    return parsePositiveNumber(payload.price);
  } catch {
    return null;
  }
}

async function fetchKrakenEthUsdPrice(): Promise<number | null> {
  try {
    const response = await fetch('https://api.kraken.com/0/public/Ticker?pair=ETHUSD');
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      error?: string[];
      result?: Record<string, { c?: [string, string] }>;
    };

    if (payload.error?.length || !payload.result) return null;

    const ticker = Object.values(payload.result)[0];
    return parsePositiveNumber(ticker?.c?.[0]);
  } catch {
    return null;
  }
}

function parsePositiveNumber(value: string | number | undefined): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
