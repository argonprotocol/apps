import { BaseTable, IFieldTypes } from './BaseTable';
import { convertFromSqliteFields, toSqlParams } from '../Utils';
import { LRU } from 'tiny-lru';

export interface IWalletTransferRecord {
  id: number;
  walletAddress: string;
  walletName: string;
  amount: bigint;
  currency: 'argon' | 'argonot';
  otherParty?: string;
  tokenGatewayCommitmentHash?: string;
  transferType: 'transfer' | 'faucet' | 'tokenGateway' | 'ethereum';
  isInternal: boolean;
  extrinsicIndex: number;
  microgonsForArgonot: bigint;
  microgonsForUsd: bigint;
  blockNumber: number;
  blockHash: string;
  blockTime?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
type IWalletTransferRecordKey = keyof IWalletTransferRecord & string;
export class WalletTransfersTable extends BaseTable {
  public revision = 0;
  public argonotCustodyRevision = 0;
  private argonotCustodyCache = new LRU<{
    revision: number;
    promise: Promise<IWalletTransferRecord[]>;
  }>(10);
  private bigIntFields: IWalletTransferRecordKey[] = ['amount', 'microgonsForArgonot', 'microgonsForUsd'];
  private dateFields: IWalletTransferRecordKey[] = ['blockTime', 'createdAt', 'updatedAt'];
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

  public async fetchByWalletAddress(address: string): Promise<IWalletTransferRecord[]> {
    const records = await this.db.select<any[]>(
      'SELECT * FROM WalletTransfers WHERE walletAddress = ? ORDER BY blockNumber DESC, id DESC',
      toSqlParams([address]),
    );
    return convertFromSqliteFields(records, this.fields);
  }

  public async fetchArgonotCustody(addresses: readonly string[]): Promise<IWalletTransferRecord[]> {
    if (!addresses.length) return [];

    const scope = [...new Set(addresses)].sort();
    return this.loadArgonotCustody(`wallets:${scope.join(',')}`, async () => {
      const placeholders = scope.map(() => '?').join(', ');
      const records = await this.db.select<any[]>(
        `SELECT * FROM WalletTransfers
         WHERE currency = 'argonot' AND walletAddress IN (${placeholders})
         ORDER BY blockNumber ASC, extrinsicIndex ASC, id ASC`,
        toSqlParams(scope),
      );
      return convertFromSqliteFields(records, this.fields);
    });
  }

  public async fetchArgonotCustodyBoundaries(address: string): Promise<IWalletTransferRecord[]> {
    return this.loadArgonotCustody(`boundaries:${address}`, async () => {
      const records = await this.db.select<any[]>(
        `SELECT * FROM WalletTransfers
         WHERE currency = 'argonot' AND (walletAddress = ? OR otherParty = ?)
         ORDER BY blockNumber ASC, extrinsicIndex ASC, id ASC`,
        toSqlParams([address, address]),
      );
      return convertFromSqliteFields(records, this.fields);
    });
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
      tokenGatewayCommitmentHash,
      transferType,
      microgonsForArgonot,
      microgonsForUsd,
      blockNumber,
      blockHash,
      blockTime,
    } = args;
    const records = await this.db.select<IWalletTransferRecord[]>(
      `INSERT INTO WalletTransfers (walletAddress, walletName, amount, currency, extrinsicIndex, isInternal,
                                    microgonsForArgonot, microgonsForUsd, otherParty, tokenGatewayCommitmentHash,
                                    transferType, blockNumber, blockHash, blockTime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET
           isInternal = excluded.isInternal,
           transferType = excluded.transferType,
           microgonsForArgonot = excluded.microgonsForArgonot,
           microgonsForUsd = excluded.microgonsForUsd,
           blockTime = excluded.blockTime,
           tokenGatewayCommitmentHash = excluded.tokenGatewayCommitmentHash
         WHERE WalletTransfers.isInternal IS NOT excluded.isInternal
            OR WalletTransfers.transferType IS NOT excluded.transferType
            OR WalletTransfers.microgonsForArgonot IS NOT excluded.microgonsForArgonot
            OR WalletTransfers.microgonsForUsd IS NOT excluded.microgonsForUsd
            OR WalletTransfers.blockTime IS NOT excluded.blockTime
            OR WalletTransfers.tokenGatewayCommitmentHash IS NOT excluded.tokenGatewayCommitmentHash
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
        tokenGatewayCommitmentHash,
        transferType,
        blockNumber,
        blockHash,
        blockTime,
      ]),
    );
    const record = convertFromSqliteFields<IWalletTransferRecord[]>(records, this.fields)[0];
    if (record) {
      this.revision += 1;
      if (record.currency === 'argonot') this.argonotCustodyRevision += 1;
    }
    return record;
  }

  private loadArgonotCustody(
    key: string,
    load: () => Promise<IWalletTransferRecord[]>,
  ): Promise<IWalletTransferRecord[]> {
    const cached = this.argonotCustodyCache.get(key);
    if (cached?.revision === this.argonotCustodyRevision) return cached.promise;

    const promise = load();
    this.argonotCustodyCache.set(key, { revision: this.argonotCustodyRevision, promise });
    void promise.catch(() => {
      if (this.argonotCustodyCache.get(key)?.promise === promise) this.argonotCustodyCache.delete(key);
    });
    return promise;
  }
}
