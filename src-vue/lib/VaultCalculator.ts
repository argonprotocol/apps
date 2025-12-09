import BigNumber from 'bignumber.js';
import { bigIntMax, bigNumberToBigInt, MainchainClients, roundTo } from '@argonprotocol/apps-core';
import { Config } from './Config';
import { calculateAPY, createDeferred } from './Utils';
import { Vaults } from './Vaults.ts';

export class VaultCalculator {
  private rules!: Config['vaultingRules'];
  private readonly clients: MainchainClients;
  private isLoaded = createDeferred(false);

  public epochPoolRewards!: bigint;
  public epochPoolCapitalTotal!: bigint;

  constructor(mainchainClients: MainchainClients) {
    this.clients = mainchainClients;
  }

  public async load(rules: Config['vaultingRules']) {
    if (this.isLoaded.isRunning || this.isLoaded.isSettled) {
      return this.isLoaded.promise;
    }
    this.isLoaded.setIsRunning(true);
    this.rules = rules;
    try {
      const { totalPoolRewards, totalActivatedCapital } = await Vaults.getPreviousEpochTreasuryPoolPayout(this.clients);
      this.epochPoolRewards = totalPoolRewards;
      this.epochPoolCapitalTotal = totalActivatedCapital;
      this.isLoaded.resolve();
    } catch (e) {
      this.isLoaded.reject(e);
      throw e;
    }
  }

  public calculateInternalAPY(btcUtilization: 'Low' | 'High', poolUtilization: 'Low' | 'High'): number {
    const vaultRevenue = this.calculateInternalRevenue(btcUtilization, poolUtilization);
    const vaultCost = this.rules.baseMicrogonCommitment;

    return calculateAPY(vaultCost, vaultCost + vaultRevenue);
  }

  public calculateInternalRevenue(btcUtilization: 'Low' | 'High', poolUtilization: 'Low' | 'High'): bigint {
    const { profitSharingPct } = this.rules;

    const totalPoolCapital = this.calculateTotalPoolCapital(btcUtilization, poolUtilization);
    const totalPoolRevenue = this.calculateTotalPoolRevenue(btcUtilization, poolUtilization);
    const internalBtcRevenue = this.calculateInternalBtcRevenue(btcUtilization);

    const externalPoolCapital = this.calculateExternalPoolCapital(btcUtilization, poolUtilization);

    const externalFactorBn = totalPoolCapital
      ? BigNumber(externalPoolCapital).dividedBy(totalPoolCapital)
      : BigNumber(0);
    const internalFactorBn = BigNumber(1).minus(externalFactorBn);

    const revenueFromExternalBn = BigNumber(totalPoolRevenue)
      .multipliedBy(externalFactorBn)
      .multipliedBy(1 - profitSharingPct / 100);
    const revenueFromExternal = bigNumberToBigInt(revenueFromExternalBn);

    const revenueFromInternalBn = BigNumber(totalPoolRevenue).multipliedBy(internalFactorBn);
    const revenueFromInternal = bigNumberToBigInt(revenueFromInternalBn);

    return revenueFromInternal + revenueFromExternal + internalBtcRevenue;
  }

  public calculateExternalRevenue(btcUtilization: 'Low' | 'High', poolUtilization: 'Low' | 'High'): bigint {
    const { profitSharingPct } = this.rules;
    const totalPoolCapital = this.calculateTotalPoolCapital(btcUtilization, poolUtilization);
    const externalPoolCapital = this.calculateExternalPoolCapital(btcUtilization, poolUtilization);

    if (totalPoolCapital <= 0n) return 0n;
    const totalPoolRevenue = this.calculateTotalPoolRevenue(btcUtilization, poolUtilization);
    const externalFundingRatio = BigNumber(externalPoolCapital).div(totalPoolCapital);

    const externalPoolRevenueBn = BigNumber(totalPoolRevenue)
      .multipliedBy(externalFundingRatio)
      .multipliedBy(profitSharingPct / 100);
    return bigNumberToBigInt(externalPoolRevenueBn);
  }

  public calculateExternalAPY(btcUtilization: 'Low' | 'High', poolUtilization: 'Low' | 'High'): number {
    const externalPoolCapital = this.calculateExternalPoolCapital(btcUtilization, poolUtilization);
    const externalPoolRevenue = this.calculateExternalRevenue(btcUtilization, poolUtilization);

    return calculateAPY(externalPoolCapital, externalPoolCapital + externalPoolRevenue);
  }

