import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { u8aToHex } from '@polkadot/util';
import { createTestDb, createTestDbAtMigration } from './helpers/db.ts';
import BitcoinUtxoTracking, { type IUtxoTrackingDeps } from '../lib/BitcoinUtxoTracking.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import type { IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { BitcoinLock, type ArgonClient, type BlockWatch, type IBlockHeaderInfo } from '@argonprotocol/apps-core';
import {
  createBitcoinLockConfig,
  createCurrentLock,
  createStore,
  historyBlock,
  historyEvent,
} from './helpers/bitcoin.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import * as indexerClient from '../lib/IndexerClient.ts';
import * as mainchain from '../stores/mainchain.ts';
import { BitcoinReleaseKind, BitcoinReleaseStatus } from '../interfaces/IBitcoinReleaseRecord.ts';
import { BitcoinHistoryUtxoState } from '../lib/recovery/BitcoinLockReplay.ts';

type IMempoolTestDeps = Pick<IUtxoTrackingDeps['mempool'], 'getAddressUtxos' | 'getTipHeight' | 'getTxStatus'>;

function createLock(overrides: Partial<IBitcoinLockRecord> = {}): IBitcoinLockRecord {
  return {
    uuid: overrides.uuid ?? 'lock-1',
    lockId: overrides.lockId ?? 1,
    status: overrides.status ?? BitcoinLockStatus.LockPendingFunding,
    securitizedSatoshis: overrides.securitizedSatoshis ?? 10_000n,
    ownerAccount: overrides.ownerAccount ?? '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    securityFees: overrides.securityFees ?? 0n,
    couponFeesPaid: overrides.couponFeesPaid ?? 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: overrides.fundHoldExtensionsByBitcoinExpirationHeight ?? {},
    cosignVersion: overrides.cosignVersion ?? 'v1',
    scriptDetails: overrides.scriptDetails ?? createLockDetails(),
    network: overrides.network ?? 'testnet',
    hdPath: overrides.hdPath ?? "m/84'/0'/0'",
    vaultId: overrides.vaultId ?? 1,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    fundedSatoshis: overrides.fundedSatoshis ?? 0n,
    fundingUtxoIds: overrides.fundingUtxoIds ?? [],
  };
}

function createTracking(
  db: Awaited<ReturnType<typeof createTestDb>>,
  overrides?: {
    mempool?: Partial<IMempoolTestDeps>;
    getOracleBitcoinBlockHeight?: () => number;
  },
) {
  const mempool = {
    getAddressUtxos: overrides?.mempool?.getAddressUtxos ?? vi.fn().mockResolvedValue([]),
    getTipHeight: overrides?.mempool?.getTipHeight ?? vi.fn().mockResolvedValue(125),
    getTxStatus: overrides?.mempool?.getTxStatus ?? vi.fn(),
  } satisfies IMempoolTestDeps;

  return new BitcoinUtxoTracking({
    dbPromise: Promise.resolve(db),
    getBitcoinNetwork: () => BitcoinNetwork.Bitcoin,
    getOracleBitcoinBlockHeight: overrides?.getOracleBitcoinBlockHeight ?? (() => 110),
    getConfig: () => createBitcoinLockConfig(),
    getMainchainClient: async () => ({}) as unknown as ArgonClient,
    mempool: mempool as IUtxoTrackingDeps['mempool'],
  });
}

function createLockDetails(): NonNullable<IBitcoinLockRecord['scriptDetails']> {
  return {
    p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
    vaultPubkey: `02${'11'.repeat(32)}`,
    vaultClaimPubkey: `02${'22'.repeat(32)}`,
    ownerPubkey: `02${'33'.repeat(32)}`,
    vaultXpubSources: { parentFingerprint: new Uint8Array(4), cosignHdIndex: 0, claimHdIndex: 0 },
    createdAtHeight: 100,
    vaultClaimHeight: 200,
    openClaimHeight: 300,
  };
}

