import {
  AccountActivityKind,
  NetworkConfig,
  setFetchImplementation,
  type IIndexerSpec,
} from '@argonprotocol/apps-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findAddressActivity } from '../lib/IndexerClient.ts';

describe('IndexerClient', () => {
  beforeEach(() => {
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', { indexerHost: 'https://indexer.test' });
  });

  afterEach(() => {
    vi.useRealTimers();
    setFetchImplementation();
    NetworkConfig.clearRuntimeOverride('dev-docker');
  });

  it('shares a pending account range lookup between the default wallet and financial history filters', async () => {
    vi.useFakeTimers();
    const walletMask =
      AccountActivityKind.Transfer | AccountActivityKind.Crosschain | AccountActivityKind.AccountBalance;
    const financialMask = AccountActivityKind.BondPosition;
    const indexedHistory = {
      blocks: [
        { blockNumber: 11, blockHash: '0x11', specVersion: 141, activityMask: AccountActivityKind.Transfer },
        { blockNumber: 12, blockHash: '0x12', specVersion: 141, activityMask: AccountActivityKind.BondPosition },
        {
          blockNumber: 13,
          blockHash: '0x13',
          specVersion: 141,
          activityMask: AccountActivityKind.Crosschain | AccountActivityKind.BondPosition,
        },
        { blockNumber: 14, blockHash: '0x14', specVersion: 141, activityMask: AccountActivityKind.AccountBalance },
        { blockNumber: 15, blockHash: '0x15', specVersion: 141, activityMask: AccountActivityKind.Fee },
      ],
      asOfBlock: 20,
      definitionVersion: 1,
      coverage: { fromBlock: 0, toBlock: 20, gaps: [] },
    } satisfies IIndexerSpec['/v2/activity/:address']['responseType'];
    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>(resolve => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn((_input: string | URL | Request) => pendingResponse);
    setFetchImplementation(fetchMock);

    const walletHistoryPromise = findAddressActivity('5shared', {
      afterBlock: 10,
      toBlock: 20,
      activityMask: walletMask,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    const financialHistoryPromise = findAddressActivity('5shared', {
      afterBlock: 10,
      toBlock: 20,
      activityMask: financialMask,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    resolveResponse(
      new Response(JSON.stringify(indexedHistory), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const [walletHistory, financialHistory] = await Promise.all([walletHistoryPromise, financialHistoryPromise]);
    const requestUrl = String(fetchMock.mock.calls[0][0]);
    const requestedMask = Number(new URL(requestUrl).searchParams.get('activityMask'));
    expect(requestedMask & AccountActivityKind.AccountBalance).toBe(AccountActivityKind.AccountBalance);
    expect(walletHistory.blocks.map(block => block.blockNumber)).toEqual([11, 13, 14]);
    expect(financialHistory.blocks.map(block => block.blockNumber)).toEqual([12, 13]);
  });

  it('keeps a standalone financial history lookup narrow', async () => {
    const financialMask = AccountActivityKind.BondPosition;
    const indexedHistory = {
      blocks: [{ blockNumber: 12, blockHash: '0x12', specVersion: 141, activityMask: financialMask }],
      asOfBlock: 20,
      definitionVersion: 1,
      coverage: { fromBlock: 0, toBlock: 20, gaps: [] },
    } satisfies IIndexerSpec['/v2/activity/:address']['responseType'];
    const fetchMock = vi.fn(async (_input: string | URL | Request) => {
      return new Response(JSON.stringify(indexedHistory));
    });
    setFetchImplementation(fetchMock);

    await findAddressActivity('5financial', {
      afterBlock: 10,
      toBlock: 20,
      activityMask: financialMask,
    });

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(Number(requestUrl.searchParams.get('activityMask'))).toBe(financialMask);
  });
});
