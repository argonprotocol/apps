import { BaseTable, type IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';

export type HdKeyRole = 'bitcoinLock' | 'councilSigner' | 'mintingAuthority';

export interface IWalletHdKeyRecord {
  id: number;
  keyRole: HdKeyRole;
  scopeKey: string;
  hdIndex: number;
  hdPath: string;
  address: string;
  publicKeyHex?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class WalletHdKeysTable extends BaseTable {
  private readonly fieldTypes: IFieldTypes = {
    date: ['createdAt', 'updatedAt'],
  };

  public async upsert(
    record: Pick<IWalletHdKeyRecord, 'keyRole' | 'scopeKey' | 'hdIndex' | 'hdPath' | 'address' | 'publicKeyHex'>,
  ): Promise<IWalletHdKeyRecord> {
    const rows = await this.db.select<IWalletHdKeyRecord[]>(
      `INSERT INTO WalletHdKeys (
        keyRole, scopeKey, hdIndex, hdPath, address, publicKeyHex
      ) VALUES (
        ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT (keyRole, scopeKey, hdIndex) DO UPDATE SET
        hdPath = excluded.hdPath,
        address = excluded.address,
        publicKeyHex = COALESCE(excluded.publicKeyHex, WalletHdKeys.publicKeyHex)
      RETURNING *`,
      toSqlParams([
        record.keyRole,
        record.scopeKey,
        record.hdIndex,
        record.hdPath,
        record.address,
        record.publicKeyHex ?? null,
      ]),
    );

    return this.toRecord(rows[0]);
  }

  public async fetchByAddresses(args: {
    keyRole: HdKeyRole;
    scopeKey: string;
    addresses: string[];
  }): Promise<Map<string, IWalletHdKeyRecord>> {
    const { keyRole, scopeKey, addresses } = args;

    if (addresses.length === 0) {
      return new Map();
    }

    const placeholders = addresses.map(() => '?').join(', ');
    const rows = await this.db.select<IWalletHdKeyRecord[]>(
      `SELECT * FROM WalletHdKeys
       WHERE keyRole = ?
         AND scopeKey = ?
         AND lower(address) IN (${placeholders})
       ORDER BY hdIndex ASC`,
      toSqlParams([keyRole, scopeKey, ...addresses.map(address => address.toLowerCase())]),
    );

    return new Map(
      rows.map(row => {
        const record = this.toRecord(row);
        return [record.address.toLowerCase(), record] as const;
      }),
    );
  }

  public async fetchByScope(args: { keyRole: HdKeyRole; scopeKey: string }): Promise<IWalletHdKeyRecord[]> {
    const { keyRole, scopeKey } = args;
    const rows = await this.db.select<IWalletHdKeyRecord[]>(
      `SELECT * FROM WalletHdKeys
       WHERE keyRole = ? AND scopeKey = ?
       ORDER BY hdIndex ASC`,
      toSqlParams([keyRole, scopeKey]),
    );

    return rows.map(row => this.toRecord(row));
  }

  public async getNextHdKeyIndex(args: { keyRole: HdKeyRole; scopeKey: string }): Promise<number> {
    const { keyRole, scopeKey } = args;
    const [row] = await this.db.select<{ nextHdIndex: number }[]>(
      `SELECT COALESCE(MAX(hdIndex) + 1, 0) as nextHdIndex
       FROM WalletHdKeys
       WHERE keyRole = ? AND scopeKey = ?`,
      toSqlParams([keyRole, scopeKey]),
    );

    return row?.nextHdIndex ?? 0;
  }

  public async delete(args: { keyRole: HdKeyRole; scopeKey: string; hdIndex: number }): Promise<void> {
    const { keyRole, scopeKey, hdIndex } = args;
    await this.db.execute(
      `DELETE FROM WalletHdKeys
       WHERE keyRole = ? AND scopeKey = ? AND hdIndex = ?`,
      toSqlParams([keyRole, scopeKey, hdIndex]),
    );
  }

  public async deleteByKeyRole(keyRole: HdKeyRole | HdKeyRole[]): Promise<void> {
    const keyRoles = Array.isArray(keyRole) ? keyRole : [keyRole];
    if (keyRoles.length === 0) {
      return;
    }

    if (keyRoles.length === 1) {
      await this.db.execute(`DELETE FROM WalletHdKeys WHERE keyRole = ?`, toSqlParams(keyRoles));
      return;
    }

    const placeholders = keyRoles.map(() => '?').join(', ');
    await this.db.execute(`DELETE FROM WalletHdKeys WHERE keyRole IN (${placeholders})`, toSqlParams(keyRoles));
  }

  private toRecord(record: IWalletHdKeyRecord): IWalletHdKeyRecord {
    return convertFromSqliteFields<IWalletHdKeyRecord>(record, this.fieldTypes);
  }
}
