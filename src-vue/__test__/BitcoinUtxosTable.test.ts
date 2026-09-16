import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import {
  type IBitcoinUtxoRecord,
  type IMempoolFundingObservation,
  BitcoinUtxoSpendStatus,
  BitcoinUtxoStatus,
} from '../lib/db/BitcoinUtxosTable.ts';

async function createRecord(overrides: Partial<IBitcoinUtxoRecord> = {}) {
  const db = await createTestDb();
  const table = db.bitcoinUtxosTable;
  const record = await table.insert({
    lockId: overrides.lockId ?? 1,
    txid: overrides.txid ?? 'txid'.padEnd(64, '0'),
    vout: overrides.vout ?? 0,
    satoshis: overrides.satoshis ?? 10_000n,
    network: overrides.network ?? 'testnet',
    status: overrides.status ?? BitcoinUtxoStatus.SeenOnMempool,
    spendStatus: overrides.spendStatus ?? BitcoinUtxoSpendStatus.Unspent,
    activeReleaseId: overrides.activeReleaseId,
    createdByReleaseId: overrides.createdByReleaseId,
    spentByReleaseId: overrides.spentByReleaseId,
    statusError: overrides.statusError,
    mempoolObservation: overrides.mempoolObservation,
    firstSeenAt: overrides.firstSeenAt ?? new Date(),
    firstSeenOnArgonAt: overrides.firstSeenOnArgonAt,
    firstSeenBitcoinHeight: overrides.firstSeenBitcoinHeight ?? 0,
    firstSeenOracleHeight: overrides.firstSeenOracleHeight,
    lastConfirmationCheckAt: overrides.lastConfirmationCheckAt,
    lastConfirmationCheckOracleHeight: overrides.lastConfirmationCheckOracleHeight,
  });
  return { db, table, record };
}

describe('BitcoinUtxosTable', () => {
  it('fetches only UTXOs belonging to one lock', async () => {
    const { table, record } = await createRecord({ lockId: 7 });
    await table.insert({
      lockId: 8,
      txid: 'other'.padEnd(64, '0'),
      vout: 1,
      satoshis: 20_000n,
      network: 'testnet',
      status: BitcoinUtxoStatus.SeenOnMempool,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date(),
      firstSeenBitcoinHeight: 0,
    });

    await expect(table.fetchByLockId(7)).resolves.toEqual([record]);
  });

  it('keeps inbound classification independent from release membership and spend state', async () => {
    const { table, record } = await createRecord({ status: BitcoinUtxoStatus.SeenOnMempool });

    await table.setFundingUtxo(record);
    await table.setActiveRelease(record, 'release-1');

    let updated = (await table.fetchAll()).find(utxo => utxo.id === record.id)!;
    expect(updated).toMatchObject({
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      activeReleaseId: 'release-1',
    });

    await table.setSpent(record, 'release-1');
    updated = (await table.fetchAll()).find(utxo => utxo.id === record.id)!;
    expect(updated).toMatchObject({
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Spent,
      spentByReleaseId: 'release-1',
    });
    expect(updated.activeReleaseId).toBeUndefined();
  });

  it('persists latest mempool evidence without changing inbound classification', async () => {
    const { table, record } = await createRecord();
    const mempoolObservation: IMempoolFundingObservation = {
      isConfirmed: false,
      confirmations: 0,
      satoshis: 12_345n,
      txid: record.txid,
      vout: record.vout,
      transactionBlockHeight: 0,
      transactionBlockTime: 1710000000,
      argonBitcoinHeight: 110,
    };

    await table.updateMempoolObservation(record, mempoolObservation, 110);
    await table.updateMempoolObservation(
      record,
      { ...mempoolObservation, satoshis: 99_999n, isConfirmed: true, confirmations: 3, transactionBlockHeight: 123 },
      111,
    );

    const updated = (await table.fetchAll()).find(utxo => utxo.id === record.id)!;
    expect(updated.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(updated.mempoolObservation?.satoshis).toBe(99_999n);
    expect(updated.firstSeenBitcoinHeight).toBe(123);
    expect(updated.firstSeenOracleHeight).toBe(111);
  });

  it('records only inbound status transitions', async () => {
    const { table, record } = await createRecord();

    await table.setOrphaned(record);
    await table.setActiveRelease(record, 'release-1');
    await table.setSpent(record, 'release-1');

    const history = await table.fetchStatusHistory(record.id);
    expect(history.map(entry => entry.newStatus)).toEqual([
      BitcoinUtxoStatus.SeenOnMempool,
      BitcoinUtxoStatus.Orphaned,
    ]);
    expect(history.every(entry => entry.createdAt instanceof Date)).toBe(true);
  });
});
