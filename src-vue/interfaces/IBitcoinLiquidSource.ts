export interface IBitcoinLiquidSource {
  key: string;
  cosigner: string;
  unallocatedSatoshis: bigint;
  maximumLiquidSatoshis: bigint;
  selectedSatoshis: bigint;
}
