import type { ISqliteMigration } from '@argonprotocol/apps-core';
import { InitialMiningMigration } from './001-initial.ts';

export const miningMigrations = [InitialMiningMigration] satisfies ISqliteMigration[];
