import { BitcoinFission, type ArgonClient, type BlockWatch, type IBitcoinFission } from '@argonprotocol/apps-core';
import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';

import type { IBitcoinFissionRecord } from '../interfaces/IBitcoinFissionRecord.ts';
import type { IBitcoinLockSummary } from '../interfaces/IBitcoinLockSummary.ts';
import type { IBitcoinSecuritizationTerm } from '../interfaces/IBitcoinSecuritizationTerm.ts';
import { BitcoinFissions } from '../lib/BitcoinFissions.ts';
import { BitcoinFissionsTable } from '../lib/db/BitcoinFissionsTable.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinFissionRecovery } from '../lib/recovery/BitcoinFissions.ts';
import { createBitcoinLiquidPositions } from '../lib/financials/BitcoinLocks.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import { toBitcoinLockDetails } from '../lib/recovery/BitcoinLockHistory.ts';
import { createHistoricalBitcoinLockRecord } from '../lib/recovery/BitcoinLockReplay.ts';
import { createTestDb, createTestDbAtMigration } from './helpers/db.ts';
import {
  createCurrentLock,
  createHistoricalLock,
  createLock,
  createStore,
  historyBlock,
  historyEvent,
} from './helpers/bitcoin.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

const ownerAccount = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('Bitcoin Fission current state', () => {
  it('can retry a failed current-state load without losing the mounted state owner', async () => {
    const db = await createTestDb();
    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: { fissionByOwnerAndId: { entries: async () => [] } },
        mint: {
          pendingMintUtxoIdLookup: async () => [],
          pendingMintUtxosByIndex: Object.assign(async () => () => undefined, { multi: async () => [] }),
        },
      },
    } as unknown as ArgonClient;
    const transientError = new Error('archive unavailable');
    const start = vi.fn().mockRejectedValueOnce(transientError).mockResolvedValue(undefined);
    const blockWatch = { subscriptionClient: client, start } as unknown as BlockWatch;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount, blockWatch);
    fissions.data = Vue.reactive(fissions.data) as BitcoinFissions['data'];

    const observedReadiness: string[] = [];
    const stopWatching = Vue.watchEffect(() => {
      observedReadiness.push(fissions.data.readiness);
    });

    const firstAttempt = fissions.load();
    await expect(firstAttempt).rejects.toBe(transientError);
    await expect(fissions.currentLoadPromise).rejects.toBe(transientError);
    expect(fissions.data.readiness).toBe('error');
    expect(fissions.data.loadError).toBe(transientError);

    const retry = fissions.load();
    const concurrentRetry = fissions.load();
    expect(fissions.data.readiness).toBe('loading');
    await expect(Promise.all([retry, concurrentRetry])).resolves.toEqual([undefined, undefined]);
    await expect(fissions.currentLoadPromise).resolves.toBeUndefined();
    expect(fissions.data.readiness).toBe('ready');
    expect(fissions.data.loadError).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
    await Vue.nextTick();
    expect(observedReadiness).toEqual(['idle', 'loading', 'error', 'loading', 'ready']);
    stopWatching();
  });

  it('reassembles computed Liquids when their authoritative Fission state changes', async () => {
    const db = await createTestDb();
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    fissions.data = Vue.reactive(fissions.data) as BitcoinFissions['data'];
    fissions.data.fissionsById = { 11: new BitcoinFission(createCurrentFission()) };
    const liquids = Vue.computed(() => fissions.getLiquids());
    const initial = liquids.value[0];

    fissions.data.fissionsById = {
      11: new BitcoinFission({ ...createCurrentFission(), liquidityPromised: 1_800n, lastUpdatedArgonBlock: 161 }),
    };

    expect(liquids.value[0]).not.toBe(initial);
    expect(liquids.value[0].liquidityPromised).toBe(1_800n);
  });

  it('keeps consecutive current-state refreshes ordered when an older query resolves late', async () => {
    const db = await createTestDb();
    const initial = createCurrentFission();
    let releaseOlderQuery: VoidFunction = () => undefined;
    const olderQueryGate = new Promise<void>(resolve => {
      releaseOlderQuery = resolve;
    });
    const createClient = (current: IBitcoinFission, wait?: Promise<void>) =>
      ({
        consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
        query: {
          bitcoinFissions: {
            fissionByOwnerAndId: {
              entries: vi.fn(async () => {
                await wait;
                return [[{ args: [ownerAccount, current.fissionId] }, current]];
              }),
            },
          },
          mint: {
            pendingMintUtxoIdLookup: async () => [],
            pendingMintUtxosByIndex: Object.assign(async () => () => undefined, { multi: async () => [] }),
          },
        },
      }) as unknown as ArgonClient;
    const olderClient = createClient({ ...initial, ratchetNumber: 2, lastUpdatedArgonBlock: 170 }, olderQueryGate);
    const newerClient = createClient({ ...initial, ratchetNumber: 3, lastUpdatedArgonBlock: 171 });
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    fissions.data.readiness = 'ready';
    fissions.data.fissionsById = { [initial.fissionId]: new BitcoinFission(initial) };

    const olderRefresh = fissions.refreshCurrent(olderClient);
    const newerRefresh = fissions.refreshCurrent(newerClient);
    await Promise.resolve();
    await Promise.resolve();
    releaseOlderQuery();
    await Promise.all([olderRefresh, newerRefresh]);

    expect(fissions.getAll()).toEqual([expect.objectContaining({ ratchetNumber: 3, lastUpdatedArgonBlock: 171 })]);
    expect(fissions.data.financialRevision).toBe(2);
  });

  it('coalesces finalized refresh signals and applies the latest current state', async () => {
    const db = await createTestDb();
    const initial = createCurrentFission();
    let releaseFirstQuery: VoidFunction = () => undefined;
    const firstQueryGate = new Promise<void>(resolve => {
      releaseFirstQuery = resolve;
    });
    const createClient = (current: IBitcoinFission | undefined, wait?: Promise<void>) => {
      const entries = vi.fn(async () => {
        await wait;
        return current ? [[{ args: [ownerAccount, current.fissionId] }, current]] : [];
      });
      return {
        client: {
          consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
          query: {
            bitcoinFissions: { fissionByOwnerAndId: { entries } },
            mint: {
              pendingMintUtxoIdLookup: async () => [],
              pendingMintUtxosByIndex: Object.assign(async () => () => undefined, { multi: async () => [] }),
            },
          },
        } as unknown as ArgonClient,
        entries,
      };
    };
    const first = createClient({ ...initial, ratchetNumber: 2, lastUpdatedArgonBlock: 170 }, firstQueryGate);
    const superseded = createClient({ ...initial, ratchetNumber: 3, lastUpdatedArgonBlock: 171 });
    const latest = createClient(undefined);
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    fissions.data.readiness = 'ready';
    fissions.data.fissionsById = { [initial.fissionId]: new BitcoinFission(initial) };

    const firstRefresh = fissions.refreshCurrentCoalesced(first.client);
    const supersededRefresh = fissions.refreshCurrentCoalesced(superseded.client);
    const latestRefresh = fissions.refreshCurrentCoalesced(latest.client);
    releaseFirstQuery();
    await Promise.all([firstRefresh, supersededRefresh, latestRefresh]);

    expect(first.entries).toHaveBeenCalledOnce();
    expect(superseded.entries).not.toHaveBeenCalled();
    expect(latest.entries).toHaveBeenCalledOnce();
    expect(fissions.getAll()).toEqual([expect.objectContaining({ ratchetNumber: 2, lastUpdatedArgonBlock: 170 })]);
    expect(fissions.data.financialRevision).toBe(2);
  });

  it('keeps the last-known Fission until a finalized close fact archives it', async () => {
    const db = await createTestDb();
    const initial = createCurrentFission();
    let current: IBitcoinFission | undefined = {
      ...initial,
      ratchetNumber: 2,
      lastUpdatedArgonBlock: 170,
    };
    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: {
          fissionByOwnerAndId: {
            entries: async () => (current ? [[{ args: [ownerAccount, current.fissionId] }, current]] : []),
          },
        },
        mint: {
          pendingMintUtxoIdLookup: async () => [],
          pendingMintUtxosByIndex: Object.assign(async () => () => undefined, { multi: async () => [] }),
        },
      },
    } as unknown as ArgonClient;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    fissions.data.readiness = 'ready';
    const canonicalFission = new BitcoinFission(initial);
    fissions.data.fissionsById = { [initial.fissionId]: canonicalFission };

    await fissions.refreshCurrent(client);
    expect(fissions.getAll()[0]).toBe(canonicalFission);
    expect(fissions.getAll()).toEqual([expect.objectContaining({ ratchetNumber: 2, lastUpdatedArgonBlock: 170 })]);

    current = undefined;
    await fissions.refreshCurrent(client);
    expect(fissions.getAll()).toEqual([expect.objectContaining({ ratchetNumber: 2, lastUpdatedArgonBlock: 170 })]);
    expect(fissions.getArchived()).toEqual([]);
    expect(fissions.getRecords()).toEqual(fissions.getAll());
    expect(fissions.data.financialRevision).toBe(2);
  });

  it('archives a Fission from a finalized Lock-spent event', async () => {
    const db = await createTestDb();
    const record = createFissionRecord({ fissionId: 11, liquidityPromised: 1_500n });
    await db.bitcoinFissionsTable.replaceRecords([record]);
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    fissions.data.readiness = 'ready';
    fissions.data.fissionsById = { 11: new BitcoinFission(record) };
    const block = { ...historyBlock(170), tick: 550 };
    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: { fissionByOwnerAndId: { entries: async () => [] } },
        mint: {
          pendingMintUtxoIdLookup: async () => [],
          pendingMintUtxosByIndex: Object.assign(async () => () => undefined, { multi: async () => [] }),
        },
      },
    } as unknown as ArgonClient;

    await fissions.syncFinalizedBlock(
      block,
      [
        historyEvent(159, 'bitcoinFissions', 'FissionClosedByLock', {
          accountId: ownerAccount,
          fissionId: 11,
          utxoId: 11,
        }),
        historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
          who: ownerAccount,
          actualFee: 7n,
          tip: 0n,
        }),
      ],
      client,
    );

    expect(fissions.getAll()).toEqual([]);
    expect(fissions.getArchived()).toEqual([
      expect.objectContaining({ fissionId: 11, closeReason: 'lock-spent', closeTxFee: 7n }),
    ]);
    expect(await db.bitcoinFissionsTable.fetchAll(ownerAccount)).toEqual([
      expect.objectContaining({ fissionId: 11, closeReason: 'lock-spent', closeTxFee: 7n }),
    ]);
  });

  it('selects active and archived Fissions from one canonical collection', async () => {
    const db = await createTestDb();
    const active = new BitcoinFission({ ...createCurrentFission(), fissionId: 7, liquidId: 7 });
    const archived = new BitcoinFission({
      ...createCurrentFission(),
      fissionId: 8,
      liquidId: 8,
      closedAtArgonBlock: 170,
      closeReason: 'closed',
    });
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    fissions.data.fissionsById = { 7: active, 8: archived };
    fissions.data.activeFissionIds.add(active.fissionId);

    expect(fissions.getAll()).toEqual([active]);
    expect(fissions.getArchived()).toEqual([archived]);
    expect(fissions.getRecords()).toEqual([active, archived]);
    expect('historyById' in fissions.data).toBe(false);
  });

  it('does not reactivate a stored Fission missing its close history after restart', async () => {
    const db = await createTestDb();
    const incomplete = createFissionRecord({ fissionId: 8, liquidityPromised: 1_400n });
    await db.bitcoinFissionsTable.replaceRecords([incomplete]);

    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: { fissionByOwnerAndId: { entries: async () => [] } },
        mint: {
          pendingMintUtxoIdLookup: async () => [],
          pendingMintUtxosByIndex: Object.assign(async () => () => undefined, { multi: async () => [] }),
        },
      },
    } as unknown as ArgonClient;
    const blockWatch = {
      subscriptionClient: client,
      start: async () => undefined,
    } as unknown as BlockWatch;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount, blockWatch);

    await fissions.load();

    expect(fissions.getAll()).toEqual([]);
    expect(fissions.getArchived()).toEqual([expect.objectContaining({ fissionId: incomplete.fissionId })]);
    const [stored] = await db.bitcoinFissionsTable.fetchAll(ownerAccount);
    expect(stored.fissionId).toBe(incomplete.fissionId);
    expect(stored.closedAtArgonBlock).toBeUndefined();
  });

  it('keeps current runtime state authoritative when closed history was published first', async () => {
    const db = await createTestDb();
    const current = createCurrentFission();
    const historical = createFissionRecord(current);
    historical.closedAtArgonBlock = 170;
    historical.closedAtTick = 520;
    historical.closeReason = 'closed';
    historical.redemptionAmount = 900n;
    historical.closeTxFee = 7n;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    fissions.data.fissionsById[current.fissionId] = new BitcoinFission(historical);
    await fissions.refreshCurrent({
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: {
          fissionByOwnerAndId: {
            entries: async () => [[{ args: [ownerAccount, current.fissionId] }, current]],
          },
        },
        mint: {
          pendingMintUtxoIdLookup: async () => [],
          pendingMintUtxosByIndex: Object.assign(async () => () => undefined, { multi: async () => [] }),
        },
      },
    } as unknown as ArgonClient);

    const [liquid] = fissions.getLiquids();

    expect(liquid.isClosed).toBe(false);
    expect(liquid.closeHistoryEntry).toBeUndefined();
  });

  it('keeps a pending mint current after its Fission closes', async () => {
    const db = await createTestDb();
    const current = createCurrentFission();
    let isClosed = false;
    const record = createFissionRecord({ fissionId: current.fissionId, liquidityPromised: current.liquidityPromised });
    record.liquidId = current.liquidId;
    record.utxoId = current.utxoId;
    await db.bitcoinFissionsTable.replaceRecords([record]);
    const queueIndex = 3;
    let remainingAmount: bigint | undefined = 200n;
    const callbacks = new Map<number, (mint?: { remainingAmount: bigint; maxAmountPerFrame: bigint }) => void>();
    const pendingMintUtxosByIndex = Object.assign(
      async (index: bigint, callback: (mint?: { remainingAmount: bigint; maxAmountPerFrame: bigint }) => void) => {
        callbacks.set(Number(index), callback);
        return () => callbacks.delete(Number(index));
      },
      {
        multi: async (indices: bigint[]) =>
          indices.map(index => {
            if (Number(index) !== queueIndex || remainingAmount === undefined) return undefined;
            return {
              accountId: ownerAccount,
              fissionId: current.fissionId,
              utxoId: current.utxoId,
              remainingAmount,
              maxAmountPerFrame: 50n,
            };
          }),
      },
    );
    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: {
          fissionByOwnerAndId: {
            entries: async () => (isClosed ? [] : [[{ args: [ownerAccount, current.fissionId] }, current]]),
          },
        },
        mint: {
          pendingMintUtxoIdLookup: async () => (remainingAmount === undefined ? [] : [queueIndex]),
          pendingMintUtxosByIndex,
        },
      },
    } as unknown as ArgonClient;
    const blockWatch = {
      subscriptionClient: client,
      start: async () => undefined,
    } as unknown as BlockWatch;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount, blockWatch);

    await fissions.load();
    expect(fissions.getAll()[0].pendingMints).toEqual([
      {
        queueIndex,
        fissionId: current.fissionId,
        utxoId: current.utxoId,
        ownerAccount,
        remainingAmount: 200n,
        maxAmountPerFrame: 50n,
      },
    ]);
    expect(fissions.getAll()[0].ratchets[0].mintPending).toBe(200n);

    const onPendingMintChanged = callbacks.get(queueIndex);
    if (!onPendingMintChanged) throw new Error('The loaded pending mint was not subscribed.');
    const loadedRevision = fissions.data.financialRevision;

    remainingAmount = 125n;
    onPendingMintChanged({ remainingAmount, maxAmountPerFrame: 50n });
    await vi.waitFor(() => expect(fissions.getAll()[0].pendingMints[0]?.remainingAmount).toBe(125n));
    expect(fissions.getAll()[0].ratchets[0].mintPending).toBe(125n);
    expect(fissions.data.financialRevision).toBe(loadedRevision + 1);

    isClosed = true;
    await fissions.syncFinalizedBlock(
      { ...historyBlock(170), tick: 550 },
      [
        historyEvent(159, 'bitcoinFissions', 'FissionClosedByLock', {
          accountId: ownerAccount,
          fissionId: current.fissionId,
          utxoId: current.utxoId,
        }),
      ],
      client,
    );

    expect(fissions.getAll()).toEqual([]);
    expect(fissions.getArchived()[0].pendingMints[0]?.remainingAmount).toBe(125n);
    expect(callbacks.has(queueIndex)).toBe(true);

    remainingAmount = undefined;
    onPendingMintChanged();
    await vi.waitFor(() => expect(fissions.getArchived()[0].pendingMints).toEqual([]));
    expect(fissions.getArchived()[0].ratchets[0].mintPending).toBe(0n);
    expect(callbacks.has(queueIndex)).toBe(false);
  });

  it('restores an archived Fission pending mint after restart', async () => {
    const db = await createTestDb();
    const record = createFissionRecord({
      fissionId: 11,
      liquidityPromised: 1_500n,
    });
    Object.assign(record, {
      closedAtArgonBlock: 170,
      closedAtTick: 550,
      closeReason: 'closed',
    });
    record.ratchets[0].mintPending = 125n;
    await db.bitcoinFissionsTable.replaceRecords([record]);

    const queueIndex = 3;
    let remainingAmount: bigint | undefined = 125n;
    const callbacks = new Map<number, (mint?: { remainingAmount: bigint; maxAmountPerFrame: bigint }) => void>();
    const pendingMintUtxosByIndex = Object.assign(
      async (index: bigint, callback: (mint?: { remainingAmount: bigint; maxAmountPerFrame: bigint }) => void) => {
        callbacks.set(Number(index), callback);
        return () => callbacks.delete(Number(index));
      },
      {
        multi: async (indices: bigint[]) =>
          indices.map(index => {
            if (Number(index) !== queueIndex || remainingAmount === undefined) return undefined;
            return {
              accountId: ownerAccount,
              fissionId: record.fissionId,
              utxoId: record.utxoId,
              remainingAmount,
              maxAmountPerFrame: 50n,
            };
          }),
      },
    );
    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: { fissionByOwnerAndId: { entries: async () => [] } },
        mint: {
          pendingMintUtxoIdLookup: async (utxoId: number) => (utxoId === record.utxoId ? [queueIndex] : []),
          pendingMintUtxosByIndex,
        },
      },
    } as unknown as ArgonClient;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount, {
      subscriptionClient: client,
      start: async () => undefined,
    } as unknown as BlockWatch);

    await fissions.load();

    expect(fissions.getAll()).toEqual([]);
    expect(fissions.getArchived()[0].pendingMints[0]?.remainingAmount).toBe(125n);
    const onPendingMintChanged = callbacks.get(queueIndex);
    if (!onPendingMintChanged) throw new Error('The archived pending mint was not subscribed.');

    remainingAmount = 75n;
    onPendingMintChanged({ remainingAmount, maxAmountPerFrame: 50n });
    await vi.waitFor(() => expect(fissions.getArchived()[0].pendingMints[0]?.remainingAmount).toBe(75n));
    expect(fissions.getArchived()[0].ratchets[0].mintPending).toBe(75n);
  });

  it('subscribes a pending mint when recovery publishes an archived Fission', async () => {
    const db = await createTestDb();
    const queueIndex = 3;
    const callbacks = new Map<number, (mint?: { remainingAmount: bigint; maxAmountPerFrame: bigint }) => void>();
    const pendingMintUtxosByIndex = Object.assign(
      async (index: bigint, callback: (mint?: { remainingAmount: bigint; maxAmountPerFrame: bigint }) => void) => {
        callbacks.set(Number(index), callback);
        return () => callbacks.delete(Number(index));
      },
      {
        multi: async (indices: bigint[]) =>
          indices.map(index => {
            if (Number(index) !== queueIndex) return undefined;
            return {
              accountId: ownerAccount,
              fissionId: 11,
              utxoId: 7,
              remainingAmount: 125n,
              maxAmountPerFrame: 50n,
            };
          }),
      },
    );
    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: { fissionByOwnerAndId: { entries: async () => [] } },
        mint: {
          pendingMintUtxoIdLookup: async (utxoId: number) => (utxoId === 7 ? [queueIndex] : []),
          pendingMintUtxosByIndex,
        },
      },
    } as unknown as ArgonClient;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount, {
      subscriptionClient: client,
      start: async () => undefined,
    } as unknown as BlockWatch);
    await fissions.load();

    await fissions.recovery.beginHistoryReplay({ replace: true });
    await fissions.recovery.recoverBlock(historyBlock(159), [
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: 11,
        liquidId: 12,
        utxoId: 7,
        satoshis: 10_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 1_500n,
      }),
    ]);
    await fissions.recovery.recoverBlock({ ...historyBlock(170), tick: 550 }, [
      historyEvent(159, 'bitcoinFissions', 'FissionClosed', {
        accountId: ownerAccount,
        fissionId: 11,
        redemptionAmount: 900n,
      }),
    ]);
    await fissions.recovery.commitHistoryReplay();

    expect(fissions.getAll()).toEqual([]);
    expect(fissions.getArchived()[0].pendingMints[0]?.remainingAmount).toBe(125n);
    expect(callbacks.has(queueIndex)).toBe(true);
  });

  it('keeps published current state when a pending-mint subscription cannot attach', async () => {
    const db = await createTestDb();
    const current = createCurrentFission();
    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: {
          fissionByOwnerAndId: {
            entries: async () => [[{ args: [ownerAccount, current.fissionId] }, current]],
          },
        },
        mint: {
          pendingMintUtxoIdLookup: async () => [3],
          pendingMintUtxosByIndex: Object.assign(
            async () => {
              throw new Error('subscription unavailable');
            },
            {
              multi: async () => [
                {
                  accountId: ownerAccount,
                  fissionId: current.fissionId,
                  utxoId: current.utxoId,
                  remainingAmount: 200n,
                  maxAmountPerFrame: 50n,
                },
              ],
            },
          ),
        },
      },
    } as unknown as ArgonClient;
    const blockWatch = {
      subscriptionClient: client,
      start: async () => undefined,
    } as unknown as BlockWatch;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount, blockWatch);

    await expect(fissions.load()).resolves.toBeUndefined();
    expect(fissions.getAll()).toEqual([
      expect.objectContaining({
        fissionId: current.fissionId,
        pendingMints: [expect.objectContaining({ queueIndex: 3 })],
      }),
    ]);
  });

  it('publishes normal create, ratchet, and close economics immediately and restores them after restart', async () => {
    const db = await createTestDb();
    const blocks = {
      159: { ...historyBlock(159), tick: 500 },
      160: { ...historyBlock(160), tick: 510 },
      170: { ...historyBlock(170), tick: 550 },
    };
    let current: IBitcoinFission | undefined = {
      ownerAccount,
      fissionId: 21,
      liquidId: 12,
      utxoId: 7,
      satoshis: 100_000_000n,
      microgonsAtTargetPerBtc: 100n,
      liquidityPromised: 100n,
      createdAtArgonBlock: blocks[159].blockNumber,
      ratchetNumber: 0,
      lastRatchetTick: blocks[159].tick,
      lastUpdatedArgonBlock: blocks[159].blockNumber,
    };
    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: {
          fissionByOwnerAndId: {
            entries: async () => (current ? [[{ args: [ownerAccount, current.fissionId] }, current]] : []),
          },
        },
        mint: {
          pendingMintUtxoIdLookup: async () => [],
          pendingMintUtxosByIndex: Object.assign(async () => () => undefined, { multi: async () => [] }),
        },
      },
    } as unknown as ArgonClient;
    const closedClient = {
      ...client,
      query: {
        ...client.query,
        bitcoinFissions: { fissionByOwnerAndId: { entries: async () => [] } },
      },
    } as unknown as ArgonClient;
    const blockWatch = {
      subscriptionClient: client,
      start: async () => undefined,
      getApi: async (block: { blockNumber: number }) => (block.blockNumber === 170 ? closedClient : client),
      getHeader: async (blockNumber: keyof typeof blocks) => blocks[blockNumber],
    } as unknown as BlockWatch;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount, blockWatch, {
      fetchMainchainRatesAtBlock: async () => ({ ARGNOT: 0n, BTC: 200n, USD: 0n }),
    });
    fissions.data.readiness = 'ready';
    const recordFinalized = async (
      blockNumber: keyof typeof blocks,
      events: ReturnType<typeof historyEvent>[],
      id: number,
    ) => {
      const block = blocks[blockNumber];
      await fissions.recordFinalizedTransaction({
        tx: {
          id,
          blockHeight: block.blockNumber,
          blockHash: block.blockHash,
          blockExtrinsicIndex: 2,
        },
        txResult: {
          blockNumber: block.blockNumber,
          extrinsicIndex: 2,
          events: events.map(record => record.event),
        },
      } as unknown as TransactionInfo);
    };

    await recordFinalized(
      159,
      [
        historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
          accountId: ownerAccount,
          fissionId: 21,
          liquidId: 12,
          utxoId: 7,
          satoshis: 100_000_000n,
          microgonsAtTargetPerBtc: 100n,
          liquidityPromised: 100n,
        }),
        historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
          who: ownerAccount,
          actualFee: 11n,
          tip: 0n,
        }),
      ],
      1,
    );

    expect(fissions.getRecords()).toEqual([
      expect.objectContaining({
        fissionId: 21,
        createdAtTick: blocks[159].tick,
        ratchets: [expect.objectContaining({ txFee: 11n })],
      }),
    ]);
    expect(fissions.getAll()).toEqual([
      expect.objectContaining({
        fissionId: current.fissionId,
        createdAtTick: 500,
        ratchets: [expect.objectContaining({ source: 'fission', sourceRatchetIndex: 0 })],
      }),
    ]);
    expect(fissions.getLiquids()).toEqual([
      expect.objectContaining({ historyTransactionFees: 11n, closeTransactionFees: 0n }),
    ]);
    expect(fissions.data.financialRevision).toBe(1);

    const published = fissions.getAll()[0];
    current = {
      ...current,
      microgonsAtTargetPerBtc: 150n,
      liquidityPromised: 140n,
      ratchetNumber: 1,
      lastRatchetTick: blocks[160].tick,
      lastUpdatedArgonBlock: blocks[160].blockNumber,
    };
    await recordFinalized(
      160,
      [
        historyEvent(159, 'bitcoinFissions', 'FissionRatcheted', {
          accountId: ownerAccount,
          fissionId: 21,
          ratchetNumber: 1,
          microgonsAtTargetPerBtc: 150n,
          liquidityPromised: 140n,
          amountMinted: 40n,
          amountBurned: 0n,
        }),
        historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
          who: ownerAccount,
          actualFee: 9n,
          tip: 0n,
        }),
      ],
      2,
    );

    expect(fissions.getAll()[0]).toBe(published);
    expect(fissions.getAll()[0]).toMatchObject({
      ratchetNumber: 1,
      liquidityPromised: 140n,
      ratchets: [
        expect.objectContaining({ ratchetNumber: 0, liquidityPromised: 100n }),
        expect.objectContaining({ ratchetNumber: 1, liquidityPromised: 140n }),
      ],
    });
    expect(fissions.getLiquids()[0]).toMatchObject({ historyTransactionFees: 20n, closeTransactionFees: 0n });
    expect(fissions.getRecords()[0].ratchets.at(-1)?.mintPending).toBe(0n);

    await recordFinalized(
      170,
      [
        historyEvent(159, 'bitcoinFissions', 'FissionClosed', {
          accountId: ownerAccount,
          fissionId: 21,
          redemptionAmount: 90n,
        }),
        historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
          who: ownerAccount,
          actualFee: 7n,
          tip: 0n,
        }),
      ],
      3,
    );

    expect(fissions.getAll()).toEqual([]);
    expect(fissions.getLiquids()[0]).toMatchObject({
      historyTransactionFees: 20n,
      closeTransactionFees: 7n,
      redemptionAmount: 90n,
      totalCloseCost: 97n,
    });
    expect(fissions.getRecords()[0].ratchets.at(-1)?.mintPending).toBe(0n);
    expect((await db.bitcoinFissionsTable.fetchAll(ownerAccount))[0].ratchets.at(-1)?.mintPending).toBe(0n);
    expect(fissions.data.financialRevision).toBe(3);

    current = undefined;
    const restarted = new BitcoinFissions(Promise.resolve(db), ownerAccount, blockWatch, {
      fetchMainchainRatesAtBlock: async () => ({ ARGNOT: 0n, BTC: 200n, USD: 0n }),
    });
    await restarted.load();

    expect(restarted.getAll()).toEqual([]);
    expect(restarted.getLiquids()[0]).toMatchObject({
      historyTransactionFees: 20n,
      closeTransactionFees: 7n,
      redemptionAmount: 90n,
      totalCloseCost: 97n,
    });

    const [position] = createBitcoinLiquidPositions({
      summaries: [
        {
          utxoId: 7,
          status: BitcoinLockStatus.Released,
          satoshis: 100_000_000n,
          valueOfBtc: 200n,
          securityFees: 10n,
          unlockAmount: 90n,
          record: {
            uuid: 'normal-finalized-liquid',
            status: BitcoinLockStatus.Released,
            utxoId: 7,
            securitizedSatoshis: 100_000_000n,
            vaultId: 1,
            cosignVersion: 'v1',
            network: 'testnet',
            hdPath: "m/84'/0'/0'",
            removalReason: 'released',
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          },
        } as IBitcoinLockSummary,
      ],
      fissions: restarted.getLiquids().flatMap(liquid => liquid.fissions),
      terms: [
        {
          utxoId: 7,
          termIndex: 0,
          origin: 'created',
          startTick: 500,
          startBlockNumber: 159,
          securitizedSatoshis: 100_000_000n,
          securitizationCoverageMicrogons: 100n,
          cumulativeNetSecurityFee: 10n,
          addedNetSecurityFee: 10n,
          endTick: 550,
          endBlockNumber: 170,
          endReason: 'released',
        } as IBitcoinSecuritizationTerm,
      ],
      activeFissionIds: new Set(),
      hasCurrentPrice: true,
    });
    expect(position).toMatchObject({
      lifecycle: 'completed',
      insuranceCost: 10n,
      transactionFees: 27n,
      totalFees: 37n,
      pendingLiquidity: 0n,
      receivedLiquidity: 140n,
    });
    expect(position.totalReturn).toBeTypeOf('number');
  });

  it('repairs a loaded Fission in place when recovery finds missing history', async () => {
    const db = await createTestDb();
    const historical = createFissionRecord({ fissionId: 7, liquidityPromised: 1_400n });
    historical.closedAtArgonBlock = 170;
    historical.closedAtTick = 520;
    historical.closeReason = 'closed';
    await db.bitcoinFissionsTable.replaceRecords([historical]);

    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: { fissionByOwnerAndId: { entries: async () => [] } },
        mint: {
          pendingMintUtxoIdLookup: async () => [],
          pendingMintUtxosByIndex: Object.assign(async () => () => undefined, { multi: async () => [] }),
        },
      },
    } as unknown as ArgonClient;
    const blockWatch = {
      subscriptionClient: client,
      start: async () => undefined,
    } as unknown as BlockWatch;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount, blockWatch);

    await fissions.load();
    const loaded = fissions.getRecords()[0];
    expect(fissions.getRecords()).toEqual([expect.objectContaining({ fissionId: 7, closedAtArgonBlock: 170 })]);

    await fissions.recovery.beginHistoryReplay({ replace: true });
    await fissions.recovery.recoverBlock(historyBlock(159), [
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: historical.fissionId,
        liquidId: historical.liquidId,
        utxoId: historical.utxoId,
        satoshis: historical.satoshis,
        microgonsAtTargetPerBtc: historical.microgonsAtTargetPerBtc,
        liquidityPromised: historical.liquidityPromised,
      }),
      historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
        who: ownerAccount,
        actualFee: 11n,
        tip: 0n,
      }),
    ]);
    await fissions.recovery.recoverBlock(historyBlock(170), [
      historyEvent(159, 'bitcoinFissions', 'FissionClosed', {
        accountId: ownerAccount,
        fissionId: historical.fissionId,
        redemptionAmount: 900n,
      }),
      historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
        who: ownerAccount,
        actualFee: 7n,
        tip: 0n,
      }),
    ]);
    await fissions.recovery.commitHistoryReplay();

    expect(fissions.getRecords()[0]).toBe(loaded);
    expect(fissions.getRecords()[0]).toMatchObject({
      fissionId: historical.fissionId,
      closeTxFee: 7n,
      ratchets: [expect.objectContaining({ txFee: 11n })],
    });
    expect((await db.bitcoinFissionsTable.fetchAll(ownerAccount))[0]).toMatchObject({
      closeTxFee: 7n,
      ratchets: [expect.objectContaining({ txFee: 11n })],
    });
  });
});

