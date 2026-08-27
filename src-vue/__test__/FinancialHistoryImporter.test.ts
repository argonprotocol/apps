import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_ACTIVITY_DEFINITION_VERSION, AccountActivityKind } from '@argonprotocol/apps-core';
import {
  FinancialHistoryImporter,
  needsFinancialHistoryRecovery,
  restoreFinancialHistory,
} from '../lib/recovery/index.ts';
import { findAddressActivity } from '../lib/IndexerClient.ts';
import { SyncStateKeys } from '../lib/db/SyncStateTable.ts';
import { optionCodec } from '../../core/__test__/helpers/codecs.ts';

vi.mock('../lib/IndexerClient.ts', () => ({ findAddressActivity: vi.fn() }));

afterEach(() => vi.mocked(findAddressActivity).mockReset());

const withBackgroundArchiveRead = async <T>(read: () => Promise<T>): Promise<T> => await read();

describe('FinancialHistoryImporter', () => {
  it('retries an archive-overloaded batch one block at a time', async () => {
    let concurrentHeaderReads = 0;
    const recoveredBlockNumbers: number[] = [];
    const importer = new FinancialHistoryImporter({
      blockWatch: {
        withBackgroundArchiveRead,
        getHeader: async ({ blockNumber, blockHash }: { blockNumber: number; blockHash: string }) => {
          concurrentHeaderReads += 1;
          await Promise.resolve();
          const isOverloaded = concurrentHeaderReads > 1;
          concurrentHeaderReads -= 1;
          if (isOverloaded) throw new Error('archive overloaded');
          return { blockNumber, blockHash };
        },
        getEventsWithSpec: vi.fn(async () => ({ events: [], specVersion: 151 })),
      } as any,
      argonBonds: {} as any,
      vaultHistory: {} as any,
      enabledDomains: ['bitcoin'],
      bitcoinLockRecovery: {
        recoverBlock: async (block: { blockNumber: number }) => {
          recoveredBlockNumbers.push(block.blockNumber);
        },
      } as any,
    });

    const result = await importer.importBlocks([
      {
        blockNumber: 10,
        blockHash: '0x10',
        specVersion: 151,
        activityMask: AccountActivityKind.BitcoinLock,
      },
      {
        blockNumber: 11,
        blockHash: '0x11',
        specVersion: 151,
        activityMask: AccountActivityKind.BitcoinLock,
      },
    ]);

    expect(result).toEqual({ importedBlockCount: 2, domainErrors: {} });
    expect(recoveredBlockNumbers).toEqual([10, 11]);
  });

  it('continues recovering later blocks after one history block cannot be applied', async () => {
    const attemptedBlockNumbers: number[] = [];
    const recoveredBlockNumbers: number[] = [];
    const checkpoints: number[] = [];
    const markHistoryReplayFailure = vi.fn();
    const importer = new FinancialHistoryImporter({
      blockWatch: {
        withBackgroundArchiveRead,
        getHeader: vi.fn(async ({ blockNumber, blockHash }) => ({ blockNumber, blockHash })),
        getEventsWithSpec: vi.fn(async () => ({ events: [], specVersion: 151 })),
      } as any,
      argonBonds: {} as any,
      vaultHistory: {} as any,
      enabledDomains: ['bitcoin'],
      bitcoinLockRecovery: {
        markHistoryReplayFailure,
        recoverBlock: async (block: { blockNumber: number }) => {
          attemptedBlockNumbers.push(block.blockNumber);
          if (block.blockNumber === 21) throw new Error('historical event does not match the recovered lock');
          recoveredBlockNumbers.push(block.blockNumber);
        },
      } as any,
    });

    const result = await importer.importBlocks(
      [20, 21, 22].map(blockNumber => ({
        blockNumber,
        blockHash: `0x${blockNumber}`,
        specVersion: 151,
        activityMask: AccountActivityKind.BitcoinLock,
      })),
      {
        onCheckpoint: async blockNumber => {
          checkpoints.push(blockNumber);
        },
      },
    );

    expect(attemptedBlockNumbers).toEqual([20, 21, 22]);
    expect(recoveredBlockNumbers).toEqual([20, 22]);
    expect(markHistoryReplayFailure).toHaveBeenCalledOnce();
    expect(checkpoints).toEqual([20]);
    expect(result).toEqual({
      importedBlockCount: 2,
      domainErrors: {
        bitcoin: expect.stringContaining('historical event does not match the recovered lock'),
      },
      failedAtBlock: 21,
    });
  });

  it('initializes recovery only when an enabled domain has incomplete coverage', async () => {
    const get = vi.fn(async () => ({
      accountId: '5owner',
      asOfBlock: 99,
      domains: ['bonds'],
      domainCheckpoints: {
        bonds: {
          asOfBlock: 99,
          definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
          recoveryVersion: 1,
          partialRecovery: true,
        },
      },
    }));
    const db = {
      syncStateTable: {
        get,
      },
    } as any;

    await expect(
      needsFinancialHistoryRecovery({
        db,
        accountId: '5owner',
        enabledDomains: ['bonds'],
        recoverMissingCheckpointsFor: ['bonds'],
      }),
    ).resolves.toBe(true);

    get.mockResolvedValueOnce({
      accountId: '5owner',
      asOfBlock: 99,
      domains: ['bonds'],
      domainCheckpoints: {
        bonds: {
          asOfBlock: 99,
          definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
          recoveryVersion: 1,
          partialRecovery: false,
        },
      },
    });
    await expect(
      needsFinancialHistoryRecovery({
        db,
        accountId: '5owner',
        enabledDomains: ['bonds'],
        recoverMissingCheckpointsFor: ['bonds'],
      }),
    ).resolves.toBe(false);
  });

  it('recovers missing checkpoints only for selected domains', async () => {
    const db = {
      syncStateTable: {
        get: vi.fn(async () => undefined),
      },
    } as any;

    await expect(
      needsFinancialHistoryRecovery({
        db,
        accountId: '5owner',
        enabledDomains: ['bonds'],
        recoverMissingCheckpointsFor: ['vaulting'],
      }),
    ).resolves.toBe(false);
    await expect(
      needsFinancialHistoryRecovery({
        db,
        accountId: '5owner',
        enabledDomains: ['vaulting'],
        recoverMissingCheckpointsFor: ['vaulting'],
      }),
    ).resolves.toBe(true);
  });

  it('initializes Bitcoin recovery when a loaded lock is still quarantined', async () => {
    const db = {
      syncStateTable: {
        get: vi.fn(async () => ({
          accountId: '5owner',
          asOfBlock: 100,
          domains: ['bitcoin'],
          domainCheckpoints: {
            bitcoin: {
              asOfBlock: 100,
              definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
              recoveryVersion: 4,
            },
          },
        })),
      },
    } as any;

    await expect(
      needsFinancialHistoryRecovery({
        db,
        accountId: '5owner',
        enabledDomains: ['bitcoin'],
        bitcoinLockRecovery: { hasPendingHistoryRecovery: true } as any,
        recoverMissingCheckpointsFor: [],
      }),
    ).resolves.toBe(true);
  });

  it('rejects an older activity index before replaying quarantined Bitcoin history', async () => {
    vi.mocked(findAddressActivity).mockResolvedValueOnce({
      blocks: [],
      asOfBlock: 100,
      definitionVersion: 1,
      coverage: { fromBlock: 0, toBlock: 100, gaps: [] },
    });

    await expect(
      restoreFinancialHistory({
        db: {
          syncStateTable: {
            get: vi.fn(async () => ({
              accountId: '5owner',
              asOfBlock: 100,
              domains: ['bitcoin'],
              domainCheckpoints: {
                bitcoin: { asOfBlock: 100, definitionVersion: 1, recoveryVersion: 8 },
              },
            })),
            upsert: vi.fn(async () => undefined),
          },
        } as any,
        blockWatch: { getFinalizedApi: vi.fn(async () => ({})) } as any,
        accountId: '5owner',
        argonBonds: {} as any,
        bitcoinLockRecovery: {
          hasPendingHistoryRecovery: true,
          beginHistoryReplay: vi.fn(async () => undefined),
          commitHistoryReplay: vi.fn(async () => undefined),
          cancelHistoryReplay: vi.fn(async () => undefined),
          findMissingActiveLockIds: vi.fn(async () => []),
        } as any,
        vaultHistory: {} as any,
        enabledDomains: ['bitcoin'],
        recoverMissingCheckpointsFor: [],
        minimumAsOfBlock: 100,
      }),
    ).rejects.toThrow(
      `Activity index definition 1 is older than the minimum compatible definition ${ACCOUNT_ACTIVITY_DEFINITION_VERSION - 1}`,
    );
  });

  it('skips the activity lookup when the saved checkpoint already covers finalized progress', async () => {
    const getCheckpoint = vi.fn(async () => ({
      accountId: '5owner',
      asOfBlock: 100,
      definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
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
        recoverMissingCheckpointsFor: ['bonds'],
        minimumAsOfBlock: 100,
        onCheckStart,
      }),
    ).resolves.toEqual({ importedBlockCount: 0, asOfBlock: 100, targetBlock: 100 });
    expect(getCheckpoint).toHaveBeenCalledOnce();
    expect(onCheckStart).not.toHaveBeenCalled();
  });

  it('keeps a covered bond domain ready when pending Bitcoin recovery fails', async () => {
    const onDomainComplete = vi.fn();
    vi.mocked(findAddressActivity).mockRejectedValueOnce(new Error('indexer unavailable'));

    await expect(
      restoreFinancialHistory({
        db: {
          syncStateTable: {
            get: vi.fn(async () => ({
              accountId: '5owner',
              asOfBlock: 100,
              domains: ['bonds', 'bitcoin'],
              domainCheckpoints: {
                bonds: {
                  asOfBlock: 100,
                  definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
                  recoveryVersion: 1,
                },
                bitcoin: {
                  asOfBlock: 100,
                  definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
                  recoveryVersion: 8,
                },
              },
            })),
          },
        } as any,
        blockWatch: {} as any,
        accountId: '5owner',
        argonBonds: {} as any,
        bitcoinLockRecovery: {
          hasPendingHistoryRecovery: true,
          cancelHistoryReplay: vi.fn(async () => undefined),
        } as any,
        vaultHistory: {} as any,
        enabledDomains: ['bonds', 'bitcoin'],
        recoverMissingCheckpointsFor: [],
        minimumAsOfBlock: 100,
        onDomainComplete,
      }),
    ).rejects.toThrow('indexer unavailable');

    expect(onDomainComplete).toHaveBeenNthCalledWith(1, { domain: 'bonds', asOfBlock: 100 });
    expect(onDomainComplete).toHaveBeenNthCalledWith(2, {
      domain: 'bitcoin',
      asOfBlock: 100,
      error: 'indexer unavailable',
    });
  });

  it('retries incomplete incremental Bitcoin history from the beginning in the same recovery', async () => {
    const beginHistoryReplay = vi.fn();
    const commitHistoryReplay = vi.fn();
    const markHistoryReplayFailure = vi.fn();
    const recoverBlock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Bitcoin lock 44 pending mint exceeds recovered history'))
      .mockResolvedValue(undefined);
    vi.mocked(findAddressActivity)
      .mockResolvedValueOnce({
        asOfBlock: 100,
        definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
        blocks: [
          {
            blockNumber: 95,
            blockHash: '0x95',
            specVersion: 151,
            activityMask: AccountActivityKind.BitcoinMint,
          },
        ],
        coverage: { fromBlock: 90, toBlock: 100, gaps: [] },
      })
      .mockResolvedValueOnce({
        asOfBlock: 100,
        definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
        blocks: [
          {
            blockNumber: 10,
            blockHash: '0x10',
            specVersion: 151,
            activityMask: AccountActivityKind.BitcoinLock,
          },
          {
            blockNumber: 95,
            blockHash: '0x95',
            specVersion: 151,
            activityMask: AccountActivityKind.BitcoinMint,
          },
        ],
        coverage: { fromBlock: 0, toBlock: 100, gaps: [] },
      });

    await expect(
      restoreFinancialHistory({
        db: {
          syncStateTable: {
            get: vi.fn(async () => ({
              accountId: '5owner',
              asOfBlock: 90,
              domains: ['bitcoin'],
              domainCheckpoints: {
                bitcoin: {
                  asOfBlock: 90,
                  definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
                  recoveryVersion: 8,
                },
              },
            })),
            upsert: vi.fn(async () => undefined),
          },
        } as any,
        blockWatch: {
          finalizedBlockHeader: { blockNumber: 100 },
          withBackgroundArchiveRead,
          getHeader: vi.fn(async ({ blockNumber, blockHash }) => ({ blockNumber, blockHash })),
          getEventsWithSpec: vi.fn(async () => ({ events: [], specVersion: 151 })),
          getFinalizedApi: vi.fn(async () => ({})),
        } as any,
        accountId: '5owner',
        argonBonds: {} as any,
        bitcoinLockRecovery: {
          hasPendingHistoryRecovery: false,
          beginHistoryReplay,
          markHistoryReplayFailure,
          recoverBlock,
          findMissingActiveLockIds: vi.fn(async () => []),
          commitHistoryReplay,
          cancelHistoryReplay: vi.fn(),
        } as any,
        vaultHistory: {} as any,
        enabledDomains: ['bitcoin'],
        recoverMissingCheckpointsFor: ['bitcoin'],
        minimumAsOfBlock: 100,
      }),
    ).resolves.toEqual({ importedBlockCount: 2, asOfBlock: 100, targetBlock: 100 });

    expect(findAddressActivity).toHaveBeenNthCalledWith(1, '5owner', {
      afterBlock: 90,
      toBlock: 100,
      activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
    });
    expect(findAddressActivity).toHaveBeenNthCalledWith(2, '5owner', {
      afterBlock: 0,
      toBlock: 100,
      activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
    });
    expect(beginHistoryReplay).toHaveBeenNthCalledWith(1, { lockScope: 'encountered' });
    expect(beginHistoryReplay).toHaveBeenNthCalledWith(2, { lockScope: 'all' });
    expect(markHistoryReplayFailure).toHaveBeenCalledOnce();
    expect(commitHistoryReplay).toHaveBeenNthCalledWith(1, true);
    expect(commitHistoryReplay).toHaveBeenNthCalledWith(2, true);
  });

  it('repairs only pending Bitcoin locks when a fresh wallet has no recovery checkpoint', async () => {
    const upsert = vi.fn(async () => undefined);
    const beginHistoryReplay = vi.fn();
    const commitHistoryReplay = vi.fn();
    vi.mocked(findAddressActivity).mockResolvedValue({
      asOfBlock: 100,
      definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
      blocks: [],
      coverage: { fromBlock: 0, toBlock: 100, gaps: [] },
    });
    const restoreArgs = {
      db: {
        syncStateTable: { get: vi.fn(async () => undefined), upsert },
        bondLotHistoryTable: { fetchAll: vi.fn(async () => []) },
      } as any,
      blockWatch: {
        finalizedBlockHeader: { blockNumber: 100 },
        getFinalizedApi: vi.fn(async () => ({})),
      } as any,
      accountId: '5owner',
      argonBonds: { data: { bondLots: [] } } as any,
      bitcoinLockRecovery: {
        hasPendingHistoryRecovery: true,
        beginHistoryReplay,
        findMissingActiveLockIds: vi.fn(async () => []),
        commitHistoryReplay,
        cancelHistoryReplay: vi.fn(),
      } as any,
      vaultHistory: {} as any,
      enabledDomains: ['bitcoin', 'bonds'] as const,
      recoverMissingCheckpointsFor: [],
      minimumAsOfBlock: 100,
    };

    await restoreFinancialHistory(restoreArgs);

    expect(findAddressActivity).toHaveBeenCalledOnce();
    expect(beginHistoryReplay).toHaveBeenCalledWith({ lockScope: 'pending' });
    expect(commitHistoryReplay).toHaveBeenCalledWith(true);
    expect(upsert).toHaveBeenLastCalledWith(
      SyncStateKeys.FinancialHistory,
      expect.objectContaining({
        asOfBlock: 100,
        domains: ['bitcoin'],
        domainCheckpoints: {
          bitcoin: {
            asOfBlock: 100,
            definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
            recoveryVersion: 8,
          },
        },
      }),
    );
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
                bonds: {
                  asOfBlock: 110,
                  definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
                  recoveryVersion: 1,
                },
                vaulting: { asOfBlock: 100, definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION },
              },
            })),
          },
        } as any,
        blockWatch: {} as any,
        accountId: '5owner',
        argonBonds: {} as any,
        vaultHistory: {} as any,
        enabledDomains: ['bonds', 'vaulting'],
        recoverMissingCheckpointsFor: ['bonds', 'vaulting'],
        minimumAsOfBlock: 100,
      }),
    ).resolves.toEqual({ importedBlockCount: 0, asOfBlock: 100, targetBlock: 100 });

    expect(findAddressActivity).not.toHaveBeenCalled();
  });

  it('restores a newly enabled domain from the previous activity index definition', async () => {
    const upsert = vi.fn(async () => undefined);
    vi.mocked(findAddressActivity).mockResolvedValueOnce({
      asOfBlock: 100,
      definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION - 1,
      blocks: [],
      coverage: { fromBlock: 0, toBlock: 100, gaps: [] },
    });

    await restoreFinancialHistory({
      db: {
        syncStateTable: {
          get: vi.fn(async () => ({
            accountId: '5owner',
            asOfBlock: 100,
            definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
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
          query: { vaults: { vaultIdByOperator: vi.fn(async () => null) } },
        })),
      } as any,
      accountId: '5owner',
      argonBonds: { data: { bondLots: [] }, importHistoryBlock: vi.fn() } as any,
      vaultHistory: { importBlock: vi.fn() } as any,
      enabledDomains: ['bonds', 'vaulting'],
      recoverMissingCheckpointsFor: ['vaulting'],
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
          bonds: {
            asOfBlock: 100,
            definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
            recoveryVersion: 1,
          },
          vaulting: { asOfBlock: 100, definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION - 1 },
        },
      }),
    );
  });

  it('keeps active Bitcoin recovery ahead of history and fills creation details after history fails', async () => {
    const upsert = vi.fn(async () => undefined);
    const beginHistoryReplay = vi.fn();
    const recoverBlock = vi.fn(async () => undefined);
    const recoverActiveLocks = vi.fn(async () => [{ utxoId: 12 }]);
    const recoverActiveLockCreationDetails = vi.fn(async () => undefined);
    const commitHistoryReplay = vi.fn();
    const cancelHistoryReplay = vi.fn();
    vi.mocked(findAddressActivity)
      .mockResolvedValueOnce({
        asOfBlock: 10,
        definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
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
        definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
        blocks: [
          {
            blockNumber: 7,
            blockHash: '0x7',
            specVersion: 151,
            activityMask: AccountActivityKind.BitcoinLock,
          },
          {
            blockNumber: 9,
            blockHash: '0x9',
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
          withBackgroundArchiveRead,
          getHeader: vi.fn(async ({ blockNumber }: { blockNumber: number }) => {
            if (blockNumber === 9) throw new Error('archive unavailable');
            return { blockNumber, blockHash: `0x${blockNumber}` };
          }),
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
          recoverActiveLocks,
          recoverActiveLockCreationDetails,
          recoverBlock,
          commitHistoryReplay,
          cancelHistoryReplay,
        } as any,
        mainchainClients: {} as any,
        vaultHistory: {} as any,
        enabledDomains: ['bonds', 'bitcoin'],
        recoverMissingCheckpointsFor: ['bonds', 'bitcoin'],
        minimumAsOfBlock: 10,
      }),
    ).rejects.toThrow('Bitcoin lock history failed at block 9: archive unavailable');

    expect(upsert).toHaveBeenLastCalledWith(
      SyncStateKeys.FinancialHistory,
      expect.objectContaining({
        domainCheckpoints: {
          bonds: {
            asOfBlock: 10,
            definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
            recoveryVersion: 1,
          },
          bitcoin: {
            asOfBlock: 8,
            definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
            recoveryVersion: 8,
            partialRecovery: true,
          },
        },
      }),
    );
    expect(beginHistoryReplay).toHaveBeenCalledOnce();
    expect(recoverActiveLocks).toHaveBeenCalledOnce();
    expect(recoverActiveLocks.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(findAddressActivity).mock.invocationCallOrder[1],
    );
    expect(commitHistoryReplay).toHaveBeenCalledWith(true);
    expect(cancelHistoryReplay).toHaveBeenCalledOnce();
    expect(beginHistoryReplay.mock.invocationCallOrder[0]).toBeLessThan(recoverBlock.mock.invocationCallOrder[0]);
    expect(recoverBlock.mock.invocationCallOrder[0]).toBeLessThan(cancelHistoryReplay.mock.invocationCallOrder[0]);
    expect(recoverActiveLockCreationDetails).toHaveBeenCalledOnce();
  });

  it('replays only index-selected Bitcoin blocks when its app recovery version changes', async () => {
    const beginHistoryReplay = vi.fn();
    const recoverBlock = vi.fn(async () => undefined);
    const upsert = vi.fn(async () => undefined);
    const commitHistoryReplay = vi.fn();
    const cancelHistoryReplay = vi.fn();
    const onProgress = vi.fn();
    const onActiveBitcoinLocksFound = vi.fn();
    const recoverActiveLocks = vi.fn(async () => [{ utxoId: 12 }]);
    const recoverActiveLockCreationDetails = vi.fn(async () => undefined);
    const getEventsWithSpec = vi.fn(async () => ({ events: [], specVersion: 151 }));
    vi.mocked(findAddressActivity).mockResolvedValueOnce({
      asOfBlock: 100,
      definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
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
            definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
            domains: ['bitcoin'],
            domainCheckpoints: {
              bitcoin: {
                asOfBlock: 100,
                definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
                recoveryVersion: 5,
              },
            },
          })),
          upsert,
        },
      } as any,
      blockWatch: {
        finalizedBlockHeader: { blockNumber: 100 },
        withBackgroundArchiveRead,
        getFinalizedApi: vi.fn(async () => ({})),
        getHeader: vi.fn(async () => ({ blockNumber: 80, blockHash: '0x80' })),
        getEventsWithSpec,
      } as any,
      accountId: '5owner',
      argonBonds: {} as any,
      bitcoinLockRecovery: {
        beginHistoryReplay,
        recoverBlock,
        recoverActiveLocks,
        recoverActiveLockCreationDetails,
        findMissingActiveLockIds: vi.fn(async () => []),
        commitHistoryReplay,
        cancelHistoryReplay,
      } as any,
      mainchainClients: {} as any,
      vaultHistory: {} as any,
      enabledDomains: ['bitcoin'],
      recoverMissingCheckpointsFor: ['bitcoin'],
      minimumAsOfBlock: 100,
      onActiveBitcoinLocksFound,
      onProgress,
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
        recoveryVersions: { bitcoin: 8 },
        domainCheckpoints: {
          bitcoin: {
            asOfBlock: 100,
            definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
            recoveryVersion: 8,
          },
        },
      }),
    );
    expect(beginHistoryReplay).toHaveBeenCalledOnce();
    expect(beginHistoryReplay).toHaveBeenCalledWith({ lockScope: 'all' });
    expect(commitHistoryReplay).toHaveBeenCalledOnce();
    expect(commitHistoryReplay).toHaveBeenCalledWith(true);
    expect(cancelHistoryReplay).not.toHaveBeenCalled();
    expect(recoverActiveLockCreationDetails).not.toHaveBeenCalled();
    expect(onActiveBitcoinLocksFound).toHaveBeenCalledWith(1);
    expect(onProgress).toHaveBeenLastCalledWith(1, {
      domain: 'bitcoin',
      recoveredBlockCount: 1,
      totalBlockCount: 1,
    });
    expect(beginHistoryReplay.mock.invocationCallOrder[0]).toBeLessThan(recoverBlock.mock.invocationCallOrder[0]);
    expect(recoverActiveLocks.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(findAddressActivity).mock.invocationCallOrder[0],
    );
    expect(recoverBlock.mock.invocationCallOrder[0]).toBeLessThan(commitHistoryReplay.mock.invocationCallOrder[0]);
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(commitHistoryReplay.mock.invocationCallOrder[0]);
    expect(commitHistoryReplay.mock.invocationCallOrder[0]).toBeLessThan(upsert.mock.invocationCallOrder.at(-1)!);
  });

  it('does not let another account checkpoint hide missing active bond history', async () => {
    const upsert = vi.fn();
    vi.mocked(findAddressActivity).mockResolvedValueOnce({
      asOfBlock: 100,
      definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
      blocks: [],
      coverage: { fromBlock: 0, toBlock: 100, gaps: [] },
    });

    await expect(
      restoreFinancialHistory({
        db: {
          syncStateTable: {
            get: vi.fn(async () => ({
              accountId: '5previous',
              asOfBlock: 100,
              definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
            })),
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
        recoverMissingCheckpointsFor: ['bonds'],
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
      definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
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
        recoverMissingCheckpointsFor: ['bonds'],
        minimumAsOfBlock: 100,
      }),
    ).rejects.toThrow('coverage gap from block 50 to 60');
    expect(upsert).not.toHaveBeenCalled();
  });
});
