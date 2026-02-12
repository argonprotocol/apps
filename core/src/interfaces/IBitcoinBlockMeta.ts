export interface IBitcoinBlockMeta {
  hash: string;
  height: number;
  time: number;
  nTx: number;
  size: number;
  weight: number;
  merkleroot: string;
  previousblockhash: string;
  nextblockhash?: string;
  version: number;
  versionHex: string;
  bits: string;
  difficulty: number;
  chainwork: string;
  confirmations: number;
  strippedsize: number;
  nonce: number;
  mediantime: number;
}
