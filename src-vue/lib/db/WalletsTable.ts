import { BaseTable, type IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';

export type IWalletRecordType = 'argon' | 'ethereum';
export type IWalletRecordRole = 'defaultArgon' | 'defaultEthereum' | 'externalEthereum';
export type IWalletSecretKind = 'coreMnemonic' | 'privateKey' | 'mnemonic';

export interface IWalletRecord {
  id: number;
  walletType: IWalletRecordType;
  role: IWalletRecordRole;
  name: string;
  address: string;
  sortOrder: number;
  keyReference?: string | null;
  derivationPath?: string | null;
  secretKind?: IWalletSecretKind | null;
  encryptedSecret?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IWalletRecordInsert = Pick<IWalletRecord, 'walletType' | 'role' | 'name' | 'address'> &
  Partial<Pick<IWalletRecord, 'sortOrder' | 'keyReference' | 'derivationPath' | 'secretKind' | 'encryptedSecret'>>;

export class WalletsTable extends BaseTable {
  private readonly fieldTypes: IFieldTypes = {
    date: ['createdAt', 'updatedAt'],
  };

  public async fetchAll(): Promise<IWalletRecord[]> {
    const rows = await this.db.select<IWalletRecord[]>('SELECT * FROM Wallets ORDER BY sortOrder ASC, id ASC');
    return rows.map(row => this.toRecord(row));
  }

  public async fetchEthereumWallets(): Promise<IWalletRecord[]> {
    const rows = await this.db.select<IWalletRecord[]>(
      `SELECT * FROM Wallets WHERE walletType = 'ethereum' ORDER BY sortOrder ASC, id ASC`,
    );
    return rows.map(row => this.toRecord(row));
  }

  public async count(): Promise<number> {
    const [row] = await this.db.select<{ count: number }[]>('SELECT COUNT(*) as count FROM Wallets');
    return row?.count ?? 0;
  }

  public async getDefaultArgon(): Promise<IWalletRecord | undefined> {
    const rows = await this.db.select<IWalletRecord[]>(
      `SELECT * FROM Wallets WHERE role = 'defaultArgon' ORDER BY id ASC LIMIT 1`,
    );
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  public async getDefaultEthereum(): Promise<IWalletRecord | undefined> {
    const rows = await this.db.select<IWalletRecord[]>(
      `SELECT * FROM Wallets WHERE role = 'defaultEthereum' ORDER BY id ASC LIMIT 1`,
    );
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  public async upsertDefaultArgon(args: {
    name?: string;
    address: string;
    keyReference: string;
    sortOrder?: number;
  }): Promise<IWalletRecord> {
    const rows = await this.db.select<IWalletRecord[]>(
      `INSERT INTO Wallets (
        walletType, role, name, address, sortOrder, keyReference
      ) VALUES (
        'argon', 'defaultArgon', ?, ?, ?, ?
      )
      ON CONFLICT(walletType) WHERE walletType = 'argon' DO UPDATE SET
        name = excluded.name,
        address = excluded.address,
        sortOrder = excluded.sortOrder,
        keyReference = excluded.keyReference
      RETURNING *`,
      toSqlParams([args.name ?? 'Argon Wallet', args.address, args.sortOrder ?? 0, args.keyReference]),
    );
    return this.toRecord(rows[0]);
  }

  public async createDefaultEthereum(args: {
    address: string;
    derivationPath: string;
    sortOrder?: number;
  }): Promise<IWalletRecord> {
    const rows = await this.db.select<IWalletRecord[]>(
      `INSERT INTO Wallets (
        walletType, role, name, address, sortOrder, derivationPath, secretKind
      ) VALUES (
        'ethereum', 'defaultEthereum', 'Default Ethereum', ?, ?, ?, 'coreMnemonic'
      )
      ON CONFLICT(role) WHERE role = 'defaultEthereum' DO UPDATE SET
        address = excluded.address,
        derivationPath = excluded.derivationPath,
        secretKind = excluded.secretKind
      RETURNING *`,
      toSqlParams([args.address.toLowerCase(), args.sortOrder ?? 1, args.derivationPath]),
    );
    return this.toRecord(rows[0]);
  }

  public async importExternalEthereum(args: {
    name?: string;
    address: string;
    derivationPath?: string;
    secretKind: Extract<IWalletSecretKind, 'privateKey' | 'mnemonic'>;
    encryptedSecret: string;
    sortOrder?: number;
  }): Promise<IWalletRecord> {
    const rows = await this.db.select<IWalletRecord[]>(
      `INSERT INTO Wallets (
        walletType, role, name, address, sortOrder, derivationPath, secretKind, encryptedSecret
      ) VALUES (
        'ethereum', 'externalEthereum', ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(address) DO UPDATE SET
        name = excluded.name,
        sortOrder = excluded.sortOrder,
        derivationPath = excluded.derivationPath,
        secretKind = excluded.secretKind,
        encryptedSecret = excluded.encryptedSecret
      RETURNING *`,
      toSqlParams([
        args.name ?? 'External Ethereum',
        args.address.toLowerCase(),
        args.sortOrder ?? 10,
        args.derivationPath,
        args.secretKind,
        args.encryptedSecret,
      ]),
    );
    return this.toRecord(rows[0]);
  }

  public async updateSortOrder(records: Pick<IWalletRecord, 'id' | 'sortOrder'>[]): Promise<void> {
    for (const record of records) {
      await this.db.execute(
        `UPDATE Wallets SET sortOrder = ? WHERE id = ?`,
        toSqlParams([record.sortOrder, record.id]),
      );
    }
  }

  private toRecord(record: IWalletRecord): IWalletRecord {
    return convertFromSqliteFields<IWalletRecord>(record, this.fieldTypes);
  }
}
