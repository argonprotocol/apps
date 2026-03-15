import { describe, expect, it, vi } from 'vitest';
import type { BlockWatch, Currency as CurrencyBase } from '@argonprotocol/apps-core';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { Db } from '../lib/Db.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';

function createStore() {
  const blockWatch = Object.assign(Object.create(null), {
    start: async () => undefined,
    events: { on: () => () => undefined },
    bestBlockHeader: { blockNumber: 0, blockHash: '0x0' },
  }) as BlockWatch;
  const currency = Object.assign(Object.create(null), {
    load: async () => undefined,
    priceIndex: {},
  }) as CurrencyBase;
  const transactionTracker = Object.assign(Object.create(null), {
    load: async () => undefined,
    pendingBlockTxInfosAtLoad: [],
    data: { txInfos: [], txInfosByType: {} },
  }) as TransactionTracker;

  return new BitcoinLocks(
    Promise.resolve(Object.create(null) as Db),
    Object.create(null) as WalletKeys,
    blockWatch,
    currency,
    transactionTracker,
  );
}

function createLock(args: {
  uuid: string;
  utxoId?: number;
  status: BitcoinLockStatus;
  vaultId?: number;
  createdAt: string;
}): IBitcoinLockRecord {
  return {
    uuid: args.uuid,
    utxoId: args.utxoId,
    status: args.status,
    satoshis: 10_000n,
    liquidityPromised: 0n,
    lockedMarketRate: 0n,
    ratchets: [],
    cosignVersion: 'v1',
    lockDetails: createLockDetails(),
    fundingUtxoRecordId: null,
    fundingUtxoRecord: undefined,
    network: 'testnet',
    hdPath: "m/84'/0'/0'",
    vaultId: args.vaultId ?? 1,
    createdAt: new Date(args.createdAt),
    updatedAt: new Date(args.createdAt),
  };
}

function createLockDetails(): IBitcoinLockRecord['lockDetails'] {
  return {
    p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
    ownerAccount: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    createdAtHeight: 100,
    vaultClaimHeight: 200,
  } as IBitcoinLockRecord['lockDetails'];
}

function createCandidate(overrides: Partial<IBitcoinUtxoRecord> = {}): IBitcoinUtxoRecord {
  return {
    id: overrides.id ?? 1,
    lockUtxoId: overrides.lockUtxoId ?? 1,
    txid: overrides.txid ?? 'a'.repeat(64),
    vout: overrides.vout ?? 0,
    satoshis: overrides.satoshis ?? 10_500n,
    network: overrides.network ?? 'testnet',
    status: overrides.status ?? BitcoinUtxoStatus.SeenOnMempool,
    statusError: overrides.statusError,
    mempoolObservation: overrides.mempoolObservation,
    firstSeenAt: overrides.firstSeenAt ?? new Date('2026-01-01T00:00:00Z'),
    firstSeenOnArgonAt: overrides.firstSeenOnArgonAt,
    firstSeenBitcoinHeight: overrides.firstSeenBitcoinHeight ?? 100,
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
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
  };
}