  public calculateSecuritization(): bigint {
    // this function has no utilization parameter because BTC space is only dependent on pool capital
    const { baseMicrogonCommitment, capitalForSecuritizationPct } = this.rules;

    const btcSecuritizationBn = BigNumber(baseMicrogonCommitment).multipliedBy(capitalForSecuritizationPct / 100);
    return bigNumberToBigInt(btcSecuritizationBn);
  }

  public calculateBtcSpaceInMicrogons(): bigint {
    // this function has no utilization parameter because BTC space is only dependent on pool capital
    const { baseMicrogonCommitment: vaultCapital, capitalForSecuritizationPct, securitizationRatio } = this.rules;

    const vaultCapitalBn = BigNumber(vaultCapital);
    const btcSecuritizationBn = vaultCapitalBn.multipliedBy(capitalForSecuritizationPct / 100);
    const btcSpaceInMicrogonsBn = btcSecuritizationBn.dividedBy(securitizationRatio);

    return bigNumberToBigInt(btcSpaceInMicrogonsBn);
  }

  public personalBtcInMicrogons(): bigint {
    const btcSpaceInMicrogons = this.calculateBtcSpaceInMicrogons();
    const personalBtcInMicrogonsBn = BigNumber(btcSpaceInMicrogons).multipliedBy(this.rules.personalBtcPct).div(100);

    return bigNumberToBigInt(personalBtcInMicrogonsBn);
  }

  public calculateInternalBtcRevenue(utilization: 'Low' | 'High'): bigint {
    const personalBtcInMicrogons = this.personalBtcInMicrogons();
    const btcUtilizedInMicrogons = this.calculateBtcUtilizedInMicrogons(utilization);
    const btcSellableInMicrogons = BigNumber(btcUtilizedInMicrogons).minus(personalBtcInMicrogons).toNumber();

    let totalRevenueFromBtcBn = BigNumber(btcSellableInMicrogons).multipliedBy(this.rules.btcPctFee / 100);
    if (btcSellableInMicrogons > 0n) {
      // TODO: this assumes all the BTC space is taken in a single transaction. We need a more sophisticated model for this.
      totalRevenueFromBtcBn = totalRevenueFromBtcBn.plus(this.rules.btcFlatFee);
    }

    return bigNumberToBigInt(totalRevenueFromBtcBn.dividedBy(36.5));
  }

  public updateCapitalSplit() {
    const maxTreasuryRatio = BigNumber(Math.min(this.rules.securitizationRatio, 2));
    const capital = BigNumber(this.rules.baseMicrogonCommitment);
    const securitizationRatio = BigNumber(this.rules.securitizationRatio);
    const treasuryPct = BigNumber(this.calculatePercentOfTreasuryClaimed()).dividedBy(100);
    const btcInMicrogons = capital.dividedBy(securitizationRatio.plus(maxTreasuryRatio.times(treasuryPct)));

    const securitizationPct = btcInMicrogons.multipliedBy(securitizationRatio).dividedBy(capital);

    this.rules.capitalForSecuritizationPct = Number(securitizationPct.times(100).toFixed(2));
    this.rules.capitalForTreasuryPct = 100 - this.rules.capitalForSecuritizationPct;
  }

  /**
   * Responds to user input of the percent of the treasury pool they want to fund and converts the amount of capital to
   * allocate to the treasury.
   * @param percent - percent of the treasury pool the user wants to fund (0-100)
   */
  public updateTreasuryFundingPercent(percent: number) {
    const securitizationRatio = this.rules.securitizationRatio;
    const maxTreasuryRatio = Math.min(securitizationRatio, 2);
    const treasuryPoolFundedPct = percent / 100;

    const capitalPct =
      (treasuryPoolFundedPct * maxTreasuryRatio) / (securitizationRatio + treasuryPoolFundedPct * maxTreasuryRatio);
    this.rules.capitalForTreasuryPct = roundTo(capitalPct * 100, 2);
    this.updateCapitalSplit();
  }

  /**
   * Converts the percent of total capital spent on treasury to the percent of the treasury pool that can be claimed.
   */
  public calculatePercentOfTreasuryClaimed(): number {
    const securitizationRatio = this.rules.securitizationRatio;
    const maxTreasuryRatio = Math.min(securitizationRatio, 2);
    const capitalPct = this.rules.capitalForTreasuryPct / 100;

    const treasuryPoolFundedPct = (capitalPct * securitizationRatio) / (maxTreasuryRatio * (1 - capitalPct));
    const percentToShow = roundTo(treasuryPoolFundedPct * 100, 2);
    if (Math.round(percentToShow) - percentToShow < 0.01) {
      return Math.round(percentToShow);
    }
    return percentToShow;
  }

