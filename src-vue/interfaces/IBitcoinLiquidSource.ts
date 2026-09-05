export interface IBitcoinLiquidSource {
  key: string;
  cosigner: string;
  isMyVault: boolean;
  unallocatedSatoshis: bigint;
  maximumLiquidSatoshis: bigint;
  selectedSatoshis: bigint;
}
