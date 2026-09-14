import { BitcoinLock, type ArgonClient, type TxSigningAccount } from '@argonprotocol/apps-core';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import type { SubmittableExtrinsic } from '@argonprotocol/mainchain';
import { describe, expect, it, vi } from 'vitest';

import { BitcoinLockStatus, type IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import { BitcoinReleaseKind, BitcoinReleaseStatus } from '../interfaces/IBitcoinReleaseRecord.ts';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus } from '../interfaces/IBitcoinUtxoRecord.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import BitcoinReleases from '../lib/BitcoinReleases.ts';
import BitcoinUtxoTracking from '../lib/BitcoinUtxoTracking.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import { BitcoinLockRelease } from '../lib/txs/BitcoinLock.release.ts';
import { BitcoinOrphanRelease } from '../lib/txs/BitcoinOrphan.release.ts';
import { createStore } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';

describe('Bitcoin lock release', () => {
  it('refuses to release Bitcoin that is still allocated to a Liquid', async () => {
    const lock = { lockId: 11, status: BitcoinLockStatus.LockFunded } as IBitcoinLockRecord;
    const getLock = vi.spyOn(BitcoinLock, 'get').mockResolvedValue({ fissionedSatoshis: 1_000n } as BitcoinLock);
    const release = new BitcoinLockRelease(
      {
        bitcoinNetwork: 'regtest',
        getLockById: () => lock,
        isLockFunded: () => true,
        releases: { getActiveForLock: () => undefined },
      } as unknown as BitcoinLocks,
      {} as TransactionTracker,
    );

    try {
      await expect(
        release.prepare({
          lockId: 11,
          bitcoinNetworkFee: 500n,
          toScriptPubkey: 'unused-before-active-liquid-guard',
          txSigner: { address: 'owner-account' } as TxSigningAccount,
          client: {} as ArgonClient,
        }),
      ).rejects.toThrow('Close its Liquid before releasing this Bitcoin lock.');
    } finally {
      getLock.mockRestore();
    }
  });

  it('persists and resumes an ordered multi-input Lock release through every durable boundary', async () => {
    const db = await createTestDb();
    const pendingLock = await db.bitcoinLocksTable.insertPending({
      uuid: 'release-lock',
      status: BitcoinLockStatus.LockPendingFunding,
      securitizedSatoshis: 1_000n,
      cosignVersion: 'v1',
      network: 'regtest',
      hdPath: "m/84'/1'/0'/0/1",
      vaultId: 3,
    });
    await db.execute('UPDATE BitcoinLocks SET lockId = ?, status = ?, fundedSatoshis = ? WHERE uuid = ?', [
      7,
      BitcoinLockStatus.LockFunded,
      1_000n,
      pendingLock.uuid,
    ]);

    const firstInput = await db.bitcoinUtxosTable.insert({
      lockId: 7,
      txid: '1'.repeat(64),
      vout: 0,
      satoshis: 400n,
      network: 'regtest',
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-09-11T00:00:00Z'),
      firstSeenBitcoinHeight: 100,
    });
    const secondInput = await db.bitcoinUtxosTable.insert({
      lockId: 7,
      txid: '2'.repeat(64),
      vout: 1,
      satoshis: 600n,
      network: 'regtest',
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-09-11T00:01:00Z'),
      firstSeenBitcoinHeight: 100,
    });
    await db.execute('UPDATE BitcoinLocks SET fundingUtxoIds = ? WHERE uuid = ?', [
      [firstInput.id, secondInput.id],
      pendingLock.uuid,
    ]);

    const destinationScript = `0x0020${'ab'.repeat(32)}`;
    const destinationAddress = BitcoinLocks.formatP2wshAddress(destinationScript, BitcoinNetwork.Regtest);

    const submitAndWatch = vi.fn(async () => {
      const persistedRelease = await db.bitcoinReleasesTable.getById('release-1');
      const persistedLock = await db.bitcoinLocksTable.getByLockId(7);
      const persistedInputs = await db.bitcoinUtxosTable.fetchByLockId(7);

      expect(persistedRelease).toMatchObject({
        id: 'release-1',
        kind: BitcoinReleaseKind.Lock,
        status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
        inputUtxoIds: [firstInput.id, secondInput.id],
        toScriptPubkey: destinationScript,
      });
      expect(persistedLock).toMatchObject({
        status: BitcoinLockStatus.Releasing,
        activeReleaseId: 'release-1',
      });
      expect(persistedInputs.map(input => input.activeReleaseId)).toEqual(['release-1', 'release-1']);
      throw new Error('Argon submission unavailable');
    });
    const transactionTracker = {
      findLatestTxAttempt: vi.fn().mockResolvedValue(undefined),
      submitAndWatch,
    } as unknown as TransactionTracker;
    const bitcoinLocks = await loadBitcoinLocksState(db, transactionTracker);
    const lock = bitcoinLocks.getLockById(7)!;
    const releases = bitcoinLocks.releases;
    const operation = new BitcoinLockRelease(bitcoinLocks, transactionTracker);
    const txSigner = { address: 'owner-account' } as TxSigningAccount;
    const tx = {} as SubmittableExtrinsic;

    await expect(
      operation.submit(
        {
          lockId: 7,
          bitcoinNetworkFee: 25n,
          toScriptPubkey: 'unused-for-prepared-operation',
          txSigner,
          client: {} as ArgonClient,
        },
        {
          client: {} as ArgonClient,
          lock,
          txs: [tx],
          txSigner,
          metadata: {
            releaseId: 'release-1',
            lockId: 7,
            toScriptPubkey: destinationAddress,
            bitcoinNetworkFee: 25n,
          },
          operationKey: 'owner-account:7',
          tx,
          txFeePlusTip: 1n,
          availableBalance: 1_000n,
          canAfford: true,
        },
      ),
    ).rejects.toThrow('Argon submission unavailable');

    expect(submitAndWatch).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ toScriptPubkey: destinationAddress }) }),
    );
    expect(releases.getById('release-1')?.statusError).toBe('Error: Argon submission unavailable');

    let restarted = await loadReleaseState(db);
    const staleSubmittingLock = { ...restarted.lock };
    const staleSubmittingRelease = { ...restarted.release };
    await restarted.releases.recordArgonRequest(restarted.release, {
      requestedReleaseAtTick: 101,
      insuredMicrogons: 900n,
      argonTxFeeMicrogons: 3n,
    });
    restarted = await loadReleaseState(db);
    expect(restarted.release).toMatchObject({
      status: BitcoinReleaseStatus.WaitingForVaultCosign,
      requestedReleaseAtTick: 101,
      insuredMicrogons: 900n,
    });

    const vaultSignatures = [new Uint8Array([1]), new Uint8Array([2])];
    const findVaultCosignatures = vi.spyOn(BitcoinLock, 'findVaultCosignatures').mockResolvedValue({
      blockHeight: 110,
      signatures: vaultSignatures,
    });
    await restarted.releases.syncLockVaultCosign(restarted.lock, {} as ArgonClient);
    findVaultCosignatures.mockRestore();
    restarted = await loadReleaseState(db);
    expect(restarted.release).toMatchObject({
      status: BitcoinReleaseStatus.ReadyForBitcoinBroadcast,
      inputUtxoIds: [firstInput.id, secondInput.id],
      vaultSignatures,
    });

    await restarted.releases.recordPreparedBitcoinTransaction(restarted.release, 'bitcoin-release');
    await restarted.releases.recordBitcoinBroadcast(restarted.release, {
      bitcoinTxid: 'bitcoin-release',
      bitcoinFirstSeenAt: new Date('2026-09-11T01:00:00Z'),
      bitcoinFirstSeenHeight: 120,
      bitcoinFirstSeenOracleHeight: 115,
    });
    restarted = await loadReleaseState(db);
    expect(restarted.release).toMatchObject({
      status: BitcoinReleaseStatus.ConfirmingOnBitcoin,
      bitcoinTxid: 'bitcoin-release',
    });

    await restarted.releases.recordBitcoinConfirmation(restarted.release, { bitcoinConfirmedHeight: 126 });
    restarted = await loadReleaseState(db);
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.WaitingForArgonRecognition);

    await restarted.releases.recordArgonRequest(restarted.release, {
      requestedReleaseAtTick: 101,
      insuredMicrogons: 900n,
      argonTxFeeMicrogons: 3n,
    });
    restarted = await loadReleaseState(db);
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.WaitingForArgonRecognition);

    await restarted.releases.failRelease(staleSubmittingRelease, 'late transaction failure');
    restarted = await loadReleaseState(db);
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.WaitingForArgonRecognition);
    expect(restarted.lock).toMatchObject({
      status: BitcoinLockStatus.Releasing,
      activeReleaseId: 'release-1',
    });

    const completionTime = new Date('2026-09-11T02:00:00Z');
    await restarted.releases.completeLockRelease(
      restarted.lock,
      restarted.release,
      {
        argonCompletionBlockNumber: 130,
        argonCompletionBlockHash: '0x130',
        argonCompletionBlockTime: completionTime,
        argonCompletionExtrinsicIndex: 2,
      },
      {
        removalBlockNumber: 130,
        removalBlockHash: '0x130',
        removalBlockTime: completionTime,
        removalExtrinsicIndex: 2,
        removalReason: 'released',
        btcPriceAtRemovalMicrogons: 70_000_000_000n,
      },
    );
    restarted = await loadReleaseState(db);
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.Complete);
    expect(restarted.lock).toMatchObject({
      status: BitcoinLockStatus.Released,
      activeReleaseId: undefined,
      removalReason: 'released',
    });
    expect(restarted.tracking.getUtxosForLock(7)).toEqual([
      expect.objectContaining({ spendStatus: BitcoinUtxoSpendStatus.Spent, spentByReleaseId: 'release-1' }),
      expect.objectContaining({ spendStatus: BitcoinUtxoSpendStatus.Spent, spentByReleaseId: 'release-1' }),
    ]);
  });

  it('keeps an Orphan return separate from Lock funding through restart and completion', async () => {
    const db = await createTestDb();
    const pendingLock = await db.bitcoinLocksTable.insertPending({
      uuid: 'orphan-lock',
      status: BitcoinLockStatus.LockPendingFunding,
      securitizedSatoshis: 1_000n,
      cosignVersion: 'v1',
      network: 'regtest',
      hdPath: "m/84'/1'/0'/0/2",
      vaultId: 3,
    });
    await db.execute('UPDATE BitcoinLocks SET lockId = ?, status = ?, fundedSatoshis = ? WHERE uuid = ?', [
      8,
      BitcoinLockStatus.LockFunded,
      600n,
      pendingLock.uuid,
    ]);
    const fundingUtxo = await db.bitcoinUtxosTable.insert({
      lockId: 8,
      txid: '3'.repeat(64),
      vout: 0,
      satoshis: 600n,
      network: 'regtest',
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-09-11T00:00:00Z'),
      firstSeenBitcoinHeight: 100,
    });
    const orphanUtxo = await db.bitcoinUtxosTable.insert({
      lockId: 8,
      txid: '4'.repeat(64),
      vout: 1,
      satoshis: 400n,
      network: 'regtest',
      status: BitcoinUtxoStatus.Orphaned,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-09-11T00:01:00Z'),
      firstSeenBitcoinHeight: 101,
    });
    await db.execute('UPDATE BitcoinLocks SET fundingUtxoIds = ? WHERE uuid = ?', [[fundingUtxo.id], pendingLock.uuid]);

    const lock = (await db.bitcoinLocksTable.getByLockId(8))!;
    const tracking = createUtxoTracking(db);
    tracking.load(await db.bitcoinUtxosTable.fetchAll());
    const releases = new BitcoinReleases(
      {} as BitcoinLocks,
      Promise.resolve(db),
      tracking,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await releases.load();
    const trackedOrphan = tracking.getUtxoRecordById(orphanUtxo.id)!;
    const destinationScript = `0x0020${'cd'.repeat(32)}`;
    const destinationAddress = BitcoinLocks.formatP2wshAddress(destinationScript, BitcoinNetwork.Regtest);
    const submitAndWatch = vi.fn(async () => {
      expect(await db.bitcoinReleasesTable.getById('orphan-release-1')).toMatchObject({
        kind: BitcoinReleaseKind.Orphan,
        status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
        inputUtxoIds: [orphanUtxo.id],
        toScriptPubkey: destinationScript,
      });
      expect(await db.bitcoinUtxosTable.getByLockOutpoint(8, orphanUtxo.txid, orphanUtxo.vout)).toMatchObject({
        status: BitcoinUtxoStatus.Orphaned,
        activeReleaseId: 'orphan-release-1',
      });
      expect(await db.bitcoinLocksTable.getByLockId(8)).toMatchObject({
        status: BitcoinLockStatus.LockFunded,
        fundingUtxoIds: [fundingUtxo.id],
        activeReleaseId: undefined,
      });
      throw new Error('Argon submission unavailable');
    });
    const transactionTracker = {
      findLatestTxAttempt: vi.fn().mockResolvedValue(undefined),
      submitAndWatch,
    } as unknown as TransactionTracker;
    const bitcoinLocks = {
      bitcoinNetwork: BitcoinNetwork.Regtest,
      getLockById: () => lock,
      ensureBitcoinActionsAvailable: () => undefined,
      utxoTracking: tracking,
      releases,
    } as unknown as BitcoinLocks;
    const operation = new BitcoinOrphanRelease(bitcoinLocks, transactionTracker);
    const txSigner = { address: 'owner-account' } as TxSigningAccount;
    const tx = {} as SubmittableExtrinsic;

    await expect(
      operation.submit(
        {
          lock,
          record: trackedOrphan,
          toScriptPubkey: destinationAddress,
          bitcoinNetworkFee: 25n,
          txSigner,
          client: {} as ArgonClient,
        },
        {
          client: {} as ArgonClient,
          txs: [tx],
          txSigner,
          metadata: {
            releaseId: 'orphan-release-1',
            releaseKind: 'Orphan',
            lockId: 8,
            utxoRecordId: orphanUtxo.id,
            utxoRef: { txid: orphanUtxo.txid, vout: orphanUtxo.vout },
            toScriptPubkey: destinationAddress,
            bitcoinNetworkFee: 25n,
          },
          operationKey: `owner-account:8:${orphanUtxo.txid}:${orphanUtxo.vout}`,
          tx,
          txFeePlusTip: 1n,
          availableBalance: 1_000n,
          canAfford: true,
        },
      ),
    ).rejects.toThrow('Argon submission unavailable');

    let restarted = await loadOrphanReleaseState(db, orphanUtxo.id);
    await restarted.releases.recordArgonRequest(restarted.release, { requestedReleaseAtTick: 101 });
    await restarted.releases.recordVaultCosign(restarted.release, {
      vaultSignatures: [new Uint8Array([1])],
      cosignBlockNumber: 110,
    });
    await restarted.releases.recordBitcoinBroadcast(restarted.release, {
      bitcoinTxid: 'orphan-return',
      bitcoinFirstSeenAt: new Date('2026-09-11T01:00:00Z'),
      bitcoinFirstSeenHeight: 120,
      bitcoinFirstSeenOracleHeight: 115,
    });
    await restarted.releases.completeOrphanRelease(restarted.orphan, restarted.release, 126);

    restarted = await loadOrphanReleaseState(db, orphanUtxo.id);
    expect(restarted.release).toMatchObject({
      status: BitcoinReleaseStatus.Complete,
      bitcoinConfirmedHeight: 126,
    });
    expect(restarted.orphan).toMatchObject({
      status: BitcoinUtxoStatus.Orphaned,
      spendStatus: BitcoinUtxoSpendStatus.Spent,
      activeReleaseId: undefined,
      spentByReleaseId: 'orphan-release-1',
    });
    expect(restarted.lock).toMatchObject({
      status: BitcoinLockStatus.LockFunded,
      fundingUtxoIds: [fundingUtxo.id],
      activeReleaseId: undefined,
    });
    expect(restarted.releases.getLatestForLock(restarted.lock)).toBeUndefined();
  });
});

