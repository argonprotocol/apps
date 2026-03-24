import { describe, expect, it, vi } from 'vitest';
import type { BlockWatch, Currency as CurrencyBase } from '@argonprotocol/apps-core';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { Db } from '../lib/Db.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { TransactionStatus } from '../lib/db/TransactionsTable.ts';

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

function createTxInfo(status: TransactionStatus, metadataJson: Record<string, unknown> = {}): TransactionInfo {
  return {
    tx: {
      status,
      metadataJson,
    },
    txResult: {},
  } as unknown as TransactionInfo;
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

  it('requires Argon-visible candidates before mismatch actions become available', () => {
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
    store.data.locksByUtxoId = { 1: lock };
    store.utxoTracking.data.utxosByLockUtxoId = { 1: [candidate] };
    vi.spyOn(store, 'getLockSatoshiAllowedVariance').mockReturnValue(1_000);

    let mismatchView = store.getMismatchViewState(lock);
    expect(mismatchView.nextCandidate?.canAccept || mismatchView.nextCandidate?.canReturn).toBe(false);
    expect(mismatchView.nextCandidate?.canAccept).toBe(false);
    expect(mismatchView.nextCandidate?.canReturn).toBe(false);

    candidate.status = BitcoinUtxoStatus.FundingCandidate;
    candidate.firstSeenOnArgonAt = new Date('2026-01-01T00:00:05Z');

    mismatchView = store.getMismatchViewState(lock);
    expect(mismatchView.nextCandidate?.canAccept || mismatchView.nextCandidate?.canReturn).toBe(true);
    expect(mismatchView.nextCandidate?.canAccept).toBe(true);
    expect(mismatchView.nextCandidate?.canReturn).toBe(true);
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

    const mismatchView = store.getMismatchViewState(lock);
    expect(mismatchView.candidates).toEqual([]);
    expect(mismatchView.nextCandidate).toBeUndefined();
    expect(mismatchView.phase).toBe('none');
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

    const mismatchView = store.getMismatchViewState(lock);
    expect(mismatchView.candidates.map(x => x.record.id)).toEqual([1, 2, 3]);
    expect(mismatchView.nextCandidate?.record.id).toBe(1);
  });
});

