import dayjs, { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { IBitcoinPriceRecord } from '../interfaces/IBitcoinPriceRecord';
import BitcoinFees from './BitcoinFees';
import BitcoinPrices from './BitcoinPrices';
import { GlobalVaultingStats } from '@argonprotocol/apps-core';

dayjs.extend(utc);

export type IActionType = 'enter-vault' | 'ratchet-up' | 'ratchet-down' | 'short' | 'exit-vault';

export interface IAction {
  date: string;
  price: number;
  type: IActionType;
  microgonsMinted: number;
  qtyOfArgonsToBurn: number;
  costOfArgonsToBurn: number;
  securityFee: number;
  btcTransactionFee: number;
  argonTransactionFee: number;
  fees: number;
  cashChange: number;
  totalCashUnlocked: number;
  totalAccruedValue: number;
}

export interface IShort {
  date: Dayjs | 'EXIT';
  lowestPrice: number;
}

export interface IClonableShort extends Omit<IShort, 'date'> {
  date: string;
}

const VAULT_SECURITY_PCT = 0;

export default class LlbVault {
  public bitcoinCount: number;

  public actions: IAction[] = [];

  public shorts: IShort[] = [];
  public shortsByDate: Record<string, IShort> = {};

  public prices: IBitcoinPriceRecord[] = [];
  public bitcoinFees: BitcoinFees;
  public ratchetDec: number;

  public startingDate: string;
  public endingDate: string;

  public hodlerExpenses = 0;

  public totalExpenses = 0;
  public totalMicrogonsMinted = 0;
  public totalCostOfArgonsToBurn = 0;
  public totalCashUnlocked = 0;
  public totalAccruedValue = 0;

  public profitFromShorts = 0;

  constructor(
    startingDate: string,
    endingDate: string,
    ratchetPct: number,
    shorts: IShort[] | IClonableShort[],
    bitcoinPrices: BitcoinPrices,
    bitcoinFees: BitcoinFees,
    bitcoinCount: number,
  ) {
    this.startingDate = startingDate;
    this.endingDate = endingDate;
    this.ratchetDec = ratchetPct / 100;

    this.shorts = shorts.map(short => ({
      ...short,
      date: short.date === 'EXIT' ? 'EXIT' : dayjs.utc(short.date),
    }));
    this.shortsByDate = this.shorts.reduce(
      (acc, short) => {
        acc[short.date === 'EXIT' ? 'EXIT' : short.date.format('YYYY-MM-DD')] = short;
        return acc;
      },
      {} as Record<string, IShort>,
    );

    this.prices = bitcoinPrices.getDateRange(startingDate, endingDate);
    this.bitcoinFees = bitcoinFees;
    this.bitcoinCount = bitcoinCount;
    this.run();
  }

  public get totalHodlerValue(): number {
    return this.prices[this.prices.length - 1].price * this.bitcoinCount - this.hodlerExpenses;
  }

  public get hodlerProfit(): number {
    return LlbVault.calculateProfit(this.prices[0].price * this.bitcoinCount, this.totalHodlerValue);
  }

  public get startingPrice(): number {
    return this.prices[0].price;
  }

  public get endingPrice(): number {
    return this.prices[this.prices.length - 1].price;
  }

  public get vaulterProfit(): number {
    const startingValue = this.startingPrice * this.bitcoinCount;
    const endingValue = this.totalAccruedValue;
    return LlbVault.calculateProfit(startingValue, endingValue);
  }

  public get profitFromInitialLock(): number {
    const lossSaved = Math.max(0, this.startingPrice + this.hodlerExpenses - this.endingPrice);
    return lossSaved * this.bitcoinCount;
  }

  public run() {
    this.actions = [];

    const bitcoinCount = this.bitcoinCount;

    {
      const startingPrice = this.prices[0].price;
      const qtyOfArgonsToBurn = 0;
      const costOfArgonsToBurn = 0;
      const securityFee = startingPrice * VAULT_SECURITY_PCT;
      const btcTransactionFee = this.bitcoinFees.getByDate(this.startingDate);
      const argonTransactionFee = this.bitcoinFees.getByDate(this.startingDate);
      const fees = securityFee + btcTransactionFee + argonTransactionFee;
      const cashChange = startingPrice * bitcoinCount - (costOfArgonsToBurn + fees);

      this.hodlerExpenses = fees;

      this.totalExpenses = fees;
      this.totalMicrogonsMinted = startingPrice * bitcoinCount;
      this.totalCostOfArgonsToBurn = costOfArgonsToBurn * bitcoinCount;
      this.totalCashUnlocked = cashChange;
      this.totalAccruedValue = cashChange;

      this.actions.push({
        date: this.startingDate,
        price: startingPrice,
        type: 'enter-vault',
        microgonsMinted: startingPrice * bitcoinCount,
        qtyOfArgonsToBurn,
        costOfArgonsToBurn,
        securityFee,
        btcTransactionFee,
        argonTransactionFee,
        fees,
        cashChange,
        totalCashUnlocked: this.totalCashUnlocked,
        totalAccruedValue: this.totalAccruedValue,
      });
    }

    for (const [index, item] of this.prices.entries()) {
      if (index === this.prices.length - 1) break;
      const currentPrice = item.price;
      const currentDate = item.date;
      const currentShort = this.shortsByDate[currentDate];

      const lastAction = this.actions[this.actions.length - 1];

      const changePct = LlbVault.calculateProfit(lastAction.price, currentPrice);
      const changeAbs = currentPrice - lastAction.price;
      const isEnoughChange =
        this.ratchetDec && Math.abs(changeAbs) >= this.ratchetDec && Math.abs(changePct) >= this.ratchetDec;
      if (!isEnoughChange && !currentShort) {
        continue;
      }

      const unlockPriceOfBtc = Math.min(currentPrice, lastAction.price);

      let qtyOfArgonsToBurn = unlockPriceOfBtc * bitcoinCount;
      let costOfArgonsToBurn = unlockPriceOfBtc * bitcoinCount;

      if (currentShort) {
        qtyOfArgonsToBurn =
          GlobalVaultingStats.calculateUnlockBurnPerBitcoinDollar(currentShort.lowestPrice) *
          unlockPriceOfBtc *
          bitcoinCount;
        const newCostOfArgonsToBurn = qtyOfArgonsToBurn * currentShort.lowestPrice;
        this.profitFromShorts += costOfArgonsToBurn - newCostOfArgonsToBurn;
        costOfArgonsToBurn = newCostOfArgonsToBurn;
      }

      const securityFee = currentPrice * VAULT_SECURITY_PCT;
      const btcTransactionFee = changePct > 0 ? this.bitcoinFees.getByDate(currentDate) : 0;
      const argonTransactionFee = this.bitcoinFees.getByDate(currentDate);
      const fees = securityFee + btcTransactionFee + argonTransactionFee;
      const cashChange = currentPrice * bitcoinCount - (costOfArgonsToBurn + fees);

      this.totalExpenses += fees;
      this.totalMicrogonsMinted += currentPrice * bitcoinCount;
      this.totalCostOfArgonsToBurn += costOfArgonsToBurn;
      this.totalCashUnlocked += cashChange;
      this.totalAccruedValue += cashChange;

      this.actions.push({
        date: currentDate,
        price: currentPrice,
        type: currentShort ? 'short' : changePct > 0 ? 'ratchet-up' : 'ratchet-down',
        microgonsMinted: currentPrice * bitcoinCount,
        qtyOfArgonsToBurn,
        costOfArgonsToBurn,
        securityFee,
        btcTransactionFee,
        argonTransactionFee,
        fees,
        cashChange,
        totalCashUnlocked: this.totalCashUnlocked,
        totalAccruedValue: this.totalAccruedValue,
      });
    }

    {
      // unlock bitcoin at the end
      const endingPrice = this.prices[this.prices.length - 1].price;
      const lastAction = this.actions[this.actions.length - 1];

      const unlockPriceOfBtc = Math.min(endingPrice, lastAction.price);

      let qtyOfArgonsToBurn = unlockPriceOfBtc * bitcoinCount;
      let costOfArgonsToBurn = unlockPriceOfBtc * bitcoinCount;

      if (this.shortsByDate.EXIT) {
        const currentShort = this.shortsByDate.EXIT;
        qtyOfArgonsToBurn =
          GlobalVaultingStats.calculateUnlockBurnPerBitcoinDollar(currentShort.lowestPrice) *
          unlockPriceOfBtc *
          bitcoinCount;
        const newCostOfArgonsToBurn = qtyOfArgonsToBurn * currentShort.lowestPrice;
        this.profitFromShorts += costOfArgonsToBurn - newCostOfArgonsToBurn;
        costOfArgonsToBurn = newCostOfArgonsToBurn;
      }

      const securityFee = endingPrice * VAULT_SECURITY_PCT;
      const btcTransactionFee = this.bitcoinFees.getByDate(this.endingDate);
      const argonTransactionFee = this.bitcoinFees.getByDate(this.endingDate);
      const fees = securityFee + btcTransactionFee + argonTransactionFee;
      const cashChange = -(costOfArgonsToBurn + fees);

      this.hodlerExpenses += fees;

      this.totalExpenses += fees;
      this.totalMicrogonsMinted += 0;
      this.totalCostOfArgonsToBurn += costOfArgonsToBurn;
      this.totalAccruedValue += endingPrice * bitcoinCount + cashChange;

      this.actions.push({
        date: this.endingDate,
        price: endingPrice,
        type: 'exit-vault',
        microgonsMinted: 0,
        qtyOfArgonsToBurn,
        costOfArgonsToBurn,
        securityFee,
        btcTransactionFee,
        argonTransactionFee,
        fees,
        cashChange,
        totalCashUnlocked: this.totalCashUnlocked,
        totalAccruedValue: this.totalAccruedValue,
      });
    }
  }

  private static calculateProfit(buyPrice: number, sellPrice: number): number {
    return (sellPrice - buyPrice) / buyPrice;
  }
}
