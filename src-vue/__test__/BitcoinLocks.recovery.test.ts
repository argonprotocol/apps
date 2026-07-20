import { describe, expect, it, vi } from 'vitest';
import type { BlockWatch, Currency as CurrencyBase } from '@argonprotocol/apps-core';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { Db } from '../lib/Db.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { BitcoinLock, hexToU8a, type IBitcoinLock } from '@argonprotocol/mainchain';
import { createHistoricalEventData } from '../../indexer/__test__/helpers/historicalEvents.ts';
import { bigintCodec, numberCodec, optionCodec } from '../../core/__test__/helpers/codecs.ts';
import { encodeAddress } from '@polkadot/util-crypto';
import { getBitcoinAlertNotices } from '../lib/Alerts.ts';
import { BitcoinFinancials } from '../lib/financials/BitcoinLocks.ts';

function createStore(
  options: { blockWatch?: BlockWatch; transactionTracker?: TransactionTracker; walletKeys?: WalletKeys } = {},
) {
  const blockWatch =
    options.blockWatch ??
    (Object.assign(Object.create(null), {
      start: async () => undefined,
      events: { on: () => () => undefined },
      bestBlockHeader: { blockNumber: 0, blockHash: '0x0' },
    }) as BlockWatch);
  const currency = Object.assign(Object.create(null), {
    load: async () => undefined,
    priceIndex: { getSatoshiPriceInTargetMicrogons: () => 2_000n },
    convertSatToBtc: () => 0,
    convertBtcToMicrogon: () => 0n,
    fetchMainchainRatesAtBlock: async () => ({ BTC: 4_000_000n, ARGNOT: 1_000_000n, USD: 1_000_000n }),
  }) as CurrencyBase;
  const transactionTracker =
    options.transactionTracker ??
    (Object.assign(Object.create(null), {
      load: async () => undefined,
      pendingBlockTxInfosAtLoad: [],
      data: { txInfos: [], txInfosByType: {} },
    }) as TransactionTracker);

  return new BitcoinLocks(
    Promise.resolve(Object.create(null) as Db),
    options.walletKeys ?? (Object.create(null) as WalletKeys),
    blockWatch,
    currency,
    transactionTracker,
  );
}

function createLock(args: {
  uuid: string;
  utxoId?: number;
  status: BitcoinLockStatus;
  createdAt: string;
}): IBitcoinLockRecord {
  return {
    uuid: args.uuid,
    utxoId: args.utxoId,
    status: args.status,
    satoshis: 10_000n,
    liquidityPromised: 0n,
    lockedTargetPrice: 0n,
    ratchets: [],
    cosignVersion: 'v1',
    lockDetails: {
      p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
      ownerAccount: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      createdAtHeight: 100,
      vaultClaimHeight: 200,
    } as IBitcoinLockRecord['lockDetails'],
    fundingUtxoRecordId: null,
    network: 'testnet',
    hdPath: "m/84'/0'/0'",
    vaultId: 1,
    createdAt: new Date(args.createdAt),
    updatedAt: new Date(args.createdAt),
  };
}

function createHistoricalLock(args: {
  accountId: string;
  liquidityPromised: bigint;
  lockedTargetPrice?: bigint;
}): IBitcoinLock {
  return {
    utxoId: 7,
    p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
    vaultId: 1,
    lockedTargetPrice: args.lockedTargetPrice ?? 1_000n,
    liquidityPromised: args.liquidityPromised,
    ownerAccount: args.accountId,
    satoshis: 10_000n,
    vaultPubkey: `02${'11'.repeat(32)}`,
    securityFees: 20n,
    couponFeesPaid: 0n,
    vaultClaimPubkey: `02${'22'.repeat(32)}`,
    ownerPubkey: `02${'33'.repeat(32)}`,
    vaultXpubSources: {
      parentFingerprint: new Uint8Array(4),
      cosignHdIndex: 0,
      claimHdIndex: 0,
    },
    vaultClaimHeight: 700,
    openClaimHeight: 800,
    createdAtHeight: 500,
    isFunded: true,
    createdAtArgonBlock: 151,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
  };
}

function historyBlock(blockNumber: number) {
  return {
    blockNumber,
    blockHash: `0x${blockNumber}`,
    blockTime: new Date('2026-01-01T00:00:00Z').getTime(),
    parentHash: `0x${blockNumber - 1}`,
    author: 'test',
    tick: blockNumber,
    isFinalized: true,
  };
}

function historyEvent(
  specVersion: number,
  section: string,
  method: string,
  values: Readonly<Record<string, unknown>>,
  extrinsicIndex = 2,
) {
  return {
    event: {
      section,
      method,
      data: createHistoricalEventData(specVersion, section, method, values),
    },
    phase: { isApplyExtrinsic: true, asApplyExtrinsic: numberCodec(extrinsicIndex) },
  };
}

