import type { IEventInfo, IExtrinsicEvent } from '@argonprotocol/apps-core';
import type { Db } from './Db.ts';
import type { ITransactionRecord } from './db/TransactionsTable.ts';
import type { IWalletLedgerRecord } from './db/WalletLedgerTable.ts';
import type { IWalletTransferRecord } from './db/WalletTransfersTable.ts';

export type WalletActivityType =
  | 'transfer'
  | 'ethereum'
  | 'tokenGateway'
  | 'faucet'
  | 'vaultRevenue'
  | 'fee'
  | 'balanceChange'
  | 'submittedTransaction'
  | 'unknown';

export type WalletActivitySource = 'walletTransfer' | 'walletLedger' | 'submittedTransaction';

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
  microgonChange?: bigint;
  micronotChange?: bigint;
  amount?: bigint;
  currency?: IWalletTransferRecord['currency'];
  otherParty?: string;
  events: IEventInfo[];
  ledger?: IWalletLedgerRecord;
  transfer?: IWalletTransferRecord;
  transaction?: ITransactionRecord;
}

export class WalletActivity {
  constructor(private readonly db: Db) {}

  public async fetchByWalletAddress(walletAddress: string): Promise<IWalletActivityRecord[]> {
    const [ledgerRecords, transfers, transactions] = await Promise.all([
      this.db.walletLedgerTable.fetchByWalletAddress(walletAddress),
      this.db.walletTransfersTable.fetchByWalletAddress(walletAddress),
      this.db.transactionsTable.fetchByAccountAddress(walletAddress),
    ]);

    return buildWalletActivity({ ledgerRecords, transfers, transactions });
  }
}

export function buildWalletActivity(args: {
  ledgerRecords: IWalletLedgerRecord[];
  transfers: IWalletTransferRecord[];
  transactions?: ITransactionRecord[];
}): IWalletActivityRecord[] {
  const transactions = args.transactions ?? [];
  const transfersByBlockExtrinsic = groupBy(args.transfers, transferKey);
  const transactionsByBlockExtrinsic = groupBy(
    transactions.filter(transaction => transaction.blockHash && transaction.blockExtrinsicIndex !== undefined),
    transactionKey,
  );
  const consumedTransferIds = new Set<number>();
  const consumedTransactionIds = new Set<number>();
  const activities: IWalletActivityRecord[] = [];

  for (const ledger of args.ledgerRecords) {
    const eventGroups: IExtrinsicEvent[] = ledger.extrinsicEventsJson.length ? ledger.extrinsicEventsJson : [[null]];
    const isSharedLedgerDelta = eventGroups.length > 1;

    for (const eventGroup of eventGroups) {
      const [extrinsicIndex, ...events] = eventGroup;
      const key = blockExtrinsicKey(ledger.blockHash, extrinsicIndex);
      const matchingTransfers = transfersByBlockExtrinsic.get(key) ?? [];
      const matchingTransaction = transactionsByBlockExtrinsic.get(key)?.[0];

      if (matchingTransaction) {
        consumedTransactionIds.add(matchingTransaction.id);
      }

      if (matchingTransfers.length) {
        for (const transfer of matchingTransfers) {
          consumedTransferIds.add(transfer.id);
          activities.push({
            id: `transfer:${transfer.id}`,
            source: 'walletTransfer',
            activityType: transfer.transferType === 'transfer' ? 'transfer' : transfer.transferType,
            walletAddress: transfer.walletAddress,
            walletName: transfer.walletName,
            blockNumber: transfer.blockNumber,
            blockHash: transfer.blockHash,
            extrinsicIndex: transfer.extrinsicIndex,
            isFinalized: ledger.isFinalized,
            amount: transfer.amount,
            currency: transfer.currency,
            otherParty: transfer.otherParty,
            events,
            ledger,
            transfer,
            transaction: matchingTransaction,
          });
        }
        continue;
      }

      activities.push({
        id: `ledger:${ledger.id}:${extrinsicIndex ?? 'none'}`,
        source: 'walletLedger',
        activityType: classifyEvents(events),
        walletAddress: ledger.walletAddress,
        walletName: ledger.walletName,
        blockNumber: ledger.blockNumber,
        blockHash: ledger.blockHash,
        extrinsicIndex,
        isFinalized: ledger.isFinalized,
        microgonChange: isSharedLedgerDelta ? undefined : ledger.microgonChange,
        micronotChange: isSharedLedgerDelta ? undefined : ledger.micronotChange,
        events,
        ledger,
        transaction: matchingTransaction,
      });
    }
  }

  for (const transfer of args.transfers) {
    if (consumedTransferIds.has(transfer.id)) continue;
    const matchingTransaction = transactionsByBlockExtrinsic.get(transferKey(transfer))?.[0];
    if (matchingTransaction) {
      consumedTransactionIds.add(matchingTransaction.id);
    }
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
      events: [],
      transfer,
      transaction: matchingTransaction,
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
      events: [],
      transaction,
    });
  }

  return activities.sort(compareActivityRecords);
}

function classifyEvents(events: IEventInfo[]): WalletActivityType {
  if (events.length === 0) {
    return 'balanceChange';
  }
  if (hasEvent(events, 'tokenGateway')) {
    return 'tokenGateway';
  }
  if (hasEvent(events, 'crosschainTransfer', 'BurnNoticeAccepted')) {
    return 'ethereum';
  }
  if (hasEvent(events, 'vaults', 'VaultCollected') || hasEvent(events, 'treasury')) {
    return 'vaultRevenue';
  }
  if (hasEvent(events, 'transactionPayment', 'TransactionFeePaid')) {
    return 'fee';
  }
  if (events.some(event => ['balances', 'ownership'].includes(event.pallet))) {
    return 'balanceChange';
  }
  return 'unknown';
}

function hasEvent(events: IEventInfo[], pallet: string, method?: string): boolean {
  return events.some(event => event.pallet === pallet && (!method || event.method === method));
}

function groupBy<T>(records: T[], getKey: (record: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const key = getKey(record);
    const group = groups.get(key);
    if (group) {
      group.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  return groups;
}

function transferKey(transfer: IWalletTransferRecord): string {
  return blockExtrinsicKey(transfer.blockHash, transfer.extrinsicIndex);
}

function transactionKey(transaction: ITransactionRecord): string {
  return blockExtrinsicKey(transaction.blockHash!, transaction.blockExtrinsicIndex!);
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
