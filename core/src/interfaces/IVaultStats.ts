import type BigNumber from 'bignumber.js';

export interface IAllVaultStats {
  formatVersion?: number;
  synchedToFrame: number;
  networkPoolsByFrame?: Record<
    number,
    {
      auctionPoolMicrogons: bigint;
      vaultPoolMicrogons?: bigint;
      includesBondPayments: boolean;
    }
  >;
  revenueBackfill?: {
    nextFrame: number;
    throughFrame: number;
  };
  argonBondsByFrame?: {
    frameId: number;
    poolDistributed: bigint;
    /** Absent when the payout's participating capital could not be recovered. */
    participatingBonds?: bigint;
  }[];
  argonotStakingByFrame: IArgonotStakingFrameStats[];
  vaultsById: {
    [vaultId: number]: IVaultStats;
  };
}

export interface IArgonotStakingFrameStats {
  frameId: number;
  poolDistributed: bigint;
  participatingBonds: number;
  microgonsPerArgonot: bigint;
}

export interface IVaultStats {
  openedTick: number;
  baseline: {
    feeRevenue: bigint;
    bitcoinLocks: number;
  };
  changesByFrame: IVaultFrameStats[];
}

export interface IVaultFrameStats {
  frameId: number;
  bitcoinFeeRevenue: bigint;
  bitcoinFeeCouponValueUsed?: bigint;
  bitcoinLocksCreated: number;
  securitization: bigint;
  /** Held Argonots at frame end; recorded from the securitization runtime onward. */
  argonotSecuritizationMicronots?: bigint;
  /** Upstream participation frozen for this frame's vault rewards. */
  upstreamParticipation?: BigNumber;
  securitizationActivated: bigint;
  treasuryPool: {
    externalCapital: bigint;
    vaultCapital: bigint;
    totalEarnings: bigint;
    vaultEarnings: bigint;
    /** Flexible bond income included in older vault payouts; absent until its frame allocation is recovered. */
    flexibleBondEarnings?: bigint;
  };
}
