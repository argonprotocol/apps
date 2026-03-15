import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import {
  type IBitcoinUtxoRecord,
  type IMempoolFundingObservation,
  BitcoinUtxoStatus,
} from '../lib/db/BitcoinUtxosTable.ts';

async function createRecord(overrides: Partial<IBitcoinUtxoRecord> = {}) {
  const db = await createTestDb();
  const table = db.bitcoinUtxosTable;
  const record = await table.insert({
    lockUtxoId: overrides.lockUtxoId ?? 1,
    txid: overrides.txid ?? 'txid'.padEnd(64, '0'),
    vout: overrides.vout ?? 0,
    satoshis: overrides.satoshis ?? 10_000n,
    network: overrides.network ?? 'testnet',
    status: overrides.status ?? BitcoinUtxoStatus.SeenOnMempool,
    mempoolObservation: overrides.mempoolObservation,
    firstSeenAt: overrides.firstSeenAt ?? new Date(),
    firstSeenOnArgonAt: overrides.firstSeenOnArgonAt,
    firstSeenBitcoinHeight: overrides.firstSeenBitcoinHeight ?? 0,
    firstSeenOracleHeight: overrides.firstSeenOracleHeight,
    lastConfirmationCheckAt: overrides.lastConfirmationCheckAt,
    lastConfirmationCheckOracleHeight: overrides.lastConfirmationCheckOracleHeight,
    requestedReleaseAtTick: overrides.requestedReleaseAtTick,
    releaseBitcoinNetworkFee: overrides.releaseBitcoinNetworkFee,
    releaseToDestinationAddress: overrides.releaseToDestinationAddress,
    releaseCosignVaultSignature: overrides.releaseCosignVaultSignature,
    releaseCosignHeight: overrides.releaseCosignHeight,
    releaseTxid: overrides.releaseTxid,
    releaseFirstSeenAt: overrides.releaseFirstSeenAt,
    releaseFirstSeenBitcoinHeight: overrides.releaseFirstSeenBitcoinHeight,
    releaseFirstSeenOracleHeight: overrides.releaseFirstSeenOracleHeight,
    releaseLastConfirmationCheckAt: overrides.releaseLastConfirmationCheckAt,
    releaseLastConfirmationCheckOracleHeight: overrides.releaseLastConfirmationCheckOracleHeight,
    releasedAtBitcoinHeight: overrides.releasedAtBitcoinHeight,
  });
  return { db, table, record };
}

