import { IBitcoinPriceRecord } from '../interfaces/IBitcoinPriceRecord';
import LlbVault, { IAction } from './LlbVault';

export default class LlbVaultSnapshot {
  public isLoaded = false;

  public actions: IAction[] = [];
  public prices: IBitcoinPriceRecord[] = [];

  public startingPrice: number = 0;
  public endingPrice: number = 0;

  public totalExpenses: number = 0;
  public totalAccruedValue: number = 0;
  public vaulterProfit: number = 0;
  public hodlerExpenses: number = 0;
  public hodlerProfit: number = 0;
  public totalHodlerValue: number = 0;
  public profitFromShorts: number = 0;
  public profitFromInitialLock: number = 0;
  public totalCashUnlocked: number = 0;
  public ratchetCount: number = 0;
  public shortCount: number = 0;

  public update(vault: LlbVault) {
    this.isLoaded = false;

    this.actions = vault.actions;
    this.prices = vault.prices;

    this.startingPrice = vault.startingPrice;
    this.endingPrice = vault.endingPrice;

    this.totalExpenses = vault.totalExpenses;
    this.totalAccruedValue = vault.totalAccruedValue;
    this.vaulterProfit = vault.vaulterProfit;
    this.hodlerExpenses = vault.hodlerExpenses;
    this.hodlerProfit = vault.hodlerProfit;
    this.totalHodlerValue = vault.totalHodlerValue;
    this.profitFromShorts = vault.profitFromShorts;
    this.profitFromInitialLock = vault.profitFromInitialLock;
    this.totalCashUnlocked = vault.totalCashUnlocked;

    this.ratchetCount = vault.actions.filter(a => a.type === 'ratchet-up' || a.type === 'ratchet-down').length;
    this.shortCount = vault.shorts.length;
  }
}
