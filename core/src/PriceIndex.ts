import BigNumber from 'bignumber.js';
import { type ApiDecoration, MICROGONS_PER_ARGON, PriceIndex as PriceIndexModel } from '@argonprotocol/mainchain';
import { bigNumberToBigInt } from './utils.js';
import type { MainchainClients } from './MainchainClients.js';
import { NetworkConfig } from './NetworkConfig.js';

export type ICurrencyKey = CurrencyKey.ARGN | CurrencyKey.USD | CurrencyKey.EUR | CurrencyKey.GBP | CurrencyKey.INR;
export type IExchangeRates = Record<ICurrencyKey | 'ARGNOT' | 'BTC', bigint>;

export enum CurrencyKey {
  ARGN = 'ARGN',
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  INR = 'INR',
}

export type IMainchainExchangeRates = Omit<IExchangeRates, 'EUR' | 'GBP' | 'INR'>;

export class PriceIndex {
  public current: PriceIndexModel;
  public exchangeRates: IMainchainExchangeRates;

  constructor(public clients: MainchainClients) {
    this.current = new PriceIndexModel();
    this.exchangeRates = {
      USD: BigInt(MICROGONS_PER_ARGON),
      ARGNOT: BigInt(MICROGONS_PER_ARGON),
      ARGN: BigInt(MICROGONS_PER_ARGON),
      BTC: BigInt(MICROGONS_PER_ARGON),
    };
  }

  public async fetchMicrogonsInCirculation(api?: ApiDecoration<'promise'>): Promise<bigint> {
    const client = api ?? (await this.clients.prunedClientOrArchivePromise);
    return (await client.query.balances.totalIssuance()).toBigInt();
  }

  public async fetchMicrogonExchangeRatesTo(api?: ApiDecoration<'promise'>): Promise<IMainchainExchangeRates> {
    api ??= await this.clients.prunedClientOrArchivePromise;
    const microgonsForArgon = BigInt(MICROGONS_PER_ARGON);
    const priceIndex = await this.current.load(api as any);

    if (priceIndex.argonUsdPrice === undefined) {
      return this.exchangeRates;
    }

    // These exchange rates should be relative to the argon
    const usdForArgonBn = priceIndex.argonUsdPrice;
    const microgonsForUsd = this.calculateExchangeRateInMicrogons(BigNumber(1), usdForArgonBn);
    let microgonsForArgnot = this.calculateExchangeRateInMicrogons(priceIndex.argonotUsdPrice!, usdForArgonBn);

    if (
      priceIndex.argonotUsdPrice! === BigNumber(0) &&
      (NetworkConfig.networkName === 'dev-docker' || NetworkConfig.networkName === 'localnet')
    ) {
      microgonsForArgnot = microgonsForArgnot / 10n;
    }
    const microgonsForBtc = this.calculateExchangeRateInMicrogons(priceIndex.btcUsdPrice!, usdForArgonBn);
    this.exchangeRates = {
      ARGN: microgonsForArgon,
      USD: microgonsForUsd,
      ARGNOT: microgonsForArgnot,
      BTC: microgonsForBtc,
    };

    return this.exchangeRates;
  }

  private calculateExchangeRateInMicrogons(usdAmount: BigNumber, usdForArgon: BigNumber): bigint {
    const oneArgonInMicrogons = BigInt(MICROGONS_PER_ARGON);
    const usdAmountBn = BigNumber(usdAmount);
    const usdForArgonBn = BigNumber(usdForArgon);
    if (usdAmountBn.isZero() || usdForArgonBn.isZero()) return oneArgonInMicrogons;

    const argonsRequired = usdAmountBn.dividedBy(usdForArgonBn);
    return bigNumberToBigInt(argonsRequired.multipliedBy(MICROGONS_PER_ARGON));
  }
}
