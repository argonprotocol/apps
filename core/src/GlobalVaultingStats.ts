import type { Vaults } from './Vaults.ts';
import { SATOSHIS_PER_BITCOIN } from './Currency.ts';

export class GlobalVaultingStats {
  private vaults: Vaults;
  public microgonValueInVaults: bigint = 0n;
  public epochEarnings: bigint = 0n;
  public vaultCount: number = 0;
  public averageAPY: number = 0;
  public bitcoinLocked: number = 0;

  constructor(vaults: Vaults) {
    this.vaults = vaults;
  }

  public async load() {
    await this.vaults.load();

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
    this.vaults
      .getMarketRate(satsLocked)
      .then(rate => {
        this.microgonValueInVaults = rate;
      })
      .catch(() => {
        this.microgonValueInVaults = 0n;
      });
    this.vaultCount = list.length;

    if (vaultApys.length > 0) {
      this.averageAPY = vaultApys.reduce((a, b) => a + b, 0) / vaultApys.length;
    } else {
      this.averageAPY = 0;
    }
  }
}
