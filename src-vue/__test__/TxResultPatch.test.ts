import { describe, expect, it, vi } from 'vitest';
import { TxResult, u8aEq } from '@argonprotocol/mainchain';

describe('TxResult patch', () => {
  it('waits to publish in-block until it has a real block number', async () => {
    const inBlockHash = Uint8Array.from([1, 2, 3]);
    const finalizedHash = Uint8Array.from([4, 5, 6]);
    const getHeader = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unable to retrieve header and parent from supplied hash'))
      .mockResolvedValue({
        number: {
          toNumber: () => 145,
        },
      });
    const txResult = createTxResult({
      rpc: {
        chain: {
          getHeader,
        },
      },
    });

    let inBlockHashResult: Uint8Array | undefined;
    void txResult.waitForInFirstBlock.then(hash => {
      inBlockHashResult = hash;
    });

    txResult.onSubscriptionResult({
      events: [],
      isFinalized: false,
      status: {
        isBroadcast: false,
        isDropped: false,
        isFinalized: false,
        isInBlock: true,
        asInBlock: inBlockHash,
        isInvalid: false,
        isUsurped: false,
      },
      txIndex: 4,
    } as any);

    await Promise.resolve();

    expect(getHeader).toHaveBeenCalledTimes(1);
    expect(inBlockHashResult).toBeUndefined();
    expect(txResult.blockHash).toBeUndefined();
    expect(txResult.blockNumber).toBeUndefined();

    txResult.onSubscriptionResult({
      events: [],
      isFinalized: true,
      status: {
        isBroadcast: false,
        isDropped: false,
        isFinalized: true,
        asFinalized: finalizedHash,
        isInBlock: false,
        isInvalid: false,
        isUsurped: false,
      },
      txIndex: 4,
    } as any);

    await expect(txResult.waitForInFirstBlock).resolves.toEqual(finalizedHash);
    await expect(txResult.waitForFinalizedBlock).resolves.toEqual(finalizedHash);

    expect(txResult.blockNumber).toBe(145);
    expect(txResult.extrinsicIndex).toBe(4);
    expect(txResult.blockHash).toEqual(finalizedHash);
  });

  it('publishes in-block immediately when given a real block number', async () => {
    const txResult = createTxResult();
    const blockHash = Uint8Array.from([7, 8, 9]);

    await txResult.setSeenInBlock({
      blockHash,
      blockNumber: 201,
      extrinsicIndex: 5,
      events: [],
    });

    await expect(txResult.waitForInFirstBlock).resolves.toEqual(blockHash);
    expect(txResult.blockNumber).toBe(201);
    expect(txResult.extrinsicIndex).toBe(5);
  });

  it('ignores a stale in-block lookup after finalized wins', async () => {
    const inBlockHash = Uint8Array.from([1, 2, 3]);
    const finalizedHash = Uint8Array.from([4, 5, 6]);
    let resolveInBlockHeader!: (value: unknown) => void;
    let resolveFinalizedHeader!: (value: unknown) => void;
    const getHeader = vi.fn().mockImplementation((hash: Uint8Array) => {
      if (u8aEq(hash, inBlockHash)) {
        return new Promise(resolve => {
          resolveInBlockHeader = resolve;
        });
      }

      if (u8aEq(hash, finalizedHash)) {
        return new Promise(resolve => {
          resolveFinalizedHeader = resolve;
        });
      }

      throw new Error('Unexpected hash');
    });
    const txResult = createTxResult({
      rpc: {
        chain: {
          getHeader,
        },
      },
    });

    txResult.onSubscriptionResult({
      events: [],
      isFinalized: false,
      status: {
        isBroadcast: false,
        isDropped: false,
        isFinalized: false,
        isInBlock: true,
        asInBlock: inBlockHash,
        isInvalid: false,
        isUsurped: false,
      },
      txIndex: 4,
    } as any);

    await Promise.resolve();

    txResult.onSubscriptionResult({
      events: [],
      isFinalized: true,
      status: {
        isBroadcast: false,
        isDropped: false,
        isFinalized: true,
        asFinalized: finalizedHash,
        isInBlock: false,
        isInvalid: false,
        isUsurped: false,
      },
      txIndex: 4,
    } as any);

    await Promise.resolve();

    resolveFinalizedHeader({
      number: {
        toNumber: () => 145,
      },
    });

    await expect(txResult.waitForInFirstBlock).resolves.toEqual(finalizedHash);
    await expect(txResult.waitForFinalizedBlock).resolves.toEqual(finalizedHash);
    expect(txResult.blockHash).toEqual(finalizedHash);
    expect(txResult.blockNumber).toBe(145);

    resolveInBlockHeader({
      number: {
        toNumber: () => 144,
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(txResult.blockHash).toEqual(finalizedHash);
    expect(txResult.blockNumber).toBe(145);
  });
});

function createTxResult(client: Record<string, unknown> = {}): TxResult {
  return new TxResult(
    {
      events: {
        system: { ExtrinsicFailed: { is: vi.fn().mockReturnValue(false) } },
        utility: { BatchInterrupted: { is: vi.fn().mockReturnValue(false) } },
        transactionPayment: { TransactionFeePaid: { is: vi.fn().mockReturnValue(false) } },
      },
      ...client,
    } as any,
    {
      signedHash: '0xtx',
      method: {},
      accountAddress: '5Submitter',
      submittedTime: new Date('2026-07-05T00:00:00.000Z'),
      submittedAtBlockNumber: 123,
      nonce: 7,
    },
  );
}
