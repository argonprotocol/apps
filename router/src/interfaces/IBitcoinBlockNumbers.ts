import type { IBlockNumbers } from './IBlockNumbers.ts';

export interface IBitcoinBlockNumbers extends IBlockNumbers {
  localNodeBlockTime: number;
}
