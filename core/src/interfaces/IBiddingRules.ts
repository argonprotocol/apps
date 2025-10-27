import { z } from 'zod';

export enum MicronotPriceChangeType {
  Between = 'Between',
  Exactly = 'Exactly',
}

export enum BidAmountFormulaType {
  PreviousDayLow = 'PreviousDayLow',
  PreviousDayMid = 'PreviousDayMid',
  PreviousDayHigh = 'PreviousDayHigh',
  BreakevenAtSlowGrowth = 'BreakevenAtSlowGrowth',
  BreakevenAtMediumGrowth = 'BreakevenAtMediumGrowth',
  BreakevenAtFastGrowth = 'BreakevenAtFastGrowth',
  Custom = 'Custom',
}

export enum BidAmountAdjustmentType {
  Absolute = 'Absolute',
  Relative = 'Relative',
}

export enum SeatGoalType {
  Max = 'Max',
  MaxPercent = 'MaxPercent',
  Min = 'Min',
  MinPercent = 'MinPercent',
}

export enum SeatGoalInterval {
  Frame = 'Frame',
  Epoch = 'Epoch',
}

export enum ProfitUsage {
  Reinvest = 'Reinvest',
  Accumulate = 'Accumulate',
}

export const BiddingRulesSchema = z.object({
  argonCirculationGrowthPctMin: z.number(),
  argonCirculationGrowthPctMax: z.number(),
  argonotPriceChangeType: z.nativeEnum(MicronotPriceChangeType),
  argonotPriceChangePctMin: z.number(),
  argonotPriceChangePctMax: z.number(),
  startingBidFormulaType: z.nativeEnum(BidAmountFormulaType),
  startingBidAdjustmentType: z.nativeEnum(BidAmountAdjustmentType),
  startingBidCustom: z.bigint(),
  startingBidAdjustAbsolute: z.bigint(),
  startingBidAdjustRelative: z.number(),
  rebiddingDelay: z.number(),
  rebiddingIncrementBy: z.bigint(),
  maximumBidFormulaType: z.nativeEnum(BidAmountFormulaType),
  maximumBidAdjustmentType: z.nativeEnum(BidAmountAdjustmentType),
  maximumBidCustom: z.bigint(),
  maximumBidAdjustAbsolute: z.bigint(),
  maximumBidAdjustRelative: z.number(),

  seatGoalType: z.nativeEnum(SeatGoalType),
  seatGoalCount: z.number(),
  seatGoalPercent: z.number(),
  seatGoalInterval: z.nativeEnum(SeatGoalInterval),

  startingMicrogons: z.bigint(),
  startingMicronots: z.bigint(),
  sidelinedMicrogons: z.bigint(),
  sidelinedMicronots: z.bigint(),
});

export type IBiddingRules = z.infer<typeof BiddingRulesSchema>;
