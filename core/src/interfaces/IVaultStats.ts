export interface IAllVaultStats {
  formatVersion?: number;
  synchedToFrame: number;
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
    satoshis: bigint;
    bitcoinLocks: number;
    microgonLiquidityRealized: bigint;
  };
  changesByFrame: IVaultFrameStats[];
}

export interface IVaultFrameStats {
  frameId: number;
  bitcoinFeeRevenue: bigint;
  bitcoinFeeCouponValueUsed?: bigint;
  satoshisAdded: bigint;
  bitcoinLocksCreated: number;
  microgonLiquidityAdded: bigint;
  securitization: bigint;
  securitizationActivated: bigint;
  securitizationRelockable?: bigint;
  treasuryPool: {
    externalCapital: bigint;
    vaultCapital: bigint;
    totalEarnings: bigint;
    vaultEarnings: bigint;
  };
  uncollectedEarnings: bigint;
}
