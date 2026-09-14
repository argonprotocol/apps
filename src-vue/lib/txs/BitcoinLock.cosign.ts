import { BitcoinLock, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';

import type { MyVault } from '../MyVault.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import { TxAttemptState, type TransactionTracker } from '../TransactionTracker.ts';
import { TransactionOperation, type TransactionOperationBuild } from './TransactionOperation.ts';

export interface BitcoinLockCosignInput {
  client: ArgonClient;
  txSigner: TxSigningAccount;
  lockId: number;
  vaultSignatureHexes: string[];
}

export interface IBitcoinLockCosignMetadata {
  lockId: number;
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
    const existing = await this.myVault.findLatestReleaseCosignTxAttempt(input.lockId);
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
          lockId: input.lockId,
          vaultSignatureHexes: input.vaultSignatureHexes,
        }),
      ],
      txSigner: input.txSigner,
      metadata: { lockId: input.lockId },
    };
  }

  protected getOperationKey(input: BitcoinLockCosignInput): string {
    return `${input.txSigner.address}:${input.lockId}`;
  }

  protected matches(input: BitcoinLockCosignInput, txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): boolean {
    return txInfo.tx.accountAddress === input.txSigner.address && txInfo.tx.metadataJson.lockId === input.lockId;
  }

  protected async onSubmitted(txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): Promise<void> {
    const { lockId } = txInfo.tx.metadataJson;
    this.myVault.data.releasedExternalLockIds.add(lockId);
    this.myVault.data.myPendingBitcoinCosignTxInfosByLockId.set(lockId, txInfo);
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): Promise<void> {
    const { lockId } = txInfo.tx.metadataJson;
    try {
      await this.myVault.trackTxResultFee(txInfo.txResult);
    } finally {
      if (this.myVault.data.myPendingBitcoinCosignTxInfosByLockId.get(lockId)?.tx.id === txInfo.tx.id) {
        this.myVault.data.myPendingBitcoinCosignTxInfosByLockId.delete(lockId);
      }
    }
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): Promise<void> {
    const { lockId } = txInfo.tx.metadataJson;
    if (this.myVault.data.myPendingBitcoinCosignTxInfosByLockId.get(lockId)?.tx.id === txInfo.tx.id) {
      this.myVault.data.myPendingBitcoinCosignTxInfosByLockId.delete(lockId);
    }
  }
}
