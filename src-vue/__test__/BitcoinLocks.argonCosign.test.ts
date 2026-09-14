import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import {
  BitcoinReleaseKind,
  BitcoinReleaseStatus,
  type IBitcoinReleaseRecord,
} from '../interfaces/IBitcoinReleaseRecord.ts';
import { TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { createCurrentLock, historyBlock } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import { getMainchainClient } from '../stores/mainchain.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));

type IBitcoinLocksTestTarget = {
  checkIncomingArgonBlock(header: { blockHash: string; blockNumber: number }): Promise<void>;
  checkForMissingBitcoinLockState(lock: IBitcoinLockRecord): Promise<void>;
  failPendingLock(uuid: string, error: unknown): Promise<void>;
};

describe('BitcoinLocks Argon cosign gating', () => {
  afterEach(() => vi.restoreAllMocks());

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
        bitcoinLocks: {
          orphanedUtxosByAccount: { entries: vi.fn().mockResolvedValue([]) },
        },
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
    vi.spyOn(store.releases, 'recoverPendingOrphanCosignEvents').mockResolvedValue(undefined);
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
    const fundingUtxo = {
      id: 1,
      lockId: record.lockId!,
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      satoshis: 10_000n,
    } as IBitcoinUtxoRecord;
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
    store.data.locksByLockId[record.lockId!] = record;
    store.utxoTracking.load([fundingUtxo]);
    vi.spyOn(BitcoinLock, 'get').mockImplementation(async () => currentLock as BitcoinLock);
    vi.spyOn(store.releases, 'recoverPendingOrphanCosignEvents').mockResolvedValue(undefined);
    vi.spyOn(store.releases, 'reconcileOrphanReleases').mockResolvedValue(undefined);
    vi.spyOn(
      store as unknown as { syncPendingFundingSignals(): Promise<void> },
      'syncPendingFundingSignals',
    ).mockResolvedValue(undefined);
    vi.spyOn(store.releases, 'reconcileLockRelease').mockResolvedValue(undefined);
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
      { getHeader: vi.fn(async () => historyBlock(159)) } as unknown as BlockWatch,
      {} as CurrencyBase,
      {} as TransactionTracker,
    );
    store.data.pendingLocks = [pending];
    const currentLock = new BitcoinLock(
      createCurrentLock({
        lockId: 7,
        ownerAccount: defaultAccount,
        securityFees: 3_000_000n,
        couponFeesPaid: 1_000_000n,
      }),
    );

    const finalized = await store.finalizeCreatedLock(pending.uuid, currentLock, {
      tx: { id: 1, blockHeight: 159, blockHash: '0x159', blockExtrinsicIndex: 2 },
      txResult: {},
    } as TransactionInfo);

    expect(finalized.securityFees).toBe(3_000_000n);
    expect(finalized.couponFeesPaid).toBe(1_000_000n);
    expect((await db.bitcoinLocksTable.getByLockId(7))?.couponFeesPaid).toBe(1_000_000n);
    expect((await db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot(defaultAccount))?.terms).toEqual([
      expect.objectContaining({
        lockId: 7,
        cumulativeNetSecurityFee: 2_000_000n,
        addedNetSecurityFee: 2_000_000n,
      }),
    ]);
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
      lockId: undefined,
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
    const release = createRelease();
    const releaseCosignOnChain = {
      blockHeight: 77,
      signatures: [new Uint8Array([7, 8, 9])],
    };
    const recordVaultCosign = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const findVaultCosignatures = vi
      .spyOn(BitcoinLock, 'findVaultCosignatures')
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
      vaultSignatures: [new Uint8Array([1, 2, 3])],
    });

    const store = new BitcoinLocks(
      Promise.resolve({} as Db),
      { canSign: true } as WalletKeys,
      { bestBlockHeader: { blockNumber: 0 } } as BlockWatch,
      {} as CurrencyBase,
      {} as TransactionTracker,
    );
    vi.spyOn(store.releases, 'getActiveForLock').mockReturnValue(release);
    vi.spyOn(store.releases, 'recordVaultCosign').mockImplementation(recordVaultCosign);
    store.myVault = { vaultId: 1, cosignMyLock } as unknown as typeof store.myVault;

    await store.releases.syncLockVaultCosign(lock, {} as ArgonClient);
    expect(findVaultCosignatures).toHaveBeenCalledTimes(1);
    expect(cosignMyLock).toHaveBeenCalledTimes(1);
    expect(recordVaultCosign).not.toHaveBeenCalled();

    await store.releases.syncLockVaultCosign(lock, {} as ArgonClient);
    expect(findVaultCosignatures).toHaveBeenCalledTimes(2);
    expect(cosignMyLock).toHaveBeenCalledTimes(1);
    expect(recordVaultCosign).toHaveBeenCalledWith(release, {
      vaultSignatures: releaseCosignOnChain.signatures,
      cosignBlockNumber: releaseCosignOnChain.blockHeight,
    });
  });

  it('stores the cosign from the local tx as soon as it reaches its first block', async () => {
    const lock = createLock();
    const release = createRelease();
    const vaultSignatures = [new Uint8Array([1, 2, 3])];
    const recordVaultCosign = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const findVaultCosignatures = vi.spyOn(BitcoinLock, 'findVaultCosignatures').mockResolvedValue(undefined);
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
      vaultSignatures,
    });

    const store = new BitcoinLocks(
      Promise.resolve({} as Db),
      { canSign: true } as WalletKeys,
      { bestBlockHeader: { blockNumber: 0 } } as BlockWatch,
      {} as CurrencyBase,
      {} as TransactionTracker,
    );
    vi.spyOn(store.releases, 'getActiveForLock').mockReturnValue(release);
    vi.spyOn(store.releases, 'recordVaultCosign').mockImplementation(recordVaultCosign);
    store.myVault = { vaultId: 1, cosignMyLock } as unknown as typeof store.myVault;

    await store.releases.syncLockVaultCosign(lock, {} as ArgonClient);

    expect(findVaultCosignatures).toHaveBeenCalledTimes(1);
    expect(cosignMyLock).toHaveBeenCalledTimes(1);
    expect(recordVaultCosign).toHaveBeenCalledWith(release, {
      vaultSignatures,
      cosignBlockNumber: 77,
    });
  });

  it('subscribes to orphan counters for every vault receiving an owner return request', async () => {
    const ownerAccount = createLock().ownerAccount!;
    const firstLock = createLock({ lockId: 11, vaultId: 1 });
    const secondLock = createLock({ uuid: 'lock-2', lockId: 12, vaultId: 2 });
    const sameVaultLock = createLock({ uuid: 'lock-3', lockId: 13, vaultId: 1 });
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
    store.data.locksByLockId = { 11: firstLock, 12: secondLock, 13: sameVaultLock };
    const orphanUtxos = [
      createFundingUtxo({ lockId: 11, activeReleaseId: 'orphan-release-1' }),
      createFundingUtxo({ id: 2, lockId: 12, activeReleaseId: 'orphan-release-2' }),
      createFundingUtxo({ id: 3, lockId: 13, activeReleaseId: 'orphan-release-3' }),
    ];
    store.utxoTracking.load(orphanUtxos);
    store.releases.data.releasesById = Object.fromEntries(
      orphanUtxos.map((utxo, index) => {
        const release = createRelease({
          id: `orphan-release-${index + 1}`,
          kind: BitcoinReleaseKind.Orphan,
          lockId: utxo.lockId,
          inputUtxoIds: [utxo.id],
        });
        return [release.id, release];
      }),
    );

    await store.releases.syncOrphanCosignCounterSubscriptions(client);

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledWith(1, ownerAccount, expect.any(Function));
    expect(subscribe).toHaveBeenCalledWith(2, ownerAccount, expect.any(Function));
  });

  it('starts cosign observation after finalization and preserves self-Vault signing', async () => {
    const db = await createTestDb();
    const walletKeys = { canSign: false };
    const lock = createLock({ status: BitcoinLockStatus.LockFunded });
    lock.activeReleaseId = undefined;
    const store = new BitcoinLocks(
      Promise.resolve(db),
      walletKeys as WalletKeys,
      { bestBlockHeader: { blockNumber: 100 } } as BlockWatch,
      {} as CurrencyBase,
      {} as TransactionTracker,
    );
    store.data.locksByLockId = { [lock.lockId!]: lock };

    const orphan = await db.bitcoinUtxosTable.insert({
      lockId: lock.lockId!,
      txid: 'b'.repeat(64),
      vout: 1,
      satoshis: 2_000n,
      network: lock.network,
      status: BitcoinUtxoStatus.Orphaned,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      firstSeenBitcoinHeight: 100,
    });
    store.utxoTracking.load([orphan]);
    const release = await store.releases.createOrphanRelease(orphan, {
      id: 'self-vault-orphan-release',
      kind: BitcoinReleaseKind.Orphan,
      lockId: lock.lockId!,
      status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
      inputUtxoIds: [orphan.id],
      toScriptPubkey: '0x0014abcd',
      bitcoinNetworkFee: 10n,
      vaultSignatures: [],
    });

    const subscribe = vi.fn(async (_vaultId: number, _owner: string, callback: (count: number) => void) => {
      callback(1);
      return vi.fn();
    });
    const client = {
      at: vi.fn(async () => ({ query: { ticks: { currentTick: vi.fn().mockResolvedValue(10) } } })),
      query: { vaults: { orphanedUtxoAccountsByVaultId: subscribe } },
    } as unknown as ArgonClient;
    vi.mocked(getMainchainClient).mockResolvedValue(client);

    await store.releases.finalizeOrphanRequest(release, new Uint8Array([1]));

    expect(release.status).toBe(BitcoinReleaseStatus.WaitingForVaultCosign);
    expect(subscribe).toHaveBeenCalledWith(lock.vaultId, lock.ownerAccount, expect.any(Function));

    const signature = new Uint8Array([7, 8, 9]);
    const createVaultSignatureForMyOrphanedUtxoRelease = vi.fn().mockResolvedValue(signature);
    store.myVault = { createVaultSignatureForMyOrphanedUtxoRelease } as unknown as typeof store.myVault;
    walletKeys.canSign = true;

    await store.releases.syncOrphanVaultCosign(lock, release);

    expect(createVaultSignatureForMyOrphanedUtxoRelease).toHaveBeenCalledWith({
      lock,
      txid: orphan.txid,
      vout: orphan.vout,
      satoshis: orphan.satoshis,
      toScriptPubkey: release.toScriptPubkey,
      bitcoinNetworkFee: release.bitcoinNetworkFee,
    });
    expect(await db.bitcoinReleasesTable.getById(release.id)).toMatchObject({
      status: BitcoinReleaseStatus.ReadyForBitcoinBroadcast,
      vaultSignatures: [signature],
    });
  });

  it('reads orphan cosign events only after an owner vault counter decreases', async () => {
    const lock = createLock({ status: BitcoinLockStatus.Released });
    const orphanRecord = createFundingUtxo({ activeReleaseId: 'orphan-release-1' });
    const orphanRelease = createRelease({ id: 'orphan-release-1', kind: BitcoinReleaseKind.Orphan });
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
        data: {
          lockId: lock.lockId,
          utxoRef: { txid: orphanRecord.txid, outputIndex: orphanRecord.vout },
          vaultId: lock.vaultId,
          accountId: lock.ownerAccount,
          signature: new Uint8Array([1, 2, 3]),
        },
      },
    };
    const getEvents = vi.fn(async (block: { blockNumber: number }) => {
      return block.blockNumber === 102 ? [cosignEvent] : [];
    });
    const blockApi = {
      query: {
        bitcoinLocks: {
          orphanedUtxosByAccount: { entries: vi.fn().mockResolvedValue([]) },
        },
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
    store.data.locksByLockId = { 11: lock };
    store.utxoTracking.load([orphanRecord]);
    store.releases.data.releasesById = { [orphanRelease.id]: orphanRelease };
    const recordVaultCosign = vi.spyOn(store.releases, 'recordVaultCosign').mockResolvedValue(undefined);
    Object.assign(store, {
      getTable: vi.fn().mockResolvedValue({}),
    });
    const testStore = store as unknown as IBitcoinLocksTestTarget;

    await store.releases.syncOrphanCosignCounterSubscriptions(subscriptionClient);
    await testStore.checkIncomingArgonBlock({ blockNumber: 101, blockHash: '0x101' });
    expect(recordVaultCosign).not.toHaveBeenCalled();

    counterCallbacks[0](0);
    blockWatchStub.bestBlockHeader = { blockNumber: 102, blockHash: '0x102' };
    await testStore.checkIncomingArgonBlock({ blockNumber: 102, blockHash: '0x102' });

    expect(recordVaultCosign).toHaveBeenCalledWith(orphanRelease, {
      vaultSignatures: [new Uint8Array([1, 2, 3])],
      cosignBlockNumber: 102,
    });
  });
});