describe('Bitcoin Fission recovery', () => {
  it('publishes no recovered Fissions when any reconstructed record is incoherent', async () => {
    const db = await createTestDb();
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    fissions.data.readiness = 'ready';

    await fissions.recovery.beginHistoryReplay({ replace: true });
    await fissions.recovery.recoverBlock(historyBlock(160), [
      historyEvent(159, 'mint', 'BitcoinMint', {
        accountId: ownerAccount,
        fissionId: 41,
        utxoId: 7,
        amount: 150n,
      }),
      historyEvent(159, 'mint', 'BitcoinMint', {
        accountId: ownerAccount,
        fissionId: 42,
        utxoId: 8,
        amount: 50n,
      }),
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: 41,
        liquidId: 51,
        utxoId: 7,
        satoshis: 10_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 100n,
      }),
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: 42,
        liquidId: 52,
        utxoId: 8,
        satoshis: 10_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 200n,
      }),
    ]);

    await expect(fissions.recovery.commitHistoryReplay()).rejects.toThrow(
      'Bitcoin Fission history for lock 7: Bitcoin Fission 41 minted more than its recovered entitlement',
    );
    expect(await db.bitcoinFissionsTable.fetchAll(ownerAccount)).toEqual([]);
    expect(fissions.getRecords()).toEqual([]);
    expect(fissions.data.financialRevision).toBe(0);
  });

  it('routes Fission mint history without mutating the backing Lock history', async () => {
    const db = await createTestDb();
    const lock = createLock({
      uuid: 'fission-backed-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const archiveClient = {
      query: {
        mint: {
          pendingMintUtxoIdLookup: async () => [0],
          pendingMintUtxosByIndex: {
            multi: async () => [{ remainingAmount: 450n }],
          },
        },
      },
    };
    const blockWatch = {
      getApi: async () => archiveClient,
    } as unknown as BlockWatch;
    const walletKeys = createMockWalletKeys('//Alice');
    const locks = createStore({
      blockWatch,
      db,
      walletKeys,
    });
    locks.data.locksByUtxoId[7] = lock;
    const fissions = new BitcoinFissionRecovery(Promise.resolve(db), ownerAccount);

    await locks.recovery.beginHistoryReplay({ lockScope: 'all' });
    await fissions.beginHistoryReplay({ replace: true });

    const createdBlock = historyBlock(186);
    const createdEvents = [
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: 0,
        liquidId: 0,
        utxoId: 7,
        satoshis: 10_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 500n,
      }),
    ];
    await locks.recovery.recoverBlock(createdBlock, createdEvents);
    await fissions.recoverBlock(createdBlock, createdEvents);

    const mintBlock = historyBlock(187);
    const mintEvents = [
      historyEvent(159, 'mint', 'BitcoinMint', {
        accountId: ownerAccount,
        fissionId: 0,
        utxoId: 7,
        amount: 50n,
      }),
    ];
    await locks.recovery.recoverBlock(mintBlock, mintEvents);
    await fissions.recoverBlock(mintBlock, mintEvents);

    const recoveredLocks = await locks.recovery.commitHistoryReplay();
    await fissions.commitHistoryReplay(recoveredLocks);

    expect(lock.ratchets).toEqual([]);
    expect(await db.bitcoinFissionsTable.fetchAll(ownerAccount)).toEqual([
      expect.objectContaining({
        fissionId: 0,
        utxoId: 7,
        liquidityPromised: 500n,
        ratchets: [expect.objectContaining({ amountMinted: 500n, mintPending: 450n })],
      }),
    ]);
  });

  it('migrates pre-Fission Lock ratchets into the known Fission identity without renumbering them', async () => {
    const { db, migrateToLatest } = await createTestDbAtMigration(32);
    await db.execute(
      `INSERT INTO BitcoinLocks (
        uuid, status, utxoId, satoshis, lockedTargetPrice, liquidityPromised, ratchets, cosignVersion,
        lockDetails, network, hdPath, vaultId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'migration-lock',
        'LockedAndMinted',
        7,
        10_000n,
        1_500n,
        1_400n,
        [
          {
            mintAmount: 1_000n,
            mintPending: 350n,
            liquidityPromised: 1_000n,
            lockedTargetPrice: 1_000n,
            securityFee: 11n,
            txFee: 5n,
            burned: 0n,
            blockHeight: 151,
            extrinsicIndex: 2,
            oracleBitcoinBlockHeight: 500,
          },
          {
            mintAmount: 400n,
            mintPending: 400n,
            liquidityPromised: 1_400n,
            lockedTargetPrice: 1_500n,
            securityFee: 0n,
            txFee: 9n,
            burned: 0n,
            blockHeight: 158,
            extrinsicIndex: 3,
            oracleBitcoinBlockHeight: 502,
          },
        ],
        'v1',
        { ownerAccount, createdAtArgonBlock: 151 },
        'testnet',
        "m/84'/0'/0'",
        1,
      ],
    );

    await migrateToLatest();

    const [fission] = await db.bitcoinFissionsTable.fetchAll(ownerAccount);
    expect(fission).toMatchObject({
      origin: 'lock-migration',
      fissionId: 7,
      liquidId: 7,
      utxoId: 7,
      liquidityPromised: 1_400n,
    });
    expect(fission.ratchets).toEqual([
      expect.objectContaining({
        source: 'lock',
        sourceRatchetIndex: 0,
        microgonsAtTargetPerBtc: 1_000n,
        securityFee: 11n,
        txFee: 5n,
        blockNumber: 151,
      }),
      expect.objectContaining({
        source: 'lock',
        sourceRatchetIndex: 1,
        microgonsAtTargetPerBtc: 1_500n,
        securityFee: 0n,
        txFee: 9n,
        blockNumber: 158,
      }),
    ]);
  });

  it('converges partial finalized history under natural identities when replay resumes', async () => {
    const db = await createTestDb();
    const partial = createFissionRecord({ fissionId: 7, liquidityPromised: 1_000n });
    await db.bitcoinFissionsTable.replaceRecords([partial]);

    const complete = createFissionRecord({ fissionId: 7, liquidityPromised: 1_400n });
    complete.ratchetNumber = 1;
    complete.lastUpdatedArgonBlock = 160;
    complete.ratchets.push({
      source: 'fission',
      sourceRatchetIndex: 1,
      ratchetNumber: 1,
      microgonsAtTargetPerBtc: 1_500n,
      liquidityPromised: 1_400n,
      amountMinted: 400n,
      amountBurned: 0n,
      mintPending: 400n,
      blockNumber: 160,
    });
    const second = createFissionRecord({ fissionId: 8, liquidityPromised: 700n });

    const restartedTable = new BitcoinFissionsTable(db);
    await restartedTable.replaceRecords([complete, second]);

    expect(await restartedTable.fetchAll(ownerAccount)).toEqual([
      expect.objectContaining({
        fissionId: 7,
        liquidityPromised: 1_400n,
        ratchetNumber: 1,
        ratchets: [
          expect.objectContaining({ sourceRatchetIndex: 0, liquidityPromised: 1_400n }),
          expect.objectContaining({ sourceRatchetIndex: 1, liquidityPromised: 1_400n }),
        ],
      }),
      expect.objectContaining({ fissionId: 8, liquidityPromised: 700n }),
    ]);

    const [historyCount] = await db.select<{ count: number }[]>('SELECT COUNT(*) count FROM BitcoinFissions');
    const [ratchetCount] = await db.select<{ count: number }[]>('SELECT COUNT(*) count FROM BitcoinFissionRatchets');
    expect(historyCount.count).toBe(2);
    expect(ratchetCount.count).toBe(3);
  });

  it('reconstructs a migrated Fission without a creation event and preserves ratchet repayment history', async () => {
    const db = await createTestDb();
    const historicalLock = createHistoricalLock({
      accountId: ownerAccount,
      liquidityPromised: 1_000n,
      lockedTargetPrice: 1_000n,
    });
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'migrated-fission-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const currentLock = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock(toBitcoinLockDetails(historicalLock)),
    });
    const lock = createHistoricalBitcoinLockRecord(currentLock);
    lock.status = BitcoinLockStatus.LockFunded;
    lock.satoshis = historicalLock.fundedSatoshis;
    lock.lockedTargetPrice = 1_500n;
    lock.liquidityPromised = 1_400n;
    lock.lockDetails = toBitcoinLockDetails(historicalLock);
    lock.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 600n,
        liquidityPromised: 1_000n,
        lockedTargetPrice: 1_000n,
        securityFee: 20n,
        txFee: 11n,
        burned: 0n,
        blockHeight: 151,
        tick: 500,
        oracleBitcoinBlockHeight: 500,
      },
      {
        mintAmount: 400n,
        mintPending: 400n,
        liquidityPromised: 1_400n,
        lockedTargetPrice: 1_500n,
        securityFee: 0n,
        txFee: 9n,
        burned: 0n,
        blockHeight: 158,
        tick: 508,
        extrinsicIndex: 3,
        oracleBitcoinBlockHeight: 502,
      },
    ];

    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    const current = new BitcoinFission({
      ownerAccount,
      fissionId: 7,
      liquidId: 7,
      utxoId: 7,
      satoshis: historicalLock.fundedSatoshis,
      microgonsAtTargetPerBtc: 1_600n,
      liquidityPromised: 1_500n,
      createdAtArgonBlock: lock.lockDetails.createdAtArgonBlock,
      ratchetNumber: 3,
      lastUpdatedArgonBlock: 160,
    });
    current.pendingMints = [
      {
        queueIndex: 3,
        fissionId: 7,
        utxoId: 7,
        ownerAccount,
        remainingAmount: 50n,
        maxAmountPerFrame: 10n,
      },
    ];
    fissions.data.fissionsById[current.fissionId] = current;
    fissions.data.activeFissionIds.add(current.fissionId);
    fissions.data.readiness = 'ready';
    const revisionBeforeBackfill = fissions.data.financialRevision;
    const recovery = fissions.recovery;
    await recovery.beginHistoryReplay({ replace: true });
    await recovery.recoverBlock(historyBlock(160), [
      historyEvent(159, 'bitcoinFissions', 'FissionRatcheted', {
        accountId: ownerAccount,
        fissionId: 7,
        ratchetNumber: 1,
        microgonsAtTargetPerBtc: 1_600n,
        liquidityPromised: 1_500n,
        amountMinted: 300n,
        amountBurned: 200n,
      }),
      historyEvent(159, 'mint', 'BitcoinMint', {
        accountId: ownerAccount,
        fissionId: 7,
        utxoId: 7,
        amount: 250n,
      }),
    ]);
    const [fission] = await recovery.commitHistoryReplay([lock]);

    expect(fission).toEqual(
      expect.objectContaining({
        origin: 'lock-migration',
        fissionId: 7,
        liquidId: 7,
        utxoId: 7,
        ratchetNumber: 1,
        microgonsAtTargetPerBtc: 1_600n,
        liquidityPromised: 1_500n,
      }),
    );
    expect(fission.ratchets).toEqual([
      expect.objectContaining({ source: 'lock', mintPending: 350n, blockNumber: 151, tick: 500 }),
      expect.objectContaining({ source: 'lock', mintPending: 400n, blockNumber: 158, tick: 508 }),
      expect.objectContaining({ source: 'fission', ratchetNumber: 1, mintPending: 300n, blockNumber: 160 }),
    ]);
    expect(fissions.getAll()[0]).toBe(current);
    expect(fissions.data.readiness).toBe('ready');
    expect(fissions.data.financialRevision).toBe(revisionBeforeBackfill + 1);
    expect(current).toMatchObject({
      liquidId: 7,
      utxoId: 7,
      microgonsAtTargetPerBtc: 1_600n,
      liquidityPromised: 1_500n,
      ratchetNumber: 3,
      lastUpdatedArgonBlock: 160,
      ratchets: fission.ratchets,
      pendingMints: [expect.objectContaining({ queueIndex: 3, remainingAmount: 50n })],
    });
    expect(fissions.getRecords()[0]).toMatchObject({
      origin: fission.origin,
      fissionId: fission.fissionId,
      ratchetNumber: 3,
      ratchets: fission.ratchets,
    });
    const [liquid] = fissions.getLiquids();
    expect(liquid.fissions).toEqual([fissions.getAll()[0]]);
    expect(liquid.history).toHaveLength(3);
  });

  it('reconstructs a completed pre-159 Liquid from its Lock history without a Fission event', async () => {
    const db = await createTestDb();
    const historicalLock = createHistoricalLock({
      accountId: ownerAccount,
      liquidityPromised: 1_000n,
      lockedTargetPrice: 1_000n,
    });
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'completed-migrated-fission-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const durable = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock(toBitcoinLockDetails(historicalLock)),
    });
    const lock = createHistoricalBitcoinLockRecord(durable);
    Object.assign(lock, {
      status: BitcoinLockStatus.Released,
      satoshis: 10_000n,
      lockedTargetPrice: 1_000n,
      liquidityPromised: 1_000n,
      lockDetails: toBitcoinLockDetails(historicalLock),
      removalBlockNumber: 158,
      removalTick: 540,
      removalBlockHash: '0x158',
      removalBlockTime: new Date('2026-01-02T00:00:00Z'),
      removalExtrinsicIndex: 3,
      removalReason: 'released',
      btcPriceAtRemovalMicrogons: 1_200n,
      releaseRedemptionMicrogons: 900n,
      ratchets: [
        {
          mintAmount: 1_000n,
          mintPending: 0n,
          liquidityPromised: 1_000n,
          lockedTargetPrice: 1_000n,
          securityFee: 20n,
          txFee: 11n,
          burned: 0n,
          blockHeight: 151,
          tick: 500,
          oracleBitcoinBlockHeight: 500,
        },
      ],
    });

    const recovery = new BitcoinFissionRecovery(Promise.resolve(db), ownerAccount);
    await recovery.beginHistoryReplay({ replace: true });
    const [fission] = await recovery.commitHistoryReplay([lock]);

    expect(fission).toMatchObject({
      origin: 'lock-migration',
      fissionId: 7,
      createdAtTick: 500,
      closedAtArgonBlock: 158,
      closedAtTick: 540,
      closeReason: 'closed',
      redemptionAmount: 900n,
      btcPriceAtCloseMicrogons: 1_200n,
    });
  });

  it('does not let replayed history replace current runtime Fission state', async () => {
    const db = await createTestDb();
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    const current = createCurrentFission();
    const pendingMint = {
      queueIndex: 3,
      fissionId: current.fissionId,
      utxoId: current.utxoId,
      ownerAccount,
      remainingAmount: 200n,
      maxAmountPerFrame: 50n,
    };
    const loadedCurrent = new BitcoinFission(current);
    loadedCurrent.pendingMints = [pendingMint];
    fissions.data.fissionsById[current.fissionId] = loadedCurrent;
    fissions.data.activeFissionIds.add(current.fissionId);

    await fissions.recovery.beginHistoryReplay({ replace: true });
    await fissions.recovery.recoverBlock(historyBlock(160), [
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: current.fissionId,
        liquidId: current.liquidId,
        utxoId: current.utxoId,
        satoshis: current.satoshis,
        microgonsAtTargetPerBtc: current.microgonsAtTargetPerBtc,
        liquidityPromised: current.liquidityPromised - 1n,
      }),
    ]);

    await expect(fissions.recovery.commitHistoryReplay()).rejects.toThrow('does not match recovered history');
    expect(fissions.data.fissionsById).toEqual({ [current.fissionId]: loadedCurrent });
    expect(loadedCurrent.pendingMints).toEqual([pendingMint]);
    expect(await db.bitcoinFissionsTable.fetchAll(ownerAccount)).toEqual([]);
  });

  it('resumes active Fission history from SQLite without treating empty close fields as a closure', async () => {
    const db = await createTestDb();
    const current = createCurrentFission();
    const historical = createFissionRecord(current);
    Object.assign(historical, current);
    await db.bitcoinFissionsTable.replaceRecords([historical]);

    const recovery = new BitcoinFissionRecovery(Promise.resolve(db), ownerAccount, () => [current]);
    await recovery.beginHistoryReplay();

    const [committed] = await recovery.commitHistoryReplay();
    expect(committed).toMatchObject({ fissionId: current.fissionId });
    expect(committed.closedAtArgonBlock).toBeUndefined();

    const [persisted] = await db.bitcoinFissionsTable.fetchAll(ownerAccount);
    expect(persisted).toMatchObject({ fissionId: current.fissionId });
    expect(persisted.closedAtArgonBlock).toBeUndefined();
  });

  it('persists Argon ticks for Fission creation, ratchets, and closure', async () => {
    const db = await createTestDb();
    const recovery = new BitcoinFissionRecovery(Promise.resolve(db), ownerAccount, undefined, {
      blockWatch: { getApi: async () => ({}) } as never,
      currency: { fetchMainchainRatesAtBlock: async () => ({ BTC: 61_000_000n }) } as never,
    });
    await recovery.beginHistoryReplay({ replace: true });
    await recovery.recoverBlock({ ...historyBlock(159), tick: 500 }, [
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: 21,
        liquidId: 12,
        utxoId: 7,
        satoshis: 10_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 1_000n,
      }),
      historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
        who: ownerAccount,
        actualFee: 11n,
        tip: 0n,
      }),
    ]);
    await recovery.recoverBlock({ ...historyBlock(160), tick: 508 }, [
      historyEvent(159, 'bitcoinFissions', 'FissionRatcheted', {
        accountId: ownerAccount,
        fissionId: 21,
        ratchetNumber: 1,
        microgonsAtTargetPerBtc: 1_500n,
        liquidityPromised: 1_400n,
        amountMinted: 400n,
        amountBurned: 0n,
      }),
      historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
        who: ownerAccount,
        actualFee: 9n,
        tip: 0n,
      }),
    ]);
    await recovery.recoverBlock({ ...historyBlock(161), tick: 509 }, [
      historyEvent(159, 'mint', 'BitcoinMint', {
        accountId: ownerAccount,
        fissionId: 21,
        utxoId: 7,
        amount: 1_400n,
      }),
    ]);
    await recovery.recoverBlock({ ...historyBlock(170), tick: 550 }, [
      historyEvent(159, 'bitcoinFissions', 'FissionClosed', {
        accountId: ownerAccount,
        fissionId: 21,
        redemptionAmount: 900n,
      }),
      historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
        who: ownerAccount,
        actualFee: 7n,
        tip: 0n,
      }),
    ]);
    await recovery.commitHistoryReplay();

    const [fission] = await db.bitcoinFissionsTable.fetchAll(ownerAccount);
    expect(fission).toMatchObject({
      createdAtTick: 500,
      closedAtTick: 550,
      closeTxFee: 7n,
      feeHistoryCompleteThroughBlock: 170,
      btcPriceAtCloseMicrogons: 61_000_000n,
    });
    expect(fission.ratchets).toEqual([
      expect.objectContaining({ ratchetNumber: 0, tick: 500, mintPending: 0n, txFee: 11n }),
      expect.objectContaining({ ratchetNumber: 1, tick: 508, mintPending: 0n, txFee: 9n }),
    ]);

    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: { fissionByOwnerAndId: { entries: async () => [] } },
        mint: {
          pendingMintUtxoIdLookup: async () => [],
          pendingMintUtxosByIndex: Object.assign(async () => () => undefined, { multi: async () => [] }),
        },
      },
    } as unknown as ArgonClient;
    const restarted = new BitcoinFissions(Promise.resolve(db), ownerAccount, {
      subscriptionClient: client,
      start: async () => undefined,
    } as unknown as BlockWatch);
    await restarted.load();

    expect(restarted.getLiquids()).toEqual([
      expect.objectContaining({ historyTransactionFees: 20n, closeTransactionFees: 7n }),
    ]);
  });

  it('distinguishes a complete zero-fee ledger from missing and partial fee history after restart', async () => {
    const db = await createTestDb();
    const recovery = new BitcoinFissionRecovery(Promise.resolve(db), ownerAccount);
    await recovery.beginHistoryReplay({ replace: true });
    await recovery.recoverBlock(historyBlock(159), [
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: 21,
        liquidId: 12,
        utxoId: 7,
        satoshis: 5_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 500n,
      }),
      historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
        who: ownerAccount,
        actualFee: 0n,
        tip: 0n,
      }),
    ]);
    await recovery.recoverBlock(historyBlock(160), [
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: 22,
        liquidId: 12,
        utxoId: 8,
        satoshis: 5_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 500n,
      }),
    ]);
    await recovery.recoverBlock(historyBlock(161), [
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: 23,
        liquidId: 13,
        utxoId: 9,
        satoshis: 5_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 500n,
      }),
      historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
        who: ownerAccount,
        actualFee: 0n,
        tip: 0n,
      }),
    ]);
    await recovery.commitHistoryReplay();

    const persisted = await new BitcoinFissionsTable(db).fetchAll(ownerAccount);
    const liquids = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    liquids.data.fissionsById = Object.fromEntries(
      persisted.map(record => [record.fissionId, new BitcoinFission(record)]),
    );

    expect(liquids.getLiquids().find(liquid => liquid.liquidId === 12)?.historyTransactionFees).toBeUndefined();
    expect(liquids.getLiquids().find(liquid => liquid.liquidId === 13)?.historyTransactionFees).toBe(0n);
    expect(persisted.find(record => record.fissionId === 22)?.feeHistoryCompleteThroughBlock).toBeUndefined();
  });
});

describe('Bitcoin Fission finalized events', () => {
  it('records a finalized Fission event from the live block stream', async () => {
    const db = await createTestDb();
    const block = { ...historyBlock(159), tick: 500 };
    const current = {
      ...createCurrentFission(),
      fissionId: 21,
      liquidId: 12,
      utxoId: 7,
      microgonsAtTargetPerBtc: 1_000n,
      liquidityPromised: 1_000n,
      ratchetNumber: 0,
      lastRatchetTick: block.tick,
      lastUpdatedArgonBlock: block.blockNumber,
    };
    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: {
          fissionByOwnerAndId: { entries: async () => [[{ args: [ownerAccount, current.fissionId] }, current]] },
        },
        mint: {
          pendingMintUtxoIdLookup: async () => [],
          pendingMintUtxosByIndex: { multi: async () => [] },
        },
      },
    } as unknown as ArgonClient;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    fissions.data.readiness = 'ready';

    await fissions.syncFinalizedBlock(
      block,
      [
        historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
          accountId: ownerAccount,
          fissionId: 21,
          liquidId: 12,
          utxoId: 7,
          satoshis: 10_000n,
          microgonsAtTargetPerBtc: 1_000n,
          liquidityPromised: 1_000n,
        }),
        historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
          who: ownerAccount,
          actualFee: 11n,
          tip: 0n,
        }),
      ],
      client,
    );

    expect(await db.bitcoinFissionsTable.fetchAll(ownerAccount)).toEqual([
      expect.objectContaining({
        fissionId: 21,
        createdAtArgonBlock: block.blockNumber,
        ratchets: [expect.objectContaining({ txFee: 11n })],
      }),
    ]);
    expect(fissions.getAll()).toEqual([
      expect.objectContaining({ fissionId: 21, ratchets: [expect.objectContaining({ txFee: 11n })] }),
    ]);
  });

  it('keeps finalized Fission facts when an older history backfill finishes afterward', async () => {
    const db = await createTestDb();
    let current = {
      ...createCurrentFission(),
      microgonsAtTargetPerBtc: 1_000n,
      liquidityPromised: 1_000n,
      ratchetNumber: 0,
      lastRatchetTick: 500,
      lastUpdatedArgonBlock: 159,
    };
    const client = {
      consts: { bitcoinFissions: { minimumRatchetPercent: { toBigInt: () => 5n } } },
      query: {
        bitcoinFissions: {
          fissionByOwnerAndId: { entries: async () => [[{ args: [ownerAccount, current.fissionId] }, current]] },
        },
        mint: {
          pendingMintUtxoIdLookup: async () => [],
          pendingMintUtxosByIndex: { multi: async () => [] },
        },
      },
    } as unknown as ArgonClient;
    const fissions = new BitcoinFissions(Promise.resolve(db), ownerAccount);
    fissions.data.readiness = 'ready';
    const creationEvents = [
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: current.fissionId,
        liquidId: current.liquidId,
        utxoId: current.utxoId,
        satoshis: current.satoshis,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 1_000n,
      }),
    ];
    await fissions.syncFinalizedBlock(historyBlock(159), creationEvents, client);
    await fissions.recovery.beginHistoryReplay({ replace: true });
    await fissions.recovery.recoverBlock(historyBlock(159), creationEvents);
    await fissions.recovery.recoverBlock(historyBlock(160), [
      historyEvent(159, 'bitcoinFissions', 'FissionRatcheted', {
        accountId: ownerAccount,
        fissionId: current.fissionId,
        ratchetNumber: 1,
        microgonsAtTargetPerBtc: 1_500n,
        liquidityPromised: 1_400n,
        amountMinted: 400n,
        amountBurned: 0n,
      }),
    ]);
    current = {
      ...current,
      microgonsAtTargetPerBtc: 1_500n,
      liquidityPromised: 1_400n,
      ratchetNumber: 1,
      lastRatchetTick: 600,
      lastUpdatedArgonBlock: 160,
    };
    await fissions.refreshCurrent(client);
    const prepared = await fissions.recovery.prepareHistoryReplay();

    current = {
      ...current,
      microgonsAtTargetPerBtc: 1_800n,
      liquidityPromised: 1_700n,
      ratchetNumber: 2,
      lastRatchetTick: 700,
      lastUpdatedArgonBlock: 170,
    };
    await fissions.syncFinalizedBlock(
      historyBlock(170),
      [
        historyEvent(159, 'bitcoinFissions', 'FissionRatcheted', {
          accountId: ownerAccount,
          fissionId: current.fissionId,
          ratchetNumber: 2,
          microgonsAtTargetPerBtc: current.microgonsAtTargetPerBtc,
          liquidityPromised: current.liquidityPromised,
          amountMinted: 300n,
          amountBurned: 0n,
        }),
        historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
          who: ownerAccount,
          actualFee: 11n,
          tip: 0n,
        }),
      ],
      client,
    );
    const published = fissions.getAll()[0];

    await db.bitcoinFissionsTable.replaceRecords(prepared.records);
    await fissions.recovery.publishRecoveredRecords(prepared.records);
    expect(fissions.getAll()[0]).toBe(published);
    expect(fissions.getAll()[0].lastUpdatedArgonBlock).toBe(170);

    const finalizedRecords = await fissions.recovery.finishHistoryReplay();
    await fissions.recovery.publishRecoveredRecords(finalizedRecords);
    const [record] = await db.bitcoinFissionsTable.fetchAll(ownerAccount);

    expect(fissions.getAll()[0]).toBe(published);
    expect(record).toMatchObject({
      fissionId: current.fissionId,
      ratchetNumber: 2,
      lastUpdatedArgonBlock: 170,
      microgonsAtTargetPerBtc: current.microgonsAtTargetPerBtc,
      liquidityPromised: current.liquidityPromised,
    });
    expect(record.ratchets).toEqual([
      expect.objectContaining({ ratchetNumber: 0, blockNumber: 159 }),
      expect.objectContaining({ ratchetNumber: 1, blockNumber: 160 }),
      expect.objectContaining({ ratchetNumber: 2, blockNumber: 170, txFee: 11n }),
    ]);
    expect(await db.bitcoinFissionsTable.fetchAll(ownerAccount)).toEqual([
      expect.objectContaining({
        fissionId: current.fissionId,
        ratchetNumber: 2,
        lastUpdatedArgonBlock: 170,
        ratchets: [
          expect.objectContaining({ ratchetNumber: 0, blockNumber: 159 }),
          expect.objectContaining({ ratchetNumber: 1, blockNumber: 160 }),
          expect.objectContaining({ ratchetNumber: 2, blockNumber: 170, txFee: 11n }),
        ],
      }),
    ]);
  });
});

function createFissionRecord({
  fissionId,
  liquidityPromised,
}: {
  fissionId: number;
  liquidityPromised: bigint;
}): IBitcoinFissionRecord {
  const createdAt = new Date('2026-01-01T00:00:00Z');
  return {
    origin: 'created',
    ownerAccount,
    fissionId,
    liquidId: fissionId,
    utxoId: fissionId,
    satoshis: 10_000n,
    microgonsAtTargetPerBtc: 1_000n,
    liquidityPromised,
    createdAtArgonBlock: 159,
    ratchetNumber: 0,
    lastUpdatedArgonBlock: 159,
    ratchets: [
      {
        source: 'fission',
        sourceRatchetIndex: 0,
        ratchetNumber: 0,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised,
        amountMinted: liquidityPromised,
        amountBurned: 0n,
        mintPending: liquidityPromised,
        blockNumber: 159,
      },
    ],
    createdBlockHash: '0x159',
    createdBlockTime: createdAt,
    createdExtrinsicIndex: 2,
    createdAt,
    updatedAt: createdAt,
  };
}

function createCurrentFission(): IBitcoinFission {
  return {
    ownerAccount,
    fissionId: 11,
    liquidId: 12,
    utxoId: 7,
    satoshis: 10_000n,
    microgonsAtTargetPerBtc: 1_600n,
    liquidityPromised: 1_500n,
    createdAtArgonBlock: 159,
    ratchetNumber: 1,
    lastRatchetTick: 600,
    lastUpdatedArgonBlock: 160,
  };
}
