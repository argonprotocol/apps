import { describe, expect, it, vi } from 'vitest';
import { SubmissionStatusErrorCode, submitWithTerminalStatusWatch } from '../src/submitWithTerminalStatusWatch.ts';

describe('submitWithTerminalStatusWatch', () => {
  it('rejects the tx result when the node drops the transaction before inclusion', async () => {
    const harness = createSubmissionHarness();

    const { result, signedTx: returnedSignedTx } = await submitWithTerminalStatusWatch(harness.submitter, {
      nonce: 7,
    });

    expect(returnedSignedTx).toBe(harness.signedTx);

    harness.emitResult({
      events: [],
      isFinalized: false,
      status: {
        isBroadcast: false,
        isDropped: true,
        isInBlock: false,
        isInvalid: false,
        isUsurped: false,
      },
      txIndex: undefined,
    });

    await expect(result.waitForInFirstBlock).rejects.toMatchObject({
      code: SubmissionStatusErrorCode.Dropped,
    });
    await expect(result.waitForFinalizedBlock).rejects.toMatchObject({
      code: SubmissionStatusErrorCode.Dropped,
    });
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it('unsubscribes after the transaction is finalized', async () => {
    const harness = createSubmissionHarness();

    const { result } = await submitWithTerminalStatusWatch(harness.submitter, {
      nonce: 7,
    });

    harness.emitResult({
      events: [],
      isFinalized: false,
      status: {
        isBroadcast: false,
        isDropped: false,
        isInBlock: true,
        isInvalid: false,
        isUsurped: false,
        asInBlock: new Uint8Array([1, 2, 3]),
      },
      txIndex: 0,
    });

    await expect(result.waitForInFirstBlock).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    expect(harness.unsubscribe).not.toHaveBeenCalled();

    harness.emitResult({
      events: [],
      isFinalized: true,
      status: {
        isBroadcast: false,
        isDropped: false,
        isInBlock: false,
        isInvalid: false,
        isUsurped: false,
      },
      txIndex: 0,
    });

    await expect(result.waitForFinalizedBlock).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });
});

function createSubmissionHarness() {
  let onResult!: (result: unknown) => void;
  const unsubscribe = vi.fn();

  const blockNumber = {
    toNumber: () => 123,
  };
  const blockNumberAtInclusion = {
    toNumber: () => 124,
  };

  const client = {
    rpc: {
      chain: {
        getHeader: vi.fn(async (_blockHash?: Uint8Array) => ({
          number: _blockHash ? blockNumberAtInclusion : blockNumber,
        })),
      },
    },
    events: {
      system: {
        ExtrinsicFailed: { is: () => false },
      },
      utility: {
        BatchInterrupted: { is: () => false },
      },
      transactionPayment: {
        TransactionFeePaid: { is: () => false },
      },
    },
  };

  const signedTx = {
    hash: {
      toHex: () => '0xdropped',
    },
    method: {
      toHuman: () => ({ section: 'ethereumVerifier', method: 'submit' }),
    },
    nonce: {
      toNumber: () => 7,
    },
    send: vi.fn(async callback => {
      onResult = callback as (result: unknown) => void;
      return unsubscribe;
    }),
  };
  const submitter = {
    address: '5SyncAccount',
    client,
    sign: vi.fn(async () => signedTx),
  } as any;

  return {
    emitResult(result: unknown) {
      onResult(result);
    },
    signedTx,
    submitter,
    unsubscribe,
  };
}
