import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { type IBitcoinFeeRecord } from '../interfaces/IBitcoinFeeRecord.ts';
import BitcoinPrices from './BitcoinPrices.ts';
import { bitcoinFees } from '@argonprotocol/apps-core';

dayjs.extend(utc);

export default class BitcoinFees {
  public feeByDate: Record<string, number> = {};
  public bitcoinPrices: BitcoinPrices = new BitcoinPrices();

  private earliestDateToUse = '2025-01-01';

  constructor() {
    this.feeByDate = Object.fromEntries(
      bitcoinFees.map((record: IBitcoinFeeRecord) => [record.date, Number(record.feeInBitcoins)]),
    );
  }

  private getByDateAsBtc(date: string): number {
    return this.feeByDate[date];
  }

  public getByDate(date: string): number {
    const feeAsBtc = this.getByDateAsBtc(date);
    if (!feeAsBtc) {
      const prevDate = dayjs.utc(date).subtract(1, 'day');
      if (prevDate.isBefore(this.earliestDateToUse)) {
        throw new Error(`prevDate is before ${this.earliestDateToUse}: ${date}`);
      }
      return this.getByDate(prevDate.format('YYYY-MM-DD'));
    }
    const dollarToBitcoin = this.bitcoinPrices.getByDate(date).price;
    const fee = feeAsBtc * dollarToBitcoin;
    return fee;
  }
}
