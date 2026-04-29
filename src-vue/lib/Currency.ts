import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import {
  SATOSHIS_PER_BITCOIN,
  MICRONOTS_PER_ARGONOT,
  Currency as CurrencyBase,
  UnitOfMeasurement,
  MainchainClients,
  bigNumberToBigInt,
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

  constructor(clients: MainchainClients, config: Config) {
    super(clients);
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

  public convertSatToBtc(sat: bigint): number {
    return super.convertSatToBtc(sat);
  }

  public convertBtcToMicrogon(btc: number): bigint {
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