describe('BitcoinLocks recovery', () => {
  it('quarantines only recovering locks while regular locks remain active and syncable', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'interim-release',
      utxoId: 7,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.fundingUtxoRecord = {
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
      statusError: 'PSBT finalize error',
    } as never;
    record.isHistoryRecoveryPending = true;
    store.data.locksByUtxoId[7] = record;
    expect(getBitcoinAlertNotices(store)).toEqual([]);

    const regularRecord = createLock({
      uuid: 'regular-lock',
      utxoId: 8,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-02-01T00:00:00Z',
    });
    store.data.locksByUtxoId[8] = regularRecord;
    const setStatus = vi.fn(async (lock: IBitcoinLockRecord, status: BitcoinLockStatus) => {
      lock.status = status;
    });
    vi.spyOn(store, 'getTable').mockResolvedValue({ setStatus } as never);

    expect(store.getActiveLocks()).toEqual([regularRecord]);
    expect(store.getAllLocks()).toEqual([regularRecord]);
    expect(store.getLockByUtxoId(7)).toBeUndefined();
    expect(store.getLockByUtxoId(8)).toBe(regularRecord);
    await expect(store.acknowledgeFailed(record)).rejects.toThrow('Bitcoin history recovery is still in progress');

    const releasingRecord = { status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin } as never;
    await store.syncLockReleaseStatusFromFundingRecord(record, releasingRecord);
    await store.syncLockReleaseStatusFromFundingRecord(regularRecord, releasingRecord);

    expect(record.status).toBe(BitcoinLockStatus.LockPendingFunding);
    expect(regularRecord.status).toBe(BitcoinLockStatus.Releasing);
    expect(setStatus).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith(regularRecord, BitcoinLockStatus.Releasing);

    vi.spyOn(store, 'load').mockResolvedValue();
    const regularSummary = {
      record: regularRecord,
      status: regularRecord.status,
      unlockAmount: 0n,
    } as ReturnType<typeof store.createLockSummary>;
    const createLockSummaryAt = vi.spyOn(store, 'createLockSummaryAt').mockResolvedValue(regularSummary);
    const financials = await new BitcoinFinancials(store).loadSnapshot({
      clientAt: Object.create(null),
      hasCurrentPrice: false,
    });

    expect(createLockSummaryAt).toHaveBeenCalledOnce();
    expect(createLockSummaryAt).toHaveBeenCalledWith(regularRecord, expect.anything());
    expect(financials.summaries).toEqual([regularSummary]);

    delete record.isHistoryRecoveryPending;
    expect(store.getAllLocks()).toEqual([regularRecord, record]);
  });

  it('serializes history replay with the affected lock queue without yielding or waiting behind itself', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'queue-owned-recovery',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    store.data.locksByUtxoId[7] = record;
    const setHistoryRecoveryPending = vi.fn();
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async () => record),
      setHistoryRecoveryPending,
    } as never);

    const runInQueueForUtxo = Reflect.get(store, 'runInQueueForUtxo') as (
      lock: IBitcoinLockRecord,
      timeoutMs: number,
      task: () => Promise<IBitcoinLockRecord>,
      options: { waitForHistoryRecovery: boolean },
    ) => Promise<IBitcoinLockRecord>;
    let started = false;
    const admitted = runInQueueForUtxo.call(
      store,
      record,
      1_000,
      async () => {
        started = true;
        return record;
      },
      { waitForHistoryRecovery: true },
    );

    expect(started).toBe(true);
    await admitted;

    store.recovery.beginHistoryReplay();
    await expect(
      runInQueueForUtxo.call(
        store,
        record,
        1_000,
        async () => {
          return await store.recovery.recoverLock({
            lock: { utxoId: 7 } as BitcoinLock,
            createdAtArgonBlockHeight: 1,
            finalFee: 0n,
            lockQueueOwnerUuid: record.uuid,
          });
        },
        { waitForHistoryRecovery: true },
      ),
    ).resolves.toMatchObject({ uuid: record.uuid });
    await store.recovery.commitHistoryReplay();

    expect(setHistoryRecoveryPending).toHaveBeenCalledWith(record.uuid, true);
    expect(setHistoryRecoveryPending).toHaveBeenCalledWith(record.uuid, false);
  });

  it('resumes one-shot relay work after the affected lock finishes recovery', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'relay-recovery',
      utxoId: 7,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.isHistoryRecoveryPending = true;
    record.relayMetadataJson = { operatorHost: 'http://relay.test', offerCode: 'offer-1', status: 'Submitted' };
    store.data.locksByUtxoId[7] = record;
    const setHistoryRecoveryPending = vi.fn();
    const setRelayMetadata = vi.fn();
    vi.spyOn(store, 'getTable').mockResolvedValue({ setHistoryRecoveryPending, setRelayMetadata } as never);
    vi.spyOn(store as any, 'runPendingLoadReconciliation').mockResolvedValue(undefined);

    const syncRelayBackedPendingLock = Reflect.get(store, 'syncRelayBackedPendingLock') as (
      lock: IBitcoinLockRecord,
      relay: object,
    ) => Promise<void>;
    const relaySync = syncRelayBackedPendingLock.call(store, record, {
      status: 'Failed',
      coupon: { offerCode: 'offer-1' },
    });

    expect(setRelayMetadata).not.toHaveBeenCalled();

    store.recovery.beginHistoryReplay();
    await store.recovery.commitHistoryReplay();
    await relaySync;
    expect(setRelayMetadata).toHaveBeenCalledOnce();
  });

  it('keeps recovered expired locks in history without processing them as active', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'expired-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.removalReason = 'expired';
    store.data.locksByUtxoId[7] = record;

    expect(store.getActiveLocks()).toEqual([]);
    expect(store.getAllLocks()).toEqual([record]);
    expect(store.getLockByUtxoId(7)).toBe(record);
    const setStatus = vi.fn();
    vi.spyOn(store, 'getTable').mockResolvedValue({ setStatus } as never);

    await store.syncLockReleaseStatusFromFundingRecord(record, {
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
    } as never);

    expect(setStatus).not.toHaveBeenCalled();
    expect(record.status).toBe(BitcoinLockStatus.LockPendingFunding);
  });

  it('publishes existing and out-of-order locks only after history replay is committed', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'settled-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const pending = createLock({
      uuid: 'out-of-order-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const recoveredRecord = { ...record, status: BitcoinLockStatus.LockPendingFunding };
    const recoveredPending = { ...pending, utxoId: 8, status: BitcoinLockStatus.LockPendingFunding };
    store.data.locksByUtxoId[7] = record;
    store.data.pendingLocks.push(pending);
    const setHistoryRecoveryPending = vi.fn();
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async utxoId => (utxoId === 7 ? recoveredRecord : recoveredPending)),
      setHistoryRecoveryPending,
    } as never);

    store.recovery.beginHistoryReplay();
    await store.recovery.recoverLock({
      lock: { utxoId: 7 } as BitcoinLock,
      createdAtArgonBlockHeight: 1,
      finalFee: 0n,
    });
    await store.recovery.recoverLock({
      lock: { utxoId: 8 } as BitcoinLock,
      createdAtArgonBlockHeight: 1,
      finalFee: 0n,
    });

    expect(record.status).toBe(BitcoinLockStatus.LockedAndMinted);
    expect(record.isHistoryRecoveryPending).toBe(true);
    expect(pending.isHistoryRecoveryPending).toBe(true);
    expect(store.getAllLocks()).toEqual([]);

    await store.recovery.commitHistoryReplay(false);

    expect(record.status).toBe(BitcoinLockStatus.LockPendingFunding);
    expect(store.data.pendingLocks).toEqual([pending]);
    expect(store.getAllLocks()).toEqual([]);

    store.recovery.beginHistoryReplay();
    await store.recovery.commitHistoryReplay();

    expect(setHistoryRecoveryPending).toHaveBeenCalledWith(record.uuid, true);
    expect(setHistoryRecoveryPending).toHaveBeenCalledWith(record.uuid, false);
    expect(setHistoryRecoveryPending).toHaveBeenCalledWith(pending.uuid, true);
    expect(setHistoryRecoveryPending).toHaveBeenCalledWith(pending.uuid, false);
    expect(record.isHistoryRecoveryPending).toBeUndefined();
    expect(store.data.locksByUtxoId[7]).toBe(record);
    expect(store.data.pendingLocks).toEqual([]);
    expect(store.data.locksByUtxoId[8].isHistoryRecoveryPending).toBeUndefined();
    expect(store.getAllLocks()).toHaveLength(2);
  });

  it('replays creation, ratchet, mint, and release with historical codec events', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const getApi = vi.fn();
    const blockWatch = {
      clients: {},
      getApi,
    } as unknown as BlockWatch;
    const store = createStore({
      blockWatch,
      walletKeys: {
        defaultArgonAddress: accountId,
        miningBotAddress: encodeAddress(new Uint8Array(32).fill(0x44)),
        operationalAddress: encodeAddress(new Uint8Array(32).fill(0x55)),
      } as WalletKeys,
    });
    const fundingRecord = { id: 1 } as never;
    vi.spyOn(store.utxoTracking, 'getAcceptedFundingRecordForLock').mockReturnValue(fundingRecord);
    const setReleaseRequest = vi.spyOn(store.utxoTracking, 'setReleaseRequest').mockResolvedValue();
    const createdLock = new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_000n }));
    const ratchetedLock = new BitcoinLock(
      createHistoricalLock({ accountId, liquidityPromised: 1_200n, lockedTargetPrice: 1_300n }),
    );
    const twiceRatchetedLock = new BitcoinLock(
      createHistoricalLock({ accountId, liquidityPromised: 1_400n, lockedTargetPrice: 1_500n }),
    );
    const record = createLock({
      uuid: 'recovered',
      utxoId: 7,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.lockDetails = createdLock;
    store.data.locksByUtxoId[7] = record;
    const table = {
      getByUtxoId: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(record),
      saveRecoveredHistory: vi.fn(async () => undefined),
      updateMintState: vi.fn(async () => undefined),
      recordReleaseRequest: vi.fn(async (lock: IBitcoinLockRecord, facts: Partial<IBitcoinLockRecord>) => {
        Object.assign(lock, facts, { status: BitcoinLockStatus.Releasing });
      }),
      setStatus: vi.fn(async (lock: IBitcoinLockRecord, status: BitcoinLockStatus) => {
        lock.status = status;
      }),
      recordRemoval: vi.fn(
        async (lock: IBitcoinLockRecord, status: BitcoinLockStatus, facts: Partial<IBitcoinLockRecord>) => {
          Object.assign(lock, facts);
          lock.status = status;
        },
      ),
    };
    vi.spyOn(store, 'getTable').mockResolvedValue(table as never);
    vi.spyOn(store.recovery, 'recoverLock').mockResolvedValue(record);
    vi.spyOn(BitcoinLock, 'get')
      .mockResolvedValueOnce(createdLock)
      .mockResolvedValueOnce(ratchetedLock)
      .mockResolvedValueOnce(twiceRatchetedLock);
    vi.spyOn(BitcoinLock.prototype, 'findPendingMints').mockResolvedValueOnce([]).mockResolvedValue([100n]);
    vi.spyOn(BitcoinLock.prototype, 'getReleaseRequest').mockResolvedValue({
      toScriptPubkey: '0x0014',
      bitcoinNetworkFee: 8n,
      dueFrame: 20,
      vaultId: 1,
      redemptionAmount: 900n,
    });
    const api = {
      query: {
        ticks: { currentTick: vi.fn(async () => numberCodec(700)) },
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn(async () => optionCodec({ blockHeight: numberCodec(600) })),
        },
      },
    };
    getApi.mockResolvedValue(api);

    await store.recovery.recoverBlock(historyBlock(151), [
      historyEvent(151, 'bitcoinLocks', 'BitcoinLockCreated', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 1_000n,
        securitization: 1_000n,
        lockedTargetPrice: 1_000n,
        accountId,
        securityFee: 20n,
      }),
      historyEvent(151, 'transactionPayment', 'TransactionFeePaid', {
        who: accountId,
        actualFee: 11n,
        tip: 0n,
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(152), [
      historyEvent(152, 'mint', 'BitcoinMint', { accountId, utxoId: 7, amount: 1_000n }),
    ]);
    await store.recovery.recoverBlock(historyBlock(153), [
      historyEvent(152, 'bitcoinLocks', 'BitcoinLockRatcheted', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 1_200n,
        oldTargetPrice: 1_000n,
        securityFee: 25n,
        newTargetPrice: 1_300n,
        amountBurned: 50n,
        accountId,
      }),
      historyEvent(152, 'transactionPayment', 'TransactionFeePaid', {
        who: accountId,
        actualFee: 13n,
        tip: 0n,
      }),
      historyEvent(
        152,
        'bitcoinLocks',
        'BitcoinLockRatcheted',
        {
          utxoId: 7,
          vaultId: 1,
          liquidityPromised: 1_400n,
          oldTargetPrice: 1_300n,
          securityFee: 30n,
          newTargetPrice: 1_500n,
          amountBurned: 25n,
          accountId,
        },
        3,
      ),
      historyEvent(
        152,
        'transactionPayment',
        'TransactionFeePaid',
        {
          who: accountId,
          actualFee: 17n,
          tip: 0n,
        },
        3,
      ),
    ]);
    await store.recovery.recoverBlock(historyBlock(154), [
      historyEvent(153, 'mint', 'BitcoinMint', { accountId, utxoId: 7, amount: 300n }),
    ]);
    await store.recovery.recoverBlock(historyBlock(155), [
      historyEvent(154, 'bitcoinLocks', 'BitcoinUtxoCosignRequested', { utxoId: 7, vaultId: 1 }),
      historyEvent(154, 'transactionPayment', 'TransactionFeePaid', {
        who: accountId,
        actualFee: 19n,
        tip: 0n,
      }),
      historyEvent(154, 'bitcoinLocks', 'BitcoinSpentAfterRelease', { utxoId: 7, vaultId: 1 }),
    ]);

    const recovered = store.data.locksByUtxoId[7];
    expect(recovered).toBe(record);
    expect(recovered.ratchets).toEqual([
      expect.objectContaining({ mintAmount: 1_000n, mintPending: 0n, txFee: 11n, extrinsicIndex: 2 }),
      expect.objectContaining({ mintAmount: 200n, mintPending: 0n, burned: 50n, txFee: 13n, extrinsicIndex: 2 }),
      expect.objectContaining({ mintAmount: 200n, mintPending: 100n, burned: 25n, txFee: 17n, extrinsicIndex: 3 }),
    ]);
    expect(recovered.status).toBe(BitcoinLockStatus.Released);
    expect(recovered).toMatchObject({
      releaseRedemptionMicrogons: 900n,
      releaseArgonTxFeeMicrogons: 19n,
      removalBlockNumber: 155,
      removalBlockHash: '0x155',
      removalExtrinsicIndex: 2,
      removalReason: 'released',
      btcPriceAtRemovalMicrogons: 4_000_000n,
    });
    expect(setReleaseRequest).toHaveBeenCalledWith(fundingRecord, {
      requestedReleaseAtTick: 700,
      releaseToDestinationAddress: '0x0014',
      releaseBitcoinNetworkFee: 8n,
    });
    expect(table.saveRecoveredHistory).toHaveBeenCalledTimes(3);
    expect(table.updateMintState).toHaveBeenCalledTimes(2);
  });

  it('recovers a down-ratchet as a full remint at the new cumulative liquidity', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x41));
    const record = createLock({
      uuid: 'down-ratchet',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.liquidityPromised = 800n;
    record.lockedTargetPrice = 800n;
    record.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 0n,
        lockedTargetPrice: 1_000n,
        securityFee: 20n,
        txFee: 11n,
        burned: 0n,
        blockHeight: 151,
        extrinsicIndex: 2,
        oracleBitcoinBlockHeight: 500,
      },
      {
        mintAmount: 0n,
        mintPending: 0n,
        lockedTargetPrice: 800n,
        securityFee: 25n,
        txFee: 0n,
        burned: 800n,
        blockHeight: 152,
        oracleBitcoinBlockHeight: 600,
      },
    ];
    const api = {
      query: {
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn(async () => optionCodec({ blockHeight: numberCodec(600) })),
        },
      },
    };
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => api) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    const saveRecoveredHistory = vi.fn();
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async () => record),
      saveRecoveredHistory,
    } as never);
    vi.spyOn(BitcoinLock, 'get').mockResolvedValue(
      new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 800n, lockedTargetPrice: 800n })),
    );

    await store.recovery.recoverBlock(historyBlock(152), [
      historyEvent(130, 'bitcoinLocks', 'BitcoinLockRatcheted', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 800n,
        originalPeggedPrice: 1_000n,
        securityFee: 25n,
        newPeggedPrice: 800n,
        amountBurned: 800n,
        accountId,
      }),
    ]);

    const recovered = store.data.locksByUtxoId[7];
    expect(recovered.liquidityPromised).toBe(800n);
    expect(recovered.lockedTargetPrice).toBe(800n);
    expect(recovered.ratchets).toHaveLength(2);
    expect(recovered.ratchets.at(-1)).toMatchObject({
      mintAmount: 800n,
      mintPending: 800n,
      liquidityPromised: 800n,
      burned: 800n,
    });
    expect(saveRecoveredHistory).toHaveBeenCalledWith(recovered);
  });

  it('finishes creation provenance after finalization persisted but history save failed', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x3d));
    const chainLock = new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_000n }));
    chainLock.ownerPubkey = `0x${chainLock.ownerPubkey}`;
    const pending = createLock({
      uuid: 'durable-partial-creation',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      createdAt: '2026-01-01T01:00:00Z',
    });
    let durable: IBitcoinLockRecord | undefined;
    let saveAttempt = 0;
    const table = {
      getByUtxoId: vi.fn(async () => durable),
      findLockByHdPath: vi.fn(async () => pending),
      finalizePending: vi.fn(async () => {
        durable = {
          ...pending,
          utxoId: 7,
          status: BitcoinLockStatus.LockPendingFunding,
          liquidityPromised: 1_000n,
          lockedTargetPrice: 1_000n,
          lockDetails: chainLock,
          ratchets: [
            {
              mintAmount: 1_000n,
              mintPending: 1_000n,
              lockedTargetPrice: 1_000n,
              securityFee: 20n,
              txFee: 0n,
              burned: 0n,
              blockHeight: 151,
              oracleBitcoinBlockHeight: 500,
            },
          ],
        };
        return durable;
      }),
      saveRecoveredHistory: vi.fn(async (record: IBitcoinLockRecord, createdAt: Date) => {
        saveAttempt += 1;
        if (saveAttempt === 1) throw new Error('disk full');
        durable = { ...record, createdAt };
      }),
    };
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    vi.spyOn(store, 'getTable').mockResolvedValue(table as never);
    vi.spyOn(store, 'getDerivedPubkey').mockResolvedValue({
      hdPath: pending.hdPath,
      hdIndex: 0,
      address: 'tb1qrecovered',
      ownerBitcoinPubkey: hexToU8a(chainLock.ownerPubkey),
    });
    vi.spyOn(store, 'trackDerivedBitcoinLockKey').mockResolvedValue();
    vi.spyOn(BitcoinLock, 'get').mockResolvedValue(chainLock);
    const block = historyBlock(151);
    const events = [
      historyEvent(151, 'bitcoinLocks', 'BitcoinLockCreated', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 1_000n,
        securitization: 1_000n,
        lockedTargetPrice: 1_000n,
        accountId,
        securityFee: 20n,
      }),
    ];

    await expect(store.recovery.recoverBlock(block, events)).rejects.toThrow('disk full');
    expect(durable?.ratchets[0].extrinsicIndex).toBeUndefined();

    await store.recovery.recoverBlock(block, events);

    expect(table.finalizePending).toHaveBeenCalledOnce();
    expect(table.saveRecoveredHistory).toHaveBeenCalledTimes(2);
    expect(durable?.ratchets[0].extrinsicIndex).toBe(2);
    expect(durable?.createdAt).toEqual(new Date(block.blockTime));
  });

  it('rebuilds pending liquidity before applying a partial scoped mint', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x35));
    const record = createLock({
      uuid: 'partially-minted',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.liquidityPromised = 1_000n;
    record.lockedTargetPrice = 1_000n;
    record.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 0n,
        lockedTargetPrice: 1_000n,
        securityFee: 20n,
        txFee: 0n,
        burned: 0n,
        blockHeight: 151,
        extrinsicIndex: 2,
        oracleBitcoinBlockHeight: 500,
      },
    ];
    const saveRecoveredHistory = vi.fn(async () => undefined);
    const updateMintState = vi.fn(async () => undefined);
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async () => record),
      saveRecoveredHistory,
      updateMintState,
    } as never);
    vi.spyOn(BitcoinLock.prototype, 'findPendingMints').mockResolvedValue([600n]);

    await store.recovery.recoverBlock(historyBlock(151), [
      historyEvent(151, 'bitcoinLocks', 'BitcoinLockCreated', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 1_000n,
        securitization: 1_000n,
        lockedTargetPrice: 1_000n,
        accountId,
        securityFee: 20n,
      }),
      historyEvent(151, 'mint', 'BitcoinMint', { accountId, utxoId: 7, amount: 400n }),
    ]);

    expect(saveRecoveredHistory).toHaveBeenCalledOnce();
    expect(updateMintState).toHaveBeenCalledOnce();
    expect(store.data.locksByUtxoId[7].ratchets[0].mintPending).toBe(600n);
  });

  it('does not apply a scoped mint twice when its block is retried before the history checkpoint', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x46));
    const record = createLock({
      uuid: 'retried-scoped-mint',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndIsMinting,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 1_000n,
        lockedTargetPrice: 1_000n,
        securityFee: 20n,
        txFee: 0n,
        burned: 0n,
        blockHeight: 151,
        oracleBitcoinBlockHeight: 500,
      },
    ];
    const updateMintState = vi.fn(async () => undefined);
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    vi.spyOn(store, 'getTable').mockResolvedValue({ updateMintState } as never);
    vi.spyOn(BitcoinLock.prototype, 'findPendingMints').mockResolvedValue([600n]);
    const events = [historyEvent(151, 'mint', 'BitcoinMint', { accountId, utxoId: 7, amount: 400n })];

    await store.recovery.recoverBlock(historyBlock(152), events);
    await store.recovery.recoverBlock(historyBlock(152), events);

    expect(updateMintState).toHaveBeenCalledOnce();
    expect(store.data.locksByUtxoId[7].ratchets[0].mintPending).toBe(600n);
  });

  it('ignores unrelated scoped and account-less events in an owned activity block', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x47));
    const unrelatedAccountId = encodeAddress(new Uint8Array(32).fill(0x48));
    const record = createLock({
      uuid: 'owned-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndIsMinting,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 1_000n,
        lockedTargetPrice: 1_000n,
        securityFee: 20n,
        txFee: 0n,
        burned: 0n,
        blockHeight: 151,
        oracleBitcoinBlockHeight: 500,
      },
    ];
    const getByUtxoId = vi.fn();
    const updateMintState = vi.fn(async () => undefined);
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    vi.spyOn(store, 'getTable').mockResolvedValue({ getByUtxoId, updateMintState } as never);
    vi.spyOn(BitcoinLock.prototype, 'findPendingMints').mockResolvedValue([600n]);
    const getLock = vi.spyOn(BitcoinLock, 'get');
    getLock.mockClear();

    await store.recovery.recoverBlock(historyBlock(152), [
      historyEvent(151, 'mint', 'BitcoinMint', {
        accountId: unrelatedAccountId,
        utxoId: 99,
        amount: 100n,
      }),
      historyEvent(151, 'bitcoinLocks', 'BitcoinLockRatcheted', {
        utxoId: 98,
        vaultId: 1,
        liquidityPromised: 1_100n,
        oldTargetPrice: 1_000n,
        securityFee: 25n,
        newTargetPrice: 1_100n,
        amountBurned: 0n,
        accountId: unrelatedAccountId,
      }),
      historyEvent(151, 'bitcoinLocks', 'BitcoinSpentAfterRelease', { utxoId: 97, vaultId: 2 }),
      historyEvent(151, 'mint', 'BitcoinMint', { accountId, utxoId: 7, amount: 400n }),
    ]);

    expect(getByUtxoId).toHaveBeenCalledOnce();
    expect(getByUtxoId).toHaveBeenCalledWith(97);
    expect(getLock).not.toHaveBeenCalled();
    expect(updateMintState).toHaveBeenCalledOnce();
    expect(store.data.locksByUtxoId[7].ratchets[0].mintPending).toBe(600n);
  });

  it('reconciles an unscoped historical mint after restarting beyond the lock creation checkpoint', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x37));
    const record = createLock({
      uuid: 'loaded-before-mint-replay',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndIsMinting,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 1_000n,
        lockedTargetPrice: 1_000n,
        securityFee: 20n,
        txFee: 0n,
        burned: 0n,
        blockHeight: 151,
        oracleBitcoinBlockHeight: 500,
      },
    ];
    const untouchedRecord = createLock({
      uuid: 'unrelated-pending-mint',
      utxoId: 8,
      status: BitcoinLockStatus.LockedAndIsMinting,
      createdAt: '2026-01-02T00:00:00Z',
    });
    untouchedRecord.ratchets = record.ratchets.map(ratchet => ({ ...ratchet }));
    const blockWatch = { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch;
    const store = createStore({
      blockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    store.data.locksByUtxoId[8] = untouchedRecord;
    vi.spyOn(store, 'getTable').mockResolvedValue({
      setHistoryRecoveryPending: vi.fn(),
      updateMintState: vi.fn(),
    } as never);
    const findPendingMints = vi
      .spyOn(BitcoinLock.prototype, 'findPendingMints')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([1_000n]);
    findPendingMints.mockClear();

    store.recovery.beginHistoryReplay();
    await store.recovery.recoverBlock(historyBlock(153), [
      historyEvent(153, 'mint', 'BitcoinMint', { accountId, utxoId: null, amount: 1_000n }),
    ]);

    expect(findPendingMints).toHaveBeenCalledTimes(2);
    expect(store.data.locksByUtxoId[7].ratchets[0].mintPending).toBe(1_000n);
    expect(record.isHistoryRecoveryPending).toBe(true);
    expect(untouchedRecord.isHistoryRecoveryPending).toBeUndefined();

    await store.recovery.commitHistoryReplay(false);

    expect(store.data.locksByUtxoId[7].ratchets[0].mintPending).toBe(0n);
    expect(record.isHistoryRecoveryPending).toBe(true);
  });

  it('reads active pending mint state at the supplied financial block without advancing the settled record', async () => {
    const blockApi = { query: {} };
    const blockWatch = { getApi: vi.fn(async () => blockApi) } as unknown as BlockWatch;
    const store = createStore({ blockWatch });
    const record = createLock({
      uuid: 'active-financial-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndIsMinting,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 1_000n,
        lockedTargetPrice: 1_000n,
        securityFee: 0n,
        txFee: 0n,
        burned: 0n,
        blockHeight: 151,
        oracleBitcoinBlockHeight: 500,
      },
    ];
    const fundingRecord = {
      id: 1,
      lockUtxoId: 7,
      txid: 'a'.repeat(64),
      vout: 0,
      satoshis: record.satoshis,
      network: 'testnet',
      status: BitcoinUtxoStatus.FundingUtxo,
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      firstSeenBitcoinHeight: 500,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    vi.spyOn(store.utxoTracking, 'getAcceptedFundingRecordForLock').mockReturnValue(fundingRecord);
    const findPendingMints = vi.spyOn(BitcoinLock.prototype, 'findPendingMints').mockResolvedValue([]);
    vi.spyOn(store, 'getMismatchViewState').mockReturnValue({
      phase: 'none',
      candidateCount: 0,
      isFundingExpired: false,
      candidates: [],
    });
    vi.spyOn(store, 'getLockProcessingDetails').mockReturnValue({
      progressPct: 100,
      confirmations: 3,
      expectedConfirmations: 3,
    });
    vi.spyOn(store, 'getLockProcessingError').mockReturnValue('');
    vi.spyOn(store, 'hasObservedFundingSignal').mockReturnValue(true);
    vi.spyOn(BitcoinLock, 'calculateRedemptionAmountFromSatoshis').mockReturnValue(0n);
    const clientAt = await blockWatch.getApi(historyBlock(152));

    const summary = await store.createLockSummaryAt(record, clientAt);

    expect(findPendingMints).toHaveBeenCalledWith(blockApi);
    expect(summary.pendingLiquidity).toBe(0n);
    expect(summary.receivedLiquidity).toBe(1_000n);
    expect(summary.record).not.toBe(record);
    expect(record.ratchets[0].mintPending).toBe(1_000n);
  });
});

