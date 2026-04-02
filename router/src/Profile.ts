import { db } from './Database.ts';

export interface IProfileRecord {
  name: string;
}

const DEFAULT_PROFILE: IProfileRecord = {
  name: '',
};

const fetchProfileStmt = db.prepare(`
  SELECT
    name
  FROM Profile
  LIMIT 1
`);

const clearProfileStmt = db.prepare(`
  DELETE FROM Profile
`);

const insertProfileStmt = db.prepare(`
  INSERT INTO Profile (
    name
  )
  VALUES (
    $name
  )
`);

export class Profile {
  public static fetch(): IProfileRecord {
    const record = fetchProfileStmt.get() as Record<string, unknown> | undefined;
    if (!record) {
      return { ...DEFAULT_PROFILE };
    }

    return {
      name: String(record.name ?? DEFAULT_PROFILE.name),
    };
  }

  public static save(payload: Partial<IProfileRecord>): IProfileRecord {
    const currentProfile = this.fetch();
    const nextProfile: IProfileRecord = {
      ...currentProfile,
      ...payload,
      name: String(payload.name ?? currentProfile.name).trim() || DEFAULT_PROFILE.name,
    };

    clearProfileStmt.run();
    insertProfileStmt.run({
      $name: nextProfile.name,
    });

    return nextProfile;
  }
}
