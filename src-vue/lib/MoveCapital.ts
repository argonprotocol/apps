import {
  type ArgonClient,
  bigIntMax,
  isValidArgonAccountAddress,
  MoveFrom,
  MoveTo,
  MoveToken,
} from '@argonprotocol/apps-core';
import { nanoid } from 'nanoid';

import { ExtrinsicType } from './db/TransactionsTable.ts';
import { getTransactionFailureMessage, type TransactionInfo } from './TransactionInfo.ts';
import { TxAttemptState, type TransactionTracker } from './TransactionTracker.ts';
import type { IWallet } from './Wallet.ts';
import { existentialDepositMicronots } from './WalletForArgon.ts';
import type { WalletKeys } from './WalletKeys.ts';
import {
  BalanceTransfer,
  type BalanceTransferInput,
  type IAllocationChange,
  type IAllocationChangeLeg,
  type IAssetsToMove,
  type ITransactionMoveMetadata,
} from './txs/Balance.transfer.ts';

export interface ExternalTransferInput {
  destinationAddress: string;
  moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
  amount: bigint;
  availableMicrogons: bigint;
  availableMicronots: bigint;
  client?: ArgonClient;
}

export type ExternalTransferQuoteInput = Omit<ExternalTransferInput, 'amount'>;

export interface ExternalTransferQuote {
  maximumAmount: bigint;
  transactionFeeMicrogons: bigint;
}

export interface ChangeAllocationInput {
  targetMicrogons: bigint;
  targetMicronots: bigint;
  sourceWallet: IWallet;
  allocatedWallet: IWallet;
  allocateFrom: MoveFrom.DefaultArgon | MoveFrom.MiningBot;
  allocateTo: MoveTo.DefaultArgon | MoveTo.MiningBot;
  client?: ArgonClient;
}

export interface MoveCapitalData {
  isLoaded: boolean;
  loadError?: string;
  pendingExternalTransfer?: TransactionInfo<ITransactionMoveMetadata>;
  pendingAllocationChange?: TransactionInfo<ITransactionMoveMetadata>;
  allocationError?: string;
}

export class MoveCapital {
  public data: MoveCapitalData = { isLoaded: false };
  private readonly balanceTransfers: BalanceTransfer;
  private readonly allocationClients = new Map<string, ArgonClient>();
  private readonly allocationContinuations = new Map<string, Promise<void>>();
  private allocationSubmission?: Promise<TransactionInfo<ITransactionMoveMetadata> | undefined>;
  private loading?: Promise<void>;

  constructor(
    walletKeys: WalletKeys,
    private readonly transactionTracker: TransactionTracker,
  ) {
    this.balanceTransfers = new BalanceTransfer(walletKeys, transactionTracker, {
      ownsTransfer: txInfo => {
        const metadata = txInfo.tx.metadataJson;
        return (
          Boolean(metadata?.allocationChange) ||
          (txInfo.tx.accountAddress === walletKeys.defaultArgonAddress &&
            metadata?.moveFrom === MoveFrom.DefaultArgon &&
            metadata.moveTo === MoveTo.External)
        );
      },
      onFinalized: async txInfo => {
        const allocationChange = txInfo.tx.metadataJson.allocationChange;
        if (allocationChange) await this.continueAllocationChange(txInfo, allocationChange);
      },
      onPostProcessed: async (txInfo, error) => {
        this.publishPendingTransfers(txInfo.tx.metadataJson.allocationChange ? error : undefined);
      },
    });
  }

  public async load(): Promise<void> {
    if (this.loading) return await this.loading;

    const loading = (async () => {
      await this.balanceTransfers.load();
      await this.restoreAllocationChange();
      this.publishPendingTransfers();
      this.data.loadError = undefined;
      this.data.isLoaded = true;
    })();
    this.loading = loading;
    try {
      await loading;
    } catch (error) {
      this.data.loadError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (this.loading === loading) this.loading = undefined;
    }
  }

  public async move(input: BalanceTransferInput): Promise<TransactionInfo<ITransactionMoveMetadata>> {
    if (input.moveTo === MoveTo.External && !isValidArgonAccountAddress(input.externalAddress?.trim() ?? '')) {
      throw new Error('Enter a valid Argon address.');
    }

    const txInfo = await this.balanceTransfers.submit(input);
    this.publishPendingTransfers();
    return txInfo;
  }

  public async getTransferFee(input: BalanceTransferInput): Promise<bigint> {
    if (input.moveTo === MoveTo.External && !isValidArgonAccountAddress(input.externalAddress?.trim() ?? '')) {
      throw new Error('Enter a valid Argon address.');
    }
    return await this.balanceTransfers.estimateFee(input);
  }