describe('BitcoinLocks ratchet transaction tracking', () => {
  it('reuses a stored pending ratchet instead of submitting another transaction', async () => {
    const pendingTxInfo = {
      tx: {
        extrinsicType: ExtrinsicType.BitcoinRatchet,
        metadataJson: { utxoId: 7 },
        status: TransactionStatus.Finalized,
      },
      txResult: {},
      isPostProcessed: false,
    };
    const transactionTracker = Object.assign(Object.create(null), {
      findLatestTxInfo: vi.fn((matches: (candidate: typeof pendingTxInfo) => boolean) => {
        return matches(pendingTxInfo) ? pendingTxInfo : undefined;
      }),
    }) as TransactionTracker;
    const store = createStore({ transactionTracker });
    const lock = createLock({
      uuid: 'pending-ratchet',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });

    await expect(store.ratchet(lock, { address: 'owner' } as never)).resolves.toBe(pendingTxInfo);

    pendingTxInfo.isPostProcessed = true;
    expect(store.getPendingRatchetTxInfo(lock)).toBeUndefined();
  });

  it('returns after tracked submission without waiting for finalization', async () => {
    const waitForFinalizedBlock = new Promise<Uint8Array>(() => undefined);
    const txResult = { waitForFinalizedBlock };
    const getRatchetResult = vi.fn(() => waitForFinalizedBlock);
    const ratchet = vi.fn(async () => ({ txResult, getRatchetResult }));
    const txInfo = {
      tx: { id: 12 },
      txResult,
      createPostProcessor: () => ({ resolve: vi.fn(), reject: vi.fn() }),
    };
    const trackTxResult = vi.fn(async () => txInfo);
    const transactionTracker = Object.assign(Object.create(null), {
      data: { txInfos: [], txInfosByType: {} },
      findLatestTxInfo: vi.fn(() => undefined),
      trackTxResult,
    }) as TransactionTracker;
    const store = createStore({ transactionTracker });
    const lock = createLock({
      uuid: 'ratchet-submit',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const getRatchetContext = vi.fn(async () => ({
      bitcoinLock: { ratchet },
      client: {},
      vault: {},
    }));
    Object.assign(store, { getRatchetContext });
    vi.spyOn(store, 'getRatchetPreview').mockResolvedValue({ canRatchet: true } as never);

    await expect(store.ratchet(lock, { address: 'owner' } as never)).resolves.toBe(txInfo);
    expect(ratchet).toHaveBeenCalledWith(
      expect.objectContaining({
        disableAutomaticTxTracking: true,
        microgonsAtTargetPerBtc: 2_000n,
      }),
    );
    expect(trackTxResult).toHaveBeenCalledWith({
      txResult,
      extrinsicType: ExtrinsicType.BitcoinRatchet,
      metadata: { utxoId: 7 },
    });
    expect(getRatchetResult).not.toHaveBeenCalled();
  });
});
