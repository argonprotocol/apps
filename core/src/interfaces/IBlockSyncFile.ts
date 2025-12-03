export interface IBlockSyncFile {
  blocksByNumber: { [blockNumber: number]: IBlock };
  syncedToBlockNumber: number;
  bestBlockNumber: number;
  finalizedBlockNumber: number;
}

export interface IBlock {
  number: number;
  hash: string;
  author: string;
  tick: number;
  frameId?: number;
  frameRewardTicksRemaining?: number;
  isNewFrame?: boolean;
}
