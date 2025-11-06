import BigNumber from 'bignumber.js';
import BiddingCalculatorData from './BiddingCalculatorData.js';
import { bigIntAbs, bigIntMax, bigIntMin, bigNumberToBigInt, ceilTo } from './utils.js';
import { BidAmountAdjustmentType, BidAmountFormulaType, type IBiddingRules } from './interfaces/IBiddingRules.js';
import { MICROGONS_PER_ARGON } from './index.js';

const MICRONOTS_PER_ARGONOT = MICROGONS_PER_ARGON;

interface IBidDetails {
  formulaType: BidAmountFormulaType;
  adjustmentType: BidAmountAdjustmentType;
  adjustAbsolute: bigint;
  adjustRelative: number;
  custom: bigint;
}

type IBidType = 'minimum' | 'maximum';
type IGrowthType = 'slow' | 'medium' | 'fast';

export default class BiddingCalculator {
  public data: BiddingCalculatorData;
  public biddingRules: IBiddingRules;

  public startingBidAmount!: bigint;

  public startingBidAmountAtPivot: null | bigint = null;
  public startingBidAmountFromMaximumBid: null | bigint = null;
  public startingBidAmountFromExpectedGrowth: null | bigint = null;
  public maximumBidAmount!: bigint;

  public maximumBidAmountAtPivot: null | bigint = null;
  public maximumBidAmountFromStartingBid: null | bigint = null;
  public maximumBidAmountFromExpectedGrowth: null | bigint = null;
  public startingBidAtSlowGrowthAPY!: number;

  public startingBidAtFastGrowthAPY!: number;
  public maximumBidAtSlowGrowthAPY!: number;

  public maximumBidAtFastGrowthAPY!: number;
  public averageAPY!: number;

  public pivotPoint: null | 'ExpectedGrowth' | 'StartingBid' | 'MaximumBid' = null;

  private readonly onLoadSubscribers = new Set<() => void>();

  constructor(calculatorData: BiddingCalculatorData, biddingRules: IBiddingRules) {
    this.data = calculatorData;
    this.biddingRules = biddingRules;
  }

  public onLoad(callbackFn: () => void): { unsubscribe: () => void } {
    this.onLoadSubscribers.add(callbackFn);
    return {
      unsubscribe: () => this.onLoadSubscribers.delete(callbackFn),
    };
  }

  public async load() {
    await this.data.load();
    this.calculateBidAmounts();
    for (const s of this.onLoadSubscribers) s();
  }

  public get startingBidAmountOverride(): bigint | null {
    if (this.startingBidAmountFromMaximumBid !== null || this.startingBidAmountFromExpectedGrowth !== null) {
      return bigIntMin(this.startingBidAmountFromMaximumBid, this.startingBidAmountFromExpectedGrowth);
    }
    return null;
  }

  public get maximumBidAmountOverride(): bigint | null {
    if (this.maximumBidAmountFromStartingBid !== null || this.maximumBidAmountFromExpectedGrowth !== null) {
      return bigIntMax(this.maximumBidAmountFromStartingBid, this.maximumBidAmountFromExpectedGrowth);
    }
    return null;
  }

  public get slowGrowthRewards(): bigint {
    return this.calculateMinimumRewardsThisSeat();
  }

  public get fastGrowthRewards(): bigint {
    return this.calculateOptimisticRewardsThisSeat();
  }

  public minimumCapitalRequirement(rules: IBiddingRules): {
    micronots: bigint;
    startingMicrogons: bigint;
    maxMicrogons: bigint;
  } {
    const epochSeatGoal = BigInt(this.data.getEpochSeatGoalCount(rules));
    const startingMicrogons = ceilTo(this.startingBidAmount * epochSeatGoal, 6);
    const maxMicrogons = ceilTo(this.maximumBidAmount * epochSeatGoal, 6);
    const micronots = epochSeatGoal * this.data.micronotsRequiredForBid;
    return { startingMicrogons: BigInt(startingMicrogons), maxMicrogons: BigInt(maxMicrogons), micronots };
  }

  public async updateBiddingRules(biddingRules: IBiddingRules) {
    this.biddingRules = biddingRules;
  }

  public setPivotPoint(pivotPoint: null | 'ExpectedGrowth' | 'StartingBid' | 'MaximumBid') {
    if (pivotPoint === 'ExpectedGrowth') {
      this.startingBidAmountAtPivot ??= this.startingBidAmount;
      this.maximumBidAmountAtPivot ??= this.maximumBidAmount;
    }
    this.pivotPoint = pivotPoint;
  }