async function loadReleaseState(db: Awaited<ReturnType<typeof createTestDb>>) {
  const bitcoinLocks = await loadBitcoinLocksState(db);
  return {
    lock: bitcoinLocks.getLockById(7)!,
    release: bitcoinLocks.releases.getById('release-1')!,
    releases: bitcoinLocks.releases,
    tracking: bitcoinLocks.utxoTracking,
  };
}

async function loadBitcoinLocksState(
  db: Awaited<ReturnType<typeof createTestDb>>,
  transactionTracker?: TransactionTracker,
): Promise<BitcoinLocks> {
  const bitcoinLocks = createStore({ db, transactionTracker });
  bitcoinLocks.data.bitcoinNetwork = BitcoinNetwork.Regtest;
  const lock = await db.bitcoinLocksTable.getByLockId(7);
  if (lock) bitcoinLocks.data.locksByLockId[7] = lock;
  bitcoinLocks.utxoTracking.load(await db.bitcoinUtxosTable.fetchAll());
  await bitcoinLocks.releases.load();
  return bitcoinLocks;
}

async function loadOrphanReleaseState(db: Awaited<ReturnType<typeof createTestDb>>, orphanUtxoId: number) {
  const tracking = createUtxoTracking(db);
  tracking.load(await db.bitcoinUtxosTable.fetchAll());
  const releases = new BitcoinReleases(
    {} as BitcoinLocks,
    Promise.resolve(db),
    tracking,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await releases.load();
  return {
    lock: (await db.bitcoinLocksTable.getByLockId(8))!,
    orphan: tracking.getUtxoRecordById(orphanUtxoId)!,
    release: releases.getById('orphan-release-1')!,
    releases,
  };
}

function createUtxoTracking(db: Awaited<ReturnType<typeof createTestDb>>): BitcoinUtxoTracking {
  return new BitcoinUtxoTracking({
    dbPromise: Promise.resolve(db),
    getBitcoinNetwork: () => BitcoinNetwork.Regtest,
    getOracleBitcoinBlockHeight: () => 100,
    getConfig: () => undefined,
    getMainchainClient: async () => ({}) as ArgonClient,
    mempool: {} as never,
  });
}
