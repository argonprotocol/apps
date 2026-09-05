import { describe, expect, it, vi } from 'vitest';
import { BitcoinLock } from '@argonprotocol/apps-core';
import {
  type ArgonClient,
  type ArgonQueryClient,
  BlockWatch,
  Currency as CurrencyBase,
} from '@argonprotocol/apps-core';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { Db } from '../lib/Db.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoRole, BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import { TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { createCurrentLock } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));

type IBitcoinLocksTestTarget = {
  checkIncomingArgonBlock(header: { blockHash: string; blockNumber: number }): Promise<void>;
  checkForMissingBitcoinLockState(lock: IBitcoinLockRecord): Promise<void>;
  failPendingLock(uuid: string, error: unknown): Promise<void>;
  syncLockReleaseArgonCosign(lock: IBitcoinLockRecord, archiveClient: ArgonClient): Promise<void>;
};

describe('BitcoinLocks Argon cosign gating', () => {
  it.each([
    'FissionCreated',
    'FissionRatcheted',
    'FissionClosed',
    'FissionClosedByLock',
    'BitcoinLockBurned',
    'BitcoinSpentAfterRelease',
  ])('publishes one Fission-state change signal after a %s event batch', async method => {
    const section = method.startsWith('Fission') ? 'bitcoinFissions' : 'bitcoinLocks';
    const blockApi = {
      query: {
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn().mockResolvedValue(null),
        },
      },
    };
    const blockWatch = {
      getHeaderByBlockNumber: vi.fn(async (blockNumber: number) => ({
        blockNumber,
        blockHash: `0x${blockNumber}`,
      })),
      getEventsWithSpec: vi.fn(async () => ({
        api: blockApi,
        events: [{ event: { section, method, data: {} } }, { event: { section, method, data: {} } }],
        specVersion: 159,
      })),
    } as unknown as BlockWatch;
    const store = new BitcoinLocks(
      Promise.resolve({} as Db),
      Object.create(null) as WalletKeys,
      blockWatch,
      Object.create(null) as CurrencyBase,
      Object.create(null) as TransactionTracker,
    );
    vi.spyOn(store.orphanReleases, 'recoverPendingCosignEvents').mockResolvedValue(undefined);
    const refreshes: ArgonQueryClient[] = [];
    store.events.on('fissions:changed', change => refreshes.push(change.client));

    await (store as unknown as IBitcoinLocksTestTarget).checkIncomingArgonBlock({
      blockNumber: 102,
      blockHash: '0x102',
    });

    expect(refreshes).toEqual([blockApi]);
  });

  it('updates a mounted wallet when Fissions allocate and release its current Lock', async () => {
    const db = await createTestDb();
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'wallet-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({ uuid: pending.uuid, lock: createCurrentLock() });
    await db.bitcoinLocksTable.setStatus(record, BitcoinLockStatus.LockFunded);
    const fundingUtxo = { role: BitcoinUtxoRole.Funding, satoshis: 10_000n } as IBitcoinUtxoRecord;
    record.utxos.push(fundingUtxo);
    record.fundingUtxo = fundingUtxo;
    let eventMethod = 'FissionCreated';
    let currentLock = createCurrentLock({ fissionedSatoshis: 6_000n });
    const blockApi = { query: { bitcoinUtxos: { confirmedBitcoinBlockTip: vi.fn().mockResolvedValue(null) } } };
    const blockWatch = {
      getHeaderByBlockNumber: vi.fn(async (blockNumber: number) => ({ blockNumber, blockHash: `0x${blockNumber}` })),
      getEventsWithSpec: vi.fn(async () => ({
        api: blockApi,
        events: [{ event: { section: 'bitcoinFissions', method: eventMethod, data: {} } }],
        specVersion: 159,
      })),
    } as unknown as BlockWatch;
    const store = new BitcoinLocks(
      Promise.resolve(db),
      Object.create(null) as WalletKeys,
      blockWatch,
      Object.create(null) as CurrencyBase,
      Object.create(null) as TransactionTracker,
    );
    store.data.locksByUtxoId[record.utxoId!] = record;
    store.utxoTracking.data.utxosByLockUtxoId[record.utxoId!] = [fundingUtxo];
    vi.spyOn(BitcoinLock, 'get').mockImplementation(async () => currentLock as BitcoinLock);
    vi.spyOn(store.orphanReleases, 'recoverPendingCosignEvents').mockResolvedValue(undefined);
    vi.spyOn(store.orphanReleases, 'reconcileOrphanReturns').mockResolvedValue(undefined);
    vi.spyOn(
      store as unknown as { syncPendingFundingSignals(): Promise<void> },
      'syncPendingFundingSignals',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      store as unknown as { reconcileAcceptedFundingReleaseOnBlock(): Promise<void> },
      'reconcileAcceptedFundingReleaseOnBlock',
    ).mockResolvedValue(undefined);
    const wallet = new WalletForBitcoin(
      () => store,
      () => record.ownerAccount!,
      Object.create(null) as never,
    );

    expect(wallet.getSendableChannels()).toEqual([record]);
    await (store as unknown as IBitcoinLocksTestTarget).checkIncomingArgonBlock({
      blockNumber: 102,
      blockHash: '0x102',
    });
    expect(record.fissionedSatoshis).toBe(6_000n);
    expect(wallet.getSendableChannels()).toEqual([]);
    expect(wallet.getLiquidLockedChannels()).toEqual([record]);

    eventMethod = 'FissionClosed';
    currentLock = createCurrentLock({ fissionedSatoshis: 0n });
    await (store as unknown as IBitcoinLocksTestTarget).checkIncomingArgonBlock({
      blockNumber: 103,
      blockHash: '0x103',
    });
    expect(record.fissionedSatoshis).toBe(0n);
    expect(wallet.getSendableChannels()).toEqual([record]);
    expect(wallet.getLiquidLockedChannels()).toEqual([]);
  });

  it('preserves the runtime coupon amount when a member Lock is finalized', async () => {
    const db = await createTestDb();
    const defaultAccount = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'member-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const store = new BitcoinLocks(
      Promise.resolve(db),
      { defaultArgonAddress: defaultAccount } as WalletKeys,
      {} as BlockWatch,
      {} as CurrencyBase,
      {} as TransactionTracker,
    );
    store.data.pendingLocks = [pending];
    const currentLock = new BitcoinLock(
      createCurrentLock({
        utxoId: 7,
        ownerAccount: defaultAccount,
        securityFees: 3_000_000n,
        couponFeesPaid: 1_000_000n,
      }),
    );

    const finalized = await store.finalizeCreatedLock(pending.uuid, currentLock);

    expect(finalized.securityFees).toBe(3_000_000n);
    expect(finalized.couponFeesPaid).toBe(1_000_000n);
    expect((await db.bitcoinLocksTable.getByUtxoId(7))?.couponFeesPaid).toBe(1_000_000n);
  });

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
    store.data.readiness = 'ready';
    const setLockFailed = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    Object.assign(store, {
      getTable: vi.fn().mockResolvedValue({
        setLockFailed,
      }),
    });
    const testStore = store as unknown as IBitcoinLocksTestTarget;

    await testStore.failPendingLock(lock.uuid, extrinsicError);

    expect(setLockFailed).toHaveBeenCalledWith(lock, {
      errorCode: 'bitcoinLocks.InsufficientVaultFunds',
      details: 'bitcoinLocks.InsufficientVaultFunds',
      message: 'bitcoinLocks.InsufficientVaultFunds',
    });
    expect(store.data.financialRevision).toBe(1);
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
      { canSign: true } as WalletKeys,
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
      { canSign: true } as WalletKeys,
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

  it('subscribes to orphan counters for every vault receiving an owner return request', async () => {
    const ownerAccount = createLock().ownerAccount!;
    const firstLock = createLock({ utxoId: 11, vaultId: 1 });
    const secondLock = createLock({ uuid: 'lock-2', utxoId: 12, vaultId: 2 });
    const sameVaultLock = createLock({ uuid: 'lock-3', utxoId: 13, vaultId: 1 });
    const subscribe = vi.fn(async (_vaultId: number, _owner: string, callback: (count: unknown) => void) => {
      callback(1);
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
    const counterCallbacks: Array<(count: number) => void> = [];
    const subscribe = vi.fn(async (_vaultId: number, _owner: string, callback: (count: number) => void) => {
      counterCallbacks.push(callback);
      callback(1);
      return vi.fn();
    });
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
        data: {},
      },
    };
    const getEvents = vi.fn(async (block: { blockNumber: number }) => {
      return block.blockNumber === 102 ? [cosignEvent] : [];
    });
    const blockApi = {
      query: {
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn().mockResolvedValue(null),
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
      { defaultArgonAddress: lock.ownerAccount } as WalletKeys,
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
    await testStore.checkIncomingArgonBlock({ blockNumber: 101, blockHash: '0x101' });
    expect(recoverBlock).not.toHaveBeenCalled();

    counterCallbacks[0](0);
    blockWatchStub.bestBlockHeader = { blockNumber: 102, blockHash: '0x102' };
    await testStore.checkIncomingArgonBlock({ blockNumber: 102, blockHash: '0x102' });

    expect(recoverBlock).toHaveBeenCalledWith(blockHeaders.get(102), [cosignEvent]);
  });
});