describe('BitcoinUtxosTable', () => {
  it('updateMempoolObservation persists latest mempool payload and first seen heights', async () => {
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
    const laterObservation: IMempoolFundingObservation = {
      ...mempoolObservation,
      satoshis: 99_999n,
      isConfirmed: true,
      confirmations: 3,
      transactionBlockHeight: 123,
    };

    await table.updateMempoolObservation(record, mempoolObservation, 110);
    await table.updateMempoolObservation(record, laterObservation, 111);

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    expect(updated.mempoolObservation?.satoshis).toBe(99_999n);
    expect(updated.firstSeenBitcoinHeight).toBe(123);
    expect(updated.firstSeenOracleHeight).toBe(110);
  });

  it('setReleaseRequest stores release details on the funding record', async () => {
    const { table, record } = await createRecord({ status: BitcoinUtxoStatus.FundingUtxo });

    await table.setReleaseRequest(record, {
      requestedReleaseAtTick: 77,
      releaseToDestinationAddress: '0014abcd',
      releaseBitcoinNetworkFee: 333n,
    });

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    expect(updated.status).toBe(BitcoinUtxoStatus.ReleaseIsProcessingOnArgon);
    expect(updated.requestedReleaseAtTick).toBe(77);
    expect(updated.releaseBitcoinNetworkFee).toBe(333n);
    expect(updated.releaseToDestinationAddress).toBe('0014abcd');
  });

  it('setReleaseIsProcessingOnArgon clears legacy unconfirmed cosign data', async () => {
    const { table, record } = await createRecord({
      status: BitcoinUtxoStatus.FundingUtxo,
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseCosignHeight: undefined,
    });

    await table.setReleaseIsProcessingOnArgon(record, {
      requestedReleaseAtTick: 77,
      releaseToDestinationAddress: '0014abcd',
      releaseBitcoinNetworkFee: 333n,
    });

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    expect(updated.releaseCosignVaultSignature).toBeNull();
    expect(updated.releaseCosignHeight).toBeNull();
  });

  it('setReleaseSeenOnBitcoin records release tx metadata', async () => {
    const { table, record } = await createRecord({ status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon });

    await table.setReleaseSeenOnBitcoin(record, 'release'.padEnd(64, 'a'), 222, 200);

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    expect(updated.status).toBe(BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin);
    expect(updated.releaseTxid).toBe('release'.padEnd(64, 'a'));
    expect(updated.releaseFirstSeenBitcoinHeight).toBe(222);
    expect(updated.releaseFirstSeenOracleHeight).toBe(200);
  });

  it('setFundingUtxo records argon candidate seen timestamp when missing', async () => {
    const { table, record } = await createRecord({ status: BitcoinUtxoStatus.SeenOnMempool });

    await table.setFundingUtxo(record);

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    expect(updated.status).toBe(BitcoinUtxoStatus.FundingUtxo);
    expect(updated.firstSeenOnArgonAt).toBeInstanceOf(Date);
  });

  it('setOrphaned records the orphaned status transition', async () => {
    const { table, record } = await createRecord({ status: BitcoinUtxoStatus.FundingCandidate });

    await table.setOrphaned(record);

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    expect(updated.status).toBe(BitcoinUtxoStatus.Orphaned);
    expect(updated.firstSeenOnArgonAt).toBeInstanceOf(Date);
  });

  it('updates funding and release confirmation checkpoints', async () => {
    const { table, record } = await createRecord({ status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin });

    record.lastConfirmationCheckAt = new Date('2026-01-01T00:00:00Z');
    record.lastConfirmationCheckOracleHeight = 321;
    await table.updateLastConfirmationCheck(record);

    record.releaseLastConfirmationCheckAt = new Date('2026-01-02T00:00:00Z');
    record.releaseLastConfirmationCheckOracleHeight = 654;
    await table.updateReleaseLastConfirmationCheck(record);

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    expect(updated.lastConfirmationCheckOracleHeight).toBe(321);
    expect(updated.releaseLastConfirmationCheckOracleHeight).toBe(654);
  });

  it('records status history for each UTXO status transition', async () => {
    const { table, record } = await createRecord({ status: BitcoinUtxoStatus.SeenOnMempool });

    await table.setFundingUtxo(record);
    await table.setReleaseRequest(record, {
      requestedReleaseAtTick: 77,
      releaseToDestinationAddress: '0014abcd',
      releaseBitcoinNetworkFee: 333n,
    });
    await table.setReleaseSeenOnBitcoin(record, 'release'.padEnd(64, 'a'), 222, 200);
    await table.setReleaseComplete(record, 225);

    const history = await table.fetchStatusHistory(record.id);
    expect(history.map(entry => entry.newStatus)).toEqual([
      BitcoinUtxoStatus.SeenOnMempool,
      BitcoinUtxoStatus.FundingUtxo,
      BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
      BitcoinUtxoStatus.ReleaseComplete,
    ]);
    expect(history.every(entry => entry.createdAt instanceof Date)).toBe(true);
  });

  it('restores the last non-release status when release fails', async () => {
    const { table, record } = await createRecord({ status: BitcoinUtxoStatus.FundingCandidate });

    await table.setOrphaned(record);
    await table.setReleaseRequest(record, {
      requestedReleaseAtTick: 77,
      releaseToDestinationAddress: '0014abcd',
      releaseBitcoinNetworkFee: 333n,
    });
    await table.setReleaseError(record, 'temporary failure');

    const updated = (await table.fetchAll()).find(x => x.id === record.id)!;
    const history = await table.fetchStatusHistory(record.id);

    expect(updated.status).toBe(BitcoinUtxoStatus.Orphaned);
    expect(updated.statusError).toBe('temporary failure');
    expect(history.map(entry => entry.newStatus)).toEqual([
      BitcoinUtxoStatus.FundingCandidate,
      BitcoinUtxoStatus.Orphaned,
      BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      BitcoinUtxoStatus.Orphaned,
    ]);
  });
});
