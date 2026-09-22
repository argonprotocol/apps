import { IConfigStringified } from '../../interfaces/IConfig';
import { IConfigRecord } from '../../interfaces/db/IConfigRecord';
import { BaseTable } from './BaseTable';
import PluginSql from '@tauri-apps/plugin-sql';

export class ConfigTable extends BaseTable {
  public async fetchAllAsObject(): Promise<Partial<IConfigStringified>> {
    const data: Partial<IConfigStringified> = {};
    const rows = await this.db.select<IConfigRecord[]>('SELECT key, value FROM Config', []);

    for (const row of rows) {
      data[row.key as keyof IConfigStringified] = row.value;
    }

    return data;
  }

  public async insertOrReplace(obj: Partial<IConfigStringified>, overrideSqlInstance?: PluginSql) {
    const entries = Object.entries(obj);
    if (entries.length === 0) return;

    const placeholders = entries.map(() => '(?, ?)').join(', ');
    const values = entries.flatMap(([key, value]) => [key, value]);

    const query = `INSERT INTO Config (key, value) VALUES ${placeholders} ON CONFLICT(key) DO UPDATE SET
        value = excluded.value
      `;
    if (overrideSqlInstance) {
      await overrideSqlInstance.execute(query, values);
    } else {
      await this.db.execute(query, values);
    }
  }
}
