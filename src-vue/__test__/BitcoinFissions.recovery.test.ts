import { BitcoinFission, type ArgonClient, type BlockWatch, type IBitcoinFission } from '@argonprotocol/apps-core';
import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';

import type { IBitcoinFissionRecord } from '../interfaces/IBitcoinFissionRecord.ts';
import { BitcoinFissions } from '../lib/BitcoinFissions.ts';
import { BitcoinFissionsTable } from '../lib/db/BitcoinFissionsTable.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinFissionRecovery } from '../lib/recovery/BitcoinFissions.ts';
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
    fissions.data.historyById[current.fissionId] = historical;
    fissions.data.fissionsById[current.fissionId] = new BitcoinFission(current);

    const [liquid] = fissions.getLiquids();

    expect(liquid.isClosed).toBe(false);
    expect(liquid.closeHistoryEntry).toBeUndefined();
  });

  it('keeps a loaded Fission current as its pending mint is paid', async () => {
    const db = await createTestDb();
    const current = createCurrentFission();
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
            entries: async () => [[{ args: [ownerAccount, current.fissionId] }, current]],
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

    const onPendingMintChanged = callbacks.get(queueIndex);
    if (!onPendingMintChanged) throw new Error('The loaded pending mint was not subscribed.');
    const loadedRevision = fissions.data.financialRevision;

    remainingAmount = 125n;
    onPendingMintChanged({ remainingAmount, maxAmountPerFrame: 50n });
    await vi.waitFor(() => expect(fissions.getAll()[0].pendingMints[0]?.remainingAmount).toBe(125n));
    expect(fissions.data.financialRevision).toBe(loadedRevision + 1);

    remainingAmount = undefined;
    onPendingMintChanged();
    await vi.waitFor(() => expect(fissions.getAll()[0].pendingMints).toEqual([]));
    expect(fissions.data.financialRevision).toBe(loadedRevision + 2);
    expect(fissions.getAll()).toHaveLength(1);
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

  it('loads durable closed Fissions and republishes incremental recovery to mounted consumers', async () => {
    const db = await createTestDb();
    const historical = createFissionRecord({ fissionId: 7, liquidityPromised: 1_400n });
    historical.closedAtArgonBlock = 170;
    historical.closedAtTick = 520;
    historical.closeReason = 'closed';
    await db.bitcoinFissionsTable.upsertRecoveredHistory([historical]);

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
    expect(fissions.getHistory()).toEqual([expect.objectContaining({ fissionId: 7, closedAtArgonBlock: 170 })]);
    expect(fissions.getLiquids()).toEqual([
      expect.objectContaining({ liquidId: historical.liquidId, fissions: [expect.objectContaining({ fissionId: 7 })] }),
    ]);

    const recovered = createFissionRecord({ fissionId: 8, liquidityPromised: 700n });
    await db.bitcoinFissionsTable.upsertRecoveredHistory([recovered]);
    await fissions.recovery.beginHistoryReplay();
    await fissions.recovery.commitHistoryReplay();

    expect(fissions.getHistory()).toEqual([
      expect.objectContaining({ fissionId: 7 }),
      expect.objectContaining({ fissionId: 8 }),
    ]);
  });
});

