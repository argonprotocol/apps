import { describe, expect, it } from 'vitest';
import { Db } from '../lib/Db.ts';
import {
  BitcoinReleaseKind,
  BitcoinReleaseStatus,
  type IBitcoinReleaseRecord,
} from '../lib/db/BitcoinReleasesTable.ts';
import { createTestDb } from './helpers/db.ts';

function createRelease(overrides: Partial<IBitcoinReleaseRecord> = {}) {
  return {
    id: overrides.id ?? 'release-1',
    kind: overrides.kind ?? BitcoinReleaseKind.Lock,
    lockId: overrides.lockId ?? 7,
    status: overrides.status ?? BitcoinReleaseStatus.WaitingForVaultCosign,
    inputUtxoIds: overrides.inputUtxoIds ?? [3, 4],
    requestedReleaseAtTick: overrides.requestedReleaseAtTick ?? 55,
    toScriptPubkey: overrides.toScriptPubkey ?? '0x0014abcd',
    bitcoinNetworkFee: overrides.bitcoinNetworkFee ?? 500n,
    insuredMicrogons: overrides.insuredMicrogons ?? 2_000n,
    argonTxFeeMicrogons: overrides.argonTxFeeMicrogons ?? 9n,
    compensationMicrogons: overrides.compensationMicrogons,
    vaultSignatures: overrides.vaultSignatures ?? [],
    cosignBlockNumber: overrides.cosignBlockNumber,
    bitcoinTxid: overrides.bitcoinTxid,
    bitcoinFirstSeenAt: overrides.bitcoinFirstSeenAt,
    bitcoinFirstSeenHeight: overrides.bitcoinFirstSeenHeight,
    bitcoinFirstSeenOracleHeight: overrides.bitcoinFirstSeenOracleHeight,
    bitcoinLastConfirmationCheckAt: overrides.bitcoinLastConfirmationCheckAt,
    bitcoinLastConfirmationCheckOracleHeight: overrides.bitcoinLastConfirmationCheckOracleHeight,
    bitcoinConfirmedHeight: overrides.bitcoinConfirmedHeight,
    argonCompletionBlockNumber: overrides.argonCompletionBlockNumber,
    argonCompletionBlockHash: overrides.argonCompletionBlockHash,
    argonCompletionBlockTime: overrides.argonCompletionBlockTime,
    argonCompletionExtrinsicIndex: overrides.argonCompletionExtrinsicIndex,
    statusError: overrides.statusError,
  };
}

describe('BitcoinReleasesTable', () => {
  it('round trips ordered inputs, signatures, exact amounts, and lifecycle checkpoints after restart', async () => {
    const db = await createTestDb();
    const release = await db.bitcoinReleasesTable.insert(
      createRelease({
        bitcoinNetworkFee: 9_007_199_254_740_993n,
        insuredMicrogons: 9_007_199_254_740_995n,
        vaultSignatures: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
      }),
    );

    await db.bitcoinReleasesTable.update(release, {
      status: BitcoinReleaseStatus.ConfirmingOnBitcoin,
      bitcoinTxid: 'release-tx',
      bitcoinFirstSeenAt: new Date('2026-09-11T12:00:00Z'),
      bitcoinFirstSeenHeight: 200,
    });

    const restartedDb = new Db(db.sql, false);
    const hydrated = await restartedDb.bitcoinReleasesTable.getById(release.id);
    expect(hydrated).toMatchObject({
      status: BitcoinReleaseStatus.ConfirmingOnBitcoin,
      inputUtxoIds: [3, 4],
      bitcoinNetworkFee: 9_007_199_254_740_993n,
      insuredMicrogons: 9_007_199_254_740_995n,
      bitcoinTxid: 'release-tx',
      bitcoinFirstSeenAt: new Date('2026-09-11T12:00:00Z'),
      bitcoinFirstSeenHeight: 200,
    });
    expect(hydrated?.vaultSignatures).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  });

  it('treats the same generated ID as idempotent without merging another workflow', async () => {
    const db = await createTestDb();
    const initial = await db.bitcoinReleasesTable.insert(createRelease());
    const duplicate = await db.bitcoinReleasesTable.insert(
      createRelease({ status: BitcoinReleaseStatus.Failed, bitcoinNetworkFee: 999n }),
    );

    expect(duplicate).toEqual(initial);
    await expect(db.bitcoinReleasesTable.insert(createRelease({ kind: BitcoinReleaseKind.Orphan }))).rejects.toThrow(
      'already belongs to a different workflow',
    );
  });
});