describe('BitcoinUtxoTracking', () => {
  it('retains new funding receipts through restart and recovery until their deposits are acknowledged', async () => {
    const { db, migrateToLatest } = await createTestDbAtMigration(36);
    const previousTxid = 'a'.repeat(64);
    const depositTxid = 'b'.repeat(64);
    await db.execute(
      `INSERT INTO BitcoinUtxos (lockId, txid, vout, satoshis, network, status, firstSeenAt, firstSeenBitcoinHeight)
       VALUES (1, ?, 0, '100000', 'testnet', 'FundingUtxo', '2026-01-01T00:00:00Z', 100),
              (1, ?, 0, '5000000', 'testnet', 'SeenOnMempool', '2026-01-02T00:00:00Z', 101)`,
      [previousTxid, depositTxid],
    );
    await migrateToLatest();
    const store = createStore({ db });
    store.utxoTracking.data = Vue.reactive(store.utxoTracking.data);
    store.utxoTracking.load(await db.bitcoinUtxosTable.fetchAll());
    const pendingLock = await db.bitcoinLocksTable.insertPending(createLock());
    const currentLock = createCurrentLock({
      lockId: 1,
      fundedSatoshis: 100_000n,
      fundingUtxos: [{ utxoRef: { txid: previousTxid, vout: 0 }, satoshis: 100_000n }],
    });
    const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pendingLock.uuid, lock: currentLock });
    store.data.locksByLockId[lock.lockId!] = lock;
    await store.utxoTracking.syncFundingUtxos(lock, currentLock);
    expect(store.utxoTracking.getUnacknowledgedFundingUtxos(lock)).toEqual([]);

    const acceptedLock = createCurrentLock({
      ...currentLock,
      fundedSatoshis: 5_100_000n,
      fundingUtxos: [...currentLock.fundingUtxos, { utxoRef: { txid: depositTxid, vout: 0 }, satoshis: 5_000_000n }],
    });
    await store.utxoTracking.syncFundingUtxos(lock, acceptedLock);
    const deposit = store.utxoTracking.getUtxoRecord(1, depositTxid, 0)!;
    expect(store.utxoTracking.getUnacknowledgedFundingUtxos(lock).map(record => record.satoshis)).toEqual([5_000_000n]);

    const restarted = createStore({ db });
    restarted.utxoTracking.data = Vue.reactive(restarted.utxoTracking.data);
    restarted.utxoTracking.load(await db.bitcoinUtxosTable.fetchAll());
    const restoredLock = Vue.reactive((await db.bitcoinLocksTable.getByLockId(1))!);
    restarted.data.locksByLockId[1] = restoredLock;
    const receipt = Vue.computed(() => restarted.utxoTracking.getUnacknowledgedFundingUtxos(restoredLock));
    expect(receipt.value.map(record => record.satoshis)).toEqual([5_000_000n]);
    const recoveredDeposit = { ...deposit };
    await restarted.applyRecoveredHistory(
      { lockId: 1, utxos: [recoveredDeposit], releases: [], fissions: [], hdKeys: [], securitizationTerms: [] },
      1,
    );
    expect(receipt.value.map(record => record.satoshis)).toEqual([5_000_000n]);

    const historicalTxid = 'd'.repeat(64);
    await restarted.applyRecoveredHistory(
      {
        lockId: 1,
        utxos: [{ ...recoveredDeposit, id: 999, txid: historicalTxid }],
        releases: [],
        fissions: [],
        hdKeys: [],
        securitizationTerms: [],
      },
      1,
    );
    expect((await db.bitcoinUtxosTable.getByLockOutpoint(1, historicalTxid, 0))?.isDepositAcknowledged).toBe(true);
    expect(restarted.utxoTracking.getUtxoRecord(1, historicalTxid, 0)?.isDepositAcknowledged).toBe(true);

    await db.execute(`CREATE TRIGGER reject_receipt_ack BEFORE UPDATE OF isDepositAcknowledged ON BitcoinUtxos
      WHEN NEW.isDepositAcknowledged = 1 BEGIN SELECT RAISE(ABORT, 'receipt acknowledgment failed'); END`);
    await expect(restarted.utxoTracking.acknowledgeFunding(receipt.value)).rejects.toThrow(
      'receipt acknowledgment failed',
    );
    expect(receipt.value.map(record => record.satoshis)).toEqual([5_000_000n]);
    expect((await db.bitcoinUtxosTable.getByLockOutpoint(1, depositTxid, 0))?.isDepositAcknowledged).toBe(false);
    await db.execute('DROP TRIGGER reject_receipt_ack');
    await restarted.utxoTracking.acknowledgeFunding(receipt.value);
    expect(receipt.value).toEqual([]);

    await restarted.applyRecoveredHistory(
      { lockId: 1, utxos: [recoveredDeposit], releases: [], fissions: [], hdKeys: [], securitizationTerms: [] },
      1,
    );
    await restarted.utxoTracking.syncFundingUtxos(restoredLock, acceptedLock);
    expect(receipt.value).toEqual([]);
    const afterDone = createTracking(db);
    afterDone.load(await db.bitcoinUtxosTable.fetchAll());
    expect(afterDone.getUnacknowledgedFundingUtxos(restoredLock)).toEqual([]);

    const topUpTxid = 'c'.repeat(64);
    await restarted.utxoTracking.syncFundingUtxos(
      restoredLock,
      createCurrentLock({
        ...acceptedLock,
        fundedSatoshis: 6_100_000n,
        fundingUtxos: [...acceptedLock.fundingUtxos, { utxoRef: { txid: topUpTxid, vout: 0 }, satoshis: 1_000_000n }],
      }),
    );
    await restarted.utxoTracking.acknowledgeFunding([deposit]);
    expect(receipt.value.map(record => record.satoshis)).toEqual([1_000_000n]);
    expect(restarted.utxoTracking.getUnacknowledgedFundingUtxos(createLock({ lockId: 2 }))).toEqual([]);
  });

  it('rejects unconfirmed below-minimum deposits immediately and preserves dismissal through restart and replay', async () => {
    const { db, migrateToLatest } = await createTestDbAtMigration(36);
    const txid = '1'.repeat(64);
    await db.execute(
      `INSERT INTO BitcoinUtxos (lockId, txid, vout, satoshis, network, status, firstSeenAt, firstSeenBitcoinHeight)
       VALUES (1, ?, 0, '1000', 'testnet', 'SeenOnMempool', '2026-01-01T00:00:00Z', 0)`,
      [txid],
    );
    const beforeUpgrade = await db.select<object[]>('SELECT * FROM BitcoinUtxos');
    const historyBeforeUpgrade = await db.bitcoinUtxosTable.fetchStatusHistory(1);
    await migrateToLatest();
    expect(await db.select<object[]>('SELECT * FROM BitcoinUtxos')).toEqual([
      expect.objectContaining(beforeUpgrade[0]),
    ]);
    expect(await db.bitcoinUtxosTable.fetchStatusHistory(1)).toEqual(historyBeforeUpgrade);
    const mempool = {
      getAddressUtxos: vi.fn(async () => [
        { txid, vout: 0, value: 1_000, status: { confirmed: false } },
        { txid, vout: 1, value: 100_000, status: { confirmed: false } },
      ]),
      getTipHeight: vi.fn(async () => 132),
    } as unknown as IUtxoTrackingDeps['mempool'];
    const store = createStore({ db, mempool });
    store.data = Vue.reactive(store.data);
    store.utxoTracking.data = Vue.reactive(store.utxoTracking.data);
    store.utxoTracking.load(await db.bitcoinUtxosTable.fetchAll());
    const currentLock = createCurrentLock({ lockId: 1, fundedSatoshis: 0n, fundingUtxos: [] });
    const pendingLock = await db.bitcoinLocksTable.insertPending(createLock());
    const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pendingLock.uuid, lock: currentLock });
    store.data.locksByLockId[lock.lockId!] = lock;
    const wallet = new WalletForBitcoin(
      () => store,
      () => lock.ownerAccount!,
      {} as never,
    );
    const pending = Vue.computed(() => wallet.getPendingInboundUtxos());
    const minimumSatoshis = vi.fn(async () => 100_000n);
    const entries = vi.fn(async () => []);
    const client = {
      query: { bitcoinLocks: { minimumSatoshis, orphanedUtxosByAccount: { entries } } },
    } as unknown as ArgonClient;

    minimumSatoshis.mockRejectedValueOnce(new Error('RPC unavailable'));
    await store.utxoTracking.syncPendingFundingSignals(lock, client);
    expect(pending.value).toHaveLength(2);
    const observed = store.utxoTracking.getUtxoRecord(lock.lockId!, txid, 0)!;
    const historicalObservation = { ...observed };
    expect(observed.status).toBe('SeenOnMempool');
    expect(observed).not.toHaveProperty('fundingRejectionReason', 'BelowMinimum');

    let finishOrphanQuery!: () => void;
    entries.mockImplementationOnce(() => new Promise(resolve => (finishOrphanQuery = () => resolve([]))));
    const sync = store.utxoTracking.syncPendingFundingSignals(lock, client);
    try {
      await vi.waitFor(() => expect(observed).toHaveProperty('fundingRejectionReason', 'BelowMinimum'));
    } finally {
      finishOrphanQuery();
      await sync;
    }
    expect(observed).toMatchObject({
      status: 'SeenOnMempool',
      fundingRejectionReason: 'BelowMinimum',
      firstSeenBitcoinHeight: 0,
    });
    expect(observed.mempoolObservation?.isConfirmed).toBe(false);
    expect(store.utxoTracking.getObservedFundingUtxos(lock).map(record => record.vout)).toEqual([1]);
    expect(store.utxoTracking.getReceivedFundingSatoshis(lock)).toBe(100_000n);
    expect(pending.value).toHaveLength(2);
    expect(await db.bitcoinUtxosTable.fetchStatusHistory(observed.id)).toEqual([
      expect.objectContaining({ newStatus: 'SeenOnMempool' }),
    ]);

    await store.utxoTracking.acknowledgeBelowMinimum(observed);
    expect(pending.value.map(record => record.vout)).toEqual([1]);
    const restarted = createStore({ db, mempool });
    restarted.data.locksByLockId[lock.lockId!] = lock;
    restarted.utxoTracking.load(await db.bitcoinUtxosTable.fetchAll());
    await restarted.applyRecoveredHistory(
      {
        lockId: lock.lockId!,
        utxos: [historicalObservation],
        releases: [],
        fissions: [],
        hdKeys: [],
        securitizationTerms: [],
      },
      1,
    );
    minimumSatoshis.mockResolvedValue(500n);
    await restarted.utxoTracking.syncPendingFundingSignals(lock, client);
    const restartedWallet = new WalletForBitcoin(
      () => restarted,
      () => lock.ownerAccount!,
      {} as never,
    );
    expect(restartedWallet.getPendingInboundUtxos().map(record => record.vout)).toEqual([1]);
    expect(await db.bitcoinUtxosTable.getByLockOutpoint(lock.lockId!, txid, 0)).toMatchObject({
      status: 'SeenOnMempool',
      fundingRejectionReason: 'BelowMinimum',
      isDepositAcknowledged: true,
    });

    await restarted.utxoTracking.syncFundingUtxos(
      lock,
      createCurrentLock({
        lockId: 1,
        fundedSatoshis: 1_000n,
        fundingUtxos: [{ utxoRef: { txid, vout: 0 }, satoshis: 1_000n }],
      }),
    );
    expect(restarted.utxoTracking.getUtxoRecord(lock.lockId!, txid, 0)).toMatchObject({
      status: 'FundingUtxo',
      isDepositAcknowledged: false,
    });
    expect(
      (await db.bitcoinUtxosTable.getByLockOutpoint(lock.lockId!, txid, 0))?.fundingRejectionReason,
    ).toBeUndefined();
    expect(restartedWallet.getPendingInboundUtxos().map(record => record.vout)).toEqual([1]);
  });

  it('hides absent chain orphans while retaining cosigned returns through restart and completion', async () => {
    const db = await createTestDb();
    const store = createStore({ db });
    store.utxoTracking.data = Vue.reactive(store.utxoTracking.data);
    const lock = createLock({ status: BitcoinLockStatus.LockFunded });
    store.data.locksByLockId[lock.lockId!] = lock;
    const wallet = new WalletForBitcoin(
      () => store,
      () => lock.ownerAccount!,
      {} as never,
    );
    const visible = Vue.computed(() => wallet.getUnresolvedOrphanDeposits());
    const entries = vi.fn(async () => [
      [
        { args: [lock.ownerAccount, { txid: '2'.repeat(64), outputIndex: 0 }] },
        { lockId: lock.lockId, satoshis: 100_000n },
      ],
      [
        { args: [lock.ownerAccount, { txid: '3'.repeat(64), outputIndex: 0 }] },
        { lockId: lock.lockId, satoshis: 100_000n },
      ],
    ]);
    const client = { query: { bitcoinLocks: { orphanedUtxosByAccount: { entries } } } } as unknown as ArgonClient;
    await store.utxoTracking.syncArgonOrphans([lock], client);
    const [expired, returning] = store.utxoTracking.getUnresolvedOrphanRecords([lock]);
    const historicalOrphan = { ...expired };
    const release = await store.releases.createOrphanRelease(returning, {
      id: 'orphan-return',
      kind: BitcoinReleaseKind.Orphan,
      lockId: returning.lockId,
      sendId: 'orphan-return',
      status: BitcoinReleaseStatus.WaitingForVaultCosign,
      inputUtxoIds: [returning.id],
      toScriptPubkey: `0x0014${'11'.repeat(20)}`,
      bitcoinNetworkFee: 200n,
      destinationSatoshis: 99_800n,
      changeSatoshis: 0n,
      vaultSignatures: [],
    });
    await store.releases.recordVaultCosign(release, { vaultSignatures: [new Uint8Array(64).fill(44)] });
    expect(visible.value).toHaveLength(2);

    entries.mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(store.utxoTracking.syncArgonOrphans([lock], client)).rejects.toThrow('RPC unavailable');
    expect(visible.value).toHaveLength(2);
    entries.mockResolvedValue([]);
    await store.utxoTracking.syncArgonOrphans([lock], client);
    expect(visible.value.map(record => record.id)).toEqual([returning.id]);
    expect(expired.status).toBe('Orphaned');
    expect(expired.isOnArgonChain).toBe(false);
    expect(returning.spendStatus).toBe('Unspent');
    expect(store.utxoTracking.getUnresolvedOrphanRecords([lock])).toEqual([]);
    await expect(
      store.releases.createOrphanRelease(expired, {
        ...release,
        id: 'expired-return',
        inputUtxoIds: [expired.id],
      }),
    ).rejects.toThrow('This orphan return is not currently available.');

    const restarted = createStore({ db });
    restarted.data.locksByLockId[lock.lockId!] = lock;
    restarted.utxoTracking.load(await db.bitcoinUtxosTable.fetchAll());
    await restarted.releases.load();
    await restarted.applyRecoveredHistory(
      {
        lockId: lock.lockId!,
        utxos: [historicalOrphan],
        releases: [],
        fissions: [],
        hdKeys: [],
        securitizationTerms: [],
      },
      1,
    );
    const restartedWallet = new WalletForBitcoin(
      () => restarted,
      () => lock.ownerAccount!,
      {} as never,
    );
    expect(restartedWallet.getUnresolvedOrphanDeposits().map(record => record.id)).toEqual([returning.id]);
    const input = restarted.utxoTracking.getUtxoRecordById(returning.id)!;
    await restarted.releases.completeOrphanRelease(input, restarted.releases.getById(release.id)!, 132);
    expect(restartedWallet.getUnresolvedOrphanDeposits()).toEqual([]);
    expect(await db.bitcoinUtxosTable.getByLockOutpoint(lock.lockId!, expired.txid, expired.vout)).toMatchObject({
      status: 'Orphaned',
      isOnArgonChain: false,
    });
  });

  it('restores an offline cosign after restart and retires expired pending and interrupted returns only with complete evidence', async () => {
    const db = await createTestDb();
    const store = createStore({ db });
    const lock = Object.assign(createLock({ status: BitcoinLockStatus.Released }), { createdAtArgonBlock: 100 });
    store.data.locksByLockId[lock.lockId!] = lock;
    const returning = await store.utxoTracking.upsertUtxoRecord(
      lock,
      { txid: `0x${'4'.repeat(64)}`, vout: 0, satoshis: 100_000n },
      { markOrphaned: true },
    );
    const expired = await store.utxoTracking.upsertUtxoRecord(
      lock,
      { txid: `0x${'5'.repeat(64)}`, vout: 0, satoshis: 100_000n },
      { markOrphaned: true },
    );
    const interrupted = await store.utxoTracking.upsertUtxoRecord(
      lock,
      { txid: `0x${'6'.repeat(64)}`, vout: 0, satoshis: 100_000n },
      { markOrphaned: true },
    );
    for (const record of [returning, expired, interrupted]) {
      const release = await store.releases.createOrphanRelease(record, {
        id: `return-${record.id}`,
        kind: BitcoinReleaseKind.Orphan,
        lockId: record.lockId,
        sendId: `return-${record.id}`,
        status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
        inputUtxoIds: [record.id],
        toScriptPubkey: `0x0014${'11'.repeat(20)}`,
        bitcoinNetworkFee: 200n,
        destinationSatoshis: 99_800n,
        changeSatoshis: 0n,
        vaultSignatures: [],
      });
      // A transport failure can leave the durable reservation without a recorded Argon request.
      if (record.id !== interrupted.id) {
        await store.releases.recordArgonRequest(release, { requestedReleaseAtTick: 100 });
      }
    }
    const signature = new Uint8Array(64).fill(44);
    let expiredStillAvailable = false;
    const currentOrphan = { lockId: lock.lockId, satoshis: expired.satoshis };
    const client = {
      query: {
        bitcoinLocks: {
          orphanedUtxosByAccount: Object.assign(
            async (_owner: string, outpoint: { txid: string }) =>
              expiredStillAvailable && outpoint.txid === expired.txid ? currentOrphan : null,
            {
              entries: async () =>
                expiredStillAvailable
                  ? [[{ args: [lock.ownerAccount, { txid: expired.txid, outputIndex: expired.vout }] }, currentOrphan]]
                  : [],
            },
          ),
        },
        bitcoinUtxos: { confirmedBitcoinBlockTip: async () => ({ blockHeight: 111n }) },
      },
    } as unknown as ArgonClient;
    const currentClient = vi.spyOn(mainchain, 'getMainchainClient').mockResolvedValue(client);
    const blockWatch = {
      finalizedBlockHeader: historyBlock(110),
      getFinalizedApi: async () => client,
      getApi: async () => client,
      getEventsWithSpec: vi.fn(async (block: Pick<IBlockHeaderInfo, 'blockNumber'>) => ({
        api: client,
        events:
          block.blockNumber === 107
            ? [
                historyEvent(160, 'bitcoinLocks', 'OrphanedUtxoCosigned', {
                  lockId: lock.lockId,
                  vaultId: lock.vaultId,
                  accountId: lock.ownerAccount,
                  utxoRef: { txid: returning.txid, outputIndex: returning.vout },
                  signature: u8aToHex(signature),
                }),
              ]
            : [],
      })),
    } as unknown as BlockWatch;
    const restarted = createStore({ db, blockWatch });
    restarted.utxoTracking.data = Vue.reactive(restarted.utxoTracking.data);
    restarted.releases.data = Vue.reactive(restarted.releases.data);
    restarted.data.locksByLockId[lock.lockId!] = lock;
    restarted.utxoTracking.load(await db.bitcoinUtxosTable.fetchAll());
    await restarted.releases.load();
    const wallet = new WalletForBitcoin(
      () => restarted,
      () => lock.ownerAccount!,
      {} as never,
    );
    const visible = Vue.computed(() => wallet.getUnresolvedOrphanDeposits());
    await restarted.utxoTracking.syncArgonOrphans([lock], client);
    expect(visible.value).toHaveLength(3);
    const activity = vi.spyOn(indexerClient, 'findAddressActivity').mockResolvedValue({
      blocks: [{ blockNumber: 107, blockHash: '0x107', specVersion: 160, activityMask: 8 }],
      asOfBlock: 110,
      definitionVersion: 3,
      coverage: { fromBlock: 100, toBlock: 110, gaps: [{ fromBlock: 106, toBlock: 108, reason: 'Indexing delayed' }] },
    });
    try {
      restarted.data.isReconciliationPending = true;
      // @ts-expect-error Exercise the production startup queue over the loaded records.
      await restarted.runPendingLoadReconciliation();
      expect(visible.value).toHaveLength(3);
      expect(await db.bitcoinReleasesTable.getById(`return-${returning.id}`)).toMatchObject({
        status: BitcoinReleaseStatus.WaitingForVaultCosign,
        vaultSignatures: [],
        statusError: expect.stringContaining('Please retry shortly'),
      });
      expect(await db.bitcoinReleasesTable.getById(`return-${interrupted.id}`)).toMatchObject({
        status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
      });
      activity.mockResolvedValue({
        blocks: [{ blockNumber: 107, blockHash: '0x107', specVersion: 160, activityMask: 8 }],
        asOfBlock: 111,
        definitionVersion: 3,
        coverage: { fromBlock: 100, toBlock: 111, gaps: [] },
      });
      expiredStillAvailable = true;
      Object.assign(blockWatch, { finalizedBlockHeader: historyBlock(111) });
      await restarted.releases.reconcileOrphanReleases(lock);
      expect(restarted.releases.getById(`return-${returning.id}`)?.statusError).toBeUndefined();
      expect(await db.bitcoinReleasesTable.getById(`return-${returning.id}`)).toMatchObject({
        status: BitcoinReleaseStatus.ReadyForBitcoinBroadcast,
        vaultSignatures: [signature],
        cosignBlockNumber: 107,
      });
      // A cached absence cannot retire a return still present at the finalized evidence boundary.
      expect(await db.bitcoinReleasesTable.getById(`return-${expired.id}`)).toMatchObject({
        status: BitcoinReleaseStatus.WaitingForVaultCosign,
      });
      expect((await db.bitcoinUtxosTable.getByLockOutpoint(lock.lockId!, expired.txid, 0))?.activeReleaseId).toBe(
        `return-${expired.id}`,
      );
      expect(visible.value.map(record => record.id)).toEqual([returning.id, expired.id]);
      expiredStillAvailable = false;
      Object.assign(blockWatch, { finalizedBlockHeader: historyBlock(112) });
      activity.mockResolvedValue({
        blocks: [{ blockNumber: 107, blockHash: '0x107', specVersion: 160, activityMask: 8 }],
        asOfBlock: 112,
        definitionVersion: 3,
        coverage: { fromBlock: 100, toBlock: 112, gaps: [] },
      });
      // @ts-expect-error Exercise finalized-block reconciliation of a terminal parent lock.
      expect(await restarted.checkIncomingArgonBlock(historyBlock(112))).toBe(true);
      expect(visible.value.map(record => record.id)).toEqual([returning.id]);
      expect(await db.bitcoinReleasesTable.getById(`return-${expired.id}`)).toMatchObject({
        status: BitcoinReleaseStatus.Cancelled,
      });
      expect(
        (await db.bitcoinUtxosTable.getByLockOutpoint(lock.lockId!, expired.txid, 0))?.activeReleaseId,
      ).toBeUndefined();
      expect(await db.bitcoinReleasesTable.getById(`return-${interrupted.id}`)).toMatchObject({
        status: BitcoinReleaseStatus.Cancelled,
      });
      expect(
        (await db.bitcoinUtxosTable.getByLockOutpoint(lock.lockId!, interrupted.txid, 0))?.activeReleaseId,
      ).toBeUndefined();
    } finally {
      activity.mockRestore();
      currentClient.mockRestore();
    }
  });

  it('checks current availability before publishing newly recovered orphans and keeps failed recovery retryable', async () => {
    const db = await createTestDb();
    const entries = vi.fn(async () => []);
    const client = {
      query: {
        bitcoinLocks: { orphanedUtxosByAccount: { entries } },
        bitcoinUtxos: { confirmedBitcoinBlockTip: async () => ({ blockHeight: 111n }) },
      },
      rpc: { chain: { getFinalizedHead: async () => '0x120' } },
      at: async () => client,
    } as unknown as ArgonClient;
    const blockWatch = {
      finalizedBlockHeader: historyBlock(120),
      getFinalizedApi: async () => client,
      getEventsWithSpec: async () => ({ api: client, events: [] }),
    } as unknown as BlockWatch;
    const store = createStore({ db, blockWatch });
    const lock = Object.assign(createLock({ status: BitcoinLockStatus.Released }), { createdAtArgonBlock: 100 });
    store.data.locksByLockId[lock.lockId!] = lock;
    store.data.oracleBitcoinBlockHeight = 111;
    await store.utxoTracking.syncArgonOrphans([lock], client);
    const history = new BitcoinHistoryUtxoState();
    const expired = history.upsert(lock, { txid: `0x${'a'.repeat(64)}`, vout: 0, satoshis: 100_000n }, true);
    const unit = {
      lockId: lock.lockId!,
      utxos: [expired],
      releases: [],
      fissions: [],
      hdKeys: [],
      securitizationTerms: [],
    };
    const wallet = new WalletForBitcoin(
      () => store,
      () => lock.ownerAccount!,
      {} as never,
    );
    const currentClient = vi.spyOn(mainchain, 'getMainchainClient').mockResolvedValue(client);
    try {
      entries.mockRejectedValueOnce(new Error('Current orphan snapshot unavailable'));
      await expect(store.applyRecoveredHistory(unit, 110)).rejects.toThrow('Current orphan snapshot unavailable');
      expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([]);
      expect(wallet.getUnresolvedOrphanDeposits()).toEqual([]);

      await store.applyRecoveredHistory(unit, 110);
      expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([
        expect.objectContaining({ status: BitcoinUtxoStatus.Orphaned, isOnArgonChain: false }),
      ]);
      expect(wallet.getUnresolvedOrphanDeposits()).toEqual([]);
      // @ts-expect-error A normal finalized block need not contain any new Bitcoin state.
      expect(await store.checkIncomingArgonBlock(historyBlock(120))).toBe(true);
      expect(wallet.getUnresolvedOrphanDeposits()).toEqual([]);
    } finally {
      currentClient.mockRestore();
    }
  });

  it('retries orphan snapshots without letting older block state replace current availability', async () => {
    const db = await createTestDb();
    const pending = await db.bitcoinLocksTable.insertPending(createLock());
    const lock = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock({ lockId: 1 }),
    });
    await db.bitcoinLocksTable.setStatus(lock, BitcoinLockStatus.Released);
    const original = createStore({ db });
    await original.utxoTracking.upsertUtxoRecord(
      lock,
      { txid: `0x${'b'.repeat(64)}`, vout: 0, satoshis: 100_000n },
      { markOrphaned: true },
    );
    let snapshotAvailable = false;
    let orphanAvailable = false;
    let bitcoinTip = 111n;
    const laterOrphanTxid = `0x${'d'.repeat(64)}`;
    const client = {
      consts: { bitcoinLocks: { argonTicksPerDay: { toNumber: () => 1_440 } } },
      query: {
        bitcoinLocks: {
          orphanedUtxosByAccount: {
            entries: async () => {
              if (!snapshotAvailable) throw new Error('Current orphan snapshot unavailable');
              return orphanAvailable
                ? [
                    [
                      { args: [lock.ownerAccount, { txid: laterOrphanTxid, outputIndex: 0 }] },
                      { lockId: 1, satoshis: 100_000n },
                    ],
                  ]
                : [];
            },
          },
        },
        bitcoinUtxos: { confirmedBitcoinBlockTip: async () => ({ blockHeight: bitcoinTip }) },
      },
    } as unknown as ArgonClient;
    const archivedClient = {
      ...client,
      query: {
        ...client.query,
        bitcoinLocks: { orphanedUtxosByAccount: { entries: async () => [] } },
      },
    } as unknown as ArgonClient;
    let finalized!: (headers: IBlockHeaderInfo[]) => void;
    const blockWatch = {
      start: async () => undefined,
      events: {
        on: (_event: string, listener: typeof finalized) => {
          finalized = listener;
          return () => undefined;
        },
      },
      finalizedBlockHeader: historyBlock(120),
      getFinalizedApi: async () => client,
      getEventsWithSpec: async () => ({ api: archivedClient, events: [] }),
    } as unknown as BlockWatch;
    const restarted = createStore({ db, blockWatch });
    restarted.data = Vue.reactive(restarted.data);
    restarted.utxoTracking.data = Vue.reactive(restarted.utxoTracking.data);
    const wallet = new WalletForBitcoin(
      () => restarted,
      () => lock.ownerAccount!,
      {} as never,
    );
    const visible = Vue.computed(() => wallet.getUnresolvedOrphanDeposits());
    const currentClient = vi.spyOn(mainchain, 'getMainchainClient').mockResolvedValue(client);
    const config = vi.spyOn(BitcoinLock, 'getConfig').mockResolvedValue(createBitcoinLockConfig());
    const activeIds = vi.spyOn(BitcoinLock, 'idsByOwner').mockResolvedValue([]);
    try {
      await restarted.load();
      await vi.waitFor(() => expect(restarted.data.latestArgonBlock?.blockNumber).toBe(120));
      expect(visible.value).toHaveLength(1);
      expect((await db.bitcoinUtxosTable.fetchAll())[0].isOnArgonChain).toBeUndefined();

      snapshotAvailable = true;
      finalized([historyBlock(121)]);
      await vi.waitFor(() => expect(visible.value).toEqual([]));
      expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([
        expect.objectContaining({ status: BitcoinUtxoStatus.Orphaned, isOnArgonChain: false }),
      ]);
      await vi.waitFor(() => expect(restarted.data.isReconciliationPending).toBe(false));

      orphanAvailable = true;
      bitcoinTip = 112n;
      // The finalized reader can advance while the domain drains older block work.
      Object.assign(blockWatch, { finalizedBlockHeader: historyBlock(123) });
      finalized([historyBlock(122)]);
      await vi.waitFor(() => expect(restarted.data.latestArgonBlock?.blockNumber).toBe(122));
      expect(visible.value).toHaveLength(1);

      snapshotAvailable = false;
      orphanAvailable = false;
      bitcoinTip = 113n;
      finalized([historyBlock(123)]);
      await vi.waitFor(() => expect(restarted.data.latestArgonBlock?.blockNumber).toBe(123));
      expect(visible.value).toHaveLength(1);
      expect(await db.bitcoinUtxosTable.fetchAll()).toContainEqual(
        expect.objectContaining({ txid: laterOrphanTxid, isOnArgonChain: true }),
      );
      expect(restarted.data.isReconciliationPending).toBe(true);

      snapshotAvailable = true;
      finalized([historyBlock(124)]);
      await vi.waitFor(() => expect(visible.value).toEqual([]));
      expect(await db.bitcoinUtxosTable.fetchAll()).toContainEqual(
        expect.objectContaining({ txid: laterOrphanTxid, isOnArgonChain: false }),
      );
      await vi.waitFor(() => expect(restarted.data.isReconciliationPending).toBe(false));
    } finally {
      currentClient.mockRestore();
      config.mockRestore();
      activeIds.mockRestore();
    }
  });

  it('upserts funding records and stores mempool observations', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock();

    const record = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'a'.repeat(64), vout: 0, satoshis: 11_000n },
      {
        mempoolObservation: {
          isConfirmed: false,
          confirmations: 0,
          satoshis: 11_000n,
          txid: 'a'.repeat(64),
          vout: 0,
          transactionBlockHeight: 120,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 110,
        },
      },
    );

    const reloaded = tracking.getUtxoRecord(lock.lockId!, record.txid, record.vout)!;
    expect(reloaded.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(reloaded.firstSeenBitcoinHeight).toBe(120);
    expect(reloaded.mempoolObservation?.satoshis).toBe(11_000n);
    expect(tracking.hasObservedFundingSignal(lock)).toBe(true);
  });

  it('tracks every observed deposit while funding remains pending', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ securitizedSatoshis: 10_000n });

    await tracking.upsertUtxoRecord(lock, { txid: 'a'.repeat(64), vout: 0, satoshis: 8_000n }, {});
    await tracking.upsertUtxoRecord(lock, { txid: 'b'.repeat(64), vout: 1, satoshis: 10_200n }, {});
    await tracking.upsertUtxoRecord(lock, { txid: 'c'.repeat(64), vout: 2, satoshis: 14_000n }, {});

    const observed = tracking.getObservedFundingUtxos(lock);
    expect(observed.map(record => record.txid)).toEqual(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
    expect(tracking.getReceivedFundingSatoshis(lock)).toBe(32_200n);
  });

  it('tracks a later observed deposit independently of an already funded lock', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockFunded, fundedSatoshis: 10_000n });
    const fundingUtxo = await tracking.upsertUtxoRecord(lock, { txid: 'a'.repeat(64), vout: 0, satoshis: 10_000n }, {});
    await db.bitcoinUtxosTable.setFundingUtxo(fundingUtxo);
    lock.fundingUtxoIds = [fundingUtxo.id];

    await tracking.upsertUtxoRecord(
      lock,
      { txid: 'b'.repeat(64), vout: 1, satoshis: 5_000n },
      {
        mempoolObservation: {
          isConfirmed: false,
          confirmations: 0,
          satoshis: 5_000n,
          txid: 'b'.repeat(64),
          vout: 1,
          transactionBlockHeight: 0,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 110,
        },
      },
    );

    expect(tracking.getLockProcessingDetails(lock)).toMatchObject({
      progressPct: 0,
      confirmations: -1,
      receivedSatoshis: 15_000n,
    });
  });

  it('reports confirmation progress for each observed deposit independently', async () => {
    const db = await createTestDb();
    let oracleBitcoinBlockHeight = 111;
    const tracking = createTracking(db, { getOracleBitcoinBlockHeight: () => oracleBitcoinBlockHeight });
    const lock = createLock({ status: BitcoinLockStatus.LockFunded, fundedSatoshis: 10_000n });
    const confirmed = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'b'.repeat(64), vout: 0, satoshis: 5_000n },
      {
        mempoolObservation: {
          isConfirmed: true,
          confirmations: 1,
          satoshis: 5_000n,
          txid: 'b'.repeat(64),
          vout: 0,
          transactionBlockHeight: 120,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 111,
        },
      },
    );
    oracleBitcoinBlockHeight = 118;
    const unconfirmed = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'c'.repeat(64), vout: 1, satoshis: 6_000n },
      {
        mempoolObservation: {
          isConfirmed: false,
          confirmations: 0,
          satoshis: 6_000n,
          txid: 'c'.repeat(64),
          vout: 1,
          transactionBlockHeight: 0,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 118,
        },
      },
    );

    expect(tracking.getFundingUtxoProcessingDetails(confirmed).confirmations).toBe(7);
    expect(tracking.getFundingUtxoProcessingDetails(unconfirmed).confirmations).toBe(-1);
  });

  it('captures the oracle height when funding first becomes confirmed', async () => {
    const db = await createTestDb();
    let oracleBitcoinBlockHeight = 110;
    const tracking = createTracking(db, {
      getOracleBitcoinBlockHeight: () => oracleBitcoinBlockHeight,
    });
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });

    const record = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'c'.repeat(64), vout: 0, satoshis: 10_000n },
      {
        mempoolObservation: {
          isConfirmed: false,
          confirmations: 0,
          satoshis: 10_000n,
          txid: 'c'.repeat(64),
          vout: 0,
          transactionBlockHeight: 0,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 110,
        },
      },
    );

    oracleBitcoinBlockHeight = 111;
    await tracking.upsertUtxoRecord(
      lock,
      { txid: record.txid, vout: record.vout, satoshis: record.satoshis },
      {
        mempoolObservation: {
          isConfirmed: true,
          confirmations: 1,
          satoshis: 10_000n,
          txid: record.txid,
          vout: record.vout,
          transactionBlockHeight: 120,
          transactionBlockTime: 1710000300,
          argonBitcoinHeight: 111,
        },
      },
    );

    oracleBitcoinBlockHeight = 118;

    const details = tracking.getLockProcessingDetails(lock);

    expect(record.firstSeenOracleHeight).toBe(111);
    expect(details.confirmations).toBe(7);
    expect(details.expectedConfirmations).toBe(9);
  });

  it('hydrates a runtime-classified orphan into the local table', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });
    const chainTxid = 'f'.repeat(64);
    const orphanedEntriesQuery = vi.fn().mockResolvedValue([
      [
        { args: [{}, { txid: chainTxid, outputIndex: 2 }] },
        {
          lockId: lock.lockId,
          satoshis: 10_200n,
          cosignRequest: null,
        },
      ],
    ]);
    const preferredClient = Object.assign(Object.create(null), {
      query: Object.assign(Object.create(null), {
        bitcoinLocks: Object.assign(Object.create(null), {
          orphanedUtxosByAccount: Object.assign(Object.create(null), {
            entries: orphanedEntriesQuery,
          }),
        }),
      }),
    }) as ArgonClient;

    await tracking.syncPendingFundingSignals(lock, preferredClient);

    expect(orphanedEntriesQuery).toHaveBeenCalledWith(lock.ownerAccount);
    const orphan = tracking.getUnresolvedOrphanRecords([lock])[0];
    expect(orphan.txid).toBe(chainTxid);
    expect(orphan.vout).toBe(2);
    expect(orphan.satoshis).toBe(10_200n);
    expect(orphan.firstSeenOnArgonAt).toBeInstanceOf(Date);
    expect(orphan.status).toBe(BitcoinUtxoStatus.Orphaned);
  });

  it('records mempool funding while runtime orphan classification is unavailable', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db, {
      mempool: {
        getAddressUtxos: vi.fn().mockResolvedValue([
          {
            txid: 'd'.repeat(64),
            vout: 0,
            value: 10_100,
            status: {
              confirmed: true,
              block_height: 125,
              block_time: 1710000000,
            },
          },
        ]),
      },
    });
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });
    const preferredClient = Object.assign(Object.create(null), {
      query: Object.assign(Object.create(null), {
        bitcoinLocks: Object.assign(Object.create(null), {
          orphanedUtxosByAccount: Object.assign(Object.create(null), {
            entries: vi.fn().mockRejectedValue(new Error('rpc timeout')),
          }),
        }),
      }),
    }) as ArgonClient;

    const hasSignals = await tracking.syncPendingFundingSignals(lock, preferredClient);

    expect(hasSignals).toBe(true);
    const [observed] = tracking.getObservedFundingUtxos(lock);
    expect(observed?.txid).toBe('d'.repeat(64));
    expect(observed?.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(observed?.mempoolObservation?.isConfirmed).toBe(true);
  });

  it('still records a runtime orphan when mempool observation fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = await createTestDb();
    const tracking = createTracking(db, {
      mempool: {
        getAddressUtxos: vi.fn().mockRejectedValue(new Error('esplora unavailable')),
      },
    });
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });
    const chainTxid = 'e'.repeat(64);
    const preferredClient = Object.assign(Object.create(null), {
      query: Object.assign(Object.create(null), {
        bitcoinLocks: Object.assign(Object.create(null), {
          orphanedUtxosByAccount: Object.assign(Object.create(null), {
            entries: vi.fn().mockResolvedValue([
              [
                { args: [{}, { txid: chainTxid, outputIndex: 1 }] },
                {
                  lockId: lock.lockId,
                  satoshis: 10_100n,
                  cosignRequest: null,
                },
              ],
            ]),
          }),
        }),
      }),
    }) as ArgonClient;

    const hasSignals = await tracking.syncPendingFundingSignals(lock, preferredClient);

    expect(hasSignals).toBe(true);
    expect(tracking.getUnresolvedOrphanRecords([lock])).toEqual([
      expect.objectContaining({ txid: chainTxid, status: BitcoinUtxoStatus.Orphaned }),
    ]);
    expect(warning).toHaveBeenCalledWith(
      '[BitcoinUtxoTracking] Failed to observe mempool funding for lock lock-1 (lockId 1)',
      expect.objectContaining({ message: 'esplora unavailable' }),
    );
    warning.mockRestore();
  });

  it('keeps an observed deposit when its mempool observation is refreshed', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });

    const deposit = await tracking.upsertUtxoRecord(lock, { txid: 'e'.repeat(64), vout: 3, satoshis: 10_200n }, {});

    await tracking.upsertUtxoRecord(
      lock,
      { txid: deposit.txid, vout: deposit.vout, satoshis: deposit.satoshis },
      {
        mempoolObservation: {
          isConfirmed: false,
          confirmations: 0,
          satoshis: deposit.satoshis,
          txid: deposit.txid,
          vout: deposit.vout,
          transactionBlockHeight: 0,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 110,
        },
      },
    );

    const reloaded = tracking.getUtxoRecord(lock.lockId!, deposit.txid, deposit.vout)!;
    expect(reloaded.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(reloaded.mempoolObservation?.txid).toBe(deposit.txid);
  });

  it('keeps a failed orphan return actionable while lock is pending funding', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });

    const orphan = await tracking.upsertUtxoRecord(
      lock,
      { txid: '9'.repeat(64), vout: 0, satoshis: 9_900n },
      { markOrphaned: true },
    );
    await tracking.setStatusError(orphan, 'temporary failure');

    const unresolved = tracking.getUnresolvedOrphanRecords([lock]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].id).toBe(orphan.id);
    expect(unresolved[0].status).toBe(BitcoinUtxoStatus.Orphaned);
    expect(unresolved[0].statusError).toBe('temporary failure');
  });

  it('does not infer that another observed deposit is an orphan when funding is accepted', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    tracking.data = Vue.reactive(tracking.data) as typeof tracking.data;
    const currentLock = createCurrentLock({
      lockId: 1,
      fundedSatoshis: 10_000n,
      fundingUtxos: [{ utxoRef: { txid: '8'.repeat(64), vout: 0 }, satoshis: 10_000n }],
    });
    const pending = await db.bitcoinLocksTable.insertPending(createLock({ lockId: undefined }));
    const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pending.uuid, lock: currentLock });

    const acceptedRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: '8'.repeat(64), vout: 0, satoshis: lock.securitizedSatoshis },
      {},
    );
    const otherObservedDeposit = await tracking.upsertUtxoRecord(
      lock,
      { txid: '9'.repeat(64), vout: 1, satoshis: lock.securitizedSatoshis + 200n },
      {},
    );
    const unresolvedOrphans = Vue.computed(() => tracking.getUnresolvedOrphanRecords([lock]));
    expect(unresolvedOrphans.value).toEqual([]);

    await tracking.syncFundingUtxos(lock, currentLock);

    expect(acceptedRecord.status).toBe(BitcoinUtxoStatus.FundingUtxo);
    expect(otherObservedDeposit.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(unresolvedOrphans.value).toEqual([]);

    const history = await db.bitcoinUtxosTable.fetchStatusHistory(otherObservedDeposit.id);
    expect(history.at(-1)?.newStatus).toBe(BitcoinUtxoStatus.SeenOnMempool);
  });

  it('materializes every runtime-accepted funding outpoint without promoting other observations', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const currentLock = createCurrentLock({
      lockId: 1,
      fundedSatoshis: 10_000n,
      fundingUtxos: [
        { utxoRef: { txid: '8'.repeat(64), vout: 0 }, satoshis: 4_000n },
        { utxoRef: { txid: '9'.repeat(64), vout: 2 }, satoshis: 6_000n },
      ],
    });
    const pending = await db.bitcoinLocksTable.insertPending(createLock({ lockId: undefined }));
    const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pending.uuid, lock: currentLock });
    lock.fissionedSatoshis = lock.securitizedSatoshis;
    await tracking.syncFundingUtxos(lock, currentLock);
    const observed = await tracking.upsertUtxoRecord(lock, { txid: '7'.repeat(64), vout: 3, satoshis: 2_000n }, {});

    const fundingUtxos = tracking.getFundingUtxos(lock);
    expect(lock.fundingUtxoIds).toEqual(fundingUtxos.map(utxo => utxo.id));
    expect(lock.fundedSatoshis).toBe(10_000n);
    expect(lock.fissionedSatoshis).toBe(0n);
    expect(fundingUtxos).toEqual([
      expect.objectContaining({ txid: '8'.repeat(64), vout: 0, satoshis: 4_000n }),
      expect.objectContaining({ txid: '9'.repeat(64), vout: 2, satoshis: 6_000n }),
    ]);
    expect(tracking.getUtxosForLock(lock.lockId!)).toContain(observed);
    expect(observed.status).toBe(BitcoinUtxoStatus.SeenOnMempool);

    const reloadedLock = await db.bitcoinLocksTable.getByLockId(lock.lockId!);
    const reloadedTracking = createTracking(db);
    reloadedTracking.load(await db.bitcoinUtxosTable.fetchAll());
    expect(reloadedLock?.fundingUtxoIds).toEqual(lock.fundingUtxoIds);
    expect(reloadedLock && reloadedTracking.getFundingUtxos(reloadedLock).map(utxo => utxo.id)).toEqual(
      lock.fundingUtxoIds,
    );
  });

  it('does not overwrite a release transition that completes while funding synchronization publishes', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const currentLock = createCurrentLock({
      lockId: 1,
      fundedSatoshis: 10_000n,
      fundingUtxos: [{ utxoRef: { txid: '8'.repeat(64), vout: 0 }, satoshis: 10_000n }],
    });
    const pending = await db.bitcoinLocksTable.insertPending(createLock({ lockId: undefined }));
    const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pending.uuid, lock: currentLock });
    await db.bitcoinLocksTable.setStatus(lock, BitcoinLockStatus.LockFunded);

    let finishFundingSync!: () => void;
    let fundingSyncPersisted!: () => void;
    const waitForFundingSyncToPersist = new Promise<void>(resolve => (fundingSyncPersisted = resolve));
    const waitToPublishFundingSync = new Promise<void>(resolve => (finishFundingSync = resolve));
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async callback => {
      const result = await transaction(callback);
      fundingSyncPersisted();
      await waitToPublishFundingSync;
      return result;
    });

    const fundingSync = tracking.syncFundingUtxos(lock, currentLock);
    await waitForFundingSyncToPersist;
    await db.bitcoinLocksTable.setActiveRelease(lock, 'release-1');
    finishFundingSync();
    await fundingSync;

    expect(lock.status).toBe(BitcoinLockStatus.Releasing);
    expect(lock.activeReleaseId).toBe('release-1');

    const staleLock = { ...lock, status: BitcoinLockStatus.LockFunded, activeReleaseId: undefined };
    await tracking.syncFundingUtxos(staleLock, currentLock);
    await expect(db.bitcoinLocksTable.getByLockId(lock.lockId!)).resolves.toMatchObject({
      status: BitcoinLockStatus.Releasing,
      activeReleaseId: 'release-1',
    });
  });

  it('selects unresolved orphan records independently from their lock state', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockFunded });
    const additionalOrphan = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'e'.repeat(64), vout: 4, satoshis: lock.securitizedSatoshis + 1_000n },
      { markOrphaned: true },
    );
    const exactAmountOrphan = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'b'.repeat(64), vout: 1, satoshis: lock.securitizedSatoshis },
      { markOrphaned: true },
    );
    const returningOrphan = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'c'.repeat(64), vout: 2, satoshis: lock.securitizedSatoshis + 500n },
      { markOrphaned: true },
    );
    const returnedOrphan = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'd'.repeat(64), vout: 3, satoshis: lock.securitizedSatoshis - 500n },
      { markOrphaned: true },
    );

    await db.bitcoinUtxosTable.setSpent(returnedOrphan, 'completed-release');

    const records = tracking.getUnresolvedOrphanRecords([lock]);
    expect(records).toHaveLength(3);
    expect(records).toEqual(expect.arrayContaining([additionalOrphan, returningOrphan, exactAmountOrphan]));
  });

  it('synchronizes all chain orphans with one query per owner', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const firstLock = createLock({ lockId: 1, uuid: 'lock-1' });
    const secondLock = createLock({ lockId: 2, uuid: 'lock-2' });
    const thirdLock = createLock({
      lockId: 3,
      uuid: 'lock-3',
      ownerAccount: 'owner-2',
    });
    const orphanEntry = (lockId: number, txid: string, vout: number, satoshis: bigint) => [
      { args: [{}, { txid, outputIndex: vout }] },
      {
        lockId,
        satoshis,
        cosignRequest: null,
      },
    ];
    const entries = vi.fn().mockImplementation(async (owner: string) => {
      if (owner === thirdLock.ownerAccount) {
        return [orphanEntry(3, 'c'.repeat(64), 0, 12_000n)];
      }
      return [
        orphanEntry(1, 'a'.repeat(64), 0, 10_000n),
        orphanEntry(1, 'b'.repeat(64), 1, 11_000n),
        orphanEntry(99, 'f'.repeat(64), 0, 99_000n),
      ];
    });
    const client = {
      query: { bitcoinLocks: { orphanedUtxosByAccount: { entries } } },
    } as unknown as ArgonClient;

    const records = await tracking.syncArgonOrphans([firstLock, secondLock, thirdLock], client);

    expect(entries).toHaveBeenCalledTimes(2);
    expect(records.map(record => `${record.lockId}:${record.txid}:${record.vout}`)).toEqual([
      `1:${'a'.repeat(64)}:0`,
      `1:${'b'.repeat(64)}:1`,
      `3:${'c'.repeat(64)}:0`,
    ]);
    await tracking.syncArgonOrphans([firstLock, secondLock, thirdLock], client);
    expect(tracking.getUtxosForLock(firstLock.lockId!)).toHaveLength(2);
    expect(tracking.getUtxosForLock(thirdLock.lockId!)).toHaveLength(1);
  });
});
