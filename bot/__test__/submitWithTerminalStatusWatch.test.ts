import { describe, expect, it, vi } from 'vitest';
import {
  SubmissionStatusErrorCode,
  submitWithTerminalStatusWatch,
} from '../src/submitWithTerminalStatusWatch.ts';

describe('submitWithTerminalStatusWatch', () => {
  it('rejects the tx result when the node drops the transaction before inclusion', async () => {
    let onResult!: (result: unknown) => void;
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
      }),
    };
    const submitter = {
      address: '5SyncAccount',
      client: {
        rpc: {
          chain: {
            getHeader: vi.fn(async () => ({
              number: {
                toNumber: () => 123,
              },
            })),
          },
        },
      },
      sign: vi.fn(async () => signedTx),
    } as any;

    const { result, signedTx: returnedSignedTx } = await submitWithTerminalStatusWatch(submitter, {
      nonce: 7,
    });

    expect(returnedSignedTx).toBe(signedTx);

    onResult({
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
  });
});
