import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { AccountEventsFilter } from '@argonprotocol/apps-core';

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
  tokenGatewayCommitmentHash?: string;
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

  public async loadState(): Promise<void> {
    const allRecords = await this.fetchAll();
    const client = await getMainchainClient(true);
    for (const record of allRecords) {
      if (record.transferType === 'tokenGateway' && !record.tokenGatewayCommitmentHash) {
        console.log('Fetching token gateway commitment hash for transfer record', record.id);
        const blockEvents = await client.query.system.events.at(record.blockHash);
        const eventsFilter = new AccountEventsFilter(record.walletAddress, record.walletName as any, []);
        eventsFilter.process(client, blockEvents);
        const tokenEvent = eventsFilter.transfers.find(
          e =>
            e.extrinsicIndex === record.extrinsicIndex && e.amount === record.amount && e.currency === record.currency,
        );
        if (tokenEvent && tokenEvent.tokenGatewayCommitmentHash) {
          record.tokenGatewayCommitmentHash = tokenEvent.tokenGatewayCommitmentHash;
          await this.db.execute(
            `UPDATE WalletTransfers SET tokenGatewayCommitmentHash = ? WHERE id = ?`,
            toSqlParams([tokenEvent.tokenGatewayCommitmentHash, record.id]),
          );
        }
      }
    }
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
      tokenGatewayCommitmentHash,
    } = args;
    const records = await this.db.select<IWalletTransferRecord[]>(
      `INSERT INTO WalletTransfers (walletAddress, walletName, amount, currency, extrinsicIndex, isInternal,
                                    microgonsForArgonot, microgonsForUsd, otherParty, transferType, tokenGatewayCommitmentHash, blockNumber, blockHash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        tokenGatewayCommitmentHash,
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
