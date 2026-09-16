import { BitcoinLock } from '@argonprotocol/apps-core';
import { describe, expect, it } from 'vitest';
import { createTestDb, createTestDbAtMigration } from './helpers/db.ts';
import { BitcoinLocksTable, BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { createCurrentLock } from './helpers/bitcoin.ts';

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
  it('migrates Lock funding, full releases, and Orphan releases into independent records', async () => {
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
      `INSERT INTO BitcoinLocks (
        uuid, status, utxoId, satoshis, lockedTargetPrice, liquidityPromised, ratchets, cosignVersion,
        lockDetails, network, hdPath, vaultId, releaseRedemptionMicrogons
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'released-liquid-lock',
        'Released',
        8,
        900n,
        2_000n,
        700n,
        [
          {
            mintAmount: 700n,
            mintPending: 0n,
            lockedTargetPrice: 2_000n,
            securityFee: 5n,
            burned: 0n,
            blockHeight: 20,
            oracleBitcoinBlockHeight: 100,
          },
        ],
        'v1',
        {
          utxoId: 8,
          ownerAccount: 'owner',
          p2wshScriptHashHex: '0x0020efgh',
          vaultId: 3,
          securitizedSatoshis: 900n,
          fundedSatoshis: 900n,
          securitizationRatio: 1,
          securityFees: 5n,
          couponFeesPaid: 0n,
          vaultPubkey: '0x12',
          vaultClaimPubkey: '0x13',
          ownerPubkey: '0x14',
          vaultXpubSources: { parentFingerprint: new Uint8Array(4), cosignHdIndex: 1, claimHdIndex: 2 },
          vaultClaimHeight: 500,
          openClaimHeight: 600,
          createdAtHeight: 100,
          fundingExpirationHeight: 200,
          isFlexible: false,
          fundHoldExtensionsByBitcoinExpirationHeight: {},
          createdAtArgonBlock: 20,
        },
        'regtest',
        "m/84'/1'/0'/0/1",
        3,
        650n,
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
        id, lockUtxoId, txid, vout, satoshis, network, status, firstSeenAt, firstSeenBitcoinHeight,
        releaseToDestinationAddress, releaseBitcoinNetworkFee
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        2,
        7,
        'orphan-tx',
        1,
        300n,
        'regtest',
        'ReleaseIsProcessingOnArgon',
        new Date('2026-01-02T00:00:00Z'),
        101,
        'bcrt1qdestination',
        12n,
      ],
    );
    await db.execute(`INSERT INTO BitcoinUtxoStatusHistory (utxoRecordId, newStatus) VALUES (?, ?)`, [2, 'Orphaned']);
    await db.execute(
      `INSERT INTO BitcoinUtxos (
        id, lockUtxoId, txid, vout, satoshis, network, status, firstSeenAt, firstSeenBitcoinHeight,
        releaseToDestinationAddress, releaseBitcoinNetworkFee, releaseCosignVaultSignature,
        releaseCosignHeight, releaseTxid, releasedAtBitcoinHeight
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        3,
        8,
        'released-funding-tx',
        0,
        900n,
        'regtest',
        'ReleaseCompleteAcknowledged',
        new Date('2026-01-03T00:00:00Z'),
        102,
        'bcrt1qreleased',
        25n,
        new Uint8Array([1, 2]),
        160,
        'released-bitcoin-tx',
        110,
      ],
    );
    await db.execute(`UPDATE BitcoinLocks SET fundingUtxoRecordId = ? WHERE uuid = ?`, [3, 'released-liquid-lock']);
    await db.execute(`UPDATE BitcoinLocks SET fundingUtxoRecordId = ? WHERE uuid = ?`, [1, 'migration-lock']);
    await db.execute(
      `INSERT INTO Transactions (
         id, extrinsicHash, extrinsicMethodJson, extrinsicType, metadataJson,
         accountAddress, submittedAtTime, submittedAtBlockHeight
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        '0x1',
        {},
        'BitcoinRequestLock',
        { bitcoin: { uuid: 'migration-lock', vaultId: 3 } },
        'owner',
        new Date('2026-01-01T00:00:00Z'),
        150,
        2,
        '0x2',
        {},
        'BitcoinRequestRelease',
        { utxoId: 7 },
        'owner',
        new Date('2026-01-01T00:01:00Z'),
        151,
        3,
        '0x3',
        {},
        'BitcoinOrphanedUtxoRelease',
        { utxoId: 7, utxoRecordId: 2 },
        'owner',
        new Date('2026-01-02T00:01:00Z'),
        152,
      ],
    );
    await db.execute(
      `INSERT INTO Transactions (
         id, extrinsicHash, extrinsicMethodJson, extrinsicType, metadataJson,
         accountAddress, submittedAtTime, submittedAtBlockHeight
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [4, '0x4', {}, 'VaultCollect', { cosignedUtxoIds: [7] }, 'vault', new Date('2026-01-02T00:02:00Z'), 153],
    );

    await migrateToLatest();

    const utxoColumns = await db.select<{ name: string }[]>(`PRAGMA table_info('BitcoinUtxos')`);
    expect(utxoColumns.map(column => column.name)).toEqual(
      expect.arrayContaining(['lockId', 'spendStatus', 'activeReleaseId', 'createdByReleaseId', 'spentByReleaseId']),
    );
    expect(utxoColumns.map(column => column.name)).not.toEqual(
      expect.arrayContaining(['lockUtxoId', 'role', 'requestedReleaseAtTick', 'releaseTxid']),
    );

    const releaseColumns = await db.select<{ name: string }[]>(`PRAGMA table_info('BitcoinReleases')`);
    expect(releaseColumns.map(column => column.name)).toEqual(
      expect.arrayContaining([
        'id',
        'kind',
        'lockId',
        'sendId',
        'releaseNumber',
        'status',
        'inputUtxoIds',
        'destinationSatoshis',
        'changeSatoshis',
        'cosignDueFrame',
        'expectedTransactionId',
        'vaultSignatures',
      ]),
    );

    const utxos = await db.select<
      Array<{
        id: number;
        txid: string;
        status: string;
        spendStatus: string;
        activeReleaseId?: string;
        createdByReleaseId?: string;
        spentByReleaseId?: string;
      }>
    >(
      `SELECT id, txid, status, spendStatus, activeReleaseId, createdByReleaseId, spentByReleaseId
       FROM BitcoinUtxos ORDER BY id`,
    );
    expect(utxos.find(utxo => utxo.id === 1)).toMatchObject({
      id: 1,
      txid: 'funding-tx',
      status: 'FundingUtxo',
      spendStatus: 'Unspent',
    });
    expect(utxos.find(utxo => utxo.id === 2)).toMatchObject({
      id: 2,
      txid: 'orphan-tx',
      status: 'Orphaned',
      spendStatus: 'Unspent',
      activeReleaseId: expect.any(String),
    });
    expect(utxos.find(utxo => utxo.id === 3)).toMatchObject({
      id: 3,
      txid: 'released-funding-tx',
      status: 'FundingUtxo',
      spendStatus: 'Spent',
      spentByReleaseId: 'lock:8:1',
    });
    const releases = await db.select<
      Array<{
        id: string;
        kind: string;
        lockId: number;
        sendId: string;
        releaseNumber: number | null;
        status: string;
        inputUtxoIds: string;
        bitcoinNetworkFee: string;
        destinationSatoshis: string;
        changeSatoshis: string;
        vaultSignatures: string;
      }>
    >(
      `SELECT id, kind, lockId, sendId, releaseNumber, status, inputUtxoIds,
              bitcoinNetworkFee, destinationSatoshis, changeSatoshis, vaultSignatures
       FROM BitcoinReleases ORDER BY lockId, id`,
    );
    expect(releases).toEqual([
      {
        id: 'migration-33-release-2',
        kind: 'Orphan',
        lockId: 7,
        sendId: 'migration-33-release-2',
        status: 'SubmittingRequestOnArgon',
        inputUtxoIds: '[2]',
        bitcoinNetworkFee: '12',
        destinationSatoshis: '288',
        changeSatoshis: '0',
        vaultSignatures: '[]',
      },
      {
        id: 'lock:8:1',
        kind: 'Lock',
        lockId: 8,
        sendId: 'lock:8:1',
        releaseNumber: 1,
        status: 'Complete',
        inputUtxoIds: '[3]',
        bitcoinNetworkFee: '25',
        destinationSatoshis: '875',
        changeSatoshis: '0',
        vaultSignatures: '["0x0102"]',
      },
    ]);
    expect(releases[0].releaseNumber).toBeUndefined();

    const lockColumns = await db.select<{ name: string }[]>(`PRAGMA table_info('BitcoinLocks')`);
    expect(lockColumns.map(column => column.name)).toEqual(
      expect.arrayContaining([
        'securitizedSatoshis',
        'ownerAccount',
        'scriptDetails',
        'fundingUtxoIds',
        'fundedSatoshis',
        'activeReleaseId',
      ]),
    );
    expect(lockColumns.map(column => column.name)).not.toEqual(
      expect.arrayContaining([
        'satoshis',
        'liquidityPromised',
        'ratchets',
        'lockDetails',
        'fundingUtxoRecordId',
        'fundingUtxos',
        'releaseRedemptionMicrogons',
        'releaseArgonTxFeeMicrogons',
        'releaseCompensationMicrogons',
      ]),
    );

    const table = new BitcoinLocksTable(db);
    const [lock] = await table.fetchAll();
    expect(lock).not.toBeInstanceOf(BitcoinLock);
    expect(lock).toMatchObject({
      uuid: 'migration-lock',
      status: BitcoinLockStatus.LockFunded,
      lockId: 7,
      ownerAccount: 'owner',
      vaultId: 3,
      securitizedSatoshis: 1_000n,
      fundedSatoshis: 1_200n,
      fundingUtxoIds: [1],
      scriptDetails: {
        p2wshScriptHashHex: '0x0020abcd',
        vaultPubkey: '0x02',
        vaultClaimPubkey: '0x03',
        ownerPubkey: '0x04',
      },
    });
    expect(lock.microgonsAtTargetPerBtc).toBeUndefined();
    expect(lock.securitizationCoverageMicrogons).toBeUndefined();
    expect(lock.securitizationTick).toBeUndefined();
    expect(lock.fissionedSatoshis).toBeUndefined();
    expect(lock).not.toHaveProperty('utxos');
    expect(lock).not.toHaveProperty('fundingUtxos');
    await expect(table.getByLockId(7)).resolves.toMatchObject({
      uuid: 'migration-lock',
      lockId: 7,
    });
    await expect(table.getByLockId(7)).resolves.not.toHaveProperty('utxos');
    const migratedFissions = await db.bitcoinFissionsTable.fetchAll('owner');
    expect(migratedFissions.find(fission => fission.lockId === 7)).toBeTruthy();
    expect(migratedFissions.find(fission => fission.lockId === 8)).toMatchObject({
      redemptionAmount: 650n,
    });
    const transactions = await db.transactionsTable.fetchAll();
    expect(transactions.find(transaction => transaction.id === 1)?.metadataJson.bitcoin.uuid).toBe('migration-lock');
    expect(transactions.find(transaction => transaction.id === 2)?.metadataJson).toEqual({
      lockId: 7,
      releaseNumber: 1,
    });
    expect(transactions.find(transaction => transaction.id === 3)?.metadataJson).toEqual({
      lockId: 7,
      utxoRecordId: 2,
      releaseId: 'migration-33-release-2',
    });
    expect(transactions.find(transaction => transaction.id === 4)?.metadataJson).toEqual({
      cosignedReleases: [{ lockId: 7, releaseNumber: 1 }],
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
      lockId: 7,
      securityFees: 1n,
      createdAtHeight: 9,
      securitizationHoldExpirationBitcoinHeight: 15,
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

    expect(first.lockId).toBe(7);
    expect(second.lockId).toBe(7);
    expect(second.status).toBe(BitcoinLockStatus.LockPendingFunding);
    expect(second.securitizedSatoshis).toBe(bitcoinLock.securitizedSatoshis);
    expect(second).not.toBeInstanceOf(BitcoinLock);
    expect(second.microgonsAtTargetPerBtc).toBe(bitcoinLock.microgonsAtTargetPerBtc);
    expect(second.securitizationCoverageMicrogons).toBe(bitcoinLock.securitizationCoverageMicrogons);
    expect(second.securitizationTick).toBe(bitcoinLock.securitizationTick);
    expect(second.fissionedSatoshis).toBe(bitcoinLock.fissionedSatoshis);
    const pending = await table.findPendingByHdPath(lock.hdPath);
    expect(pending).toMatchObject({ uuid: next.uuid });
    expect(pending?.lockId).toBeUndefined();

    await table.updateFromCurrentLock(second, bitcoinLock);

    expect((await table.fetchAll()).find(record => record.uuid === second.uuid)).toMatchObject({
      securitizedSatoshis: bitcoinLock.securitizedSatoshis,
      status: BitcoinLockStatus.LockFunded,
    });
  });

  it('repairs a persisted coupon amount from authoritative current Lock state', async () => {
    const { table, lock } = await createPendingLock({ uuid: 'repair-coupon' });
    const stale = await table.finalizePending({
      uuid: lock.uuid,
      lock: createCurrentLock({
        lockId: 7,
        securityFees: 3_000_000n,
        couponFeesPaid: 3_000_000n,
      }),
    });
    const current = createCurrentLock({
      lockId: 7,
      securityFees: 3_000_000n,
      couponFeesPaid: 1_000_000n,
    });

    await table.updateFromCurrentLock(stale, current);

    expect(stale.securityFees).toBe(3_000_000n);
    expect(stale.couponFeesPaid).toBe(1_000_000n);
    expect((await table.getByLockId(7))?.couponFeesPaid).toBe(1_000_000n);
  });

  it('persists active release ownership separately from terminal Lock removal', async () => {
    const { table, lock } = await createPendingLock({
      uuid: 'release-financials',
      status: BitcoinLockStatus.LockFunded,
    });

    await table.setActiveRelease(lock, 'release-1');
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
      activeReleaseId: 'release-1',
      removalBlockNumber: 120,
      removalBlockTime: new Date('2026-07-16T12:00:00Z'),
      removalExtrinsicIndex: 3,
      btcPriceAtRemovalMicrogons: 4_000_000n,
    });
    expect(recoveredRelease.removalReason).toBeUndefined();

    await table.clearActiveRelease(recoveredRelease, BitcoinLockStatus.Released);
    expect(recoveredRelease).toMatchObject({
      status: BitcoinLockStatus.Released,
    });
    expect(recoveredRelease.activeReleaseId).toBeUndefined();
  });
});
