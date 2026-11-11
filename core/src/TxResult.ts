// Source: @argonprotocol/mainchain 1.4.12, the last release that exported this model.
import {
  type ExtrinsicError,
  type GenericEvent,
  TxSubmissionError,
  TxSubmissionErrorCode,
  u8aEq,
} from '@argonprotocol/mainchain';
import { toRuntimeEvent, type HistoricalEvent } from '@argonprotocol/runtime-client';
import type { ISubmittableResult } from '@polkadot/types/types/extrinsic';
import type { SubmittableResult } from '@polkadot/api';
import type { ArgonClient } from './MainchainClients.js';
import { runtimeDispatchErrorToExtrinsicError, type RuntimeDispatchError } from './RuntimeDispatchError.js';

type RuntimeEventInput = GenericEvent | HistoricalEvent;
export type RuntimeEvent = HistoricalEvent;

export type ITxProgressCallback = (progressToInBlock: number, result?: TxResult) => void;
export type ITxStatusCallback = (status: ISubmittableResult['status']) => void;

type IBlockInclusion = {
  blockHash: Uint8Array;
  blockNumber?: number;
  extrinsicIndex: number;
  events: RuntimeEventInput[];
};

type IPendingInBlock = Omit<IBlockInclusion, 'extrinsicIndex'> & { extrinsicIndex?: number };

export class TxResult {
  private broadcast = false;
  private submissionFailure?: Error;
  private pendingInBlock?: IPendingInBlock;

  public set isBroadcast(value: boolean) {
    this.broadcast = value;
    this.updateProgress();
  }

  public get isBroadcast(): boolean {
    return this.broadcast;
  }

  public set submissionError(value: Error) {
    if (value) {
      this.submissionFailure = value;
      this.finalizedReject(value);
      this.inBlockReject(value);
      this.updateProgress();
    }
  }

  public get submissionError(): Error | undefined {
    return this.submissionFailure;
  }

  public waitForFinalizedBlock: Promise<Uint8Array>;
  public waitForInFirstBlock: Promise<Uint8Array>;
  public events: RuntimeEvent[] = [];

  public extrinsicError: ExtrinsicError | Error | undefined;
  public extrinsicIndex: number | undefined;

  public txProgressCallback?: ITxProgressCallback;
  public txStatusCallback?: ITxStatusCallback;
  /**
   * The index of the batch that was interrupted, if any.
   */
  public batchInterruptedIndex?: number;
  public blockHash?: Uint8Array;
  public blockNumber?: number;
  /**
   * The final fee paid for the transaction, including the fee tip.
   */
  public finalFee?: bigint;
  /**
   * The fee tip paid for the transaction.
   */
  public finalFeeTip?: bigint;

  public txProgress = 0;
  public isFinalized = false;

  protected finalizedResolve!: (block: Uint8Array) => void;
  protected finalizedReject!: (error: ExtrinsicError | Error) => void;
  protected inBlockResolve!: (block: Uint8Array) => void;
  protected inBlockReject!: (error: ExtrinsicError | Error) => void;

  constructor(
    public extrinsic: {
      signedHash: string;
      method: any;
      submittedTime: Date;
      submittedAtBlockNumber: number;
      accountAddress: string;
      nonce: number;
      mortalityPeriod?: number;
    },
  ) {
    this.waitForFinalizedBlock = new Promise((resolve, reject) => {
      this.finalizedResolve = resolve;
      this.finalizedReject = reject;
    });
    this.waitForInFirstBlock = new Promise((resolve, reject) => {
      this.inBlockResolve = resolve;
      this.inBlockReject = reject;
    });
    // drown reject
    this.waitForFinalizedBlock.catch(() => null);
    this.waitForInFirstBlock.catch(() => null);
  }

