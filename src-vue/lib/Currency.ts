import { type ApiDecoration, MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import {
  SATOSHIS_PER_BITCOIN,
  MICRONOTS_PER_ARGONOT,
  Currency as CurrencyBase,
  UnitOfMeasurement,
  type ICurrencyRecord,
  type ICurrencyKey,
} from '@argonprotocol/apps-core';
import { Config } from './Config';

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

  constructor(client: Promise<ApiDecoration<'promise'>>, config: Config) {
    super(client);
    this.config = config;
    this._key = null;
  }

  public get key(): UnitOfMeasurement {
    if (!this._key) throw new Error('Currency not loaded');
    return this._key;
  }

  public async load() {
    await this.config.isLoadedPromise;
    this.setKey(this.config.defaultCurrencyKey, false);
    await super.load();
  }

  public setKey(key: ICurrencyKey, saveToConfig: boolean = true) {
    this._key = key;
    this.record = this.recordsByKey[key];
    this.symbol = this.record.symbol;
    if (saveToConfig) this.config.defaultCurrencyKey = key;
  }

  public convertSatToBtc(satoshis: bigint): number {
    return super.convertSatToBtc(satoshis);
  }

  public convertBtcToMicrogon(bitcoins: number): bigint {
    return this.convertBtcToMicrogon(bitcoins);
  }
}
