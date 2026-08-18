import { AccountActivityKind, createDeferred, MoveToken } from '@argonprotocol/apps-core';
import { describe, expect, it, vi } from 'vitest';
import { CrosschainHistory, type ICrosschainHistoryRecord } from '../lib/CrosschainHistory.ts';
import { FinancialCacheTypes, type FinancialCacheTable } from '../lib/db/FinancialCacheTable.ts';

describe('CrosschainHistory', () => {
  it('keeps loaded history visible when a refresh fails', async () => {
    const record = transferAuthorizationRecord();
    const history = new CrosschainHistory(
      { vaultingAddress: record.accountId },
      {
        start: vi.fn(async () => undefined),
        finalizedBlockHeader: { blockNumber: 12 },
      } as any,
      undefined,
      vi.fn(async () => {
        throw new Error('Indexer unavailable');
      }),
    );
    history.data.records = [record];

    const refreshPromise = history.refresh();

    expect(history.data.records).toMatchObject([record]);
    expect(history.data.isSyncing).toBe(true);

    await refreshPromise;

    expect(history.data.records).toMatchObject([record]);
    expect(history.data.error).toBe('Indexer unavailable');
  });

  it('restores cached history before refreshing from its saved block', async () => {
    const record = transferAuthorizationRecord();
    const findActivity = vi.fn(async () => {
      throw new Error('Indexer unavailable');
    });
    const getCachedHistory = vi.fn(async () => ({
      records: [record],
      definitionVersion: 3,
      refreshedThroughBlock: 10,
    }));
    const updateCachedHistory = vi.fn();
    const financialCache = Promise.resolve({
      get: getCachedHistory,
      upsert: updateCachedHistory,
    } as unknown as FinancialCacheTable);
    const history = new CrosschainHistory(
      { vaultingAddress: record.accountId },
      {
        start: vi.fn(async () => undefined),
        finalizedBlockHeader: { blockNumber: 12 },
      } as any,
      financialCache,
      findActivity,
    );

    await history.refresh();

    expect(getCachedHistory).toHaveBeenCalledWith(FinancialCacheTypes.CrosschainHistory, '5vault');
    expect(findActivity).toHaveBeenCalledWith('5vault', {
      afterBlock: 10,
      toBlock: 12,
      activityMask: AccountActivityKind.Fee,
    });
    expect(history.data.records).toEqual([record]);
    expect(history.data.error).toBe('Indexer unavailable');
    expect(updateCachedHistory).not.toHaveBeenCalled();
  });

  it('caches a complete refreshed history snapshot', async () => {
    const record = transferAuthorizationRecord();
    const updateCachedHistory = vi.fn(async () => undefined);
    const cache = {
      get: vi.fn(async () => undefined),
      upsert: updateCachedHistory,
    } as unknown as FinancialCacheTable;
    const history = new CrosschainHistory(
      { vaultingAddress: record.accountId },
      {
        start: vi.fn(async () => undefined),
        finalizedBlockHeader: { blockNumber: 12 },
      } as any,
      Promise.resolve(cache),
      vi.fn(async () => ({
        blocks: [],
        asOfBlock: 12,
        definitionVersion: 4,
        coverage: { fromBlock: 0, toBlock: 12, gaps: [] },
      })),
    );
    history.data.records = [record];

    await history.refresh();

    expect(updateCachedHistory).toHaveBeenCalledWith(FinancialCacheTypes.CrosschainHistory, '5vault', {
      records: [record],
      definitionVersion: 4,
      refreshedThroughBlock: 12,
    });
  });

  it('refreshes again when finalized state advances during an active refresh', async () => {
    const releaseFirstRefresh = createDeferred<void>();
    const finalizedBlockHeader = { blockNumber: 12 };
    const findActivity = vi
      .fn()
      .mockImplementationOnce(async () => {
        await releaseFirstRefresh.promise;
        return {
          blocks: [],
          asOfBlock: 12,
          definitionVersion: 4,
          coverage: { fromBlock: 0, toBlock: 12, gaps: [] },
        };
      })
      .mockResolvedValueOnce({
        blocks: [],
        asOfBlock: 13,
        definitionVersion: 4,
        coverage: { fromBlock: 12, toBlock: 13, gaps: [] },
      });
    const history = new CrosschainHistory(
      { vaultingAddress: '5vault' },
      {
        start: vi.fn(async () => undefined),
        finalizedBlockHeader,
      } as any,
      undefined,
      findActivity,
    );

    const firstRefresh = history.refresh();
    await vi.waitFor(() => expect(findActivity).toHaveBeenCalledTimes(1));
    finalizedBlockHeader.blockNumber = 13;
    const nextRefresh = history.refresh();
    releaseFirstRefresh.resolve();
    await Promise.all([firstRefresh, nextRefresh]);

    expect(findActivity).toHaveBeenNthCalledWith(1, '5vault', {
      afterBlock: 0,
      toBlock: 12,
      activityMask: AccountActivityKind.Fee,
    });
    expect(findActivity).toHaveBeenNthCalledWith(2, '5vault', {
      afterBlock: 12,
      toBlock: 13,
      activityMask: AccountActivityKind.Fee,
    });
    expect(history.data.coverageComplete).toBe(true);
  });

  it('only labels a recipient as previously seen after complete indexed coverage', () => {
    const record = transferAuthorizationRecord();
    const history = new CrosschainHistory({ vaultingAddress: record.accountId }, {} as any);
    history.data.records = [record];

    expect(
      history.hasSeenRecipient(
        record.details.kind === 'transferAuthorization' ? record.details.destinationAccount : '',
      ),
    ).toBeUndefined();

    history.data.coverageComplete = true;

    expect(history.hasSeenRecipient('0xrecipient')).toBe(true);
    expect(history.hasSeenRecipient('0xnew')).toBe(false);
  });

  it('totals each sponsored transfer once using the approved ARGNOT rate', () => {
    const argnTransfer = transferAuthorizationRecord();
    const transferDetails = argnTransfer.details as Extract<
      ICrosschainHistoryRecord['details'],
      { kind: 'transferAuthorization' }
    >;
    const duplicateArgnTransfer = {
      ...argnTransfer,
      id: '0xblock:3',
    };
    const argonotTransfer: ICrosschainHistoryRecord = {
      ...argnTransfer,
      id: '0xblock:4',
      details: {
        ...transferDetails,
        transferId: '0xargonot-transfer',
        moveToken: MoveToken.ARGNOT,
        amount: 2_000_000n,
      },
    };
    const history = new CrosschainHistory({ vaultingAddress: argnTransfer.accountId }, {} as any);
    history.data.records = [argnTransfer, duplicateArgnTransfer, argonotTransfer];

    expect(history.getSponsoredTransferValue(4_000_000n)).toBe(13_000_000n);
  });

  it('totals transfer tips without including minting-authority relay activity', () => {
    const firstAuthorization = transferAuthorizationRecord();
    const firstAuthorizationDetails = firstAuthorization.details as Extract<
      ICrosschainHistoryRecord['details'],
      { kind: 'transferAuthorization' }
    >;
    const secondAuthorization: ICrosschainHistoryRecord = {
      ...firstAuthorization,
      id: '0xblock:3',
      details: {
        ...firstAuthorizationDetails,
        transferId: '0xsecond-transfer',
        tip: 75_000n,
      },
    };
    const authorityRelay: ICrosschainHistoryRecord = {
      ...firstAuthorization,
      id: '0xblock:4',
      details: {
        kind: 'authorityLifecycle',
        action: 'registered',
        authoritySigningKey: '0xrelayed-authority',
        queueNonce: 4n,
      },
    };
    const legacyAuthorization: ICrosschainHistoryRecord = {
      ...firstAuthorization,
      id: '0xblock:5',
      details: {
        ...firstAuthorizationDetails,
        tip: undefined,
        reward: 25_000n,
        transferId: '0xlegacy-transfer',
      },
    };
    const history = new CrosschainHistory({ vaultingAddress: firstAuthorization.accountId }, {} as any);
    history.data.records = [firstAuthorization, secondAuthorization, authorityRelay, legacyAuthorization];

    expect(history.getTransferTips()).toBe(150_000n);
  });

  it('keeps this wallet council signatures in its crosschain history', async () => {
    const block = {
      blockNumber: 10,
      blockHash: '0xblock',
      blockTime: Date.parse('2026-08-15T12:00:00.000Z'),
    };
    const approvalEvent = (queueNonce: bigint, signer: string) => ({
      phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 1 } },
      event: {
        section: 'crosschainTransfer',
        method: 'QueueEntryApprovalRecorded',
        data: {
          approvalQueueNonce: { toBigInt: () => queueNonce },
          target: {
            isMintingAuthorityActivation: true,
            isMintingAuthorityDeactivation: false,
            isGlobalIssuanceCouncilRotation: false,
            asMintingAuthorityActivation: { toHex: () => signer },
          },
        },
      },
    });
    const events = [approvalEvent(1n, '0xauthority-one'), approvalEvent(2n, '0xauthority-two')];
    const api = {
      events: {
        crosschainTransfer: {
          QueueEntryApprovalRecorded: {
            is: (event: { method: string }) => event.method === 'QueueEntryApprovalRecorded',
          },
          TransferCollateralized: { is: () => false },
          MintingAuthorityRegistered: { is: () => false },
        },
      },
      query: {
        crosschainTransfer: {
          mintingAuthoritiesBySigner: vi.fn(async () => ({
            isSome: true,
            unwrap: () => ({ accountId: { toString: () => '5owner' } }),
          })),
        },
      },
    };
    const findActivity = vi
      .fn()
      .mockResolvedValueOnce({
        blocks: [{ blockNumber: 10, blockHash: '0xblock', specVersion: 157, activityMask: AccountActivityKind.Fee }],
        asOfBlock: 12,
        definitionVersion: 1,
        coverage: { fromBlock: 0, toBlock: 12, gaps: [] },
      })
      .mockResolvedValueOnce({
        blocks: [],
        asOfBlock: 12,
        definitionVersion: 1,
        coverage: { fromBlock: 12, toBlock: 12, gaps: [] },
      });
    const history = new CrosschainHistory(
      { vaultingAddress: '5vault' },
      {
        start: vi.fn(async () => undefined),
        finalizedBlockHeader: { blockNumber: 12 },
        getHeader: vi.fn(async () => block),
        getEventsWithSpec: vi.fn(async () => ({ api, events, specVersion: 157 })),
        getBlock: vi.fn(async () => ({
          block: {
            extrinsics: [undefined, { isSigned: true, signer: { toString: () => '5vault' } }],
          },
        })),
      } as any,
      undefined,
      findActivity,
    );

    await history.refresh();
    await history.refresh();

    expect(findActivity).toHaveBeenNthCalledWith(1, '5vault', {
      afterBlock: 0,
      toBlock: 12,
      activityMask: AccountActivityKind.Fee,
    });
    expect(findActivity).toHaveBeenNthCalledWith(2, '5vault', {
      afterBlock: 12,
      toBlock: 12,
      activityMask: AccountActivityKind.Fee,
    });
    expect(history.data.records).toMatchObject([
      {
        details: {
          kind: 'councilApproval',
          queueNonce: 2n,
          targetKind: 'mintingAuthorityActivation',
          targetValue: '0xauthority-two',
        },
      },
      {
        details: {
          kind: 'councilApproval',
          queueNonce: 1n,
          targetKind: 'mintingAuthorityActivation',
          targetValue: '0xauthority-one',
        },
      },
    ]);
    expect(history.data.coverageComplete).toBe(true);
  });
});

function transferAuthorizationRecord(): ICrosschainHistoryRecord {
  return {
    accountId: '5vault',
    id: '0xblock:2',
    blockNumber: 10,
    blockTime: new Date('2026-08-15T12:00:00.000Z'),
    extrinsicIndex: 1,
    eventIndex: 2,
    details: {
      kind: 'transferAuthorization',
      transferId: '0xtransfer',
      authoritySigningKey: '0xauthority',
      authorityOwnerAccount: '5vault',
      sourceAccount: '5source',
      destinationAccount: '0xrecipient',
      moveToken: MoveToken.ARGN,
      amount: 5_000_000n,
      tip: 50_000n,
      microgonCollateral: 10_000_000n,
      micronotCollateral: 1_000_000n,
    },
  };
}
