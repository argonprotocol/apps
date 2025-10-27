import { IBotActivity } from '@argonprotocol/apps-core';

export interface IServerStateRecord {
  latestFrameId: number;
  argonLocalNodeBlockNumber: number;
  argonMainNodeBlockNumber: number;
  argonBlocksLastUpdatedAt?: Date;
  bitcoinLocalNodeBlockNumber: number;
  bitcoinMainNodeBlockNumber: number;
  bitcoinBlocksLastUpdatedAt?: Date;
  botActivities: IBotActivity[];
  botActivityLastUpdatedAt: Date;
  botActivityLastBlockNumber: number;
  createdAt: Date;
  insertedAt: Date;
}
