export interface IBitcoinLiquidSource {
  key: string;
  vaultId: number;
  vaultName: string;
  unallocatedSatoshis: bigint;
  maximumLiquidSatoshis: bigint;
  selectedSatoshis: bigint;
}