  public calculateBidAmounts() {
    this.startingBidAmount = this.calculateBidAmount('minimum');
    this.maximumBidAmount = this.calculateBidAmount('maximum');

    if (this.pivotPoint === 'StartingBid') {
      if (this.startingBidAmount > this.maximumBidAmount) {
        this.maximumBidAmountFromStartingBid = this.startingBidAmount;
      } else {
        this.maximumBidAmountFromStartingBid = null;
      }
    } else if (this.pivotPoint === 'MaximumBid') {
      if (this.maximumBidAmount < this.startingBidAmount) {
        this.startingBidAmountFromMaximumBid = this.maximumBidAmount;
      } else {
        this.startingBidAmountFromMaximumBid = null;
      }
    } else if (this.pivotPoint === 'ExpectedGrowth') {
      if (this.startingBidAmountAtPivot !== this.startingBidAmount) {
        this.startingBidAmountFromExpectedGrowth = this.startingBidAmountAtPivot;
      } else {
        this.startingBidAmountFromExpectedGrowth = null;
      }
      if (this.maximumBidAmountAtPivot !== this.maximumBidAmount) {
        this.maximumBidAmountFromExpectedGrowth = this.maximumBidAmountAtPivot;
      } else {
        this.maximumBidAmountFromExpectedGrowth = null;
      }
    }

    this.startingBidAtSlowGrowthAPY = this.calculateAPY('minimum', 'slow');
    this.startingBidAtFastGrowthAPY = this.calculateAPY('minimum', 'fast');
    this.maximumBidAtSlowGrowthAPY = this.calculateAPY('maximum', 'slow');
    this.maximumBidAtFastGrowthAPY = this.calculateAPY('maximum', 'fast');

    this.averageAPY =
      (Math.min(this.startingBidAtSlowGrowthAPY, 999_999) +
        Math.min(this.startingBidAtFastGrowthAPY, 999_999) +
        Math.min(this.maximumBidAtSlowGrowthAPY, 999_999) +
        Math.min(this.maximumBidAtFastGrowthAPY, 999_999)) /
      4;
  }

  private calculateBidAmount(bidType: IBidType) {
    const bidDetails = this.extractBidDetails(bidType);
    const formulaPrice = this.calculateFormulaPrice(bidDetails);
    return this.adjustFormulaPrice(formulaPrice, bidDetails);
  }

  public get breakevenBidAtSlowGrowth(): bigint {
    const totalRewards = this.calculateMinimumRewardsThisSeat();
    const costOfArgonotBidLossInMicrogons = this.calculateCostOfArgonotBidLossInMicrogons(
      this.biddingRules.argonotPriceChangePctMin,
    );
    return bigIntMax(totalRewards - (this.data.estimatedTransactionFee + costOfArgonotBidLossInMicrogons), 0n);
  }

  public get breakevenBidAtFastGrowth(): bigint {
    const optimisticRewards = this.calculateOptimisticRewardsThisSeat();
    const costOfArgonotBidLossInMicrogons = this.calculateCostOfArgonotBidLossInMicrogons(
      this.biddingRules.argonotPriceChangePctMax,
    );
    return bigIntMax(optimisticRewards - (this.data.estimatedTransactionFee + costOfArgonotBidLossInMicrogons), 0n);
  }

  public get breakevenBidAtMediumGrowth(): bigint {
    return bigIntMax((this.breakevenBidAtFastGrowth + this.breakevenBidAtSlowGrowth) / 2n, 0n);
  }

