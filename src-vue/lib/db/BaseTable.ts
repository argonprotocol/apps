import type { Db } from '../Db';

export class BaseTable {
  protected db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  protected getState<State>(initialize: () => State): State {
    return this.db.getTableState(this.constructor, initialize);
  }

  public async loadState(): Promise<void> {
    // Base load method can be overridden by subclasses
  }
}

export interface IFieldTypes {
  boolean?: string[];
  bigint?: string[];
  bigintJson?: string[];
  json?: string[];
  date?: string[];
  uint8array?: string[];
}