describe('BitcoinLocks getActiveLocksForVault', () => {
  it('keeps resumable and unacknowledged expired locks active while excluding released locks', () => {
    const store = createStore();

    store.data.locksByUtxoId = {
      1: createLock({
        uuid: 'released',
        utxoId: 1,
        status: BitcoinLockStatus.Released,
        createdAt: '2026-01-01T00:00:00Z',
      }),
      2: createLock({
        uuid: 'pending',
        utxoId: 2,
        status: BitcoinLockStatus.LockPendingFunding,
        createdAt: '2026-01-03T00:00:00Z',
      }),
      3: createLock({
        uuid: 'minted',
        utxoId: 3,
        status: BitcoinLockStatus.LockedAndMinted,
        createdAt: '2026-01-02T00:00:00Z',
      }),
      4: createLock({
        uuid: 'expired',
        utxoId: 4,
        status: BitcoinLockStatus.LockExpiredWaitingForFunding,
        createdAt: '2026-01-04T00:00:00Z',
      }),
      5: createLock({
        uuid: 'expired-acknowledged',
        utxoId: 5,
        status: BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged,
        createdAt: '2026-01-05T00:00:00Z',
      }),
      6: createLock({
        uuid: 'resume-ready',
        utxoId: 6,
        status: BitcoinLockStatus.LockFundingReadyToResume,
        createdAt: '2026-01-06T00:00:00Z',
      }),
    };

    const active = store.getActiveLocksForVault(1);
    expect(active.map(x => x.uuid)).toEqual(['resume-ready', 'expired', 'pending', 'minted']);
  });

  it('includes pending lock for the same vault', () => {
    const store = createStore();

    store.data.pendingLock = createLock({
      uuid: 'pending-init',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      createdAt: '2026-01-05T00:00:00Z',
    });
    store.data.locksByUtxoId = {
      1: createLock({
        uuid: 'older-active',
        utxoId: 1,
        status: BitcoinLockStatus.LockPendingFunding,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    };

    const active = store.getActiveLocksForVault(1);
    expect(active.map(x => x.uuid)).toEqual(['pending-init', 'older-active']);
  });

  it('keeps mismatch accept and return gated to candidate visibility and the funding phase', () => {
    const store = createStore();
    const lock = createLock({
      uuid: 'pending',
      utxoId: 1,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const candidate = createCandidate({
      lockUtxoId: 1,
      status: BitcoinUtxoStatus.SeenOnMempool,
      satoshis: 11_500n,
      mempoolObservation: {
        isConfirmed: true,
        confirmations: 1,
        satoshis: 11_500n,
        txid: 'a'.repeat(64),
        vout: 0,
        transactionBlockHeight: 100,
        transactionBlockTime: 1710000000,
        argonBitcoinHeight: 100,
      },
      firstSeenOnArgonAt: undefined,
    });

    store.utxoTracking.data.supportsCandidateUtxos = true;
    vi.spyOn(store, 'getLockSatoshiAllowedVariance').mockReturnValue(1_000);

    expect(store.isMismatchCandidateActionable(lock, candidate)).toBe(false);
    expect(store.canAcceptMismatchCandidate(lock, candidate)).toBe(false);
    expect(store.canReturnMismatchCandidate(lock, candidate)).toBe(false);

    candidate.status = BitcoinUtxoStatus.FundingCandidate;
    candidate.firstSeenOnArgonAt = new Date('2026-01-01T00:00:05Z');

    expect(store.isMismatchCandidateActionable(lock, candidate)).toBe(true);
    expect(store.canAcceptMismatchCandidate(lock, candidate)).toBe(true);
    expect(store.canReturnMismatchCandidate(lock, candidate)).toBe(true);

    lock.status = BitcoinLockStatus.LockExpiredWaitingForFunding;
    expect(store.isMismatchCandidateActionable(lock, candidate)).toBe(true);
    expect(store.canAcceptMismatchCandidate(lock, candidate)).toBe(false);
    expect(store.canReturnMismatchCandidate(lock, candidate)).toBe(true);

    candidate.status = BitcoinUtxoStatus.Orphaned;
    expect(store.isMismatchCandidateActionable(lock, candidate)).toBe(true);
    expect(store.canAcceptMismatchCandidate(lock, candidate)).toBe(false);
    expect(store.canReturnMismatchCandidate(lock, candidate)).toBe(true);
  });

  it('does not surface mismatch UI for funding within the allowed variance', () => {
    const store = createStore();
    const lock = createLock({
      uuid: 'pending',
      utxoId: 1,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const candidate = createCandidate({
      lockUtxoId: 1,
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: 10_500n,
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:05Z'),
    });

    vi.spyOn(store, 'getLockSatoshiAllowedVariance').mockReturnValue(1_000);
    vi.spyOn(store.utxoTracking, 'getFundingCandidateRecords').mockReturnValue([candidate]);

    expect(store.getMismatchCandidates(lock)).toEqual([]);
    expect(store.getPreferredMismatchCandidate(lock)).toBeUndefined();
    expect(store.canAcceptMismatchCandidate(lock, candidate)).toBe(false);
    expect(store.shouldShowFundingMismatch(lock)).toBe(false);
  });

  it('keeps mismatch candidates in oldest-seen order', () => {
    const store = createStore();
    const lock = createLock({
      uuid: 'pending',
      utxoId: 1,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });

    const newestCandidate = createCandidate({
      id: 3,
      lockUtxoId: 1,
      txid: 'c'.repeat(64),
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: 11_500n,
      firstSeenAt: new Date('2026-01-03T00:00:00Z'),
      firstSeenOnArgonAt: new Date('2026-01-03T00:00:10Z'),
    });
    const oldestCandidate = createCandidate({
      id: 1,
      lockUtxoId: 1,
      txid: 'a'.repeat(64),
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: 11_500n,
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
    });
    const middleOrphan = createCandidate({
      id: 2,
      lockUtxoId: 1,
      txid: 'b'.repeat(64),
      status: BitcoinUtxoStatus.Orphaned,
      satoshis: 11_500n,
      firstSeenAt: new Date('2026-01-02T00:00:00Z'),
      firstSeenOnArgonAt: new Date('2026-01-02T00:00:10Z'),
    });

    store.data.locksByUtxoId = { 1: lock };
    store.utxoTracking.data.utxosByLockUtxoId = { 1: [newestCandidate, oldestCandidate, middleOrphan] };
    vi.spyOn(store, 'getLockSatoshiAllowedVariance').mockReturnValue(100);

    const candidates = store.getMismatchCandidates(lock);
    expect(candidates.map(x => x.id)).toEqual([1, 2, 3]);
    expect(store.getPreferredMismatchCandidate(lock)?.id).toBe(1);
  });
});
