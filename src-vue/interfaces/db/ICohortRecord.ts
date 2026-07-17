export interface ICohortRecord {
  id: number;
  progress: number;
  transactionFeesTotal: bigint;
  micronotsStakedPerSeat: bigint;
  microgonsBidPerSeat: bigint;
  seatCountWon: number;
  microgonsToBeMinedPerSeat: bigint;
  micronotsToBeMinedPerSeat: bigint;
  argonotPriceAtBid: bigint;
  createdAt: string;
  updatedAt: string;
}

export type IMiningSeatRewardTerms = Pick<
  ICohortRecord,
  'microgonsToBeMinedPerSeat' | 'micronotsToBeMinedPerSeat' | 'argonotPriceAtBid'
>;
