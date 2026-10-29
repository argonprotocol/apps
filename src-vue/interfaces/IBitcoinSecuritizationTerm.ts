export interface IBitcoinSecuritizationTerm {
  lockId: number;
  termIndex: number;
  origin: 'created' | 'resecuritized' | 'partial-release';
  startTick: number;
  startBlockNumber: number;
  startBlockHash?: string;
  startExtrinsicIndex?: number;
  securitizedSatoshis: bigint;
  securitizationCoverageMicrogons?: bigint;
  /** Exact payment for this purchase; older rows retain only the native cumulative counter. */
  netSecurityFee?: bigint;
  cumulativeNetSecurityFee: bigint;
  addedNetSecurityFee: bigint;
  endTick?: number;
  endBlockNumber?: number;
  endBlockHash?: string;
  endExtrinsicIndex?: number;
  endReason?: 'resecuritized' | 'partial-release' | 'released';
}
