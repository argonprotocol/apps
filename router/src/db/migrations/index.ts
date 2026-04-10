import type { ISqliteMigration } from '@argonprotocol/apps-core';
import { InitialMigration } from './001-initial.ts';

export const migrations = [InitialMigration] satisfies ISqliteMigration[];
