import { Db } from '../Db';

export class BaseTable {
  protected db: Db;

  constructor(db: Db) {
    this.db = db;
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