function createLock(overrides: Partial<IBitcoinLockRecord> = {}): IBitcoinLockRecord {
  return {
    uuid: overrides.uuid ?? 'lock-1',
    utxoId: 'utxoId' in overrides ? overrides.utxoId : 11,
    status: overrides.status ?? BitcoinLockStatus.Releasing,
    securitizedSatoshis: overrides.securitizedSatoshis ?? 10_000n,
    ownerAccount: overrides.ownerAccount ?? '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    securityFees: overrides.securityFees ?? 0n,
    couponFeesPaid: overrides.couponFeesPaid ?? 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: overrides.fundHoldExtensionsByBitcoinExpirationHeight ?? {},
    utxos: overrides.utxos ?? [],
    fundedSatoshis: overrides.fundedSatoshis ?? 0n,
    cosignVersion: 'v1',
    scriptDetails:
      overrides.scriptDetails ??
      ({
        p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
        vaultPubkey: `02${'11'.repeat(32)}`,
        vaultClaimPubkey: `02${'22'.repeat(32)}`,
        ownerPubkey: `02${'33'.repeat(32)}`,
        vaultXpubSources: { parentFingerprint: new Uint8Array(4), cosignHdIndex: 0, claimHdIndex: 0 },
        createdAtHeight: 100,
        vaultClaimHeight: 200,
        openClaimHeight: 300,
      } as NonNullable<IBitcoinLockRecord['scriptDetails']>),
    fundingUtxo: overrides.fundingUtxo,
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
