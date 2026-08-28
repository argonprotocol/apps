import { describe, expect, it, vi } from 'vitest';
import { TxResult } from '../src/TxResult.ts';

describe('TxResult finalized subscription recovery', () => {
  it('keeps a finalized transaction pending when its block header is temporarily unavailable', async () => {
    const blockHash = Uint8Array.from([1, 2, 3]);
    const headerUnavailable = new Error('Unable to retrieve header and parent from supplied hash');
    const client = {
      rpc: {
        chain: {
          getHeader: vi
            .fn()
            .mockRejectedValueOnce(headerUnavailable)
            .mockResolvedValue({ number: { toNumber: () => 42 } }),
        },
      },
    };
    const result = {
      events: [],
      isFinalized: true,
      status: {
        isFinalized: true,
        asFinalized: blockHash,
      },
      txIndex: 3,
    };
    const txResult = new TxResult(client as any, {
      signedHash: '0x01',
      method: {},
      submittedTime: new Date(),
      submittedAtBlockNumber: 40,
      accountAddress: '5test',
      nonce: 1,
    });

    txResult.onSubscriptionResult(result as any);

    await vi.waitFor(() => expect(client.rpc.chain.getHeader).toHaveBeenCalledTimes(1));
    expect(txResult.submissionError).toBeUndefined();
    expect(txResult.isFinalized).toBe(false);

    txResult.onSubscriptionResult(result as any);

    await expect(txResult.waitForFinalizedBlock).resolves.toEqual(blockHash);
    expect(txResult.blockNumber).toBe(42);
  });
});
