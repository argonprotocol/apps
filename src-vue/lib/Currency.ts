import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import {
  SATOSHIS_PER_BITCOIN,
  MICRONOTS_PER_ARGONOT,
  Currency as CurrencyBase,
  UnitOfMeasurement,
  MainchainClients,
  bigNumberToBigInt,
  createDeferred,
  type ICurrencyRecord,
  type ICurrencyKey,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { Config } from './Config';
import { IOtherToken } from './Wallet.ts';

export {
  SATOSHIS_PER_BITCOIN,
  MICRONOTS_PER_ARGONOT,
  MICROGONS_PER_ARGON,
  UnitOfMeasurement,
  ICurrencyKey,
  ICurrencyRecord,
};

export class Currency extends CurrencyBase {
  public _key: UnitOfMeasurement | null;
  public symbol!: string;
  public record!: ICurrencyRecord;
  private config: Config;
  private loadPromise?: Promise<void>;

  constructor(clients: MainchainClients, config: Config) {
    super(clients);
    this.config = config;
    this._key = null;
  }

  public get key(): UnitOfMeasurement {
    if (!this._key) throw new Error('Currency not loaded');
    return this._key;
  }

  public async load(skipCache = false) {
    const isInitialLoad = !this.isLoaded;
    if (isInitialLoad) {
      if (this.loadPromise) return await this.loadPromise;
      if (this.isLoadedDeferred.isRejected) {
        this.isLoadedDeferred = createDeferred<void>(false);
        this.isLoadedPromise = this.isLoadedDeferred.promise;
        void this.isLoadedPromise.catch(() => undefined);
      }
    }

    const loadPromise = (async () => {
      try {
        await this.config.isLoadedPromise;
        this.setKey(this.config.defaultCurrencyKey, false);
        await super.load(skipCache);
      } catch (error) {
        if (isInitialLoad && !this.isLoaded) {
          this.isLoadedDeferred.reject(error as Error);
        }
        throw error;
      }
    })();

    if (isInitialLoad) {
      const trackedLoadPromise = loadPromise.finally(() => {
        if (this.loadPromise === trackedLoadPromise) {
          this.loadPromise = undefined;
        }
      });
      this.loadPromise = trackedLoadPromise;
      return await trackedLoadPromise;
    }

    await loadPromise;
  }

  public setKey(key: ICurrencyKey, saveToConfig: boolean = true) {
    this._key = key;
    this.record = this.recordsByKey[key];
    this.symbol = this.record.symbol;
    if (saveToConfig) this.config.defaultCurrencyKey = key;
  }

  public convertSatToBtc(sat: bigint): number {
    return super.convertSatToBtc(sat);
  }

  public convertBtcToMicrogon(btc: number): bigint {
    return super.convertBtcToMicrogon(btc);
  }

  public convertSatToMicrogon(sat: bigint): bigint {
    const btc = super.convertSatToBtc(sat);
    return super.convertBtcToMicrogon(btc);
  }

  public convertOtherToFinalToken(token: IOtherToken): number {
    return this.convertOtherToFinalTokenBn(token).toNumber();
  }

  public convertOtherToMicrogon(token: IOtherToken): bigint {
    const microgonsBn = this.convertOtherToFinalTokenBn(token).multipliedBy(this.microgonsPer[token.unitOfMeasurement]);
    return bigNumberToBigInt(microgonsBn);
  }

  private convertOtherToFinalTokenBn(token: IOtherToken): BigNumber {
    return BigNumber(token.value.toString()).shiftedBy(-token.decimals);
  }
}
