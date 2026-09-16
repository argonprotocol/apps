import { describe, expect, it } from 'vitest';
import { Db } from '../lib/Db.ts';
import {
  BitcoinReleaseKind,
  BitcoinReleaseStatus,
  type IBitcoinReleaseRecord,
} from '../lib/db/BitcoinReleasesTable.ts';
import { createTestDb } from './helpers/db.ts';

function createRelease(overrides: Partial<IBitcoinReleaseRecord> = {}) {
  const kind = overrides.kind ?? BitcoinReleaseKind.Lock;
  return {
    id: overrides.id ?? 'release-1',
    kind,
    lockId: overrides.lockId ?? 7,
    sendId: overrides.sendId ?? 'send-1',
    releaseNumber:
      'releaseNumber' in overrides ? overrides.releaseNumber : kind === BitcoinReleaseKind.Lock ? 2 : undefined,
    status: overrides.status ?? BitcoinReleaseStatus.WaitingForVaultCosign,
    inputUtxoIds: overrides.inputUtxoIds ?? [3, 4],
    requestedReleaseAtTick: overrides.requestedReleaseAtTick ?? 55,
    toScriptPubkey: overrides.toScriptPubkey ?? '0x0014abcd',
    bitcoinNetworkFee: overrides.bitcoinNetworkFee ?? 500n,
    destinationSatoshis: overrides.destinationSatoshis ?? 8_000n,
    changeSatoshis: overrides.changeSatoshis ?? 1_500n,
    cosignDueFrame: overrides.cosignDueFrame ?? 70,
    expectedTransactionId: overrides.expectedTransactionId ?? 'expected-tx',
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
        destinationSatoshis: 9_007_199_254_740_994n,
        changeSatoshis: 9_007_199_254_740_996n,
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
      sendId: 'send-1',
      releaseNumber: 2,
      inputUtxoIds: [3, 4],
      bitcoinNetworkFee: 9_007_199_254_740_993n,
      destinationSatoshis: 9_007_199_254_740_994n,
      changeSatoshis: 9_007_199_254_740_996n,
      cosignDueFrame: 70,
      expectedTransactionId: 'expected-tx',
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

  it('requires one unique release number for each Lock release and none for Orphans', async () => {
    const db = await createTestDb();
    await db.bitcoinReleasesTable.insert(createRelease({ id: 'lock:7:2' }));

    await expect(
      db.bitcoinReleasesTable.insert(createRelease({ id: 'another-lock-release', releaseNumber: 2 })),
    ).rejects.toThrow();
    await expect(
      db.bitcoinReleasesTable.insert(createRelease({ id: 'unnumbered-lock', releaseNumber: undefined })),
    ).rejects.toThrow();

    const orphan = await db.bitcoinReleasesTable.insert(
      createRelease({ id: 'orphan-release', kind: BitcoinReleaseKind.Orphan, releaseNumber: undefined }),
    );
    expect(orphan).toMatchObject({ kind: BitcoinReleaseKind.Orphan });
    expect(orphan.releaseNumber).toBeUndefined();
    await expect(
      db.bitcoinReleasesTable.insert(
        createRelease({ id: 'numbered-orphan', kind: BitcoinReleaseKind.Orphan, releaseNumber: 2 }),
      ),
    ).rejects.toThrow();
  });
});
