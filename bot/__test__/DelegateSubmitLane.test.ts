import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArgonClient } from '@argonprotocol/apps-core';
import { DelegateSubmitLane } from '../src/DelegateSubmitLane.ts';

const keypair = { address: 'delegate-account' } as any;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DelegateSubmitLane', () => {
  it('keeps the next submission queued until the previous nonce is two blocks deep', async () => {
    vi.useFakeTimers();
    const waitStartedAt = Date.now();
    const nonceState = {
      bestBlock: 102,
      pool: 5,
      nonceByBlock: new Map([
        [100, 4],
        [101, 4],
        [102, 4],
        [103, 5],
      ]),
    };
    const lane = new DelegateSubmitLane(keypair);
    lane.client = createClient(nonceState);

    const nonceAssigned = vi.fn();
    const submission = lane.runExclusive(async (_client, getNonce) => {
      const nonce = await getNonce();
      nonceAssigned(nonce);
      return nonce;
    });
    void submission.catch(() => undefined);
    const accountNextIndex = vi.mocked(lane.client.rpc.system.accountNextIndex);
    await vi.waitFor(() => expect(accountNextIndex).toHaveBeenCalledOnce());

    nonceState.bestBlock = 103;
    vi.setSystemTime(waitStartedAt + 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(nonceAssigned).not.toHaveBeenCalled();

    nonceState.bestBlock = 104;
    vi.setSystemTime(waitStartedAt + 120_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(nonceAssigned).not.toHaveBeenCalled();

    nonceState.bestBlock = 105;
    vi.setSystemTime(waitStartedAt + 180_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(submission).resolves.toBe(5);
  });

  it('reuses the stable nonce when an early reorg removes the previous transaction', async () => {
    vi.useFakeTimers();
    const nonceState = {
      bestBlock: 102,
      pool: 5,
      nonceByBlock: new Map([[100, 4]]),
    };
    const lane = new DelegateSubmitLane(keypair);
    lane.client = createClient(nonceState);

    const nonceAssigned = vi.fn();
    const submission = lane.runExclusive(async (_client, getNonce) => {
      const nonce = await getNonce();
      nonceAssigned(nonce);
      return nonce;
    });
    const accountNextIndex = vi.mocked(lane.client.rpc.system.accountNextIndex);
    await vi.waitFor(() => expect(accountNextIndex).toHaveBeenCalledOnce());
    expect(nonceAssigned).not.toHaveBeenCalled();

    nonceState.pool = 4;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(submission).resolves.toBe(4);
  });

  it('retries when stable block state is discarded during a reorg', async () => {
    vi.useFakeTimers();
    const nonceState = {
      bestBlock: 102,
      pool: 4,
      nonceByBlock: new Map([[100, 4]]),
    };
    const lane = new DelegateSubmitLane(keypair);
    lane.client = createClient(nonceState);
    const at = vi.spyOn(lane.client, 'at').mockRejectedValueOnce(new Error('4003: State already discarded'));

    const submission = lane.runExclusive(async (_client, getNonce) => await getNonce());
    void submission.catch(() => undefined);
    await vi.waitFor(() => expect(at).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(submission).resolves.toBe(4);
  });

  it('logs and rejects unexpected stable-state read failures', async () => {
    vi.useFakeTimers();
    const nonceState = {
      bestBlock: 102,
      pool: 4,
      nonceByBlock: new Map([[100, 4]]),
    };
    const lane = new DelegateSubmitLane(keypair);
    lane.client = createClient(nonceState);
    const error = new Error('Unexpected codec failure');
    const at = vi.spyOn(lane.client, 'at').mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const submission = lane.runExclusive(async (_client, getNonce) => await getNonce());
    void submission.catch(() => undefined);
    await vi.waitFor(() => expect(at).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(submission).rejects.toBe(error);
    expect(consoleError).toHaveBeenCalledWith('[DelegateSubmitLane] Failed to read delegate nonce state', error);
  });

  it('stops waiting and reports the last mismatched nonce snapshot', async () => {
    vi.useFakeTimers();
    const nonceState = {
      bestBlock: 102,
      pool: 5,
      nonceByBlock: new Map([[100, 4]]),
    };
    const lane = new DelegateSubmitLane(keypair);
    lane.client = createClient(nonceState);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const submission = lane.runExclusive(async (_client, getNonce) => await getNonce());
    const settled = vi.fn();
    void submission.then(settled, settled);
    const accountNextIndex = vi.mocked(lane.client.rpc.system.accountNextIndex);
    await vi.waitFor(() => expect(accountNextIndex).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(600_000);

    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    await expect(submission).rejects.toThrow(
      'Timed out after 600s waiting for delegate nonce to stabilize. ' +
        'Last observation: stable block 100 nonce 4, transaction pool next index 5.',
    );
  });

  it('times out a stalled state read and releases the next submission', async () => {
    vi.useFakeTimers();
    const nonceState = {
      bestBlock: 102,
      pool: 4,
      nonceByBlock: new Map([[100, 4]]),
    };
    const lane = new DelegateSubmitLane(keypair);
    lane.client = createClient(nonceState);
    const getHeader = vi.mocked(lane.client.rpc.chain.getHeader);
    getHeader.mockReturnValueOnce(new Promise<never>(() => undefined));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const stalledSubmission = lane.runExclusive(async (_client, getNonce) => await getNonce());
    const settled = vi.fn();
    void stalledSubmission.then(settled, settled);
    const nextSubmission = lane.runExclusive(async (_client, getNonce) => await getNonce());
    await vi.waitFor(() => expect(getHeader).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(600_000);

    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    await expect(stalledSubmission).rejects.toThrow(
      'Timed out after 600s waiting for delegate nonce to stabilize. ' +
        'Last observation: no nonce snapshot was available.',
    );
    await expect(nextSubmission).resolves.toBe(4);
  });
});

function createClient(nonceState: { bestBlock: number; pool: number; nonceByBlock: Map<number, number> }): ArgonClient {
  return {
    at: vi.fn(async (blockHash: string) => {
      const blockNumber = Number(blockHash.slice(2));
      return {
        query: {
          system: {
            account: vi.fn(async () => ({ nonce: nonceState.nonceByBlock.get(blockNumber) ?? 0 })),
          },
        },
      };
    }),
    rpc: {
      chain: {
        getHeader: vi.fn(async () => ({
          number: { toNumber: () => nonceState.bestBlock },
        })),
        getBlockHash: vi.fn(async (blockNumber: number) => `0x${blockNumber}`),
      },
      system: {
        accountNextIndex: vi.fn(async () => ({
          toNumber: () => nonceState.pool,
        })),
      },
    },
  } as unknown as ArgonClient;
}
