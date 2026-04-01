import { Db } from '../../lib/Db';

let dbPromise: Promise<Db> | undefined;

export function getDbPromise() {
  if (!dbPromise) {
    dbPromise = Db.load();
  }
  return dbPromise;
}

export function setDbPromise(newDbPromise: Promise<Db> | undefined) {
  dbPromise = newDbPromise;
}
