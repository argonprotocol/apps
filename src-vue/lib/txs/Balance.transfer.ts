import {
  type ArgonClient,
  isValidArgonAccountAddress,
  MoveFrom,
  MoveTo,
  MoveToken,
  type TxSigningAccount,
} from '@argonprotocol/apps-core';
import type { SubmittableExtrinsic } from '@argonprotocol/mainchain';

import { getMainchainClient } from '../../stores/mainchain.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { WalletKeys } from '../WalletKeys.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import {
  TransactionOperation,
  type PreparedTransactionOperation,
  type TransactionOperationBuild,
  type TransactionOperationOptions,
} from './TransactionOperation.ts';

export interface IAssetsToMove {
  [MoveToken.ARGN]?: bigint;
  [MoveToken.ARGNOT]?: bigint;
}

export interface IAllocationChangeLeg {
  moveFrom: MoveFrom.DefaultArgon | MoveFrom.MiningBot;
  moveTo: MoveTo.DefaultArgon | MoveTo.MiningBot;
  assetsToMove: IAssetsToMove;
}

export interface IAllocationChange {
  id: string;
  targetMicrogons: bigint;
  targetMicronots: bigint;
  legIndex: number;
  legs: IAllocationChangeLeg[];
}

export interface ITransactionMoveMetadata {
  moveFrom: MoveFrom | 'MiningHold' | 'VaultingHold';
  moveTo: MoveTo | 'MiningHold' | 'VaultingHold';
  externalAddress?: string;
  assetsToMove: IAssetsToMove;
  allocationChange?: IAllocationChange;
  workflow?: 'miningSetup' | 'legacyMiningHoldCleanup';
}

export interface BalanceTransferInput {
  moveFrom: MoveFrom.DefaultArgon | MoveFrom.MiningBot | 'MiningHold';
  moveTo: MoveTo.DefaultArgon | MoveTo.MiningBot | MoveTo.External;
  assetsToMove: IAssetsToMove;
  externalAddress?: string;
  allocationChange?: IAllocationChange;
  workflow?: 'miningSetup' | 'legacyMiningHoldCleanup';
  txSigner?: TxSigningAccount;
  client?: ArgonClient;
}

type BalanceTransferBuild = TransactionOperationBuild<ITransactionMoveMetadata>;

interface BalanceTransferOptions extends TransactionOperationOptions<ITransactionMoveMetadata> {
  ownsTransfer?: (txInfo: TransactionInfo<ITransactionMoveMetadata>) => boolean;
}

export class BalanceTransfer extends TransactionOperation<
  BalanceTransferInput,
  ITransactionMoveMetadata,
  BalanceTransferBuild
