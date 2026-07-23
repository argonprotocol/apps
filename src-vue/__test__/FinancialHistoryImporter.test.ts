import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountActivityKind } from '@argonprotocol/apps-core';
import { needsFinancialHistoryRecovery, restoreFinancialHistory } from '../lib/recovery/index.ts';
import { findAddressActivity } from '../lib/IndexerClient.ts';
import { SyncStateKeys } from '../lib/db/SyncStateTable.ts';
import { optionCodec } from '../../core/__test__/helpers/codecs.ts';

vi.mock('../lib/IndexerClient.ts', () => ({ findAddressActivity: vi.fn() }));

afterEach(() => vi.mocked(findAddressActivity).mockReset());

describe('FinancialHistoryImporter', () => {
  it('initializes recovery when an enabled domain trails the finalized target', async () => {
    const db = {
      syncStateTable: {
        get: vi.fn(async () => ({
          accountId: '5owner',
          asOfBlock: 99,
          domains: ['bonds'],
          domainCheckpoints: {
            bonds: { asOfBlock: 99, definitionVersion: 2, recoveryVersion: 1 },
          },
        })),
      },
    } as any;

    await expect(
      needsFinancialHistoryRecovery({
        db,
        accountId: '5owner',
        enabledDomains: ['bonds'],
        targetBlock: 100,
      }),
    ).resolves.toBe(true);
    await expect(
      needsFinancialHistoryRecovery({
        db,
        accountId: '5owner',
        enabledDomains: ['bonds'],
        targetBlock: 99,
      }),
    ).resolves.toBe(false);
  });

  it('initializes Bitcoin recovery when a loaded lock is still quarantined', async () => {
    const db = {
      syncStateTable: {
        get: vi.fn(async () => ({
          accountId: '5owner',
          asOfBlock: 100,
          domains: ['bitcoin'],
          domainCheckpoints: {
            bitcoin: { asOfBlock: 100, definitionVersion: 2, recoveryVersion: 3 },
          },
        })),
      },
    } as any;

    await expect(
      needsFinancialHistoryRecovery({
        db,
        accountId: '5owner',
        enabledDomains: ['bitcoin'],
        targetBlock: 100,
        bitcoinLockRecovery: { hasPendingHistoryRecovery: true } as any,
      }),
    ).resolves.toBe(true);
  });

  it('skips the v2 activity lookup when the saved checkpoint already covers finalized progress', async () => {
    const getCheckpoint = vi.fn(async () => ({
      accountId: '5owner',
      asOfBlock: 100,
      definitionVersion: 2,
      recoveryVersions: { bonds: 1 },
      domains: ['bonds'] as const,
    }));
    const onCheckStart = vi.fn();

    await expect(
      restoreFinancialHistory({
        db: { syncStateTable: { get: getCheckpoint } } as any,
        blockWatch: {} as any,
        accountId: '5owner',
        argonBonds: {} as any,
        vaultHistory: {} as any,
        enabledDomains: ['bonds'],
        minimumAsOfBlock: 100,
        onCheckStart,
      }),
    ).resolves.toEqual({ importedBlockCount: 0, asOfBlock: 100, targetBlock: 100 });
    expect(getCheckpoint).toHaveBeenCalledOnce();
    expect(onCheckStart).not.toHaveBeenCalled();
  });

  it('replays a loaded Bitcoin recovery even when its checkpoint is current', async () => {
    const upsert = vi.fn(async () => undefined);
    const beginHistoryReplay = vi.fn();
    const commitHistoryReplay = vi.fn();
    vi.mocked(findAddressActivity).mockResolvedValueOnce({
      asOfBlock: 100,
      definitionVersion: 2,
      blocks: [],
      coverage: { fromBlock: 100, toBlock: 100, gaps: [] },
    });

    await restoreFinancialHistory({
      db: {
        syncStateTable: {
          get: vi.fn(async () => ({
            accountId: '5owner',
            asOfBlock: 100,
            domains: ['bitcoin'],
            domainCheckpoints: {
              bitcoin: { asOfBlock: 100, definitionVersion: 2, recoveryVersion: 3 },
            },
          })),
          upsert,
        },
      } as any,
      blockWatch: {
        finalizedBlockHeader: { blockNumber: 100 },
        getFinalizedApi: vi.fn(async () => ({})),
      } as any,
      accountId: '5owner',
      argonBonds: {} as any,
      bitcoinLockRecovery: {
        hasPendingHistoryRecovery: true,
        beginHistoryReplay,
        findMissingActiveLockIds: vi.fn(async () => []),
        commitHistoryReplay,
        cancelHistoryReplay: vi.fn(),
      } as any,
      vaultHistory: {} as any,
      enabledDomains: ['bitcoin'],
      minimumAsOfBlock: 100,
    });

    expect(findAddressActivity).toHaveBeenCalledWith('5owner', {
      afterBlock: 0,
      toBlock: 100,
      activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
    });
    expect(beginHistoryReplay).toHaveBeenCalledWith({ recoverExistingLocks: true });
    expect(commitHistoryReplay).toHaveBeenCalledWith(true);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('returns the minimum safe checkpoint across enabled financial domains', async () => {
    await expect(
      restoreFinancialHistory({
        db: {
          syncStateTable: {
            get: vi.fn(async () => ({
              accountId: '5owner',
              asOfBlock: 100,
              domains: ['bonds', 'vaulting'],
              domainCheckpoints: {
                bonds: { asOfBlock: 110, definitionVersion: 2, recoveryVersion: 1 },
                vaulting: { asOfBlock: 100, definitionVersion: 2 },
              },
            })),
          },
        } as any,
        blockWatch: {} as any,
        accountId: '5owner',
        argonBonds: {} as any,
        vaultHistory: {} as any,
        enabledDomains: ['bonds', 'vaulting'],
        minimumAsOfBlock: 100,
      }),
    ).resolves.toEqual({ importedBlockCount: 0, asOfBlock: 100, targetBlock: 100 });

    expect(findAddressActivity).not.toHaveBeenCalled();
  });

  it('restores only a newly enabled financial history domain', async () => {
    const upsert = vi.fn(async () => undefined);
    vi.mocked(findAddressActivity).mockResolvedValueOnce({
      asOfBlock: 100,
      definitionVersion: 2,
      blocks: [],
      coverage: { fromBlock: 0, toBlock: 100, gaps: [] },
    });

    await restoreFinancialHistory({
      db: {
        syncStateTable: {
          get: vi.fn(async () => ({
            accountId: '5owner',
            asOfBlock: 100,
            definitionVersion: 2,
            recoveryVersions: { bonds: 1 },
            domains: ['bonds'],
          })),
          upsert,
        },
        vaultCapitalHistoryTable: { fetchAll: vi.fn(async () => []) },
      } as any,
      blockWatch: {
        finalizedBlockHeader: { blockNumber: 100 },
        getFinalizedApi: vi.fn(async () => ({
          query: { vaults: { vaultIdByOperator: vi.fn(async () => optionCodec()) } },
        })),
      } as any,
      accountId: '5owner',
      argonBonds: { data: { bondLots: [] }, importHistoryBlock: vi.fn() } as any,
      vaultHistory: { importBlock: vi.fn() } as any,
      enabledDomains: ['bonds', 'vaulting'],
      minimumAsOfBlock: 100,
    });

    expect(findAddressActivity).toHaveBeenCalledOnce();
    expect(findAddressActivity).toHaveBeenCalledWith('5owner', {
      afterBlock: 0,
      toBlock: 100,
      activityMask: AccountActivityKind.VaultPosition | AccountActivityKind.VaultRevenue,
    });
    expect(upsert).toHaveBeenCalledWith(
      SyncStateKeys.FinancialHistory,
      expect.objectContaining({
        domainCheckpoints: {
          bonds: { asOfBlock: 100, definitionVersion: 2, recoveryVersion: 1 },
          vaulting: { asOfBlock: 100, definitionVersion: 2 },
        },
      }),
    );
  });

  it('preserves a successful domain checkpoint when another domain fails', async () => {
    const upsert = vi.fn(async () => undefined);
    const beginHistoryReplay = vi.fn();
    const recoverBlock = vi.fn(async () => {
      throw new Error('archive unavailable');
    });
    const commitHistoryReplay = vi.fn();
    const cancelHistoryReplay = vi.fn();
    vi.mocked(findAddressActivity)
      .mockResolvedValueOnce({
        asOfBlock: 10,
        definitionVersion: 2,
        blocks: [
          {
            blockNumber: 6,
            blockHash: '0x6',
            specVersion: 151,
            activityMask: AccountActivityKind.BondPosition,
          },
        ],
        coverage: { fromBlock: 0, toBlock: 10, gaps: [] },
      })
      .mockResolvedValueOnce({
        asOfBlock: 10,
        definitionVersion: 2,
        blocks: [
          {
            blockNumber: 7,
            blockHash: '0x7',
            specVersion: 151,
            activityMask: AccountActivityKind.BitcoinLock,
          },
        ],
        coverage: { fromBlock: 0, toBlock: 10, gaps: [] },
      });

    await expect(
      restoreFinancialHistory({
        db: {
          syncStateTable: { get: vi.fn(async () => null), upsert },
          bondLotHistoryTable: { fetchAll: vi.fn(async () => []) },
        } as any,
        blockWatch: {
          finalizedBlockHeader: { blockNumber: 10 },
          getHeader: vi.fn(async (blockNumber: number) => ({ blockNumber, blockHash: `0x${blockNumber}` })),
          getEventsWithSpec: vi.fn(async () => ({ events: [], specVersion: 151 })),
        } as any,
        accountId: '5owner',
        argonBonds: {
          data: { bondLots: [] },
          importHistoryBlock: vi.fn(async () => undefined),
          refreshHistory: vi.fn(async () => undefined),
        } as any,
        bitcoinLockRecovery: {
          beginHistoryReplay,
          recoverBlock,
          commitHistoryReplay,
          cancelHistoryReplay,
        } as any,
        vaultHistory: {} as any,
        enabledDomains: ['bonds', 'bitcoin'],
        minimumAsOfBlock: 10,
      }),
    ).rejects.toThrow('Bitcoin lock history failed at block 7: archive unavailable');

    expect(upsert).toHaveBeenCalledWith(
      SyncStateKeys.FinancialHistory,
      expect.objectContaining({
        domainCheckpoints: { bonds: { asOfBlock: 10, definitionVersion: 2, recoveryVersion: 1 } },
      }),
    );
    expect(beginHistoryReplay).toHaveBeenCalledOnce();
    expect(commitHistoryReplay).not.toHaveBeenCalled();
    expect(cancelHistoryReplay).toHaveBeenCalledOnce();
    expect(beginHistoryReplay.mock.invocationCallOrder[0]).toBeLessThan(recoverBlock.mock.invocationCallOrder[0]);
    expect(recoverBlock.mock.invocationCallOrder[0]).toBeLessThan(cancelHistoryReplay.mock.invocationCallOrder[0]);
  });

  it('replays only index-selected Bitcoin blocks when its app recovery version changes', async () => {
    const beginHistoryReplay = vi.fn();
    const recoverBlock = vi.fn(async () => undefined);
    const upsert = vi.fn(async () => undefined);
    const commitHistoryReplay = vi.fn();
    const cancelHistoryReplay = vi.fn();
    vi.mocked(findAddressActivity).mockResolvedValueOnce({
      asOfBlock: 100,
      definitionVersion: 2,
      blocks: [
        {
          blockNumber: 80,
          blockHash: '0x80',
          specVersion: 151,
          activityMask: AccountActivityKind.BitcoinLock,
        },
      ],
      coverage: { fromBlock: 0, toBlock: 100, gaps: [] },
    });

    await restoreFinancialHistory({
      db: {
        syncStateTable: {
          get: vi.fn(async () => ({
            accountId: '5owner',
            asOfBlock: 100,
            definitionVersion: 2,
            domains: ['bitcoin'],
            domainCheckpoints: {
              bitcoin: { asOfBlock: 100, definitionVersion: 2, recoveryVersion: 1 },
            },
          })),
          upsert,
        },
      } as any,
      blockWatch: {
        finalizedBlockHeader: { blockNumber: 100 },
        getFinalizedApi: vi.fn(async () => ({})),
        getHeader: vi.fn(async () => ({ blockNumber: 80, blockHash: '0x80' })),
        getEventsWithSpec: vi.fn(async () => ({ events: [], specVersion: 151 })),
      } as any,
      accountId: '5owner',
      argonBonds: {} as any,
      bitcoinLockRecovery: {
        beginHistoryReplay,
        recoverBlock,
        findMissingActiveLockIds: vi.fn(async () => []),
        commitHistoryReplay,
        cancelHistoryReplay,
      } as any,
      vaultHistory: {} as any,
      enabledDomains: ['bitcoin'],
      minimumAsOfBlock: 100,
    });

    expect(findAddressActivity).toHaveBeenLastCalledWith('5owner', {
      afterBlock: 0,
      toBlock: 100,
      activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
    });
    expect(recoverBlock).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith(
      SyncStateKeys.FinancialHistory,
      expect.objectContaining({
        asOfBlock: 100,
        recoveryVersions: { bitcoin: 3 },
        domainCheckpoints: {
          bitcoin: { asOfBlock: 100, definitionVersion: 2, recoveryVersion: 3 },
        },
      }),
    );
    expect(beginHistoryReplay).toHaveBeenCalledOnce();
    expect(beginHistoryReplay).toHaveBeenCalledWith({ recoverExistingLocks: true });
    expect(commitHistoryReplay).toHaveBeenCalledOnce();
    expect(commitHistoryReplay).toHaveBeenCalledWith(true);
    expect(cancelHistoryReplay).not.toHaveBeenCalled();
    expect(beginHistoryReplay.mock.invocationCallOrder[0]).toBeLessThan(recoverBlock.mock.invocationCallOrder[0]);
    expect(recoverBlock.mock.invocationCallOrder[0]).toBeLessThan(commitHistoryReplay.mock.invocationCallOrder[0]);
    expect(commitHistoryReplay.mock.invocationCallOrder[0]).toBeLessThan(upsert.mock.invocationCallOrder[0]);
  });

  it('does not let another account checkpoint hide missing active bond history', async () => {
    const upsert = vi.fn();
    vi.mocked(findAddressActivity).mockResolvedValueOnce({
      asOfBlock: 100,
      definitionVersion: 2,
      blocks: [],
      coverage: { fromBlock: 0, toBlock: 100, gaps: [] },
    });

    await expect(
      restoreFinancialHistory({
        db: {
          syncStateTable: {
            get: vi.fn(async () => ({ accountId: '5previous', asOfBlock: 100, definitionVersion: 2 })),
            upsert,
          },
          vaultCapitalHistoryTable: { fetchAll: vi.fn(async () => []) },
          bondLotHistoryTable: { fetchAll: vi.fn(async () => []) },
        } as any,
        blockWatch: {
          finalizedBlockHeader: { blockNumber: 100 },
          getFinalizedApi: vi.fn(async () => ({
            query: { vaults: { vaultIdByOperator: vi.fn(async () => optionCodec()) } },
          })),
        } as any,
        accountId: '5owner',
        argonBonds: {
          data: { bondLots: [{ id: 7, programType: 'Argonot' }], bondHistory: [] },
          miningFrames: { earliestWithSpec: vi.fn(() => 0) },
          refreshHistory: vi.fn(),
        } as any,
        vaultHistory: {} as any,
        enabledDomains: ['bonds'],
        minimumAsOfBlock: 100,
      }),
    ).rejects.toThrow('not restored all active bond purchases');

    expect(findAddressActivity).toHaveBeenCalledWith('5owner', expect.objectContaining({ afterBlock: 0 }));
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not advance the financial checkpoint across an index coverage gap', async () => {
    const upsert = vi.fn();
    vi.mocked(findAddressActivity).mockResolvedValueOnce({
      asOfBlock: 90,
      definitionVersion: 2,
      blocks: [],
      coverage: { fromBlock: 0, toBlock: 90, gaps: [{ fromBlock: 50, toBlock: 60, reason: 'seed gap' }] },
    });

    await expect(
      restoreFinancialHistory({
        db: {
          syncStateTable: { get: vi.fn(async () => null), upsert },
          vaultCapitalHistoryTable: { fetchAll: vi.fn(async () => []) },
          bondLotHistoryTable: { fetchAll: vi.fn(async () => []) },
        } as any,
        blockWatch: {
          finalizedBlockHeader: { blockNumber: 100 },
          getFinalizedApi: vi.fn(async () => ({
            query: { vaults: { vaultIdByOperator: vi.fn(async () => optionCodec()) } },
          })),
        } as any,
        accountId: '5owner',
        argonBonds: { data: { bondLots: [], bondHistory: [] } } as any,
        vaultHistory: {} as any,
        enabledDomains: ['bonds'],
        minimumAsOfBlock: 100,
      }),
    ).rejects.toThrow('coverage gap from block 50 to 60');
    expect(upsert).not.toHaveBeenCalled();
  });
});