function createLock(overrides: Partial<IBitcoinLockRecord> = {}): IBitcoinLockRecord {
  return {
    uuid: overrides.uuid ?? 'lock-1',
    lockId: 'lockId' in overrides ? overrides.lockId : 11,
    status: overrides.status ?? BitcoinLockStatus.Releasing,
    securitizedSatoshis: overrides.securitizedSatoshis ?? 10_000n,
    ownerAccount: overrides.ownerAccount ?? '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    securityFees: overrides.securityFees ?? 0n,
    couponFeesPaid: overrides.couponFeesPaid ?? 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: overrides.fundHoldExtensionsByBitcoinExpirationHeight ?? {},
    fundedSatoshis: overrides.fundedSatoshis ?? 0n,
    fundingUtxoIds: overrides.fundingUtxoIds ?? [1],
    activeReleaseId: overrides.activeReleaseId ?? 'release-1',
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
    network: 'testnet',
    hdPath: "m/84'/0'/0'",
    vaultId: overrides.vaultId ?? 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function createFundingUtxo(overrides: Partial<IBitcoinUtxoRecord> = {}): IBitcoinUtxoRecord {
  return {
    id: overrides.id ?? 1,
    lockId: overrides.lockId ?? 11,
    txid: 'a'.repeat(64),
    vout: 0,
    satoshis: 10_000n,
    network: 'testnet',
    status: overrides.status ?? BitcoinUtxoStatus.Orphaned,
    spendStatus: overrides.spendStatus ?? BitcoinUtxoSpendStatus.Unspent,
    activeReleaseId: overrides.activeReleaseId,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    firstSeenBitcoinHeight: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function createRelease(overrides: Partial<IBitcoinReleaseRecord> = {}): IBitcoinReleaseRecord {
  return {
    id: overrides.id ?? 'release-1',
    kind: overrides.kind ?? BitcoinReleaseKind.Lock,
    lockId: overrides.lockId ?? 11,
    status: overrides.status ?? BitcoinReleaseStatus.WaitingForVaultCosign,
    inputUtxoIds: overrides.inputUtxoIds ?? [1],
    requestedReleaseAtTick: 10,
    toScriptPubkey: '0x0014abcd',
    bitcoinNetworkFee: 10n,
    vaultSignatures: overrides.vaultSignatures ?? [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}