  public async setSeenInBlock(client: ArgonClient, block: IBlockInclusion): Promise<void> {
    if (block.blockNumber === undefined) {
      this.pendingInBlock = {
        blockHash: block.blockHash,
        extrinsicIndex: block.extrinsicIndex,
        events: block.events,
      };
      return;
    }

    if (
      this.blockHash &&
      this.blockNumber === block.blockNumber &&
      this.extrinsicIndex === block.extrinsicIndex &&
      u8aEq(this.blockHash, block.blockHash)
    ) {
      this.pendingInBlock = undefined;
      return;
    }

    this.parseEvents(client, block.events);
    this.pendingInBlock = undefined;
    this.blockHash = block.blockHash;
    this.blockNumber = block.blockNumber;
    this.extrinsicIndex = block.extrinsicIndex;
    this.updateProgress();
    if (this.extrinsicError) {
      this.inBlockReject(this.extrinsicError);
    } else {
      this.inBlockResolve(block.blockHash);
    }
  }

  public async setFinalized(client: ArgonClient) {
    let pendingInBlock = this.pendingInBlock;
    if (!pendingInBlock && this.blockHash && this.blockNumber === undefined) {
      if (this.extrinsicIndex === undefined) {
        throw new Error('Cannot finalize transaction before extrinsic index is known');
      }

      pendingInBlock = {
        blockHash: this.blockHash,
        extrinsicIndex: this.extrinsicIndex,
        events: this.events,
      };
      this.pendingInBlock = pendingInBlock;
    }

    if (pendingInBlock) {
      try {
        const published = await this.publishSeenInBlock(client, pendingInBlock);
        if (!published && this.pendingInBlock === pendingInBlock) {
          throw new Error('The finalized transaction was not found in its reported block. Retry reconciliation.');
        }
      } catch (error) {
        if (this.pendingInBlock === pendingInBlock) throw error;
      }

      if (this.pendingInBlock) return;
      if (!this.blockHash) return;
      if (!u8aEq(this.blockHash, pendingInBlock.blockHash)) return;
    }

    this.publishFinalized();
  }

  public onSubscriptionResult(client: ArgonClient, result: SubmittableResult) {
    const { events, status, isFinalized, txIndex, blockNumber } = result;
    this.txStatusCallback?.(status);

    if (status.isBroadcast) {
      this.isBroadcast = true;
      if (result.internalError) this.submissionError = result.internalError;
    }
    if (status.isRetracted) {
      const retractedHash = Uint8Array.from(status.asRetracted);
      if (this.pendingInBlock && u8aEq(this.pendingInBlock.blockHash, retractedHash)) {
        this.pendingInBlock = undefined;
      }
      if (this.blockHash && u8aEq(this.blockHash, retractedHash)) {
        this.events = [];
        this.extrinsicError = undefined;
        this.extrinsicIndex = undefined;
        this.batchInterruptedIndex = undefined;
        this.blockHash = undefined;
        this.blockNumber = undefined;
        this.finalFee = undefined;
        this.finalFeeTip = undefined;
        this.updateProgress();
      }
    }
    if (status.isUsurped) {
      this.pendingInBlock = undefined;
      this.submissionError = new TxSubmissionError(
        TxSubmissionErrorCode.Usurped,
        `Transaction was usurped by ${status.asUsurped.toHex()}.`,
      );
    }
    if (status.isDropped) {
      this.pendingInBlock = undefined;
      this.submissionError = new TxSubmissionError(
        TxSubmissionErrorCode.Dropped,
        'Transaction was dropped before it was included in a block.',
      );
    }
    if (status.isInvalid) {
      this.pendingInBlock = undefined;
      this.submissionError = new TxSubmissionError(
        TxSubmissionErrorCode.Invalid,
        'Transaction was rejected as invalid by the node.',
      );
    }
    if (!status.isInBlock && !isFinalized) return;

    const pendingInBlock = {
      blockHash: Uint8Array.from(isFinalized ? status.asFinalized : status.asInBlock),
      blockNumber: blockNumber?.toNumber(),
      extrinsicIndex: txIndex,
      events: events.map(x => x.event),
    };
    this.pendingInBlock = pendingInBlock;

    if (isFinalized) {
      void this.setFinalized(client).catch(error => {
        if (this.pendingInBlock === pendingInBlock) {
          this.submissionError = error as Error;
          return;
        }
        if (this.pendingInBlock) return;
        if (!this.blockHash) return;
        if (!u8aEq(this.blockHash, pendingInBlock.blockHash)) return;
        this.publishFinalized();
      });
      return;
    }

    void this.publishSeenInBlock(client, pendingInBlock).catch(error => {
      if (this.pendingInBlock !== pendingInBlock) return;
      if (!isMissingBlockHeaderError(error)) this.submissionError = error as Error;
    });
  }

