import { TxResult } from '@argonprotocol/apps-core';
import { expect, it, vi } from 'vitest';

import { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { Currency } from '../lib/Currency.ts';
import type { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { ExtrinsicType, type ITransactionRecord, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { BitcoinLockResecuritize, type IBitcoinResecuritizationMetadata } from '../lib/txs/BitcoinLock.resecuritize.ts';
import { TransactionOperation, type TransactionOperationBuild } from '../lib/txs/TransactionOperation.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(),
}));

it('resumes restored transactions at load without restarting them when pending state is read', async () => {
  let resolveFinalization!: () => void;
  const waitForFinalizedBlock = new Promise<void>(resolve => {
    resolveFinalization = resolve;
  });
  const txInfo = new TransactionInfo({
    tx: {
      id: 1,
      status: TransactionStatus.Submitted,
      extrinsicType: ExtrinsicType.Transfer,
      isFinalized: false,
      createdAt: new Date(),
    } as ITransactionRecord,
    txResult: {
      waitForFinalizedBlock,
    } as unknown as TxResult,
  });
  const transactionTracker = {
    data: { txInfos: [txInfo] },
    load: vi.fn().mockResolvedValue(undefined),
    pendingBlockTxInfosAtLoad: [txInfo],
  } as unknown as TransactionTracker;
  const operation = new TestTransactionOperation(transactionTracker);

  expect(operation.readPendingTransactions()).toEqual([txInfo]);
  expect(txInfo.hasPendingPostProcessing).toBe(false);

  await operation.load();
  expect(txInfo.hasPendingPostProcessing).toBe(true);

  resolveFinalization();
  await txInfo.waitForPostProcessing;
  expect(operation.finalizationCount).toBe(1);

  operation.readPendingTransactions();
  operation.readPendingTransactions();
  await Promise.resolve();
  expect(operation.finalizationCount).toBe(1);
});

it('finds the pending insurance transaction for a restored Bitcoin channel', () => {
  const otherChannel = createResecuritizationTxInfo(1, 100);
  const pendingChannel = createResecuritizationTxInfo(2, 101);
  const transactionTracker = {
    data: { txInfos: [otherChannel, pendingChannel] },
  } as unknown as TransactionTracker;
  const operation = new BitcoinLockResecuritize(
    {} as BitcoinLocks,
    transactionTracker,
    {} as Currency,
    {} as UpstreamOperatorClient,
  );

  expect(operation.getPendingResecuritizationTxInfo(101)).toBe(pendingChannel);
});

function createResecuritizationTxInfo(id: number, utxoId: number): TransactionInfo<IBitcoinResecuritizationMetadata> {
  return new TransactionInfo({
    tx: {
      id,
      status: TransactionStatus.InBlock,
      extrinsicType: ExtrinsicType.BitcoinResecuritize,
      isFinalized: false,
      metadataJson: {
        bitcoin: {
          utxoId,
          vaultId: 7,
          securitizedSatoshis: 12_500_000n,
          microgonsAtTargetPerBtc: 6_800_000_000n,
          securityFee: 4_500_000n,
        },
      },
      createdAt: new Date(),
    } as ITransactionRecord<IBitcoinResecuritizationMetadata>,
    txResult: {} as TxResult,
  });
}

class TestTransactionOperation extends TransactionOperation<void, unknown, TransactionOperationBuild<unknown>> {
  public finalizationCount = 0;
  protected readonly extrinsicType = ExtrinsicType.Transfer;

  public readPendingTransactions(): TransactionInfo[] {
    return super.getPendingTransactions(() => true);
  }

  protected getOperationKey(): string {
    return 'test';
  }

  protected matches(): boolean {
    return true;
  }

  protected async build(): Promise<TransactionOperationBuild<unknown>> {
    throw new Error('Not used by this lifecycle test.');
  }

  protected async onFinalized(): Promise<void> {
    this.finalizationCount += 1;
  }
}
