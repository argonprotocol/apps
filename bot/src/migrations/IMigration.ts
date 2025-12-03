import type { Storage } from '../Storage.ts';

export interface IMigration {
  version: number;
  up(storage: Storage): Promise<void>;
  down?: (storage: Storage) => Promise<void>;
}
