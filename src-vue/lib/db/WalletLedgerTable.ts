import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';
import { IExtrinsicEvent, IInboundTransfer } from '@argonprotocol/apps-core';

export interface IWalletLedgerRecord {
  id: number;
  walletAddress: string;
  walletName: string;
  availableMicrogons: bigint;
  availableMicronots: bigint;
  reservedMicrogons: bigint;
  reservedMicronots: bigint;
  microgonChange: bigint;
  micronotChange: bigint;
  microgonsForUsd: bigint;
  microgonsForArgonot: bigint;
  inboundTransfersJson: IInboundTransfer[];
  extrinsicEventsJson: IExtrinsicEvent[];
  blockNumber: number;
  blockHash: string;
  isFinalized: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
type IWalletLedgerRecordKey = keyof IWalletLedgerRecord & string;
export class WalletLedgerTable extends BaseTable {
  private bigIntFields: IWalletLedgerRecordKey[] = [
    'availableMicrogons',
    'availableMicronots',
    'reservedMicrogons',
    'reservedMicronots',
    'microgonChange',
    'micronotChange',
    'microgonsForUsd',
    'microgonsForArgonot',
  ];
  private dateFields: IWalletLedgerRecordKey[] = ['createdAt', 'updatedAt'];
  private jsonFields: IWalletLedgerRecordKey[] = ['extrinsicEventsJson', 'inboundTransfersJson'];
  private booleanFields: IWalletLedgerRecordKey[] = ['isFinalized'];

  private get fields(): IFieldTypes {
    return {
      bigint: this.bigIntFields,
      date: this.dateFields,
      json: this.jsonFields,
      boolean: this.booleanFields,
    };
  }

  public async fetchAll(): Promise<IWalletLedgerRecord[]> {
    const records = await this.db.select<any[]>('SELECT * FROM WalletLedger ORDER BY id DESC');
    return convertFromSqliteFields(records, this.fields);
  }

  public async insert(args: Omit<IWalletLedgerRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<IWalletLedgerRecord> {
    const {
      walletAddress,
      walletName,
      availableMicrogons,
      availableMicronots,
      reservedMicrogons,
      reservedMicronots,
      microgonChange,
      micronotChange,
      microgonsForUsd,
      microgonsForArgonot,
      inboundTransfersJson,
      extrinsicEventsJson,
      blockNumber,
      blockHash,
      isFinalized,
    } = args;
    const records = await this.db.select<IWalletLedgerRecord[]>(
      `INSERT INTO WalletLedger (
        walletAddress, walletName, availableMicrogons, availableMicronots, reservedMicrogons,
        reservedMicronots,microgonChange, micronotChange, microgonsForUsd, microgonsForArgonot,
        inboundTransfersJson, extrinsicEventsJson, blockNumber, blockHash, isFinalized) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      toSqlParams([
        walletAddress,
        walletName,
        availableMicrogons,
        availableMicronots,
        reservedMicrogons,
        reservedMicronots,
        microgonChange,
        micronotChange,
        microgonsForUsd,
        microgonsForArgonot,
        inboundTransfersJson,
        extrinsicEventsJson,
        blockNumber,
        blockHash,
        isFinalized,
      ]),
    );
    return convertFromSqliteFields<IWalletLedgerRecord[]>(records, this.fields)[0];
  }

  public async markFinalizedUpToBlock(blockNumber: number): Promise<void> {
    await this.db.execute(`UPDATE WalletLedger SET isFinalized = 1 WHERE blockNumber <= ?`, toSqlParams([blockNumber]));
  }

  public async deleteBlock(blockHash: string): Promise<void> {
    console.log('deleting block from wallet ledger', blockHash);
    await this.db.execute(`DELETE FROM WalletLedger WHERE blockHash = ?`, toSqlParams([blockHash]));
  }
}