  public async getExternalTransferQuote(input: ExternalTransferQuoteInput): Promise<ExternalTransferQuote> {
    const destinationAddress = input.destinationAddress.trim();
    if (!isValidArgonAccountAddress(destinationAddress)) throw new Error('Enter a valid Argon address.');

    const availableAmount =
      input.moveToken === MoveToken.ARGN
        ? input.availableMicrogons
        : bigIntMax(input.availableMicronots - existentialDepositMicronots, 0n);
    if (availableAmount <= 0n) return { maximumAmount: 0n, transactionFeeMicrogons: 0n };

    const transactionFeeMicrogons = await this.getTransferFee({
      moveFrom: MoveFrom.DefaultArgon,
      moveTo: MoveTo.External,
      externalAddress: destinationAddress,
      assetsToMove: { [input.moveToken]: availableAmount },
      client: input.client,
    });
    if (input.moveToken === MoveToken.ARGNOT && transactionFeeMicrogons > input.availableMicrogons) {
      throw new Error('Your wallet does not have enough ARGN to pay the network fee.');
    }

    return {
      maximumAmount:
        input.moveToken === MoveToken.ARGN
          ? bigIntMax(input.availableMicrogons - transactionFeeMicrogons, 0n)
          : availableAmount,
      transactionFeeMicrogons,
    };
  }

  public async sendToAddress(input: ExternalTransferInput): Promise<TransactionInfo<ITransactionMoveMetadata>> {
    if (input.amount <= 0n) throw new Error('Enter an amount to send.');

    const quote = await this.getExternalTransferQuote(input);
    if (input.amount > quote.maximumAmount) {
      throw new Error(`Transfer amount exceeds the available ${input.moveToken} after fees.`);
    }

    return await this.move({
      moveFrom: MoveFrom.DefaultArgon,
      moveTo: MoveTo.External,
      externalAddress: input.destinationAddress.trim(),
      assetsToMove: { [input.moveToken]: input.amount },
      client: input.client,
    });
  }

  public getPendingExternalTransfer(): TransactionInfo<ITransactionMoveMetadata> | undefined {
    return (
      this.data.pendingExternalTransfer ??
      this.balanceTransfers.getPendingTransfer(txInfo => {
        const metadata = txInfo.tx.metadataJson;
        return (
          metadata?.moveFrom === MoveFrom.DefaultArgon &&
          metadata.moveTo === MoveTo.External &&
          Boolean(metadata.externalAddress)
        );
      })
    );
  }

  public async changeAllocation(
    input: ChangeAllocationInput,
  ): Promise<TransactionInfo<ITransactionMoveMetadata> | undefined> {
    if (this.allocationSubmission) return await this.allocationSubmission;

    const submission = this.changeAllocationInner(input);
    this.allocationSubmission = submission;
    try {
      return await submission;
    } finally {
      if (this.allocationSubmission === submission) this.allocationSubmission = undefined;
    }
  }

  public getPendingAllocationChange(): TransactionInfo<ITransactionMoveMetadata> | undefined {
    return this.data.pendingAllocationChange ?? this.findPendingAllocationChange();
  }

  private findPendingAllocationChange(): TransactionInfo<ITransactionMoveMetadata> | undefined {
    const operationTransactions = this.getLatestAllocationTransactions();
    if (!operationTransactions.length) return;

    const root = this.getAllocationRoot(operationTransactions);
    const operation = root.tx.metadataJson.allocationChange!;
    const latestByLeg = this.getLatestAllocationTxByLeg(operationTransactions);
    if ([...latestByLeg.values()].some(getTransactionFailureMessage)) return;
    if (operation.legs.some((_, legIndex) => !latestByLeg.has(legIndex))) return root;
    if ([...latestByLeg.values()].some(txInfo => !txInfo.tx.isFinalized || txInfo.hasPendingPostProcessing))
      return root;
  }

