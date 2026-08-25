import { describe, expect, it, vi } from 'vitest';
import { BitcoinLock } from '@argonprotocol/apps-core';
import { type ArgonClient } from '@argonprotocol/mainchain';
import type { BlockWatch, Currency as CurrencyBase } from '@argonprotocol/apps-core';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { Db } from '../lib/Db.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import { TransactionStatus } from '../lib/db/TransactionsTable.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));

type IBitcoinLocksTestTarget = {
  checkIncomingArgonBlock(header: { blockHash: string; blockNumber: number }): Promise<void>;
  checkForMissingBitcoinLockState(lock: IBitcoinLockRecord): Promise<void>;
  onBitcoinLockFinalized(txInfo: {
    createPostProcessor: () => { resolve: () => void; reject: (error: Error) => void };
    tx: { metadataJson: { bitcoin: { uuid: string } } };
    txResult: { waitForFinalizedBlock: Promise<Uint8Array>; extrinsicError?: Error };
  }): Promise<void>;
  syncLockReleaseArgonCosign(lock: IBitcoinLockRecord, archiveClient: ArgonClient): Promise<void>;
};

describe('BitcoinLocks Argon cosign gating', () => {
  it('formats block extrinsic errors with the concrete error name', () => {
    expect(
      BitcoinLocks.formatBlockExtrinsicError({
        errorCode: 'bitcoinLocks.InsufficientVaultFunds',
        details: '',
        message: 'bitcoinLocks.InsufficientVaultFunds',
      }),
    ).toBe('InsufficientVaultFunds');
  });

  it('marks a pending lock failed when the finalized lock request rejects with an extrinsic error', async () => {
    const lock = createLock({
      uuid: 'failed-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      utxoId: undefined,
    });
    const extrinsicError = new Error('bitcoinLocks.InsufficientVaultFunds') as Error & {
      errorCode?: string;
      details?: string;
    };
    extrinsicError.errorCode = 'bitcoinLocks.InsufficientVaultFunds';
    extrinsicError.details = 'bitcoinLocks.InsufficientVaultFunds';
    const blockWatch = Object.assign(Object.create(null), {
      start: async () => undefined,
      events: { on: () => () => undefined },
      bestBlockHeader: { blockNumber: 0, blockHash: '0x0' },
    }) as BlockWatch;
    const store = new BitcoinLocks(
      Promise.resolve({} as Db),
      Object.create(null) as WalletKeys,
      blockWatch,
      Object.create(null) as CurrencyBase,
      Object.create(null) as TransactionTracker,
    );
    store.data.pendingLocks = [lock];
    const setLockFailed = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const postProcessorResolve = vi.fn();
    const postProcessorReject = vi.fn();
    Object.assign(store, {
      getTable: vi.fn().mockResolvedValue({
        setLockFailed,
      }),
    });
    const testStore = store as unknown as IBitcoinLocksTestTarget;

    await testStore.onBitcoinLockFinalized({
      createPostProcessor: () => ({ resolve: postProcessorResolve, reject: postProcessorReject }),
      tx: { metadataJson: { bitcoin: { uuid: lock.uuid } } },
      txResult: {
        waitForFinalizedBlock: Promise.reject(extrinsicError),
        extrinsicError,
      },
    });

    expect(setLockFailed).toHaveBeenCalledWith(lock, {
      errorCode: 'bitcoinLocks.InsufficientVaultFunds',
      details: 'bitcoinLocks.InsufficientVaultFunds',
      message: 'bitcoinLocks.InsufficientVaultFunds',
    });
    expect(postProcessorResolve).toHaveBeenCalledTimes(1);
    expect(postProcessorReject).not.toHaveBeenCalled();
  });

  it('stores the cosign only after a later sync sees it in finalized Argon state', async () => {
    const lock = createLock();
    const fundingRecord = createFundingRecord();
    const releaseCosignOnChain = {
      blockHeight: 77,
      signature: new Uint8Array([7, 8, 9]),
    };
    const setReleaseCosign = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const ensureLockReleaseProcessing = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const getReleaseCosignOnChain = vi
      .fn<(...args: any[]) => Promise<typeof releaseCosignOnChain | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async () => releaseCosignOnChain);
    const cosignMyLock = vi.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
      txInfo: {
        tx: {
          status: TransactionStatus.Submitted,
        },
        txResult: {
          blockNumber: undefined,
          submissionError: undefined,
          extrinsicError: undefined,
        },
      },
      vaultSignature: new Uint8Array([1, 2, 3]),
    });

    const store = new BitcoinLocks(
      Promise.resolve({} as Db),
      {} as WalletKeys,
      { bestBlockHeader: { blockNumber: 0 } } as BlockWatch,
      {} as CurrencyBase,
      {} as TransactionTracker,
    );
    Object.assign(store, {
      utxoTracking: {
        setReleaseCosign,
      },
      getAcceptedFundingRecord: vi.fn().mockReturnValue(fundingRecord),
      getReleaseCosignOnChain,
      ensureLockReleaseProcessing,
      myVault: {
        vaultId: 1,
        cosignMyLock,
      },
    });
    const testStore = store as unknown as IBitcoinLocksTestTarget;

    await testStore.syncLockReleaseArgonCosign(lock, {} as ArgonClient);
    expect(getReleaseCosignOnChain).toHaveBeenCalledTimes(1);
    expect(cosignMyLock).toHaveBeenCalledTimes(1);
    expect(setReleaseCosign).not.toHaveBeenCalled();

    await testStore.syncLockReleaseArgonCosign(lock, {} as ArgonClient);
    expect(getReleaseCosignOnChain).toHaveBeenCalledTimes(2);
    expect(cosignMyLock).toHaveBeenCalledTimes(1);
    expect(setReleaseCosign).toHaveBeenCalledWith(fundingRecord, {
      releaseCosignVaultSignature: releaseCosignOnChain.signature,
      releaseCosignHeight: releaseCosignOnChain.blockHeight,
    });
    expect(ensureLockReleaseProcessing).toHaveBeenCalledTimes(1);
  });

  it('stores the cosign from the local tx as soon as it reaches its first block', async () => {
    const lock = createLock();
    const fundingRecord = createFundingRecord();
    const vaultSignature = new Uint8Array([1, 2, 3]);
    const setReleaseCosign = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const ensureLockReleaseProcessing = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const getReleaseCosignOnChain = vi.fn<(...args: any[]) => Promise<undefined>>().mockResolvedValue(undefined);
    const cosignMyLock = vi.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
      txInfo: {
        tx: {
          status: TransactionStatus.InBlock,
        },
        txResult: {
          blockNumber: 77,
          submissionError: undefined,
          extrinsicError: undefined,
        },
      },
      vaultSignature,
    });

    const store = new BitcoinLocks(
      Promise.resolve({} as Db),
      {} as WalletKeys,
      { bestBlockHeader: { blockNumber: 0 } } as BlockWatch,
      {} as CurrencyBase,
      {} as TransactionTracker,
    );
    Object.assign(store, {
      utxoTracking: {
        setReleaseCosign,
      },
      getAcceptedFundingRecord: vi.fn().mockReturnValue(fundingRecord),
      getReleaseCosignOnChain,
      ensureLockReleaseProcessing,
      myVault: {
        vaultId: 1,
        cosignMyLock,
      },
    });
    const testStore = store as unknown as IBitcoinLocksTestTarget;

    await testStore.syncLockReleaseArgonCosign(lock, {} as ArgonClient);

    expect(getReleaseCosignOnChain).toHaveBeenCalledTimes(1);
    expect(cosignMyLock).toHaveBeenCalledTimes(1);
    expect(setReleaseCosign).toHaveBeenCalledWith(fundingRecord, {
      releaseCosignVaultSignature: vaultSignature,
      releaseCosignHeight: 77,
    });
    expect(ensureLockReleaseProcessing).toHaveBeenCalledTimes(1);
  });

  it('preserves recovered self-lock fee reimbursement when refreshing chain state', async () => {
    const defaultAccount = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
    const lock = createLock({
      lockDetails: {
        ...createLock().lockDetails,
        ownerAccount: defaultAccount,
        securityFees: 148_296_012n,
        couponFeesPaid: 148_296_012n,
      },
    });
    const latestLock = new BitcoinLock({
      ...lock.lockDetails,
      couponFeesPaid: 0n,
    });
    vi.spyOn(BitcoinLock, 'get').mockResolvedValue(latestLock);

    const store = Object.assign(Object.create(BitcoinLocks.prototype), {
      walletKeys: { defaultArgonAddress: defaultAccount },
      utxoTracking: { getAcceptedFundingRecordForLock: vi.fn() },
      getTable: vi.fn().mockResolvedValue({}),
      syncLockReleaseArgonRequest: vi.fn().mockResolvedValue(undefined),
    }) as BitcoinLocks;

    await (store as unknown as IBitcoinLocksTestTarget).checkForMissingBitcoinLockState(lock);

    expect(lock.lockDetails.couponFeesPaid).toBe(148_296_012n);
  });

  it('subscribes to orphan counters for every vault receiving an owner return request', async () => {
    const ownerAccount = createLock().lockDetails.ownerAccount;
    const firstLock = createLock({ utxoId: 11, vaultId: 1 });
    const secondLock = createLock({ uuid: 'lock-2', utxoId: 12, vaultId: 2 });
    const sameVaultLock = createLock({ uuid: 'lock-3', utxoId: 13, vaultId: 1 });
    const subscribe = vi.fn(async (_vaultId: number, _owner: string, callback: (count: unknown) => void) => {
      callback({ toNumber: () => 1 });
      return vi.fn();
    });
    const client = {
      query: { vaults: { orphanedUtxoAccountsByVaultId: subscribe } },
    } as unknown as ArgonClient;
    const store = new BitcoinLocks(
      Promise.resolve({} as Db),
      { defaultArgonAddress: ownerAccount } as WalletKeys,
      { bestBlockHeader: { blockNumber: 100 } } as BlockWatch,
      {} as CurrencyBase,
      {} as TransactionTracker,
    );
    store.data.locksByUtxoId = { 11: firstLock, 12: secondLock, 13: sameVaultLock };
    vi.spyOn(store.utxoTracking, 'getUnresolvedOrphanRecords').mockReturnValue([
      createFundingRecord({ lockUtxoId: 11 }),
      createFundingRecord({ id: 2, lockUtxoId: 12 }),
      createFundingRecord({ id: 3, lockUtxoId: 13 }),
    ]);

    await store.orphanReleases.syncCosignCounterSubscriptions(client);

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledWith(1, ownerAccount, expect.any(Function));
    expect(subscribe).toHaveBeenCalledWith(2, ownerAccount, expect.any(Function));
  });

  it('reads orphan cosign events only after an owner vault counter decreases', async () => {
    const lock = createLock({ status: BitcoinLockStatus.Released });
    const orphanRecord = createFundingRecord();
    const counterCallbacks: Array<(count: { toNumber: () => number }) => void> = [];
    const subscribe = vi.fn(
      async (_vaultId: number, _owner: string, callback: (count: { toNumber: () => number }) => void) => {
        counterCallbacks.push(callback);
        callback({ toNumber: () => 1 });
        return vi.fn();
      },
    );
    const subscriptionClient = {
      query: { vaults: { orphanedUtxoAccountsByVaultId: subscribe } },
    } as unknown as ArgonClient;
    const blockHeaders = new Map([
      [101, { blockNumber: 101, blockHash: '0x101' }],
      [102, { blockNumber: 102, blockHash: '0x102' }],
    ]);
    const cosignEvent = {
      event: {
        section: 'bitcoinLocks',
        method: 'OrphanedUtxoCosigned',
        data: Object.assign([], { names: [] }),
      },
    };
    const getEvents = vi.fn(async (block: { blockNumber: number }) => {
      return block.blockNumber === 102 ? [cosignEvent] : [];
    });
    const blockApi = {
      query: {
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn().mockResolvedValue({ isSome: false }),
        },
      },
    };
    const blockWatchStub = {
      bestBlockHeader: { blockNumber: 101, blockHash: '0x101' },
      getHeaderByBlockNumber: vi.fn(async (blockNumber: number) => blockHeaders.get(blockNumber)),
      getApi: vi.fn().mockResolvedValue(blockApi),
      getEvents,
      getEventsWithSpec: vi.fn(async (block: { blockNumber: number }) => ({
        api: blockApi,
        events: await getEvents(block),
        specVersion: 157,
      })),
    };
    const blockWatch = blockWatchStub as unknown as BlockWatch;
    const store = new BitcoinLocks(
      Promise.resolve({} as Db),
      { defaultArgonAddress: lock.lockDetails.ownerAccount } as WalletKeys,
      blockWatch,
      {} as CurrencyBase,
      {} as TransactionTracker,
    );
    store.data.locksByUtxoId = { 11: lock };
    vi.spyOn(store.utxoTracking, 'getUnresolvedOrphanRecords').mockReturnValue([orphanRecord]);
    const recoverBlock = vi.spyOn(store.recovery, 'recoverBlock').mockResolvedValue(undefined);
    Object.assign(store, {
      getTable: vi.fn().mockResolvedValue({}),
    });
    const testStore = store as unknown as IBitcoinLocksTestTarget;

    await store.orphanReleases.syncCosignCounterSubscriptions(subscriptionClient);
    await testStore.checkIncomingArgonBlock({ blockNumber: 102, blockHash: '0x102' });
    expect(recoverBlock).not.toHaveBeenCalled();

    counterCallbacks[0]({ toNumber: () => 0 });
    blockWatchStub.bestBlockHeader = { blockNumber: 102, blockHash: '0x102' };
    await testStore.checkIncomingArgonBlock({ blockNumber: 103, blockHash: '0x103' });

    expect(recoverBlock).toHaveBeenCalledWith(blockHeaders.get(102), [cosignEvent]);
  });
});

