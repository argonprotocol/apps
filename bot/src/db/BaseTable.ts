import type { Db } from '../Db.ts';

export class BaseTable {
  constructor(protected db: Db) {}
}
