import type { Db } from './Db.ts';
import type { ITransactionRecord } from './db/TransactionsTable.ts';
import type { IWalletTransferRecord } from './db/WalletTransfersTable.ts';

export type WalletActivityType = 'transfer' | 'ethereum' | 'tokenGateway' | 'faucet' | 'submittedTransaction';

export type WalletActivitySource = 'walletTransfer' | 'submittedTransaction';

export interface IWalletActivityRecord {
  id: string;
  source: WalletActivitySource;
  activityType: WalletActivityType;
  walletAddress: string;
  walletName?: string;
  blockNumber?: number;
  blockHash?: string;
  extrinsicIndex: number | null;
  isFinalized: boolean;
  amount?: bigint;
  currency?: IWalletTransferRecord['currency'];
  otherParty?: string;
  transfer?: IWalletTransferRecord;
  transaction?: ITransactionRecord;
  occurredAt?: Date;
}

export class WalletActivity {
  constructor(private readonly db: Db) {}

  public async fetchByWalletAddress(walletAddress: string): Promise<IWalletActivityRecord[]> {
    const [transfers, transactions] = await Promise.all([
      this.db.walletTransfersTable.fetchByWalletAddress(walletAddress),
      this.db.transactionsTable.fetchByAccountAddress(walletAddress),
    ]);

    return buildWalletActivity({ transfers, transactions });
  }
}

export function buildWalletActivity(args: {
  transfers: IWalletTransferRecord[];
  transactions?: ITransactionRecord[];
}): IWalletActivityRecord[] {
  const transactions = args.transactions ?? [];
  const transactionsByBlockExtrinsic = new Map<string, ITransactionRecord>();
  for (const transaction of transactions) {
    if (!transaction.blockHash || transaction.blockExtrinsicIndex === undefined) continue;

    const key = blockExtrinsicKey(transaction.blockHash, transaction.blockExtrinsicIndex);
    if (!transactionsByBlockExtrinsic.has(key)) transactionsByBlockExtrinsic.set(key, transaction);
  }

  const consumedTransactionIds = new Set<number>();
  const activities: IWalletActivityRecord[] = [];

  for (const transfer of args.transfers) {
    const matchingTransaction = transactionsByBlockExtrinsic.get(
      blockExtrinsicKey(transfer.blockHash, transfer.extrinsicIndex),
    );
    if (matchingTransaction) consumedTransactionIds.add(matchingTransaction.id);

    activities.push({
      id: `transfer:${transfer.id}`,
      source: 'walletTransfer',
      activityType: transfer.transferType === 'transfer' ? 'transfer' : transfer.transferType,
      walletAddress: transfer.walletAddress,
      walletName: transfer.walletName,
      blockNumber: transfer.blockNumber,
      blockHash: transfer.blockHash,
      extrinsicIndex: transfer.extrinsicIndex,
      isFinalized: true,
      amount: transfer.amount,
      currency: transfer.currency,
      otherParty: transfer.otherParty,
      transfer,
      transaction: matchingTransaction,
      occurredAt: transfer.blockTime ?? transfer.createdAt,
    });
  }

  for (const transaction of transactions) {
    if (consumedTransactionIds.has(transaction.id)) continue;

    activities.push({
      id: `transaction:${transaction.id}`,
      source: 'submittedTransaction',
      activityType: 'submittedTransaction',
      walletAddress: transaction.accountAddress,
      blockNumber: transaction.blockHeight ?? transaction.submittedAtBlockHeight,
      blockHash: transaction.blockHash,
      extrinsicIndex: transaction.blockExtrinsicIndex ?? null,
      isFinalized: transaction.isFinalized,
      transaction,
      occurredAt: transaction.blockTime ?? transaction.submittedAtTime,
    });
  }

  return activities.sort(compareActivityRecords);
}

function blockExtrinsicKey(blockHash: string, extrinsicIndex: number | null): string {
  return `${blockHash}:${extrinsicIndex ?? 'none'}`;
}

function compareActivityRecords(a: IWalletActivityRecord, b: IWalletActivityRecord): number {
  const blockDiff = (b.blockNumber ?? 0) - (a.blockNumber ?? 0);
  if (blockDiff) return blockDiff;

  const extrinsicDiff = (b.extrinsicIndex ?? -1) - (a.extrinsicIndex ?? -1);
  if (extrinsicDiff) return extrinsicDiff;

  return b.id.localeCompare(a.id);
}
