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
  microgonsForArgonot: bigint;
  microgonsForUsd: bigint;
  blockNumber: number;
  blockHash: string;
  createdAt: Date;
  updatedAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
type IWalletTransferRecordKey = keyof IWalletTransferRecord & string;
export class WalletTransfersTable extends BaseTable {
  private bigIntFields: IWalletTransferRecordKey[] = ['amount', 'microgonsForArgonot', 'microgonsForUsd'];
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

  public async firstTransferBlockNumber(address: string): Promise<number | null> {
    const rows = await this.db.select<{ blockNumber: number }[]>(
      `SELECT blockNumber FROM WalletTransfers WHERE walletAddress = ? ORDER BY blockNumber ASC LIMIT 1`,
      [address],
    );
    if (rows.length === 0) {
      return null;
    }
    return rows[0].blockNumber;
  }

  public async fetchExternal(walletAddress: string): Promise<IWalletTransferRecord[]> {
    const rows = await this.db.select<IWalletTransferRecord[]>(
      `SELECT * from WalletTransfers WHERE walletAddress = ? 
                 AND isInternal = ?`,
      toSqlParams([walletAddress, false]),
    );
    return convertFromSqliteFields<IWalletTransferRecord[]>(rows, this.fields);
  }

  public async insert(
    args: Omit<IWalletTransferRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IWalletTransferRecord | undefined> {
    const {
      walletAddress,
      walletName,
      amount,
      currency,
      extrinsicIndex,
      isInternal,
      otherParty,
      transferType,
      microgonsForArgonot,
      microgonsForUsd,
      blockNumber,
      blockHash,
    } = args;
    const records = await this.db.select<IWalletTransferRecord[]>(
      `INSERT INTO WalletTransfers (walletAddress, walletName, amount, currency, extrinsicIndex, isInternal,
                                    microgonsForArgonot, microgonsForUsd, otherParty, transferType, blockNumber, blockHash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(walletAddress, otherParty, extrinsicIndex, amount, currency, blockHash) DO NOTHING
         RETURNING *`,
      toSqlParams([
        walletAddress,
        walletName,
        amount,
        currency,
        extrinsicIndex,
        isInternal,
        microgonsForArgonot,
        microgonsForUsd,
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
