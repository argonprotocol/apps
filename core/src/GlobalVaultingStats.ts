import type { Vaults } from './Vaults.js';
import { SATOSHIS_PER_BITCOIN, UnitOfMeasurement, type Currency } from './Currency.js';

export class GlobalVaultingStats {
  private vaults: Vaults;
  private currency: Currency;

  public microgonValueOfVaultedBitcoins: bigint = 0n;
  public epochEarnings: bigint = 0n;
  public vaultCount: number = 0;
  public activeAPR: number = 0;
  public activeAPY: number = 0;

  public bondsAPR: number = 0;

  public bitcoinLocked: number = 0;
  public argonBurnCapacity: number = 0;

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
    const list = Object.values(this.vaults.vaultsById);

    this.epochEarnings = list.reduce((total, vault) => {
      const earnings = this.vaults.treasuryPoolTotalEarnings(vault.vaultId, 10);
      return total + earnings;
    }, 0n);

    const satsLocked = this.vaults.getTotalSatoshisLocked();
    this.bitcoinLocked = Number(satsLocked) / Number(SATOSHIS_PER_BITCOIN);
    try {
      this.microgonValueOfVaultedBitcoins = await this.vaults.getSatoshiPriceInTargetMicrogons(satsLocked);
    } catch (error) {
      this.microgonValueOfVaultedBitcoins = 0n;
    }
    this.vaultCount = list.length;

    this.activeAPR = this.vaults.calculateApr();
    this.activeAPY = this.vaults.calculateApy();

    this.bondsAPR = this.vaults.calculateBondsApr();

    const dollarValueOfVaultedBitcoin = this.currency.convertMicrogonTo(
      this.microgonValueOfVaultedBitcoins,
      UnitOfMeasurement.USD,
    );
    const usdPriceAfterTerraCollapse = this.currency.convertMicrogonTo(
      this.finalPriceAfterTerraCollapse,
      UnitOfMeasurement.USD,
    );
    const burnPerBitcoinDollar = GlobalVaultingStats.calculateUnlockBurnPerBitcoinDollar(usdPriceAfterTerraCollapse);

    this.argonBurnCapacity = burnPerBitcoinDollar * dollarValueOfVaultedBitcoin;
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
