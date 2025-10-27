import { IConfig, IConfigStringified } from '../../interfaces/IConfig';
import { IConfigRecord } from '../../interfaces/db/IConfigRecord';
import { BaseTable } from './BaseTable';
import PluginSql from '@tauri-apps/plugin-sql';

export class ConfigTable extends BaseTable {
  public async fetchAllAsObject(): Promise<Partial<IConfig>> {
    const data: any = {};
    const rows = await this.db.select<IConfigRecord[]>('SELECT key, value FROM Config', []);

    for (const row of rows) {
      data[row.key] = row.value;
    }

    return data as Partial<IConfig>;
  }

  public async insertOrReplace(obj: Partial<IConfigStringified>, overrideSqlInstance?: PluginSql) {
    const sql = overrideSqlInstance ?? this.db.sql;
    const entries = Object.entries(obj);
    if (entries.length === 0) return;

    const placeholders = entries.map(() => '(?, ?)').join(', ');
    const values = entries.flatMap(([key, value]) => [key, value]);

    await sql.execute(
      `INSERT INTO Config (key, value) VALUES ${placeholders} ON CONFLICT(key) DO UPDATE SET 
        value = excluded.value
      `,
      values,
    );
  }
}
