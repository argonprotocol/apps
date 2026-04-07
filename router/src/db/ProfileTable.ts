import { BaseTable } from './BaseTable.ts';

export interface IProfileRecord {
  name: string;
}

const DEFAULT_PROFILE: IProfileRecord = {
  name: '',
};

export class ProfileTable extends BaseTable {
  public fetch(): IProfileRecord {
    const record = this.db.sql.prepare(`SELECT name FROM Profile LIMIT 1`).get() as Record<string, unknown> | undefined;
    if (!record) {
      return { ...DEFAULT_PROFILE };
    }

    return {
      name: String(record.name ?? DEFAULT_PROFILE.name),
    };
  }

  public save(payload: Partial<IProfileRecord>): IProfileRecord {
    const currentProfile = this.fetch();
    const nextProfile = {
      ...currentProfile,
      ...payload,
      name: String(payload.name ?? currentProfile.name).trim() || DEFAULT_PROFILE.name,
    };

    this.db.sql.exec(`DELETE FROM Profile`);
    this.db.sql.prepare(`INSERT INTO Profile (name) VALUES ($name)`).run({ $name: nextProfile.name });

    return nextProfile;
  }
}
