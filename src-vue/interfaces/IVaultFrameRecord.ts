export interface IVaultFrameRecord {
  id: number;
  date: string;
  firstTick: number;
  /** Absent for the active frame or when completed earnings evidence is incomplete. */
  frameProfitPercent?: number;
  earningsMicrogons?: bigint;
}