  private async changeAllocationInner(
    input: ChangeAllocationInput,
  ): Promise<TransactionInfo<ITransactionMoveMetadata> | undefined> {
    await this.load();
    const existing = this.getPendingAllocationChange();
    if (existing) return existing;
    this.data.allocationError = undefined;

    const allocatedMicrogons = input.allocatedWallet.availableMicrogons + input.allocatedWallet.reservedMicrogons;
    const allocatedMicronots = input.allocatedWallet.availableMicronots + input.allocatedWallet.reservedMicronots;
    if (input.targetMicrogons < input.allocatedWallet.reservedMicrogons) {
      throw new Error('Allocation cannot be lower than the ARGN currently reserved by this wallet.');
    }
    if (input.targetMicronots < input.allocatedWallet.reservedMicronots) {
      throw new Error('Allocation cannot be lower than the ARGNOT currently reserved by this wallet.');
    }

    const assetsToAllocate: IAssetsToMove = {};
    const assetsToReturn: IAssetsToMove = {};
    if (input.targetMicrogons > allocatedMicrogons) {
      assetsToAllocate[MoveToken.ARGN] = input.targetMicrogons - allocatedMicrogons;
    } else if (input.targetMicrogons < allocatedMicrogons) {
      assetsToReturn[MoveToken.ARGN] = allocatedMicrogons - input.targetMicrogons;
    }
    if (input.targetMicronots > allocatedMicronots) {
      assetsToAllocate[MoveToken.ARGNOT] = input.targetMicronots - allocatedMicronots;
    } else if (input.targetMicronots < allocatedMicronots) {
      assetsToReturn[MoveToken.ARGNOT] = allocatedMicronots - input.targetMicronots;
    }
    if (
      (assetsToAllocate[MoveToken.ARGNOT] ?? 0n) >
        bigIntMax(input.sourceWallet.availableMicronots - existentialDepositMicronots, 0n) ||
      (assetsToReturn[MoveToken.ARGNOT] ?? 0n) >
        bigIntMax(input.allocatedWallet.availableMicronots - existentialDepositMicronots, 0n)
    ) {
      throw new Error('Each wallet must keep its minimum ARGNOT balance.');
    }

    const legs: IAllocationChangeLeg[] = [];
    if (assetsToAllocate[MoveToken.ARGN] || assetsToAllocate[MoveToken.ARGNOT]) {
      legs.push({ moveFrom: input.allocateFrom, moveTo: input.allocateTo, assetsToMove: assetsToAllocate });
    }
    if (assetsToReturn[MoveToken.ARGN] || assetsToReturn[MoveToken.ARGNOT]) {
      legs.push({
        moveFrom: input.allocateTo === MoveTo.MiningBot ? MoveFrom.MiningBot : MoveFrom.DefaultArgon,
        moveTo: input.allocateFrom === MoveFrom.MiningBot ? MoveTo.MiningBot : MoveTo.DefaultArgon,
        assetsToMove: assetsToReturn,
      });
    }
    if (!legs.length) return;

    // When returning ARGN while adding ARGNOT, return ARGN first so the source wallet can pay the ARGNOT leg's fee.
    if (legs.length === 2 && assetsToReturn[MoveToken.ARGN]) legs.reverse();

    const allocationChange: IAllocationChange = {
      id: nanoid(),
      targetMicrogons: input.targetMicrogons,
      targetMicronots: input.targetMicronots,
      legIndex: 0,
      legs,
    };
    if (input.client) this.allocationClients.set(allocationChange.id, input.client);
    return await this.move({ ...legs[0], allocationChange, client: input.client });
  }

  private async restoreAllocationChange(client?: ArgonClient): Promise<void> {
    const operationTransactions = this.getLatestAllocationTransactions();
    if (!operationTransactions.length) return;

    const root = this.getAllocationRoot(operationTransactions);
    const operation = root.tx.metadataJson.allocationChange!;
    if (client) this.allocationClients.set(operation.id, client);
    const latestByLeg = this.getLatestAllocationTxByLeg(operationTransactions);

    for (let legIndex = 1; legIndex < operation.legs.length; legIndex += 1) {
      const priorTxInfo = latestByLeg.get(legIndex - 1);
      const nextTxInfo = latestByLeg.get(legIndex);
      if (priorTxInfo && nextTxInfo && !priorTxInfo.tx.followOnTxId) {
        this.transactionTracker.createIntentForFollowOnTx<ITransactionMoveMetadata>(priorTxInfo).resolve(nextTxInfo);
      }
    }

    const firstMissingLeg = operation.legs.findIndex((_, legIndex) => !latestByLeg.has(legIndex));
    const lastStartedLeg = firstMissingLeg === -1 ? operation.legs.length - 1 : firstMissingLeg - 1;
    const activeTxInfo = latestByLeg.get(lastStartedLeg);
    if (!activeTxInfo || getTransactionFailureMessage(activeTxInfo)) return;

    const attemptState = await this.transactionTracker.getTxAttemptState(activeTxInfo, 0);
    if (attemptState === TxAttemptState.Replace) {
      const leg = operation.legs[lastStartedLeg];
      await this.move({
        ...leg,
        allocationChange: { ...operation, legIndex: lastStartedLeg },
        client,
      });
      return;
    }

    if (firstMissingLeg !== -1 && attemptState === TxAttemptState.Finalized) {
      this.balanceTransfers.resume(activeTxInfo);
    }
  }

