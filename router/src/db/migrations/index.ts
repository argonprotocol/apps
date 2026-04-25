import type { ISqliteMigration } from '@argonprotocol/apps-core';
import { InitialMigration } from './001-initial.ts';
import { SessionsMigration } from './002-sessions.ts';

export const migrations = [InitialMigration, SessionsMigration] satisfies ISqliteMigration[];
