import type { DatabaseSync } from 'node:sqlite';

export class BaseTable {
  constructor(protected db: { sql: DatabaseSync }) {}
}