> {
  protected readonly extrinsicType = ExtrinsicType.Transfer;

  constructor(
    private readonly walletKeys: WalletKeys,
    transactionTracker: TransactionTracker,
    private readonly options: BalanceTransferOptions = {},
  ) {
    super(transactionTracker, options);
  }

  public getPendingTransfer(
    matches: (txInfo: TransactionInfo<ITransactionMoveMetadata>) => boolean,
  ): TransactionInfo<ITransactionMoveMetadata> | undefined {
    return this.getPendingTransaction(matches);
  }

  public async estimateFee(input: BalanceTransferInput): Promise<bigint> {
    const client = input.client ?? (await getMainchainClient(false));
    const destinationAddress = this.getDestinationAddress(input);
    const txs = this.createTransactions(client, destinationAddress, input.assetsToMove);
    if (!txs.length) return 0n;

    const tx = txs.length === 1 ? txs[0] : client.tx.utility.batchAll(txs);
    const signer = input.txSigner ?? (await this.getSigner(input.moveFrom));
    return await tx.paymentInfo(signer.address).then(fee => fee.partialFee.toBigInt());
  }

  protected async build(input: BalanceTransferInput): Promise<BalanceTransferBuild> {
    const client = input.client ?? (await getMainchainClient(false));
    const destinationAddress = this.getDestinationAddress(input);

    return {
      client,
      txs: this.createTransactions(client, destinationAddress, input.assetsToMove),
      txSigner: input.txSigner ?? (await this.getSigner(input.moveFrom)),
      unavailableBalance: input.assetsToMove[MoveToken.ARGN] ?? 0n,
      metadata: {
        moveFrom: input.moveFrom,
        moveTo: input.moveTo,
        externalAddress: input.moveTo === MoveTo.External ? destinationAddress : undefined,
        assetsToMove: input.assetsToMove,
        allocationChange: input.allocationChange,
        workflow: input.workflow,
      },
    };
  }

  protected getOperationKey(input: BalanceTransferInput): string {
    if (input.allocationChange) return `${input.allocationChange.id}:${input.allocationChange.legIndex}`;
    return [
      input.moveFrom,
      input.moveTo,
      input.externalAddress?.trim() ?? '',
      input.assetsToMove[MoveToken.ARGN]?.toString() ?? '',
      input.assetsToMove[MoveToken.ARGNOT]?.toString() ?? '',
      input.workflow ?? '',
    ].join(':');
  }

  protected matches(input: BalanceTransferInput, txInfo: TransactionInfo<ITransactionMoveMetadata>): boolean {
    const metadata = txInfo.tx.metadataJson;
    if (!metadata) return false;
    if (input.allocationChange) {
      return (
        metadata.allocationChange?.id === input.allocationChange.id &&
        metadata.allocationChange.legIndex === input.allocationChange.legIndex
      );
    }
    return (
      metadata.moveFrom === input.moveFrom &&
      metadata.moveTo === input.moveTo &&
      metadata.externalAddress === (input.moveTo === MoveTo.External ? input.externalAddress?.trim() : undefined) &&
      (metadata.assetsToMove[MoveToken.ARGN] ?? 0n) === (input.assetsToMove[MoveToken.ARGN] ?? 0n) &&
      (metadata.assetsToMove[MoveToken.ARGNOT] ?? 0n) === (input.assetsToMove[MoveToken.ARGNOT] ?? 0n) &&
      metadata.workflow === input.workflow
    );
  }

  protected ownsTransaction(txInfo: TransactionInfo<ITransactionMoveMetadata>): boolean {
    return Boolean(txInfo.tx.metadataJson?.assetsToMove) && (this.options.ownsTransfer?.(txInfo) ?? true);
  }

  protected createInsufficientFundsError(
    _prepared: PreparedTransactionOperation<ITransactionMoveMetadata, BalanceTransferBuild>,
  ): Error {
    return new Error('Your wallet does not have enough ARGN to complete this move and pay the network fee.');
  }

  private createTransactions(
    client: ArgonClient,
    destinationAddress: string,
    assetsToMove: ITransactionMoveMetadata['assetsToMove'],
  ): SubmittableExtrinsic[] {
    const txs: SubmittableExtrinsic[] = [];
    const microgons = assetsToMove[MoveToken.ARGN];
    const micronots = assetsToMove[MoveToken.ARGNOT];
    if (microgons) txs.push(client.tx.balances.transferAllowDeath(destinationAddress, microgons));
    if (micronots) txs.push(client.tx.ownership.transferAllowDeath(destinationAddress, micronots));
    return txs;
  }

  private getDestinationAddress(input: BalanceTransferInput): string {
    if (input.moveTo === MoveTo.DefaultArgon) return this.walletKeys.defaultArgonAddress;
    if (input.moveTo === MoveTo.MiningBot) return this.walletKeys.miningBotAddress;

    const address = input.externalAddress?.trim() ?? '';
    if (!isValidArgonAccountAddress(address)) throw new Error('Enter a valid Argon address.');
    return address;
  }

  private async getSigner(moveFrom: BalanceTransferInput['moveFrom']): Promise<TxSigningAccount> {
    if (moveFrom === MoveFrom.MiningBot) return await this.walletKeys.getMiningBotKeypair();
    if (moveFrom === MoveFrom.DefaultArgon) return await this.walletKeys.getDefaultArgonKeypair();
    throw new Error(`A signer is required for ${moveFrom} transfers.`);
  }
}