function createLock(overrides: Partial<IBitcoinLockRecord> = {}): IBitcoinLockRecord {
  return {
    uuid: overrides.uuid ?? 'lock-1',
    utxoId: 'utxoId' in overrides ? overrides.utxoId : 11,
    status: overrides.status ?? BitcoinLockStatus.Releasing,
    satoshis: 10_000n,
    liquidityPromised: 0n,
    lockedTargetPrice: 0n,
    ratchets: [],
    cosignVersion: 'v1',
    lockDetails:
      overrides.lockDetails ??
      ({
        p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
        ownerAccount: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
        createdAtHeight: 100,
        vaultClaimHeight: 200,
      } as IBitcoinLockRecord['lockDetails']),
    fundingUtxoRecordId: 1,
    fundingUtxoRecord: undefined,
    network: 'testnet',
    hdPath: "m/84'/0'/0'",
    vaultId: overrides.vaultId ?? 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function createFundingRecord(overrides: Partial<IBitcoinUtxoRecord> = {}): IBitcoinUtxoRecord {
  return {
    id: overrides.id ?? 1,
    lockUtxoId: overrides.lockUtxoId ?? 11,
    txid: 'a'.repeat(64),
    vout: 0,
    satoshis: 10_000n,
    network: 'testnet',
    status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    firstSeenBitcoinHeight: 0,
    releaseToDestinationAddress: '0014abcd',
    releaseBitcoinNetworkFee: 10n,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}
