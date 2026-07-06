import { type ArgonClient, TxResult, TxSubmissionError, TxSubmissionErrorCode, u8aEq } from '@argonprotocol/mainchain';

const isPatched = Symbol('argon.tx-result-patched');
const pendingInBlock = Symbol('argon.tx-result-pending-in-block');

type IPendingInBlock = Omit<Parameters<TxResult['setSeenInBlock']>[0], 'blockNumber'>;
type TxResultWithPending = TxResult & { [pendingInBlock]?: IPendingInBlock };

const txResultPrototype = TxResult.prototype as TxResultWithPending & {
  [isPatched]?: boolean;
};

const originalSetSeenInBlock = Object.getOwnPropertyDescriptor(txResultPrototype, 'setSeenInBlock')
  ?.value as TxResult['setSeenInBlock'];
const originalSetFinalized = Object.getOwnPropertyDescriptor(txResultPrototype, 'setFinalized')
  ?.value as TxResult['setFinalized'];

export function patchTxResult() {
  if (txResultPrototype[isPatched]) {
    return;
  }
  txResultPrototype[isPatched] = true;

  TxResult.prototype.setSeenInBlock = async function (this: TxResultWithPending, block) {
    if (block.blockNumber === undefined) {
      this[pendingInBlock] = {
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
      delete this[pendingInBlock];
      return;
    }

    delete this[pendingInBlock];
    await originalSetSeenInBlock.call(this, block);
  };

  TxResult.prototype.setFinalized = function (this: TxResultWithPending) {
    void finalizeTxResult(this).catch(error => {
      this.submissionError = error as Error;
    });
  };

  TxResult.prototype.onSubscriptionResult = function (this: TxResultWithPending, result) {
    const { events, status, isFinalized, txIndex } = result;
    const extrinsicEvents = events.map(x => x.event);

    if (status.isBroadcast) {
      this.isBroadcast = true;
      if (result.internalError) this.submissionError = result.internalError;
    }

    if (status.isInBlock) {
      const pending = createPendingInBlock(Uint8Array.from(status.asInBlock), txIndex, extrinsicEvents);
      this[pendingInBlock] = pending;

      void publishSeenInBlock(this, pending).catch(error => {
        if (!isMissingBlockHeaderError(error)) {
          this.submissionError = error as Error;
        }
      });
    }

    if (status.isUsurped) {
      delete this[pendingInBlock];
      this.submissionError = new TxSubmissionError(
        TxSubmissionErrorCode.Usurped,
        `Transaction was usurped by ${status.asUsurped.toHex()}.`,
      );
    }

    if (status.isDropped) {
      delete this[pendingInBlock];
      this.submissionError = new TxSubmissionError(
        TxSubmissionErrorCode.Dropped,
        'Transaction was dropped before it was included in a block.',
      );
    }

    if (status.isInvalid) {
      delete this[pendingInBlock];
      this.submissionError = new TxSubmissionError(
        TxSubmissionErrorCode.Invalid,
        'Transaction was rejected as invalid by the node.',
      );
    }

    if (isFinalized) {
      this[pendingInBlock] = createPendingInBlock(Uint8Array.from(status.asFinalized), txIndex, extrinsicEvents);
      this.setFinalized();
    }
  };
}

function createPendingInBlock(
  blockHash: Uint8Array,
  txIndex: number | undefined,
  events: IPendingInBlock['events'],
): IPendingInBlock {
  if (txIndex === undefined) {
    throw new Error('Cannot publish transaction block state before extrinsic index is known');
  }

  return {
    blockHash,
    extrinsicIndex: txIndex,
    events,
  };
}

async function publishSeenInBlock(txResult: TxResultWithPending, block: IPendingInBlock) {
  const pending = txResult[pendingInBlock];
  if (!pending || pending.extrinsicIndex !== block.extrinsicIndex || !u8aEq(pending.blockHash, block.blockHash)) {
    return;
  }

  const client = (txResult as TxResult & { client: ArgonClient }).client;
  const blockNumber = await client.rpc.chain.getHeader(block.blockHash).then(x => x.number.toNumber());

  const currentPending = txResult[pendingInBlock];
  if (
    !currentPending ||
    currentPending.extrinsicIndex !== block.extrinsicIndex ||
    !u8aEq(currentPending.blockHash, block.blockHash)
  ) {
    return;
  }

  await txResult.setSeenInBlock({
    ...block,
    blockNumber,
  });
}

async function finalizeTxResult(txResult: TxResultWithPending) {
  const pending = txResult[pendingInBlock];
  if (pending) {
    await publishSeenInBlock(txResult, pending);
  } else if (txResult.blockHash && txResult.blockNumber === undefined) {
    if (txResult.extrinsicIndex === undefined) {
      throw new Error('Cannot finalize transaction before extrinsic index is known');
    }

    await publishSeenInBlock(txResult, {
      blockHash: txResult.blockHash,
      extrinsicIndex: txResult.extrinsicIndex,
      events: txResult.events,
    });
  }

  originalSetFinalized.call(txResult);
}

function isMissingBlockHeaderError(error: unknown) {
  return String(error).includes('Unable to retrieve header and parent from supplied hash');
}

patchTxResult();