  private calculateFormulaPrice(bidDetails: IBidDetails): bigint {
    let price = 0n;

    if (bidDetails.formulaType === BidAmountFormulaType.PreviousDayHigh) {
      price = this.data.previousDayHighBid;
    } else if (bidDetails.formulaType === BidAmountFormulaType.PreviousDayLow) {
      price = this.data.previousDayLowBid;
    } else if (bidDetails.formulaType === BidAmountFormulaType.PreviousDayMid) {
      price = this.data.previousDayMidBid;
    } else if (bidDetails.formulaType === BidAmountFormulaType.BreakevenAtSlowGrowth) {
      price = this.breakevenBidAtSlowGrowth;
    } else if (bidDetails.formulaType === BidAmountFormulaType.BreakevenAtFastGrowth) {
      price = this.breakevenBidAtFastGrowth;
    } else if (bidDetails.formulaType === BidAmountFormulaType.BreakevenAtMediumGrowth) {
      price = this.breakevenBidAtMediumGrowth;
    } else if (bidDetails.formulaType !== BidAmountFormulaType.Custom) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Invalid price formula type: ${bidDetails.formulaType}`);
    }

    return bigIntMax(price, 0n);
  }

  private adjustFormulaPrice(price: bigint, bidDetails: IBidDetails): bigint {
    if (bidDetails.formulaType === BidAmountFormulaType.Custom) {
      price = bidDetails.custom;
    } else if (bidDetails.adjustmentType === BidAmountAdjustmentType.Absolute) {
      price += bidDetails.adjustAbsolute;
    } else if (bidDetails.adjustmentType === BidAmountAdjustmentType.Relative) {
      const adjustmentAmountBn = BigNumber(price).multipliedBy(bidDetails.adjustRelative / 100);
      price += bigNumberToBigInt(adjustmentAmountBn);
    }

    const remainder = price % this.data.allowedBidIncrementMicrogons;
    if (remainder !== 0n) {
      price -= remainder;
    }

    return bigIntMax(price, 0n);
  }

  private calculateCostOfArgonotBidLossInMicrogons(argonotPriceChangePct: number): bigint {
    if (argonotPriceChangePct >= 0) return 0n;

    const tenDayPercent = this.convertAnnualToTenDayRate(argonotPriceChangePct);
    const lossInMicronotsBn = BigNumber(this.data.micronotsRequiredForBid).multipliedBy(tenDayPercent).dividedBy(100);

    // this will multiply times a loss, but we want to return a positive number
    const negativeLossMicrogons = this.micronotToMicrogon(bigNumberToBigInt(lossInMicronotsBn));
    return bigIntAbs(negativeLossMicrogons);
  }

  public calculateTenDayYield(bidType: IBidType, growthType: IGrowthType): number {
    const startingBidAmount = this.startingBidAmountOverride ?? this.startingBidAmount;
    const maximumBidAmount = this.maximumBidAmountOverride ?? this.maximumBidAmount;
    const microgonsBid = bidType === 'minimum' ? startingBidAmount : maximumBidAmount;

    const transactionFee = this.data.estimatedTransactionFee;

    const argonotPriceChangePct = this.extractArgonotPriceChangePct(growthType);
    const argonCirculationGrowthPct = this.extractArgonCirculationGrowthPct(growthType);

    const costOfArgonotBidLossInMicrogons = this.calculateCostOfArgonotBidLossInMicrogons(argonotPriceChangePct);
    const totalCostBn = BigNumber(microgonsBid + transactionFee + costOfArgonotBidLossInMicrogons);

    const microgonsToMine = this.data.microgonsToMineThisSeat;
    const microgonsToMint = this.calculateMicrogonsToMintThisSeat(argonCirculationGrowthPct);

    const micronotsMinedAsMicrogons = this.micronotMinedAsMicrogonValue(argonotPriceChangePct);
    const totalRewardsBn = BigNumber(microgonsToMine + micronotsMinedAsMicrogons + microgonsToMint);

    let tenDayYield = totalRewardsBn.minus(totalCostBn).dividedBy(totalCostBn).multipliedBy(100).toNumber();

    if (tenDayYield < 1000) {
      tenDayYield = Math.round(tenDayYield * 100) / 100;
    } else {
      tenDayYield = Math.round(tenDayYield);
    }
    tenDayYield = Math.max(tenDayYield, -100);

    return tenDayYield;
  }

  private calculateAPY(bidType: IBidType, growthType: IGrowthType): number {
    const tenDayYield = this.calculateTenDayYield(bidType, growthType);
    const apy = Math.pow(1 + tenDayYield / 100, 36.5) * 100 - 100;

    return Math.max(apy, -100);
  }

  private calculateMinimumRewardsThisSeat(): bigint {
    const microgonsToMine = this.data.microgonsToMineThisSeat;
    const microgonsToMint = this.calculateMicrogonsToMintThisSeat(this.biddingRules.argonCirculationGrowthPctMin);
    const micronotsMinedAsMicrogons = this.micronotMinedAsMicrogonValue(this.biddingRules.argonotPriceChangePctMin);

    return microgonsToMine + microgonsToMint + micronotsMinedAsMicrogons;
  }

  private calculateOptimisticRewardsThisSeat(): bigint {
    const microgonsToMine = this.data.microgonsToMineThisSeat;
    const microgonsToMint = this.calculateMicrogonsToMintThisSeat(this.biddingRules.argonCirculationGrowthPctMax);
    const micronotsMinedAsMicrogons = this.micronotMinedAsMicrogonValue(this.biddingRules.argonotPriceChangePctMax);
    return microgonsToMine + micronotsMinedAsMicrogons + microgonsToMint;
  }

  private micronotMinedAsMicrogonValue(argonotPriceChangePct: number): bigint {
    const tenDayPriceChangePct = this.convertAnnualToTenDayRate(argonotPriceChangePct);
    const micronots = this.data.micronotsToMineThisSeat;
    const asMicrogons = this.micronotToMicrogon(micronots);
    const priceChangeMultiplierBn = BigNumber(1 + tenDayPriceChangePct / 100);
    const microgonValueBn = BigNumber(asMicrogons).multipliedBy(priceChangeMultiplierBn);
    return bigNumberToBigInt(microgonValueBn);
  }

  private calculateMicrogonsToMintThisSeat(argonCirculationGrowthPct: number): bigint {
    if (!argonCirculationGrowthPct) return 0n;

    const tenDayCirculationGrowthPct = this.convertAnnualToTenDayRate(argonCirculationGrowthPct);
    const microgonsInCirculation = this.data.microgonsInCirculation;
    const epochMultiplier = 1 + tenDayCirculationGrowthPct / 100; // one epoch = 10 days

    const microgonsToMintThisEpochBn = BigNumber(microgonsInCirculation).multipliedBy(epochMultiplier);
    const microgonsToMintThisSeatBn =
      this.data.maxPossibleMiningSeatCount === 0
        ? BigNumber(0)
        : microgonsToMintThisEpochBn.dividedBy(this.data.maxPossibleMiningSeatCount);
    return bigNumberToBigInt(microgonsToMintThisSeatBn);
  }

  private micronotToMicrogon(micronots: bigint): bigint {
    if (!micronots) return 0n;
    const argonotsBn = BigNumber(micronots).dividedBy(MICRONOTS_PER_ARGONOT);
    const microgonsBn = argonotsBn.multipliedBy(this.data.microgonExchangeRateTo.ARGNOT);
    return bigNumberToBigInt(microgonsBn);
  }

  private extractBidDetails(bidType: IBidType): IBidDetails {
    if (bidType === 'minimum') {
      return {
        formulaType: this.biddingRules.startingBidFormulaType,
        adjustmentType: this.biddingRules.startingBidAdjustmentType,
        adjustAbsolute: this.biddingRules.startingBidAdjustAbsolute,
        adjustRelative: this.biddingRules.startingBidAdjustRelative,
        custom: this.biddingRules.startingBidCustom,
      };
    } else if (bidType === 'maximum') {
      return {
        formulaType: this.biddingRules.maximumBidFormulaType,
        adjustmentType: this.biddingRules.maximumBidAdjustmentType,
        adjustAbsolute: this.biddingRules.maximumBidAdjustAbsolute,
        adjustRelative: this.biddingRules.maximumBidAdjustRelative,
        custom: this.biddingRules.maximumBidCustom,
      };
    } else {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Invalid bid type: ${bidType}`);
    }
  }

  private extractArgonotPriceChangePct(growthType: IGrowthType): number {
    if (growthType === 'slow') {
      return this.biddingRules.argonotPriceChangePctMin;
    } else if (growthType === 'fast') {
      return this.biddingRules.argonotPriceChangePctMax;
    } else if (growthType === 'medium') {
      return BigNumber(this.biddingRules.argonotPriceChangePctMin)
        .plus(this.biddingRules.argonotPriceChangePctMax)
        .dividedBy(2)
        .toNumber();
    } else {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Invalid growth type: ${growthType}`);
    }
  }

  private extractArgonCirculationGrowthPct(growthType: IGrowthType): number {
    if (growthType === 'slow') {
      return this.biddingRules.argonCirculationGrowthPctMin;
    } else if (growthType === 'fast') {
      return this.biddingRules.argonCirculationGrowthPctMax;
    } else if (growthType === 'medium') {
      return BigNumber(this.biddingRules.argonCirculationGrowthPctMin)
        .plus(this.biddingRules.argonCirculationGrowthPctMax)
        .dividedBy(2)
        .toNumber();
    } else {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`Invalid growth type: ${growthType}`);
    }
  }

  private convertAnnualToTenDayRate(annualPct: number): number {
    if (annualPct < -100) {
      throw new RangeError('annualPct cannot go lower than -100');
    }

    const annualFactor = 1 + annualPct / 100;
    const periodsPerYear = 365 / 10;
    const rate = Math.pow(annualFactor, 1 / periodsPerYear) - 1;

    return rate * 100;
  }
}
