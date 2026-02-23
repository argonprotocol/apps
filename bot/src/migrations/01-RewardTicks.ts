import type { IMigration } from './IMigration.ts';
import type { Storage } from '../Storage.ts';

export class RewardTicksMigration implements IMigration {
  version = 1;
  public async up(storage: Storage): Promise<void> {
    if (!(await storage.botStateFile().exists())) {
      return;
    }
    // .. removed old data conversion
  }
}
