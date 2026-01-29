import { IBotActivity } from '@argonprotocol/apps-core';

export interface IServerStateRecord {
  latestFrameId: number;
  argonLocalNodeBlockNumber: number;
  argonMainNodeBlockNumber: number;
  argonBlocksLastUpdatedAt?: Date;
  bitcoinLocalNodeBlockNumber: number;
  bitcoinMainNodeBlockNumber: number;
  bitcoinBlocksLastUpdatedAt?: Date;
  botActivityLastUpdatedAt: Date;
  botActivityLastBlockNumber: number;
}
