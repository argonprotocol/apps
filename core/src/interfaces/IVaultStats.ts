import type BigNumber from 'bignumber.js';

export interface IVaultFrameNetworkPool {
  auctionPoolMicrogons: bigint;
  vaultPoolMicrogons?: bigint;
  includesBondPayments: boolean;
}

export interface IAllVaultStats {
  formatVersion?: number;
  synchedToFrame: number;
  networkPoolsByFrame?: Record<number, IVaultFrameNetworkPool>;
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
    /** Bond-holder income after archived sharing and bonus; excludes the operator's retained flexible revenue. */
    flexibleBondEarnings?: bigint;
  };
}