  private async publishSeenInBlock(client: ArgonClient, block: IPendingInBlock) {
    if (this.pendingInBlock !== block) return false;

    const { blockHash } = block;
    let { blockNumber, extrinsicIndex, events } = block;

    // A subscription can identify inclusion before Polkadot.js can load its events.
    if (extrinsicIndex === undefined) {
      const signedBlock = await client.rpc.chain.getBlock(blockHash);
      extrinsicIndex = signedBlock.block.extrinsics.findIndex(
        extrinsic => extrinsic.hash.toHex() === this.extrinsic.signedHash,
      );
      if (extrinsicIndex < 0) return false;

      blockNumber = signedBlock.block.header.number.toNumber();
      const snapshot = await client.at(blockHash);
      const records = await snapshot.query.system.events();
      events = records
        .filter(({ phase }) => phase.type === 'ApplyExtrinsic' && phase.value === extrinsicIndex)
        .map(({ event }) => event);
    }

    blockNumber ??= await client.rpc.chain.getHeader(blockHash).then(h => h.number.toNumber());
    if (this.pendingInBlock !== block) return false;

    await this.setSeenInBlock(client, {
      blockHash,
      blockNumber,
      extrinsicIndex,
      events,
    });
    return true;
  }

  private publishFinalized(): void {
    this.isFinalized = true;
    this.updateProgress();

    let error = this.extrinsicError ?? this.submissionError;
    if (!error && !this.blockHash) {
      error = new Error('Cannot finalize transaction before it is included in a block');
    }

    if (error) {
      this.finalizedReject(error);
      this.inBlockReject(error);
    } else {
      this.finalizedResolve(this.blockHash!);
      this.inBlockResolve(this.blockHash!);
    }
  }

  private updateProgress() {
    if (this.isFinalized || this.submissionError) {
      this.txProgress = 100;
    } else if (this.blockNumber) {
      const elapsedBlocks = this.blockNumber - this.extrinsic.submittedAtBlockNumber;
      const FINALIZATION_BLOCKS = 5;
      const remainingPercent = Math.max(0, FINALIZATION_BLOCKS - elapsedBlocks) * 20;
      const percent = 100 - remainingPercent;
      this.txProgress = Math.min(percent, 99);
    } else if (this.extrinsic.submittedAtBlockNumber) {
      this.txProgress = 10;
    }
    this.txProgressCallback?.(this.txProgress);
  }

  private parseEvents(client: ArgonClient, events: RuntimeEventInput[]) {
    const runtimeEvents = events.flatMap(event => toRuntimeEvent(event) ?? []);
    let encounteredError: RuntimeDispatchError | undefined;
    for (const event of runtimeEvents) {
      if (event.section === 'system' && event.method === 'ExtrinsicFailed') {
        encounteredError ??= event.data.dispatchError;
      } else if (event.section === 'utility' && event.method === 'BatchInterrupted') {
        this.batchInterruptedIndex = event.data.index;
        encounteredError = event.data.error;
      } else if (event.section === 'sudo' && (event.method === 'Sudid' || event.method === 'SudoAsDone')) {
        const { sudoResult } = event.data;
        if (sudoResult.type === 'Err') encounteredError ??= sudoResult.value;
      } else if (event.section === 'transactionPayment' && event.method === 'TransactionFeePaid') {
        this.finalFee = event.data.actualFee;
        this.finalFeeTip = event.data.tip;
      }
    }
    if (encounteredError) {
      this.extrinsicError = runtimeDispatchErrorToExtrinsicError(
        client,
        encounteredError,
        this.batchInterruptedIndex,
        this.finalFee,
      );
    } else {
      this.extrinsicError = undefined;
    }
    this.events = runtimeEvents;
  }
}

function isMissingBlockHeaderError(error: unknown) {
  return String(error).includes('Unable to retrieve header and parent from supplied hash');
}