describe('Bitcoin Fission recovery', () => {
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
    await db.bitcoinFissionsTable.upsertRecoveredHistory([partial]);

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
    await restartedTable.upsertRecoveredHistory([complete, second]);

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

    const recovery = new BitcoinFissionRecovery(Promise.resolve(db), ownerAccount);
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
    await db.bitcoinFissionsTable.upsertRecoveredHistory([historical]);

    const recovery = new BitcoinFissionRecovery(Promise.resolve(db), ownerAccount, () => [current]);
    await recovery.beginHistoryReplay();

    await expect(recovery.commitHistoryReplay()).resolves.toEqual([
      expect.objectContaining({ fissionId: current.fissionId, closedAtArgonBlock: null }),
    ]);
    expect(await db.bitcoinFissionsTable.fetchAll(ownerAccount)).toEqual([
      expect.objectContaining({ fissionId: current.fissionId, closedAtArgonBlock: null }),
    ]);
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
      btcPriceAtCloseMicrogons: 61_000_000n,
    });
    expect(fission.ratchets).toEqual([
      expect.objectContaining({ ratchetNumber: 0, tick: 500, txFee: 11n }),
      expect.objectContaining({ ratchetNumber: 1, tick: 508, txFee: 9n }),
    ]);
  });

  it('records finalized Fission operations without waiting for historical backfill', async () => {
    const db = await createTestDb();
    const recovery = new BitcoinFissionRecovery(Promise.resolve(db), ownerAccount);
    const block = { ...historyBlock(159), tick: 500 };

    await recovery.recordFinalizedBlock(block, [
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

    expect(await db.bitcoinFissionsTable.fetchAll(ownerAccount)).toEqual([
      expect.objectContaining({
        fissionId: 21,
        createdAtArgonBlock: block.blockNumber,
        ratchets: [expect.objectContaining({ txFee: 11n })],
      }),
    ]);
  });

  it('records a finalized Fission update while its creation history is still being backfilled', async () => {
    const db = await createTestDb();
    const recovery = new BitcoinFissionRecovery(Promise.resolve(db), ownerAccount);
    await recovery.beginHistoryReplay({ replace: true });
    await recovery.recoverBlock(historyBlock(159), [
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId: ownerAccount,
        fissionId: 21,
        liquidId: 12,
        utxoId: 7,
        satoshis: 10_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 1_000n,
      }),
    ]);

    await recovery.recordFinalizedBlock(historyBlock(170), [
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
        actualFee: 11n,
        tip: 0n,
      }),
    ]);

    expect(await db.bitcoinFissionsTable.fetchAll(ownerAccount)).toEqual([
      expect.objectContaining({
        fissionId: 21,
        ratchetNumber: 1,
        lastUpdatedArgonBlock: 170,
        ratchets: [
          expect.objectContaining({ ratchetNumber: 0, blockNumber: 159 }),
          expect.objectContaining({ ratchetNumber: 1, blockNumber: 170, txFee: 11n }),
        ],
      }),
    ]);
  });

  it('keeps finalized Fission facts when an older history backfill finishes afterward', async () => {
    const db = await createTestDb();
    const current = {
      ...createCurrentFission(),
      microgonsAtTargetPerBtc: 1_800n,
      liquidityPromised: 1_700n,
      ratchetNumber: 2,
      lastUpdatedArgonBlock: 170,
    };
    const recovery = new BitcoinFissionRecovery(Promise.resolve(db), ownerAccount, () => [current]);
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
    await recovery.recordFinalizedBlock(historyBlock(159), creationEvents);
    await recovery.beginHistoryReplay({ replace: true });
    await recovery.recoverBlock(historyBlock(159), creationEvents);
    await recovery.recordFinalizedBlock(historyBlock(170), [
      historyEvent(159, 'bitcoinFissions', 'FissionRatcheted', {
        accountId: ownerAccount,
        fissionId: current.fissionId,
        ratchetNumber: 2,
        microgonsAtTargetPerBtc: current.microgonsAtTargetPerBtc,
        liquidityPromised: current.liquidityPromised,
        amountMinted: 300n,
        amountBurned: 0n,
      }),
      historyEvent(159, 'mint', 'BitcoinMint', {
        accountId: ownerAccount,
        fissionId: current.fissionId,
        utxoId: current.utxoId,
        amount: 250n,
      }),
      historyEvent(159, 'transactionPayment', 'TransactionFeePaid', {
        who: ownerAccount,
        actualFee: 11n,
        tip: 0n,
      }),
    ]);

    await recovery.recoverBlock(historyBlock(160), [
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
    const [record] = await recovery.commitHistoryReplay();

    expect(record).toMatchObject({
      fissionId: current.fissionId,
      ratchetNumber: 2,
      lastUpdatedArgonBlock: 170,
      microgonsAtTargetPerBtc: current.microgonsAtTargetPerBtc,
      liquidityPromised: current.liquidityPromised,
    });
    expect(record.ratchets).toEqual([
      expect.objectContaining({ ratchetNumber: 0, blockNumber: 159, mintPending: 750n }),
      expect.objectContaining({ ratchetNumber: 1, blockNumber: 160 }),
      expect.objectContaining({ ratchetNumber: 2, blockNumber: 170, txFee: 11n }),
    ]);
    expect(await db.bitcoinFissionsTable.fetchAll(ownerAccount)).toEqual([
      expect.objectContaining({
        fissionId: current.fissionId,
        ratchetNumber: 2,
        lastUpdatedArgonBlock: 170,
        ratchets: [
          expect.objectContaining({ ratchetNumber: 0, blockNumber: 159, mintPending: 750n }),
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