describe('BitcoinLocks mismatch view state', () => {
  it('orders candidates by block height before timestamps when both heights are available', () => {
    const store = createStore();
    const lock = createLock({
      uuid: 'pending',
      utxoId: 1,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const laterSeenLowerBlock = createCandidate({
      id: 2,
      lockUtxoId: 1,
      txid: 'b'.repeat(64),
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: 11_500n,
      firstSeenAt: new Date('2026-01-03T00:00:00Z'),
      firstSeenOnArgonAt: new Date('2026-01-03T00:00:10Z'),
      firstSeenBitcoinHeight: 100,
    });
    const earlierSeenHigherBlock = createCandidate({
      id: 1,
      lockUtxoId: 1,
      txid: 'a'.repeat(64),
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: 11_500n,
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
      firstSeenBitcoinHeight: 120,
    });

    store.data.locksByUtxoId = { 1: lock };
    store.utxoTracking.data.utxosByLockUtxoId = { 1: [earlierSeenHigherBlock, laterSeenLowerBlock] };
    vi.spyOn(store, 'getLockSatoshiAllowedVariance').mockReturnValue(100);

    const view = store.getMismatchViewState(lock);
    expect(view.candidates.map(x => x.record.id)).toEqual([2, 1]);
    expect(view.nextCandidate?.record.id).toBe(2);
  });

  it('derives review state and next candidate actions from a single mismatch candidate', () => {
    const store = createStore();
    const lock = createLock({
      uuid: 'pending',
      utxoId: 1,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const candidate = createCandidate({
      id: 1,
      lockUtxoId: 1,
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: 11_500n,
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
    });

    store.data.locksByUtxoId = { 1: lock };
    store.utxoTracking.data.utxosByLockUtxoId = { 1: [candidate] };
    vi.spyOn(store, 'getLockSatoshiAllowedVariance').mockReturnValue(100);

    const view = store.getMismatchViewState(lock);
    expect(view.phase).toBe('review');
    expect(view.candidateCount).toBe(1);
    expect(view.nextCandidate?.record.id).toBe(candidate.id);
    expect(view.nextCandidate?.isNext).toBe(true);
    expect(view.nextCandidate?.canAccept).toBe(true);
    expect(view.nextCandidate?.canReturn).toBe(true);
  });

  it('disables accept until only one actionable mismatch candidate remains', () => {
    const store = createStore();
    const lock = createLock({
      uuid: 'pending',
      utxoId: 1,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const oldest = createCandidate({
      id: 1,
      lockUtxoId: 1,
      txid: 'a'.repeat(64),
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: 11_500n,
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newest = createCandidate({
      id: 2,
      lockUtxoId: 1,
      txid: 'b'.repeat(64),
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: 12_500n,
      firstSeenOnArgonAt: new Date('2026-01-02T00:00:10Z'),
      firstSeenAt: new Date('2026-01-02T00:00:00Z'),
    });

    store.data.locksByUtxoId = { 1: lock };
    store.utxoTracking.data.utxosByLockUtxoId = { 1: [newest, oldest] };
    vi.spyOn(store, 'getLockSatoshiAllowedVariance').mockReturnValue(100);

    const view = store.getMismatchViewState(lock);
    expect(view.phase).toBe('review');
    expect(view.nextCandidate?.record.id).toBe(oldest.id);
    expect(view.candidates.map(x => x.canAccept)).toEqual([false, false]);
    expect(view.candidates.map(x => x.canReturn)).toEqual([true, true]);
  });

  it('keeps expired mismatch funding returnable but not acceptable', () => {
    const store = createStore();
    const lock = createLock({
      uuid: 'expired',
      utxoId: 1,
      status: BitcoinLockStatus.LockExpiredWaitingForFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const candidate = createCandidate({
      id: 1,
      lockUtxoId: 1,
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: 11_500n,
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
    });

    store.data.locksByUtxoId = { 1: lock };
    store.utxoTracking.data.utxosByLockUtxoId = { 1: [candidate] };
    vi.spyOn(store, 'getLockSatoshiAllowedVariance').mockReturnValue(100);

    const view = store.getMismatchViewState(lock);
    expect(view.phase).toBe('review');
    expect(view.isFundingExpired).toBe(true);
    expect(view.nextCandidate?.canAccept).toBe(false);
    expect(view.nextCandidate?.canReturn).toBe(true);
  });

  it('surfaces accept, return, and error phases from the derived mismatch view', () => {
    const store = createStore();
    vi.spyOn(store, 'getLockSatoshiAllowedVariance').mockReturnValue(100);

    const acceptingLock = createLock({
      uuid: 'accepting',
      utxoId: 1,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const acceptingCandidate = createCandidate({
      id: 1,
      lockUtxoId: 1,
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: 11_500n,
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
    });
    store.data.locksByUtxoId = { 1: acceptingLock };
    store.utxoTracking.data.utxosByLockUtxoId = { 1: [acceptingCandidate] };
    vi.spyOn(store, 'getLatestMismatchAcceptTxInfo').mockReturnValueOnce(createTxInfo(TransactionStatus.InBlock));
    vi.spyOn(store, 'getMismatchAcceptTxInfo').mockReturnValueOnce(createTxInfo(TransactionStatus.InBlock));
    expect(store.getMismatchViewState(acceptingLock).phase).toBe('accepting');

    const argonReturnLock = createLock({
      uuid: 'returning-argon',
      utxoId: 2,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const argonReturnRecord = createCandidate({
      id: 2,
      lockUtxoId: 2,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      satoshis: 11_500n,
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
      releaseToDestinationAddress: '0014deadbeef',
      releaseBitcoinNetworkFee: 100n,
      releaseTxid: 'b'.repeat(64),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    store.data.locksByUtxoId = { 2: argonReturnLock };
    store.utxoTracking.data.utxosByLockUtxoId = { 2: [argonReturnRecord] };
    vi.spyOn(store, 'getOrphanedReturnTxInfoForRecord').mockReturnValue(createTxInfo(TransactionStatus.InBlock));
    expect(store.getMismatchViewState(argonReturnLock).phase).toBe('returningOnArgon');

    const bitcoinReturnLock = createLock({
      uuid: 'returning-bitcoin',
      utxoId: 3,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const bitcoinReturnRecord = createCandidate({
      id: 3,
      lockUtxoId: 3,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
      satoshis: 11_500n,
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
      releaseTxid: 'c'.repeat(64),
    });
    store.data.locksByUtxoId = { 3: bitcoinReturnLock };
    store.utxoTracking.data.utxosByLockUtxoId = { 3: [bitcoinReturnRecord] };
    expect(store.getMismatchViewState(bitcoinReturnLock).phase).toBe('returningOnBitcoin');

    const resumeReadyLock = createLock({
      uuid: 'resume-ready',
      utxoId: 4,
      status: BitcoinLockStatus.LockFundingReadyToResume,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const completedReturnRecord = createCandidate({
      id: 4,
      lockUtxoId: 4,
      status: BitcoinUtxoStatus.ReleaseComplete,
      satoshis: 11_500n,
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
    });
    store.data.locksByUtxoId = { 4: resumeReadyLock };
    store.utxoTracking.data.utxosByLockUtxoId = { 4: [completedReturnRecord] };
    expect(store.getMismatchViewState(resumeReadyLock).phase).toBe('readyToResume');

    const returnedLock = createLock({
      uuid: 'returned',
      utxoId: 5,
      status: BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const returnedRecord = createCandidate({
      id: 5,
      lockUtxoId: 5,
      status: BitcoinUtxoStatus.ReleaseComplete,
      satoshis: 11_500n,
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
    });
    store.data.locksByUtxoId = { 5: returnedLock };
    store.utxoTracking.data.utxosByLockUtxoId = { 5: [returnedRecord] };
    expect(store.getMismatchViewState(returnedLock).phase).toBe('returned');

    store.data.mismatchErrorsByLockUtxoId[5] = 'mismatch failed';
    expect(store.getMismatchViewState(returnedLock).phase).toBe('error');
    expect(store.getMismatchViewState(returnedLock).error).toBe('mismatch failed');
  });

  it('keeps an argon mismatch return active after reload even without a live tx tracker entry', () => {
    const store = createStore();
    vi.spyOn(store, 'getLockSatoshiAllowedVariance').mockReturnValue(100);

    const lock = createLock({
      uuid: 'returning-argon-reload',
      utxoId: 6,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-03T00:00:00Z',
    });
    const returnRecord = createCandidate({
      id: 6,
      lockUtxoId: 6,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      satoshis: 11_500n,
      firstSeenOnArgonAt: new Date('2026-01-01T00:00:10Z'),
      releaseToDestinationAddress: '0014deadbeef',
      releaseBitcoinNetworkFee: 100n,
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });

    store.data.locksByUtxoId = { 6: lock };
    store.utxoTracking.data.utxosByLockUtxoId = { 6: [returnRecord] };

    const view = store.getMismatchViewState(lock);

    expect(view.phase).toBe('returningOnArgon');
    expect(view.nextCandidate?.returnRecord?.id).toBe(returnRecord.id);
    expect(view.nextCandidate?.canReturn).toBe(false);
  });
});

describe('BitcoinLocks release inspection', () => {
  it('keeps release inspection on argon while the funding status is still argon processing', () => {
    const store = createStore();
    const fundingRecord = createCandidate({
      id: 41,
      lockUtxoId: 41,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      releaseTxid: 'd'.repeat(64),
      releaseToDestinationAddress: '0014deadbeef',
      releaseBitcoinNetworkFee: 100n,
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseCosignHeight: 456,
    });
    const lock = createLock({
      uuid: 'release-argon-inspect',
      utxoId: 41,
      status: BitcoinLockStatus.Releasing,
      createdAt: '2026-01-03T00:00:00Z',
    });

    lock.fundingUtxoRecordId = fundingRecord.id;
    lock.fundingUtxoRecord = fundingRecord;
    store.data.locksByUtxoId = { 41: lock };

    const state = store.getVaultUnlockReleaseState(lock.vaultId);

    expect(state.hasReleaseTxid).toBe(true);
    expect(state.isArgonSubmitting).toBe(true);
    expect(state.isBitcoinReleaseProcessing).toBe(false);
  });
});
