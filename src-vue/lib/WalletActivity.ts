import { ExtrinsicType, type ITransactionRecord } from './db/TransactionsTable.ts';
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
  otherPartyName?: string;
  transfer?: IWalletTransferRecord;
  transaction?: ITransactionRecord;
  occurredAt?: Date;
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
  const consumedTransferIds = new Set<number>();
  const activities: IWalletActivityRecord[] = [];
  const internalTransfersByIdentity = new Map<string, IWalletTransferRecord>();
  for (const transfer of args.transfers) {
    if (transfer.isInternal && transfer.otherParty) {
      internalTransfersByIdentity.set(internalTransferKey(transfer), transfer);
    }
  }

  for (const transfer of args.transfers) {
    if (consumedTransferIds.has(transfer.id)) continue;

    let activityTransfer = transfer;
    let otherPartyName: string | undefined;
    if (transfer.isInternal && transfer.otherParty) {
      const counterpart = internalTransfersByIdentity.get(
        internalTransferKey({
          ...transfer,
          walletAddress: transfer.otherParty,
          otherParty: transfer.walletAddress,
          amount: -transfer.amount,
        }),
      );
      if (counterpart && counterpart.id !== transfer.id) {
        consumedTransferIds.add(transfer.id);
        consumedTransferIds.add(counterpart.id);
        activityTransfer = transfer.amount < 0n ? transfer : counterpart;
        otherPartyName = activityTransfer.id === transfer.id ? counterpart.walletName : transfer.walletName;
      }
    }

    const matchingTransaction = transactionsByBlockExtrinsic.get(
      blockExtrinsicKey(activityTransfer.blockHash, activityTransfer.extrinsicIndex),
    );
    if (matchingTransaction) consumedTransactionIds.add(matchingTransaction.id);

    activities.push({
      id: `transfer:${activityTransfer.id}`,
      source: 'walletTransfer',
      activityType: activityTransfer.transferType === 'transfer' ? 'transfer' : activityTransfer.transferType,
      walletAddress: activityTransfer.walletAddress,
      walletName: activityTransfer.walletName,
      blockNumber: activityTransfer.blockNumber,
      blockHash: activityTransfer.blockHash,
      extrinsicIndex: activityTransfer.extrinsicIndex,
      isFinalized: true,
      amount: activityTransfer.amount,
      currency: activityTransfer.currency,
      otherParty: activityTransfer.otherParty,
      otherPartyName,
      transfer: activityTransfer,
      transaction: matchingTransaction,
      occurredAt: activityTransfer.blockTime ?? activityTransfer.createdAt,
    });
  }

  for (const transaction of transactions) {
    if (consumedTransactionIds.has(transaction.id)) continue;

    const activity: IWalletActivityRecord = {
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
    };

    if (transaction.extrinsicType === ExtrinsicType.Transfer) {
      // Vault revenue forwarding stores its single ARGN amount directly instead of using assetsToMove.
      const amount = (transaction.metadataJson as { amount?: bigint }).amount;
      if (amount !== undefined) {
        activity.amount = amount;
        activity.currency = 'argon';
      }
    }

    activities.push(activity);
  }

  return activities.sort(compareActivityRecords);
}

function blockExtrinsicKey(blockHash: string, extrinsicIndex: number | null): string {
  return `${blockHash}:${extrinsicIndex ?? 'none'}`;
}

function internalTransferKey(
  transfer: Pick<
    IWalletTransferRecord,
    'blockHash' | 'extrinsicIndex' | 'currency' | 'walletAddress' | 'otherParty' | 'amount'
  >,
): string {
  return [
    transfer.blockHash,
    transfer.extrinsicIndex,
    transfer.currency,
    transfer.walletAddress,
    transfer.otherParty,
    transfer.amount,
  ].join(':');
}

function compareActivityRecords(a: IWalletActivityRecord, b: IWalletActivityRecord): number {
  const blockDiff = (b.blockNumber ?? 0) - (a.blockNumber ?? 0);
  if (blockDiff) return blockDiff;

  const extrinsicDiff = (b.extrinsicIndex ?? -1) - (a.extrinsicIndex ?? -1);
  if (extrinsicDiff) return extrinsicDiff;

  return b.id.localeCompare(a.id);
}