  private async continueAllocationChange(
    txInfo: TransactionInfo<ITransactionMoveMetadata>,
    operation: IAllocationChange,
  ): Promise<void> {
    const nextLegIndex = operation.legIndex + 1;
    const nextLeg = operation.legs[nextLegIndex];
    if (!nextLeg) {
      this.allocationClients.delete(operation.id);
      return;
    }

    const existingContinuation = this.allocationContinuations.get(operation.id);
    if (existingContinuation) return await existingContinuation;

    const continuation = (async () => {
      const existingNext = this.getLatestAllocationTransactions().find(
        candidate => candidate.tx.metadataJson.allocationChange?.legIndex === nextLegIndex,
      );
      const followOnTx = !txInfo.tx.followOnTxId
        ? this.transactionTracker.createIntentForFollowOnTx<ITransactionMoveMetadata>(txInfo)
        : undefined;
      try {
        const nextTxInfo =
          existingNext ??
          (await this.move({
            ...nextLeg,
            allocationChange: { ...operation, legIndex: nextLegIndex },
            client: this.allocationClients.get(operation.id),
          }));
        followOnTx?.resolve(nextTxInfo);
        this.balanceTransfers.resume(nextTxInfo);
        await nextTxInfo.waitForPostProcessing;
      } catch (error) {
        followOnTx?.reject(error as Error);
        throw error;
      }
    })();
    this.allocationContinuations.set(operation.id, continuation);
    try {
      await continuation;
    } finally {
      this.allocationContinuations.delete(operation.id);
    }
  }

  private publishPendingTransfers(postProcessingError?: Error): void {
    this.data.pendingExternalTransfer = this.balanceTransfers.getPendingTransfer(txInfo => {
      const metadata = txInfo.tx.metadataJson;
      return (
        metadata?.moveFrom === MoveFrom.DefaultArgon &&
        metadata.moveTo === MoveTo.External &&
        Boolean(metadata.externalAddress)
      );
    });
    const allocationTransactions = this.getLatestAllocationTransactions();
    this.data.pendingAllocationChange = this.findPendingAllocationChange();
    const failedAllocation = allocationTransactions.reduce<TransactionInfo<ITransactionMoveMetadata> | undefined>(
      (latest, txInfo) => {
        if (!getTransactionFailureMessage(txInfo)) return latest;
        return !latest || txInfo.tx.id > latest.tx.id ? txInfo : latest;
      },
      undefined,
    );
    this.data.allocationError = postProcessingError?.message ?? getTransactionFailureMessage(failedAllocation);
  }

  private getLatestAllocationTransactions(): TransactionInfo<ITransactionMoveMetadata>[] {
    const transactions = this.transactionTracker.data.txInfos.filter(candidate => {
      const metadata = candidate.tx.metadataJson as ITransactionMoveMetadata | undefined;
      return candidate.tx.extrinsicType === ExtrinsicType.Transfer && Boolean(metadata?.allocationChange);
    }) as TransactionInfo<ITransactionMoveMetadata>[];
    const latest = transactions.reduce<TransactionInfo<ITransactionMoveMetadata> | undefined>(
      (selected, candidate) => (!selected || candidate.tx.id > selected.tx.id ? candidate : selected),
      undefined,
    );
    const operationId = latest?.tx.metadataJson.allocationChange?.id;
    return operationId
      ? transactions.filter(candidate => candidate.tx.metadataJson.allocationChange?.id === operationId)
      : [];
  }

  private getAllocationRoot(
    transactions: TransactionInfo<ITransactionMoveMetadata>[],
  ): TransactionInfo<ITransactionMoveMetadata> {
    return transactions.reduce((root, candidate) => {
      const candidateLeg = candidate.tx.metadataJson.allocationChange?.legIndex ?? 0;
      const rootLeg = root.tx.metadataJson.allocationChange?.legIndex ?? 0;
      if (candidateLeg !== rootLeg) return candidateLeg < rootLeg ? candidate : root;
      return candidate.tx.id < root.tx.id ? candidate : root;
    });
  }

  private getLatestAllocationTxByLeg(
    transactions: TransactionInfo<ITransactionMoveMetadata>[],
  ): Map<number, TransactionInfo<ITransactionMoveMetadata>> {
    const byLeg = new Map<number, TransactionInfo<ITransactionMoveMetadata>>();
    for (const txInfo of transactions) {
      const legIndex = txInfo.tx.metadataJson.allocationChange?.legIndex;
      if (legIndex === undefined) continue;
      const current = byLeg.get(legIndex);
      if (!current || txInfo.tx.id > current.tx.id) byLeg.set(legIndex, txInfo);
    }
    return byLeg;
  }
}
