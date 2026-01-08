export interface IVaultFrameRecord {
  id: number;
  date: string;
  firstTick: number;
  progress: number;
  totalTreasuryPayout: bigint;
  myTreasuryPayout: bigint;
  myTreasuryPercentTake: number;
  bitcoinChangeMicrogons: bigint;
  treasuryChangeMicrogons: bigint;
  frameProfitPercent: number;
  bitcoinPercentUsed: number;
  treasuryPercentActivated: number;
  profitMaximizationPercent: number;
}
