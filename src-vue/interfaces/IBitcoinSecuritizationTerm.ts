export interface IBitcoinSecuritizationTerm {
  utxoId: number;
  termIndex: number;
  origin: 'created' | 'resecuritized';
  startTick: number;
  startBlockNumber: number;
  startBlockHash?: string;
  startExtrinsicIndex?: number;
  securitizedSatoshis: bigint;
  securitizationCoverageMicrogons: bigint | null;
  cumulativeNetSecurityFee: bigint;
  addedNetSecurityFee: bigint;
  endTick?: number;
  endBlockNumber?: number;
  endBlockHash?: string;
  endExtrinsicIndex?: number;
  endReason?: 'resecuritized' | 'released';
}
