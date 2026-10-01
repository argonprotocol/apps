import type { Storage } from '../Storage.ts';
import type { MiningFrames } from '@argonprotocol/apps-core';

export interface IMigration {
  version: number;
  up(storage: Storage, miningFrames: MiningFrames): Promise<void>;
  down?: (storage: Storage) => Promise<void>;
}
