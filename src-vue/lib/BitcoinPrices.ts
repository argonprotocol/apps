import dayjs, { type Dayjs } from 'dayjs';
import { type IBitcoinPriceRecord } from '../interfaces/IBitcoinPriceRecord.ts';
import { bitcoinPrices } from '@argonprotocol/apps-core';

export default class BitcoinPrices {
  public prices: IBitcoinPriceRecord[] = [];
  public indexByDate: { [date: string]: number } = {};

  constructor() {
    this.prices = bitcoinPrices.map((priceRow, index): IBitcoinPriceRecord => {
      this.indexByDate[priceRow.date] = index;
      return { date: priceRow.date, price: Number(priceRow.price) };
    });
  }

  public get all(): IBitcoinPriceRecord[] {
    return this.prices.map(x => ({ date: x.date, price: x.price }));
  }

  public getForYear(yearToRun: string): IBitcoinPriceRecord[] {
    return this.prices.filter((row: IBitcoinPriceRecord) => row.date.startsWith(yearToRun));
  }

  public getDateRange(startingDate: string, endingDate: string): IBitcoinPriceRecord[] {
    const startingIndex = this.indexByDate[startingDate];
    const endingIndex = this.indexByDate[endingDate];
    return this.prices.slice(startingIndex, endingIndex + 1);
  }

  public getByIndex(index: number): IBitcoinPriceRecord {
    return this.prices[index];
  }

  public getByDate(date: string | Dayjs): IBitcoinPriceRecord {
    if (date instanceof dayjs) {
      date = date.format('YYYY-MM-DD');
    }
    return this.prices.find((row: IBitcoinPriceRecord) => row.date === date) ?? { date: '', price: 0 };
  }
}
