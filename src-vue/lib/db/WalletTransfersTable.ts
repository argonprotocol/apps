import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';

export interface IWalletTransferRecord {
  id: number;
  walletAddress: string;
  walletName: string;
  amount: bigint;
  currency: 'argon' | 'argonot';
  otherParty?: string;
  transferType: 'transfer' | 'faucet' | 'tokenGateway';
  isInternal: boolean;
  extrinsicIndex: number;
  blockNumber: number;
  blockHash: string;
  createdAt: Date;
  updatedAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
type IWalletTransferRecordKey = keyof IWalletTransferRecord & string;
export class WalletTransfersTable extends BaseTable {
  private bigIntFields: IWalletTransferRecordKey[] = ['amount'];
  private dateFields: IWalletTransferRecordKey[] = ['createdAt', 'updatedAt'];
  private jsonFields: IWalletTransferRecordKey[] = [];
  private booleanFields: IWalletTransferRecordKey[] = ['isInternal'];

  private get fields(): IFieldTypes {
    return {
      bigint: this.bigIntFields,
      date: this.dateFields,
      json: this.jsonFields,
      boolean: this.booleanFields,
    };
  }

  public async fetchAll(): Promise<IWalletTransferRecord[]> {
    const records = await this.db.select<any[]>('SELECT * FROM WalletTransfers ORDER BY id DESC');
    return convertFromSqliteFields(records, this.fields);
  }

  public async fetchSum(walletAddress: string, fromExternal: boolean = true): Promise<bigint> {
    const rows = await this.db.select<{ amount: bigint }[]>(
      `SELECT COALESCE(sum(amount), 0) as amount from WalletTransfers WHERE walletAddress = ? 
                 AND isInternal = ?`,
      toSqlParams([walletAddress, !fromExternal]),
    );
    return rows[0]?.amount || 0n;
  }

  public async insert(
    args: Omit<IWalletTransferRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IWalletTransferRecord> {
    const {
      walletAddress,
      walletName,
      amount,
      currency,
      extrinsicIndex,
      isInternal,
      otherParty,
      transferType,
      blockNumber,
      blockHash,
    } = args;
    const records = await this.db.select<IWalletTransferRecord[]>(
      `INSERT INTO WalletTransfers (walletAddress, walletName, amount, currency, extrinsicIndex, isInternal, otherParty, transferType, blockNumber, blockHash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *;`,
      toSqlParams([
        walletAddress,
        walletName,
        amount,
        currency,
        extrinsicIndex,
        isInternal,
        otherParty,
        transferType,
        blockNumber,
        blockHash,
      ]),
    );
    return convertFromSqliteFields<IWalletTransferRecord[]>(records, this.fields)[0];
  }

  public async deleteBlock(blockHash: string): Promise<void> {
    await this.db.execute(`DELETE FROM WalletTransfers WHERE blockHash = ?`, toSqlParams([blockHash]));
  }
}
