import { BitcoinLock } from '@argonprotocol/apps-core';
import { describe, expect, it } from 'vitest';
import { createTestDb, createTestDbAtMigration } from './helpers/db.ts';
import { BitcoinLocksTable, BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { createCurrentLock } from './helpers/bitcoin.ts';
import { BitcoinUtxoRole } from '../interfaces/IBitcoinUtxoRecord.ts';

async function createPendingLock(overrides: Partial<IBitcoinLockRecord> = {}) {
  const db = await createTestDb();
  const table = db.bitcoinLocksTable;
  const lock = await table.insertPending({
    uuid: overrides.uuid ?? 'lock-1',
    status: overrides.status ?? BitcoinLockStatus.LockIsProcessingOnArgon,
    securitizedSatoshis: overrides.securitizedSatoshis ?? 1_000n,
    cosignVersion: overrides.cosignVersion ?? 'v1',
    network: overrides.network ?? 'testnet',
    hdPath: overrides.hdPath ?? "m/84'/0'/0'",
    vaultId: overrides.vaultId ?? 1,
  });
  return { db, table, lock };
}

describe('BitcoinLocksTable', () => {
  it('hydrates one Lock with its exact funding and orphan outputs after migration', async () => {
    const { db, migrateToLatest } = await createTestDbAtMigration(32);
    await db.execute(
      `INSERT INTO BitcoinLocks (
        uuid, status, utxoId, satoshis, lockedTargetPrice, liquidityPromised, ratchets, cosignVersion,
        lockDetails, fundingUtxoRecordId, network, hdPath, vaultId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'migration-lock',
        'LockedAndMinted',
        7,
        1_200n,
        3_000n,
        4_000n,
        [],
        'v1',
        {
          utxoId: 7,
          p2wshScriptHashHex: '0x0020abcd',
          vaultId: 3,
          securitizedSatoshis: 1_000n,
          fundedSatoshis: 1_200n,
          ownerAccount: 'owner',
          securitizationRatio: 1,
          securityFees: 5n,
          couponFeesPaid: 2n,
          vaultPubkey: '0x02',
          vaultClaimPubkey: '0x03',
          ownerPubkey: '0x04',
          vaultXpubSources: { parentFingerprint: new Uint8Array([1, 2, 3, 4]), cosignHdIndex: 5, claimHdIndex: 6 },
          vaultClaimHeight: 500,
          openClaimHeight: 600,
          createdAtHeight: 100,
          fundingExpirationHeight: 200,
          isFlexible: false,
          fundHoldExtensionsByBitcoinExpirationHeight: {},
          createdAtArgonBlock: 10,
        },
        null,
        'regtest',
        "m/84'/1'/0'/0/0",
        3,
      ],
    );
    await db.execute(
      `INSERT INTO BitcoinUtxos (
        id, lockUtxoId, txid, vout, satoshis, network, status, firstSeenAt, firstSeenBitcoinHeight
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, 7, 'funding-tx', 0, 1_200n, 'regtest', 'FundingUtxo', new Date('2026-01-01T00:00:00Z'), 100],
    );
    await db.execute(
      `INSERT INTO BitcoinUtxos (
        id, lockUtxoId, txid, vout, satoshis, network, status, firstSeenAt, firstSeenBitcoinHeight
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [2, 7, 'orphan-tx', 1, 300n, 'regtest', 'ReleaseIsProcessingOnArgon', new Date('2026-01-02T00:00:00Z'), 101],
    );
    await db.execute(`INSERT INTO BitcoinUtxoStatusHistory (utxoRecordId, newStatus) VALUES (?, ?)`, [2, 'Orphaned']);
    await db.execute(`UPDATE BitcoinLocks SET fundingUtxoRecordId = ? WHERE uuid = ?`, [1, 'migration-lock']);

    await migrateToLatest();

    const utxoColumns = await db.select<{ name: string }[]>(`PRAGMA table_info('BitcoinUtxos')`);
    expect(utxoColumns.map(column => column.name)).toContain('role');

    const utxos = await db.select<{ txid: string; role: string; status: string }[]>(
      `SELECT txid, role, status FROM BitcoinUtxos ORDER BY id`,
    );
    expect(utxos).toEqual([
      { txid: 'funding-tx', role: 'Funding', status: 'FundingUtxo' },
      { txid: 'orphan-tx', role: 'Orphan', status: 'ReleaseIsProcessingOnArgon' },
    ]);

    const lockColumns = await db.select<{ name: string }[]>(`PRAGMA table_info('BitcoinLocks')`);
    expect(lockColumns.map(column => column.name)).toEqual(
      expect.arrayContaining(['securitizedSatoshis', 'ownerAccount', 'scriptDetails']),
    );
    expect(lockColumns.map(column => column.name)).not.toEqual(
      expect.arrayContaining(['satoshis', 'liquidityPromised', 'ratchets', 'lockDetails', 'fundingUtxoRecordId']),
    );

    const [lock] = await new BitcoinLocksTable(db).fetchAll();
    expect(lock).not.toBeInstanceOf(BitcoinLock);
    expect(lock).toMatchObject({
      uuid: 'migration-lock',
      status: BitcoinLockStatus.LockFunded,
      utxoId: 7,
      ownerAccount: 'owner',
      vaultId: 3,
      securitizedSatoshis: 1_000n,
      scriptDetails: {
        p2wshScriptHashHex: '0x0020abcd',
        vaultPubkey: '0x02',
        vaultClaimPubkey: '0x03',
        ownerPubkey: '0x04',
      },
    });
    expect(lock.microgonsAtTargetPerBtc).toBeNull();
    expect(lock.securitizationCoverageMicrogons).toBeNull();
    expect(lock.securitizationTick).toBeNull();
    expect(lock.fissionedSatoshis).toBeNull();
    expect(lock.utxos).toHaveLength(2);
    expect(lock.fundedSatoshis).toBe(1_200n);
    expect(lock.fundingUtxo).toMatchObject({ txid: 'funding-tx', vout: 0, satoshis: 1_200n });
    expect(lock.utxos.find(utxo => utxo.role === BitcoinUtxoRole.Orphan)).toMatchObject({
      txid: 'orphan-tx',
      status: 'ReleaseIsProcessingOnArgon',
    });
  });

  it('retires a delegated pending lock after authoritative recovery finds no lock', async () => {
    const { db, table, lock } = await createPendingLock({ uuid: 'retired-delegated-lock' });
    await db.execute('UPDATE BitcoinLocks SET relayMetadataJson = ? WHERE uuid = ?', [
      JSON.stringify({ offerCode: 'old-offer' }),
      lock.uuid,
    ]);

    const retired = await table.retireDelegatedPendingLocks();

    expect(retired).toMatchObject([
      {
        uuid: lock.uuid,
        status: BitcoinLockStatus.LockFailed,
        blockExtrinsicErrorJson: { message: 'Delegated Bitcoin lock initialization is no longer supported.' },
      },
    ]);
  });

  it('finalizes idempotently, persists the verified amount, and allows the owner key to be reused', async () => {
    const { table, lock } = await createPendingLock({ uuid: 'finalize-idempotent' });

    const bitcoinLock = createCurrentLock({
      utxoId: 7,
      securityFees: 1n,
      createdAtHeight: 9,
      fundingExpirationHeight: 15,
    });

    const first = await table.finalizePending({
      uuid: lock.uuid,
      lock: bitcoinLock,
    });
    const second = await table.finalizePending({
      uuid: lock.uuid,
      lock: bitcoinLock,
    });
    const next = await table.insertPending({
      uuid: 'same-owner-next-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: lock.securitizedSatoshis,
      cosignVersion: lock.cosignVersion,
      network: lock.network,
      hdPath: lock.hdPath,
      vaultId: lock.vaultId,
    });

    expect(first.utxoId).toBe(7);
    expect(second.utxoId).toBe(7);
    expect(second.status).toBe(BitcoinLockStatus.LockPendingFunding);
    expect(second.securitizedSatoshis).toBe(bitcoinLock.securitizedSatoshis);
    expect(second).toBeInstanceOf(BitcoinLock);
    expect(second.microgonsAtTargetPerBtc).toBe(bitcoinLock.microgonsAtTargetPerBtc);
    expect(second.securitizationCoverageMicrogons).toBe(bitcoinLock.securitizationCoverageMicrogons);
    expect(second.securitizationTick).toBe(bitcoinLock.securitizationTick);
    expect(second.fissionedSatoshis).toBe(bitcoinLock.fissionedSatoshis);
    expect(await table.findPendingByHdPath(lock.hdPath)).toMatchObject({ uuid: next.uuid, utxoId: null });

    await table.setCurrentLockFunded(second, bitcoinLock);

    expect((await table.fetchAll()).find(record => record.uuid === second.uuid)).toMatchObject({
      securitizedSatoshis: bitcoinLock.securitizedSatoshis,
      status: BitcoinLockStatus.LockFunded,
    });
  });

  it('persists release economics separately from the terminal removal mark', async () => {
    const { table, lock } = await createPendingLock({
      uuid: 'release-financials',
      status: BitcoinLockStatus.LockFunded,
    });

    await table.recordReleaseRequest(lock, {
      releaseRedemptionMicrogons: 500n,
      releaseArgonTxFeeMicrogons: undefined,
    });
    await table.recordReleaseRequest(lock, {
      releaseRedemptionMicrogons: 600n,
      releaseArgonTxFeeMicrogons: 7n,
    });
    await table.recordReleaseCompensation(lock, 11n);
    await table.recordReleaseCosign(lock, {
      removalBlockNumber: 120,
      removalBlockHash: undefined,
      removalBlockTime: new Date('2026-07-16T12:00:00Z'),
      removalExtrinsicIndex: 3,
      btcPriceAtRemovalMicrogons: 4_000_000n,
    });
    const recoveredRelease = (await table.fetchAll()).find(record => record.uuid === lock.uuid)!;
    expect(recoveredRelease).toMatchObject({
      status: BitcoinLockStatus.Releasing,
      removalBlockNumber: 120,
      removalBlockTime: new Date('2026-07-16T12:00:00Z'),
      removalExtrinsicIndex: 3,
      btcPriceAtRemovalMicrogons: 4_000_000n,
    });
    expect(recoveredRelease.removalReason).toBeNull();

    await table.setReleased(recoveredRelease);
    expect(recoveredRelease).toMatchObject({
      status: BitcoinLockStatus.Released,
      removalReason: 'released',
    });

    await table.recordRemoval(lock, BitcoinLockStatus.Released, {
      removalBlockNumber: 120,
      removalBlockHash: undefined,
      removalBlockTime: new Date('2026-07-16T12:00:00Z'),
      removalExtrinsicIndex: 3,
      removalReason: 'released',
      btcPriceAtRemovalMicrogons: 4_000_000n,
    });
    await table.recordReleaseRequest(lock, {
      releaseRedemptionMicrogons: 700n,
      releaseArgonTxFeeMicrogons: 8n,
    });
    await table.recordReleaseCompensation(lock, 12n);
    await table.recordRemoval(lock, BitcoinLockStatus.Released, {
      removalBlockNumber: 121,
      removalBlockHash: '0x120',
      removalBlockTime: new Date('2026-07-16T12:01:00Z'),
      removalExtrinsicIndex: 4,
      removalReason: 'released',
      btcPriceAtRemovalMicrogons: 5_000_000n,
    });
    await table.recordRemoval(lock, BitcoinLockStatus.Releasing, {
      removalBlockNumber: 122,
      removalBlockHash: '0x121',
      removalBlockTime: new Date('2026-07-16T12:02:00Z'),
      removalExtrinsicIndex: 5,
      removalReason: 'expired',
      btcPriceAtRemovalMicrogons: 5_000_000n,
    });

    const updated = (await table.fetchAll()).find(record => record.uuid === lock.uuid)!;
    expect(updated).toMatchObject({
      status: BitcoinLockStatus.Released,
      releaseRedemptionMicrogons: 500n,
      releaseArgonTxFeeMicrogons: 7n,
      releaseCompensationMicrogons: 11n,
      removalBlockNumber: 120,
      removalBlockHash: '0x120',
      removalBlockTime: new Date('2026-07-16T12:00:00Z'),
      removalExtrinsicIndex: 3,
      removalReason: 'released',
      btcPriceAtRemovalMicrogons: 4_000_000n,
    });
  });
});
