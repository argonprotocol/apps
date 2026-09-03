import { TxSubmitter, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';
import type { SubmittableExtrinsic } from '@argonprotocol/mainchain';

import { getTransactionFailureMessage, type TransactionInfo } from '../TransactionInfo.ts';
import { TxAttemptState, type TransactionTracker } from '../TransactionTracker.ts';
import type { ExtrinsicType } from '../db/TransactionsTable.ts';

export interface TransactionOperationBuild<Metadata> {
  client: ArgonClient;
  txs: SubmittableExtrinsic[];
  txSigner: TxSigningAccount;
  metadata: Metadata;
  tip?: bigint;
  unavailableBalance?: bigint;
  includeExistentialDeposit?: boolean;
}

export type PreparedTransactionOperation<Metadata, Build extends TransactionOperationBuild<Metadata>> = Build & {
  tx: SubmittableExtrinsic;
  txFeePlusTip: bigint;
  availableBalance: bigint;
  canAfford: boolean;
};

export abstract class TransactionOperation<Input, Metadata, Build extends TransactionOperationBuild<Metadata>> {
  protected abstract readonly extrinsicType: ExtrinsicType;
  private readonly submissionsByKey = new Map<string, Promise<TransactionInfo<Metadata>>>();
  private readonly publishedSubmissionIds = new Set<number>();
  private readonly submissionPublicationById = new Map<number, Promise<void>>();

  constructor(protected readonly transactionTracker: TransactionTracker) {}

  public async load(): Promise<void> {
    await this.restorePendingTransactions();
  }

  public async prepare(input: Input): Promise<PreparedTransactionOperation<Metadata, Build>> {
    const build = await this.build(input);
    const { client, txs, txSigner, tip, unavailableBalance, includeExistentialDeposit } = build;
    if (!txs.length) throw new Error('This operation did not generate a transaction.');

    const tx = txs.length === 1 ? txs[0] : client.tx.utility.batchAll(txs);
    const { availableBalance, canAfford, txFee } = await new TxSubmitter(client, tx, txSigner).canAfford({
      tip,
      unavailableBalance,
      includeExistentialDeposit,
    });

    return {
      ...build,
      tx,
      txFeePlusTip: txFee + (tip ?? 0n),
      availableBalance,
      canAfford,
    };
  }

  public async submit(input: Input): Promise<TransactionInfo<Metadata>> {
    const key = this.getOperationKey(input);
    const activeSubmission = this.submissionsByKey.get(key);
    if (activeSubmission) return await activeSubmission;

    const submission = this.submitOperation(input).finally(() => {
      if (this.submissionsByKey.get(key) === submission) this.submissionsByKey.delete(key);
    });
    this.submissionsByKey.set(key, submission);
    return await submission;
  }

  protected abstract getOperationKey(input: Input): string;

  protected abstract matches(input: Input, txInfo: TransactionInfo<Metadata>): boolean;

  protected abstract build(input: Input): Promise<Build>;

  protected abstract onFinalized(txInfo: TransactionInfo<Metadata>): Promise<void>;

  protected onSubmitted?(txInfo: TransactionInfo<Metadata>): Promise<void>;

  protected onFailed?(txInfo: TransactionInfo<Metadata>, error: Error): Promise<void>;

  protected onSubmissionFailed?(prepared: PreparedTransactionOperation<Metadata, Build>, error: Error): Promise<void>;

  protected createInsufficientFundsError(_prepared: PreparedTransactionOperation<Metadata, Build>): Error {
    return new Error('There are not enough funds to submit this transaction.');
  }

  protected getPendingTransaction(
    matches: (txInfo: TransactionInfo<Metadata>) => boolean,
  ): TransactionInfo<Metadata> | undefined {
    return this.getPendingTransactions(matches)[0];
  }

  protected getPendingTransactions(
    matches: (txInfo: TransactionInfo<Metadata>) => boolean,
  ): TransactionInfo<Metadata>[] {
    const txInfos = this.transactionTracker.data.txInfos.filter(candidate => {
      if (candidate.tx.extrinsicType !== this.extrinsicType) return false;
      if (getTransactionFailureMessage(candidate)) return false;
      if (candidate.tx.isFinalized && candidate.isPostProcessed) return false;
      return matches(candidate as TransactionInfo<Metadata>);
    }) as TransactionInfo<Metadata>[];
    return txInfos;
  }

  private async submitOperation(input: Input): Promise<TransactionInfo<Metadata>> {
    const existing = await this.transactionTracker.findLatestTxAttempt<Metadata>({
      extrinsicType: this.extrinsicType,
      waitForConfirmations: 2,
      matches: txInfo => this.matchesActiveTransaction(input, txInfo),
    });
    if (existing && existing.txAttemptState !== TxAttemptState.Replace) {
      await this.publishSubmitted(existing.txInfo);
      this.resume(existing.txInfo);
      return existing.txInfo;
    }

    const prepared = await this.prepare(input);
    if (!prepared.canAfford) {
      const error = this.createInsufficientFundsError(prepared);
      await this.onSubmissionFailed?.(prepared, error);
      throw error;
    }

    const followOnTx =
      existing?.txAttemptState === TxAttemptState.Replace && !existing.txInfo.tx.followOnTxId
        ? this.transactionTracker.createIntentForFollowOnTx<Metadata>(existing.txInfo)
        : undefined;
    let txInfo: TransactionInfo<Metadata>;
    try {
      txInfo = await this.transactionTracker.submitAndWatch({
        client: prepared.client,
        tx: prepared.tx,
        txSigner: prepared.txSigner,
        extrinsicType: this.extrinsicType,
        metadata: prepared.metadata,
        tip: prepared.tip,
        useLatestNonce: true,
      });
      followOnTx?.resolve(txInfo);
    } catch (error) {
      followOnTx?.reject(error as Error);
      await this.onSubmissionFailed?.(prepared, error as Error);
      throw error;
    }

    await this.publishSubmitted(txInfo);
    this.resume(txInfo);
    return txInfo;
  }

  public getPending(input: Input): TransactionInfo<Metadata> | undefined {
    return this.getPendingTransaction(txInfo => this.matchesActiveTransaction(input, txInfo));
  }

  public resume(txInfo: TransactionInfo<Metadata>): void {
    if (txInfo.hasPendingPostProcessing) return;

    const postProcessor = txInfo.createPostProcessor();
    void this.processFinalization(txInfo).then(postProcessor.resolve, postProcessor.reject);
  }

  private async processFinalization(txInfo: TransactionInfo<Metadata>): Promise<void> {
    await this.publishSubmitted(txInfo);
    try {
      await txInfo.txResult.waitForFinalizedBlock;
    } catch (error) {
      await this.onFailed?.(txInfo, error as Error);
      throw error;
    }

    const failureMessage = getTransactionFailureMessage(txInfo);
    if (failureMessage) {
      const error = new Error(failureMessage);
      await this.onFailed?.(txInfo, error);
      throw error;
    }

    await this.onFinalized(txInfo);
  }

  private async publishSubmitted(txInfo: TransactionInfo<Metadata>): Promise<void> {
    if (!this.onSubmitted || this.publishedSubmissionIds.has(txInfo.tx.id)) return;

    const activePublication = this.submissionPublicationById.get(txInfo.tx.id);
    if (activePublication) return await activePublication;

    const publication = this.onSubmitted(txInfo)
      .then(() => {
        this.publishedSubmissionIds.add(txInfo.tx.id);
      })
      .finally(() => {
        this.submissionPublicationById.delete(txInfo.tx.id);
      });
    this.submissionPublicationById.set(txInfo.tx.id, publication);
    await publication;
  }

  private async restorePendingTransactions(): Promise<void> {
    await this.transactionTracker.load();
    const pendingTransactions = this.transactionTracker.pendingBlockTxInfosAtLoad
      .filter(txInfo => txInfo.tx.extrinsicType === this.extrinsicType)
      .reverse() as TransactionInfo<Metadata>[];

    for (const txInfo of pendingTransactions) {
      this.resume(txInfo);
      void txInfo.waitForPostProcessing.catch(error => {
        console.warn(`[TransactionOperation] Unable to restore transaction #${txInfo.tx.id}`, error);
      });
    }
  }

  private matchesActiveTransaction(input: Input, txInfo: TransactionInfo<Metadata>): boolean {
    if (!this.matches(input, txInfo)) return false;
    if (getTransactionFailureMessage(txInfo)) return true;
    return !txInfo.tx.isFinalized || !txInfo.isPostProcessed;
  }
}
