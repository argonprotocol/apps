export interface IAllVaultStats {
  synchedToFrame: number;
  vaultsById: {
    [vaultId: number]: IVaultStats;
  };
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
