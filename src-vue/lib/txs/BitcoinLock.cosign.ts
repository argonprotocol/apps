import { BitcoinLock, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';

import type { MyVault } from '../MyVault.ts';
import type { IVaultCollectMetadata } from '../VaultCollectBuilder.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import { TxAttemptState, type TransactionTracker } from '../TransactionTracker.ts';
import { TransactionOperation, type TransactionOperationBuild } from './TransactionOperation.ts';

const COSIGN_ATTEMPT_CONFIRMATIONS_TO_WAIT = 2;

export interface BitcoinLockCosignInput extends IBitcoinLockCosignMetadata {
  client: ArgonClient;
  txSigner: TxSigningAccount;
  vaultSignatureHexes: string[];
}

export interface IBitcoinLockCosignMetadata {
  lockId: number;
  releaseNumber: number;
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
    const existing = await this.findLatestAttempt(input.lockId, input.releaseNumber);
    if (
      existing &&
      (existing.txAttemptState === TxAttemptState.Pending || existing.txAttemptState === TxAttemptState.Finalized)
    ) {
      return existing.txInfo as TransactionInfo<IBitcoinLockCosignMetadata>;
    }
    return await super.submit(input);
  }

  public async findLatestAttempt(
    lockId: number,
    releaseNumber: number,
  ): Promise<{ txInfo: TransactionInfo; txAttemptState: TxAttemptState } | undefined> {
    const txInfo = this.transactionTracker.findLatestTxInfo(candidate => {
      const { extrinsicType, metadataJson } = candidate.tx;
      if (extrinsicType === ExtrinsicType.VaultCosignBitcoinRelease) {
        const metadata = metadataJson as IBitcoinLockCosignMetadata;
        return metadata.lockId === lockId && metadata.releaseNumber === releaseNumber;
      }
      if (extrinsicType !== ExtrinsicType.VaultCollect) return false;

      const metadata = metadataJson as IVaultCollectMetadata;
      return metadata.cosignedReleases.some(
        release => release.lockId === lockId && release.releaseNumber === releaseNumber,
      );
    });
    if (!txInfo) return;

    return {
      txInfo,
      txAttemptState: await this.transactionTracker.getTxAttemptState(txInfo, COSIGN_ATTEMPT_CONFIRMATIONS_TO_WAIT),
    };
  }

  protected async build(input: BitcoinLockCosignInput): Promise<BitcoinLockCosignBuild> {
    const { client, txSigner, vaultSignatureHexes, ...metadata } = input;
    return {
      client,
      txs: [
        BitcoinLock.createReleaseCosignTx({
          client,
          lockId: input.lockId,
          vaultSignatureHexes,
        }),
      ],
      txSigner,
      metadata,
    };
  }

  protected getOperationKey(input: BitcoinLockCosignInput): string {
    return `${input.txSigner.address}:${input.lockId}:${input.releaseNumber}`;
  }

  protected matches(input: BitcoinLockCosignInput, txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): boolean {
    return (
      txInfo.tx.accountAddress === input.txSigner.address &&
      txInfo.tx.metadataJson.lockId === input.lockId &&
      txInfo.tx.metadataJson.releaseNumber === input.releaseNumber
    );
  }

  protected async onSubmitted(txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): Promise<void> {
    const { lockId, releaseNumber } = txInfo.tx.metadataJson;
    const pending = this.myVault.data.pendingCosignLocksById.get(lockId);
    if (pending && pending.releaseNumber !== releaseNumber) return;
    this.myVault.data.myPendingBitcoinCosignTxInfosByLockId.set(lockId, txInfo);
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinLockCosignMetadata>): Promise<void> {
    const { lockId, releaseNumber } = txInfo.tx.metadataJson;
    try {
      await this.transactionTracker.ensureStoredEvents(txInfo);
      let vaultSignatures: Uint8Array[] | undefined;
      for (const event of txInfo.txResult.events) {
        if (
          event.section === 'bitcoinLocks' &&
          event.method === 'BitcoinUtxoCosigned' &&
          event.data.lockId === lockId &&
          event.data.releaseNumber === releaseNumber &&
          event.data.signatures?.length
        ) {
          vaultSignatures = [...event.data.signatures];
          break;
        }
      }
      if (!vaultSignatures?.length) {
        throw new Error(`Bitcoin Lock ${lockId} release ${releaseNumber} finalized without its cosign event`);
      }

      const cosignBlockNumber = txInfo.txResult.blockNumber;
      if (cosignBlockNumber === undefined) throw new Error('Finalized Bitcoin cosign has no block number');
      await this.myVault.bitcoinLocks.releases.applyVaultCosignResult({
        lockId,
        releaseNumber,
        vaultSignatures,
        cosignBlockNumber,
      });
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
