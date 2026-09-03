import { BitcoinLock, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';

import type { MyVault } from '../MyVault.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import { TxAttemptState, type TransactionTracker } from '../TransactionTracker.ts';
import { TransactionOperation, type TransactionOperationBuild } from './TransactionOperation.ts';

export interface BitcoinLockCosignInput {
  client: ArgonClient;
  txSigner: TxSigningAccount;
  utxoId: number;
  vaultSignatureHex: string;
}

export interface IBitcoinLockCosignMetadata {
  utxoId: number;
}

type BitcoinLockCosignBuild = TransactionOperationBuild<IBitcoinLockCosignMetadata>;

export class BitcoinLockCosign extends TransactionOperation<
  BitcoinLockCosignInput,
  IBitcoinLockCosignMetadata,
  BitcoinLockCosignBuild
> {
  protected readonly extrinsicType = ExtrinsicType.VaultCosignBitcoinRelease;

  constructor(
    private readonly myVault: MyVault,
    transactionTracker: TransactionTracker,
  ) {
    super(transactionTracker);
  }

  public override async submit(input: BitcoinLockCosignInput): Promise<TransactionInfo<IBitcoinLockCosignMetadata>> {
    const existing = await this.myVault.findLatestReleaseCosignTxAttempt(input.utxoId);
    if (
      existing &&
      (existing.txAttemptState === TxAttemptState.Pending || existing.txAttemptState === TxAttemptState.Finalized)
    ) {
      return existing.txInfo as TransactionInfo<IBitcoinLockCosignMetadata>;
    }
    return await super.submit(input);
  }

  protected async build(input: BitcoinLockCosignInput): Promise<BitcoinLockCosignBuild> {
    return {
      client: input.client,
      txs: [
        BitcoinLock.createReleaseCosignTx({
          client: input.client,
          utxoId: input.utxoId,
          vaultSignatureHex: input.vaultSignatureHex,
        }),
      ],
      txSigner: input.txSigner,
      metadata: { utxoId: input.utxoId },
    };
  }

  protected getOperationKey(input: BitcoinLockCosignInput): string {
    return `${input.txSigner.address}:${input.utxoId}`;
  }

  protected matches(input: BitcoinLockCosignInput, txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): boolean {
    return txInfo.tx.accountAddress === input.txSigner.address && txInfo.tx.metadataJson.utxoId === input.utxoId;
  }

  protected async onSubmitted(txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): Promise<void> {
    const { utxoId } = txInfo.tx.metadataJson;
    this.myVault.data.releasedExternalUtxoIds.add(utxoId);
    this.myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.set(utxoId, txInfo);
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): Promise<void> {
    const { utxoId } = txInfo.tx.metadataJson;
    try {
      await this.myVault.trackTxResultFee(txInfo.txResult);
    } finally {
      if (this.myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.get(utxoId)?.tx.id === txInfo.tx.id) {
        this.myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.delete(utxoId);
      }
    }
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): Promise<void> {
    const { utxoId } = txInfo.tx.metadataJson;
    if (this.myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.get(utxoId)?.tx.id === txInfo.tx.id) {
      this.myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.delete(utxoId);
    }
  }
}