  private calculateBtcUtilizedInMicrogons(btcUtilization: 'Low' | 'High' | 'Full'): bigint {
    const { btcUtilizationPct } = this.extractRulesFor(btcUtilization);
    const btcSpaceInMicrogons = this.calculateBtcSpaceInMicrogons();
    const btcUtilizedInMicrogonsBn = BigNumber(btcSpaceInMicrogons).multipliedBy(btcUtilizationPct / 100);
    const btcUtilizedInMicrogons = bigNumberToBigInt(btcUtilizedInMicrogonsBn);

    return bigIntMax(btcUtilizedInMicrogons, this.personalBtcInMicrogons());
  }

  public calculateTotalPoolSpace(btcUtilization: 'Low' | 'High' | 'Full'): bigint {
    // Ultimately the pool space is dependent on how much BTC is in the vault
    const btcUtilizedInMicrogons = this.calculateBtcUtilizedInMicrogons(btcUtilization);
    const securitizationRatio = Math.min(this.rules.securitizationRatio, 2);
    const securitizationRatioBn = BigNumber(securitizationRatio);
    const activatedSecuritizationBn = BigNumber(btcUtilizedInMicrogons).multipliedBy(securitizationRatioBn);
    return bigNumberToBigInt(activatedSecuritizationBn);
  }

  public calculateTotalPoolCapital(btcUtilization: 'Low' | 'High', poolUtilization: 'Low' | 'High'): bigint {
    const totalPoolSpace = this.calculateTotalPoolSpace(btcUtilization);
    const poolUtilizationPct =
      poolUtilization === 'Low' ? this.rules.poolUtilizationPctMin : this.rules.poolUtilizationPctMax;
    const poolCapitalBn = BigNumber(totalPoolSpace).multipliedBy(poolUtilizationPct / 100);
    return bigNumberToBigInt(poolCapitalBn);
  }

  public calculateInternalPoolCapital(): bigint {
    const { baseMicrogonCommitment: internalCapital, capitalForTreasuryPct } = this.rules;

    const internalCapitalBn = BigNumber(internalCapital);
    const internalPoolCapitalBn = internalCapitalBn.multipliedBy(capitalForTreasuryPct / 100);
    return bigNumberToBigInt(internalPoolCapitalBn);
  }

  public calculateExternalPoolCapital(btcUtilization: 'Low' | 'High', poolUtilization: 'Low' | 'High'): bigint {
    const totalPoolSpace = this.calculateTotalPoolSpace(btcUtilization);
    const internalPoolCapital = this.calculateInternalPoolCapital();
    const poolUtilizationPct =
      poolUtilization === 'Low' ? this.rules.poolUtilizationPctMin : this.rules.poolUtilizationPctMax;
    const maxExternalCapitalBn = BigNumber(totalPoolSpace - internalPoolCapital).multipliedBy(poolUtilizationPct / 100);
    const maxExternalCapital = bigNumberToBigInt(maxExternalCapitalBn);
    return bigIntMax(0n, maxExternalCapital);
  }

  private calculateGlobalPoolCapital(btcUtilization: 'Low' | 'High', poolUtilization: 'Low' | 'High'): bigint {
    return this.epochPoolCapitalTotal + this.calculateTotalPoolCapital(btcUtilization, poolUtilization);
  }

  private calculateTotalPoolRevenue(btcUtilization: 'Low' | 'High', poolUtilization: 'Low' | 'High'): bigint {
    const totalPoolCapital = this.calculateTotalPoolCapital(btcUtilization, poolUtilization);
    const globalPoolCapital = this.calculateGlobalPoolCapital(btcUtilization, poolUtilization);
    const pctOfGlobalPool = BigNumber(totalPoolCapital).dividedBy(globalPoolCapital).toNumber();
    const epochRevenueFromPoolBn = BigNumber(this.epochPoolRewards).multipliedBy(pctOfGlobalPool);
    return bigNumberToBigInt(epochRevenueFromPoolBn);
  }

  private extractRulesFor(utilization: 'Low' | 'High' | 'Full') {
    if (utilization === 'Low') {
      return {
        btcUtilizationPct: this.rules.btcUtilizationPctMin,
      };
    } else if (utilization === 'High') {
      return {
        btcUtilizationPct: this.rules.btcUtilizationPctMax,
      };
    } else {
      return {
        btcUtilizationPct: 100,
      };
    }
  }
}
