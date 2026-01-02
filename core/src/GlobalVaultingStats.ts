import type { Vaults } from './Vaults.js';
import { SATOSHIS_PER_BITCOIN, UnitOfMeasurement, type Currency } from './Currency.js';

export class GlobalVaultingStats {
  private vaults: Vaults;
  private currency: Currency;

  public microgonValueOfVaultedBitcoins: bigint = 0n;
  public epochEarnings: bigint = 0n;
  public vaultCount: number = 0;
  public averageAPY: number = 0;
  public bitcoinLocked: number = 0;

  public argonBurnCapability: number = 0;

  public finalPriceAfterTerraCollapse = 1_000n;

  constructor(vaults: Vaults, currency: Currency) {
    this.vaults = vaults;
    this.currency = currency;
  }

  public async load() {
    await this.vaults.load();
    await this.currency.load();
    await this.update();
  }

  public async update() {
    const vaultApys: number[] = [];
    const list = Object.values(this.vaults.vaultsById);
    for (const vault of list) {
      const earnings = this.vaults.treasuryPoolEarnings(vault.vaultId, 10);
      this.epochEarnings += earnings;
      const apy = this.vaults.calculateVaultApy(vault.vaultId);
      vaultApys.push(apy);
    }

    const satsLocked = this.vaults.getTotalSatoshisLocked();
    this.bitcoinLocked = Number(satsLocked) / Number(SATOSHIS_PER_BITCOIN);
    this.microgonValueOfVaultedBitcoins = await this.fetchMicrogonValueOfSats(satsLocked);
    this.vaultCount = list.length;

    if (vaultApys.length > 0) {
      this.averageAPY = vaultApys.reduce((a, b) => a + b, 0) / vaultApys.length;
    } else {
      this.averageAPY = 0;
    }

    const dollarValueOfVaultedBitcoin = this.currency.convertMicrogonTo(
      this.microgonValueOfVaultedBitcoins,
      UnitOfMeasurement.USD,
    );
    const usdPriceAfterTerraCollapse = this.currency.convertMicrogonTo(
      this.finalPriceAfterTerraCollapse,
      UnitOfMeasurement.USD,
    );
    const burnPerBitcoinDollar = GlobalVaultingStats.calculateUnlockBurnPerBitcoinDollar(usdPriceAfterTerraCollapse);

    this.argonBurnCapability = burnPerBitcoinDollar * dollarValueOfVaultedBitcoin;
  }

  private async fetchMicrogonValueOfSats(satsLocked: bigint) {
    try {
      return await this.vaults.getMarketRateInMicrogons(satsLocked);
    } catch (error) {
      return 0n;
    }
  }

  public static calculateUnlockBurnPerBitcoinDollar(argonRatioPrice: number): number {
    const r = argonRatioPrice;
    if (r >= 1.0) {
      return 1;
    } else if (r >= 0.9) {
      return 20 * Math.pow(r, 2) - 38 * r + 19;
    } else if (r >= 0.01) {
      return (0.5618 * r + 0.3944) / r;
    } else {
      return (1 / r) * (0.576 * r + 0.4);
    }
  }
}
