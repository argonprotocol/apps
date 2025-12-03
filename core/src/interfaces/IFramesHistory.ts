export interface IFrameHistory {
  frameId: number;
  frameStartTick: number;
  dateStart: Date;
  firstBlockNumber: number | null;
  firstBlockHash: string | null;
  firstBlockTick: number | null;
  firstBlockSpecVersion: number | null;
}

export type IFramesHistory = IFrameHistory[];
export type IFrameHistoryMap = Record<number, IFrameHistory>;
