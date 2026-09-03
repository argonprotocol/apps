import { describe, expect, it, vi } from 'vitest';
import type { BlockWatch, RuntimeSystemEventRecord } from '@argonprotocol/apps-core';
import * as BitcoinHistory from '../lib/recovery/BitcoinLockHistory.ts';
import { hexToU8a } from '@argonprotocol/mainchain';
import { encodeAddress } from '@polkadot/util-crypto';
import BigNumber from 'bignumber.js';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import type { IHistoricalBitcoinLockRecord } from '../lib/recovery/BitcoinLockReplay.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { bigintCodec, numberCodec, optionCodec } from '../../core/__test__/helpers/codecs.ts';
import { createLock, createStore, createHistoricalLock, historyBlock, historyEvent } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));
vi.mock('../lib/recovery/BitcoinLockHistory.ts', async importOriginal => ({
  ...(await importOriginal()),
  getHistoricalBitcoinFundingUtxoRef: vi.fn(),
  getHistoricalBitcoinLock: vi.fn(),
  getHistoricalBitcoinPendingMints: vi.fn(),
  getHistoricalBitcoinReleaseRequest: vi.fn(),
}));

describe('BitcoinLocks historical event replay', () => {
  it('replays creation, ratchet, mint, and release with historical codec events', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const db = await createTestDb();
    const getApi = vi.fn();
    const blockWatch = {
      clients: {},
      getApi,
    } as unknown as BlockWatch;
    const store = createStore({
      blockWatch,
      db,
      walletKeys: {
        defaultArgonAddress: accountId,
        miningBotAddress: encodeAddress(new Uint8Array(32).fill(0x44)),
        operationalAddress: encodeAddress(new Uint8Array(32).fill(0x55)),
      } as WalletKeys,
    });
    const createdLock = createHistoricalLock({ accountId, liquidityPromised: 1_000n });
    const verifiedLock = {
      ...createHistoricalLock({ accountId, liquidityPromised: 900n, lockedTargetPrice: 900n }),
      fundedSatoshis: 9_900n,
    };
    const ratchetedLock = createHistoricalLock({
      accountId,
      liquidityPromised: 1_200n,
      lockedTargetPrice: 1_300n,
    });
    const twiceRatchetedLock = createHistoricalLock({
      accountId,
      liquidityPromised: 1_400n,
      lockedTargetPrice: 1_500n,
    });
    const record = createLock({
      uuid: 'recovered',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.lockDetails = {
      ...createHistoricalLock({ accountId, liquidityPromised: 9_000n }),
      utxoId: 41,
    };
    record.ratchets = [
      {
        mintAmount: 9_000n,
        mintPending: 9_000n,
        lockedTargetPrice: 1_000n,
        securityFee: 20n,
        txFee: 56_584n,
        burned: 0n,
        blockHeight: 583_481,
        oracleBitcoinBlockHeight: 500,
      },
    ];
    store.data.locksByUtxoId[7] = record;
    vi.spyOn(store.recovery, 'recoverLock').mockResolvedValue(record);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce(createdLock)
      .mockResolvedValueOnce(verifiedLock)
      .mockResolvedValueOnce(ratchetedLock)
      .mockResolvedValueOnce(twiceRatchetedLock);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinFundingUtxoRef)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ txid: 'funding-txid', vout: 0 });
    vi.mocked(BitcoinHistory.getHistoricalBitcoinPendingMints).mockResolvedValueOnce([]).mockResolvedValue([100n]);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinReleaseRequest).mockResolvedValue({
      toScriptPubkey: '0x0014',
      bitcoinNetworkFee: 8n,
      redemptionAmount: 900n,
    });
    const ownerLockKeys = vi.fn(async () => [{ args: [{}, 7] }, { args: [{}, 8] }]);
    const api = {
      runtimeVersion: { specVersion: numberCodec(158) },
      query: {
        ticks: { currentTick: vi.fn(async () => 700) },
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn(async () => ({ blockHeight: 600 })),
        },
        bitcoinLocks: {
          utxoIdsByOwnerAccount: { keys: ownerLockKeys },
        },
      },
    };
    getApi.mockResolvedValue(api);
    await store.recovery.beginHistoryReplay();

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
      historyEvent(152, 'bitcoinUtxos', 'UtxoVerified', {
        utxoId: 7,
        satoshisReceived: 9_900n,
      }),
      historyEvent(152, 'mint', 'BitcoinMint', { accountId, utxoId: 7, amount: 900n }),
    ]);
    await store.recovery.recoverBlock(historyBlock(153), [
      historyEvent(152, 'bitcoinLocks', 'BitcoinLockRatcheted', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 1_200n,
        oldTargetPrice: 900n,
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
      historyEvent(153, 'mint', 'BitcoinMint', { accountId, utxoId: 7, amount: 400n }),
    ]);
    await store.recovery.recoverBlock(historyBlock(155), [
      historyEvent(154, 'bitcoinLocks', 'BitcoinUtxoCosignRequested', { utxoId: 7, vaultId: 1 }),
      historyEvent(154, 'transactionPayment', 'TransactionFeePaid', {
        who: accountId,
        actualFee: 19n,
        tip: 0n,
      }),
      historyEvent(154, 'bitcoinLocks', 'BitcoinUtxoCosigned', {
        utxoId: 7,
        vaultId: 1,
        signature: '0x11',
      }),
    ]);

    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockReset()
      .mockImplementation(async (_api, utxoId) => {
        if (utxoId === 7) return twiceRatchetedLock;
        return createHistoricalLock({ accountId, liquidityPromised: 2_000n, lockedTargetPrice: 2_000n });
      });
    await expect(store.recovery.findMissingActiveLockIds(api as never)).resolves.toEqual([8]);

    const [recovered] = await store.recovery.commitHistoryReplay(true);
    const [fundingRecord] = await db.bitcoinUtxosTable.fetchAll();
    expect(recovered.lockDetails.utxoId).toBe(7);
    expect(recovered.satoshis).toBe(9_900n);
    expect(recovered.ratchets).toEqual([
      expect.objectContaining({ mintAmount: 900n, mintPending: 0n, txFee: 11n, extrinsicIndex: 2 }),
      expect.objectContaining({ mintAmount: 300n, mintPending: 0n, burned: 50n, txFee: 13n, extrinsicIndex: 2 }),
      expect.objectContaining({ mintAmount: 200n, mintPending: 100n, burned: 25n, txFee: 17n, extrinsicIndex: 3 }),
    ]);
    expect(recovered.status).toBe(BitcoinLockStatus.Releasing);
    expect(recovered).toMatchObject({
      releaseRedemptionMicrogons: 900n,
      releaseArgonTxFeeMicrogons: 19n,
      removalBlockNumber: 155,
      removalBlockHash: '0x155',
      removalBlockTime: new Date(historyBlock(155).blockTime),
      removalExtrinsicIndex: 2,
      btcPriceAtRemovalMicrogons: 4_000_000n,
    });
    expect(recovered.removalReason).toBeUndefined();
    expect(fundingRecord).toMatchObject({
      releaseCosignVaultSignature: hexToU8a('0x11'),
      releaseCosignHeight: 155,
    });
    expect(ownerLockKeys).toHaveBeenCalledWith(accountId);
  });

  it('rebuilds current snapshot economics before replaying historical ratchets', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const db = await createTestDb();
    const api = {
      runtimeVersion: { specVersion: numberCodec(158) },
      query: {
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn(async () => ({ blockHeight: 600 })),
        },
        bitcoinLocks: {
          utxoIdsByOwnerAccount: { keys: vi.fn(async () => [{ args: [{}, 7] }]) },
          locksByUtxoId: {
            multi: vi.fn(async () => [{ liquidityPromised: 1_400n, lockedTargetPrice: 1_500n }]),
          },
        },
      },
    };
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => api) } as unknown as BlockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    const record = createLock({
      uuid: 'pre-funding-history',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.liquidityPromised = 1_400n;
    record.lockedTargetPrice = 1_500n;
    record.lockDetails = {
      ...createHistoricalLock({ accountId, liquidityPromised: 1_400n, lockedTargetPrice: 1_500n }),
      utxoId: 7,
    };
    record.ratchets = [
      {
        mintAmount: 1_400n,
        mintPending: 0n,
        liquidityPromised: 1_400n,
        lockedTargetPrice: 1_500n,
        securityFee: 20n,
        txFee: 11n,
        burned: 0n,
        blockHeight: 151,
        oracleBitcoinBlockHeight: 500,
      },
    ];
    store.data.locksByUtxoId[7] = record;
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce({
        ...createHistoricalLock({ accountId, liquidityPromised: 1_000n, lockedTargetPrice: 1_000n }),
        fundedSatoshis: 0n,
      })
      .mockResolvedValueOnce({
        ...createHistoricalLock({ accountId, liquidityPromised: 1_050n, lockedTargetPrice: 1_050n }),
        securitizedSatoshis: 10_500n,
        fundedSatoshis: 10_500n,
      })
      .mockResolvedValueOnce(createHistoricalLock({ accountId, liquidityPromised: 1_200n, lockedTargetPrice: 1_300n }))
      .mockResolvedValueOnce(createHistoricalLock({ accountId, liquidityPromised: 1_400n, lockedTargetPrice: 1_500n }));
    vi.mocked(BitcoinHistory.getHistoricalBitcoinFundingUtxoRef).mockResolvedValue(undefined);
    await store.recovery.beginHistoryReplay();

    await store.recovery.recoverBlock(historyBlock(151), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockCreated', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 1_000n,
        securitization: 1_000n,
        lockedTargetPrice: 1_000n,
        accountId,
        securityFee: 20n,
      }),
    ]);

    await store.recovery.recoverBlock(historyBlock(153), [
      historyEvent(157, 'bitcoinLocks', 'UtxoFundedFromCandidate', {
        utxoId: 7,
        utxoRef: { txid: `0x${'44'.repeat(32)}`, outputIndex: 2 },
        vaultId: 1,
        accountId,
      }),
    ]);

    await store.recovery.recoverBlock(historyBlock(154), [
      historyEvent(158, 'bitcoinLocks', 'BitcoinLockRatcheted', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 1_200n,
        oldTargetPrice: 1_050n,
        securityFee: 25n,
        newTargetPrice: 1_300n,
        amountBurned: 0n,
        accountId,
      }),
      historyEvent(
        158,
        'bitcoinLocks',
        'BitcoinLockRatcheted',
        {
          utxoId: 7,
          vaultId: 1,
          liquidityPromised: 1_400n,
          oldTargetPrice: 1_300n,
          securityFee: 30n,
          newTargetPrice: 1_500n,
          amountBurned: 0n,
          accountId,
        },
        3,
      ),
    ]);

    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockReset()
      .mockResolvedValue({
        ...record.lockDetails,
        lockedTargetPrice: record.lockedTargetPrice,
        liquidityPromised: record.liquidityPromised,
      });
    await expect(store.recovery.findMissingActiveLockIds(api as never)).resolves.toEqual([]);

    const [recovered] = await store.recovery.commitHistoryReplay(true);
    expect(recovered).toMatchObject({
      status: BitcoinLockStatus.LockFunded,
      satoshis: 10_500n,
      liquidityPromised: 1_400n,
      lockedTargetPrice: 1_500n,
    });
    expect(recovered.ratchets).toEqual([
      expect.objectContaining({ mintAmount: 1_050n, lockedTargetPrice: 1_050n }),
      expect.objectContaining({ mintAmount: 150n, lockedTargetPrice: 1_300n }),
      expect.objectContaining({ mintAmount: 200n, lockedTargetPrice: 1_500n }),
    ]);
  });

  it('keeps an unfunded Lock pending when its UTXO is no longer watched', async () => {
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
    });
    const record = createLock({
      uuid: 'unwatched-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-01T00:00:00Z',
    });
    store.data.locksByUtxoId[7] = record;
    vi.spyOn(store, 'getTable').mockResolvedValue({ getByUtxoId: vi.fn(async () => record) } as never);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue(undefined);

    await store.recovery.recoverBlock(historyBlock(157), [
      historyEvent(157, 'bitcoinUtxos', 'UtxoUnwatched', { utxoId: 7 }),
    ]);

    expect(store.data.locksByUtxoId[7].status).toBe(BitcoinLockStatus.LockPendingFunding);
    expect(store.data.locksByUtxoId[7].removalReason).toBeUndefined();
  });

  it.each([
    {
      name: 'restores an unknown transition when canonical state is sufficient',
      method: 'FutureBitcoinTransition',
      recoveredLiquidity: 1_000n,
      isBackfill: true,
    },
    {
      name: 'requires an explicit handler when an unknown transition changes economics',
      method: 'FutureEconomicTransition',
      recoveredLiquidity: 1_100n,
      isBackfill: false,
      expectedError:
        'bitcoinLocks.FutureEconomicTransition requires an explicit recovery handler because it changed lock economics',
    },
  ])('$name', async ({ method, recoveredLiquidity, isBackfill, expectedError }) => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
    });
    const record = createLock({
      uuid: method,
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.liquidityPromised = 1_000n;
    record.lockedTargetPrice = 1_000n;
    record.lockDetails = createHistoricalLock({ accountId, liquidityPromised: 1_000n });
    record.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 0n,
        lockedTargetPrice: 1_000n,
        securityFee: 20n,
        txFee: 11n,
        burned: 0n,
        blockHeight: 151,
        oracleBitcoinBlockHeight: 500,
      },
    ];
    store.data.locksByUtxoId[7] = record;
    const saveRecoveredHistory = vi.fn(async () => undefined);
    vi.spyOn(store, 'getTable').mockResolvedValue({ saveRecoveredHistory } as never);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue({
      ...createHistoricalLock({ accountId, liquidityPromised: recoveredLiquidity }),
      isFlexible: isBackfill,
    });
    const unknownEvent = historyEvent(157, 'bitcoinLocks', 'BitcoinLockBackfillChanged', {
      utxoId: 7,
      vaultId: 1,
      isBackfill,
    });
    const futureEvent = {
      ...unknownEvent,
      event: { ...unknownEvent.event, method },
    } as unknown as RuntimeSystemEventRecord;

    const replay = store.recovery.recoverBlock(historyBlock(157), [futureEvent]);
    if (expectedError) {
      await expect(replay).rejects.toThrow(expectedError);
      return;
    }

    await expect(replay).resolves.toBeUndefined();
    expect(store.data.locksByUtxoId[7].isFlexible).toBe(true);
    expect(saveRecoveredHistory).toHaveBeenCalledWith(expect.objectContaining({ isFlexible: true }));
  });

  it('replays a flexibility change without replacing later lock economics', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
    });
    const record = createLock({
      uuid: 'flexibility-change',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.liquidityPromised = 1_100n;
    record.lockedTargetPrice = 1_100n;
    record.lockDetails = createHistoricalLock({
      accountId,
      liquidityPromised: 1_100n,
      lockedTargetPrice: 1_100n,
    });
    record.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 0n,
        lockedTargetPrice: 1_000n,
        securityFee: 20n,
        txFee: 11n,
        burned: 0n,
        blockHeight: 151,
        oracleBitcoinBlockHeight: 500,
      },
      {
        mintAmount: 100n,
        mintPending: 0n,
        liquidityPromised: 1_100n,
        lockedTargetPrice: 1_100n,
        securityFee: 2n,
        txFee: 3n,
        burned: 0n,
        blockHeight: 201,
        oracleBitcoinBlockHeight: 600,
      },
    ];
    store.data.locksByUtxoId[7] = record;
    const saveRecoveredHistory = vi.fn(async () => undefined);
    vi.spyOn(store, 'getTable').mockResolvedValue({ saveRecoveredHistory } as never);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue(
      createHistoricalLock({ accountId, liquidityPromised: 1_000n }),
    );
    const event = historyEvent(158, 'bitcoinLocks', 'BitcoinLockFlexibleChanged', {
      utxoId: 7,
      vaultId: 1,
      isFlexible: true,
    });

    await expect(store.recovery.recoverBlock(historyBlock(200), [event])).resolves.toBeUndefined();

    expect(store.data.locksByUtxoId[7].isFlexible).toBe(true);
    expect(record.liquidityPromised).toBe(1_100n);
    expect(record.lockedTargetPrice).toBe(1_100n);
    expect(saveRecoveredHistory).toHaveBeenCalledWith(expect.objectContaining({ isFlexible: true }));
  });

  it('recovers a down-ratchet as a full remint at the new cumulative liquidity', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x41));
    const record = createLock({
      uuid: 'down-ratchet',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
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
          confirmedBitcoinBlockTip: vi.fn(async () => ({ blockHeight: 600 })),
        },
      },
    };
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => api) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    const saveRecoveredHistory = vi.fn((_record: IHistoricalBitcoinLockRecord) => undefined);
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async () => record),
      saveRecoveredHistory,
    } as never);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue(
      createHistoricalLock({ accountId, liquidityPromised: 800n, lockedTargetPrice: 800n }),
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

    const recovered = saveRecoveredHistory.mock.calls.at(-1)![0];
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

  it('recovers a pre-158 promise reset but rejects the regression in newer history', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x42));
    const db = await createTestDb();
    const record = createLock({
      uuid: 'legacy-up-ratchet',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.liquidityPromised = 800n;
    record.lockedTargetPrice = 1_400n;
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
    ];
    const api = {
      runtimeVersion: { specVersion: numberCodec(156) },
      query: {
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn(async () => ({ blockHeight: 600 })),
        },
        priceIndex: {
          current: vi.fn(async () => ({
            btcUsdPrice: new BigNumber(1),
            argonotUsdPrice: new BigNumber(1),
            argonUsdPrice: new BigNumber(0.5),
            argonUsdTargetPrice: new BigNumber(1),
            argonTimeWeightedAverageLiquidity: new BigNumber(1),
            tick: 152,
          })),
        },
        bitcoinLocks: {
          utxoIdsByOwnerAccount: { keys: vi.fn(async () => [{ args: [{}, 7] }]) },
          locksByUtxoId: {
            multi: vi.fn(async () => [{ liquidityPromised: 800n, lockedTargetPrice: 1_400n }]),
          },
        },
      },
    };
    const newerApi = { ...api, runtimeVersion: { specVersion: numberCodec(158) } };
    const store = createStore({
      blockWatch: {
        getApi: vi.fn().mockResolvedValueOnce(api).mockResolvedValueOnce(newerApi),
      } as unknown as BlockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue(
      createHistoricalLock({ accountId, liquidityPromised: 800n, lockedTargetPrice: 1_400n }),
    );
    await store.recovery.beginHistoryReplay();

    await store.recovery.recoverBlock(historyBlock(152), [
      historyEvent(156, 'bitcoinLocks', 'BitcoinLockRatcheted', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 800n,
        oldTargetPrice: 1_000n,
        securityFee: 25n,
        newTargetPrice: 1_400n,
        amountBurned: 0n,
        accountId,
      }),
    ]);

    await expect(
      store.recovery.recoverBlock(historyBlock(153), [
        historyEvent(158, 'bitcoinLocks', 'BitcoinLockRatcheted', {
          utxoId: 7,
          vaultId: 1,
          liquidityPromised: 700n,
          oldTargetPrice: 1_400n,
          securityFee: 30n,
          newTargetPrice: 1_500n,
          amountBurned: 0n,
          accountId,
        }),
      ]),
    ).rejects.toThrow('Bitcoin lock 7 up-ratchet reduced its promised liquidity');

    const [recovered] = await store.recovery.commitHistoryReplay(true);
    expect(recovered).toMatchObject({ liquidityPromised: 800n, lockedTargetPrice: 1_400n });
    expect(recovered.ratchets.at(-1)).toMatchObject({
      mintAmount: 540n,
      mintPending: 540n,
      liquidityPromised: 800n,
      lockedTargetPrice: 1_400n,
    });
  });

  it('finishes creation provenance after the initial history save failed', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x3d));
    const chainLock = createHistoricalLock({ accountId, liquidityPromised: 1_000n });
    chainLock.ownerPubkey = `0x${chainLock.ownerPubkey}`;
    const pending = createLock({
      uuid: 'durable-partial-creation',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      createdAt: '2026-01-01T01:00:00Z',
    });
    let durable: IHistoricalBitcoinLockRecord | undefined;
    let saveAttempt = 0;
    const table = {
      getByUtxoId: vi.fn(async () => durable),
      findPendingByHdPath: vi.fn(async () => pending),
      saveRecoveredHistory: vi.fn(async (record: IHistoricalBitcoinLockRecord, createdAt: Date) => {
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
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue(chainLock);
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

    expect(durable?.ratchets[0].extrinsicIndex).toBe(2);
    expect(durable?.createdAt).toEqual(new Date(block.blockTime));
  });

  it('rebuilds pending liquidity before applying a partial scoped mint', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x35));
    const db = await createTestDb();
    const record = createLock({
      uuid: 'partially-minted',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.liquidityPromised = 1_000n;
    record.lockedTargetPrice = 1_000n;
    record.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 1_000n,
        lockedTargetPrice: 1_000n,
        securityFee: 20n,
        txFee: 0n,
        burned: 0n,
        blockHeight: 151,
        extrinsicIndex: 2,
        oracleBitcoinBlockHeight: 500,
      },
    ];
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    vi.mocked(BitcoinHistory.getHistoricalBitcoinPendingMints).mockResolvedValue([600n]);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue(
      createHistoricalLock({ accountId, liquidityPromised: 1_000n, lockedTargetPrice: 1_000n }),
    );
    await store.recovery.beginHistoryReplay();

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

    const [recovered] = await store.recovery.commitHistoryReplay(true);
    expect(recovered.ratchets[0].mintPending).toBe(600n);
  });

  it('does not apply a scoped mint twice when its block is retried before the history checkpoint', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x46));
    const db = await createTestDb();
    const record = createLock({
      uuid: 'retried-scoped-mint',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
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
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    vi.mocked(BitcoinHistory.getHistoricalBitcoinPendingMints).mockResolvedValue([600n]);
    const events = [historyEvent(151, 'mint', 'BitcoinMint', { accountId, utxoId: 7, amount: 400n })];
    await store.recovery.beginHistoryReplay();

    await store.recovery.recoverBlock(historyBlock(152), events);
    await store.recovery.recoverBlock(historyBlock(152), events);

    const [recovered] = await store.recovery.commitHistoryReplay(true);
    expect(recovered.ratchets[0].mintPending).toBe(600n);
  });

  it('ignores unrelated scoped and account-less events in an owned activity block', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x47));
    const unrelatedAccountId = encodeAddress(new Uint8Array(32).fill(0x48));
    const db = await createTestDb();
    const record = createLock({
      uuid: 'owned-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
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
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    const getByUtxoId = vi.spyOn(db.bitcoinLocksTable, 'getByUtxoId');
    vi.mocked(BitcoinHistory.getHistoricalBitcoinPendingMints).mockResolvedValue([600n]);
    const getLock = vi.mocked(BitcoinHistory.getHistoricalBitcoinLock);
    getLock.mockClear();
    await store.recovery.beginHistoryReplay();

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
    const [recovered] = await store.recovery.commitHistoryReplay(true);
    expect(recovered.ratchets[0].mintPending).toBe(600n);
  });

  it('reconciles an unscoped historical mint after restarting beyond the lock creation checkpoint', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x37));
    const record = createLock({
      uuid: 'loaded-before-mint-replay',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
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
      status: BitcoinLockStatus.LockFunded,
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
      .mocked(BitcoinHistory.getHistoricalBitcoinPendingMints)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([1_000n]);
    findPendingMints.mockClear();

    await store.recovery.beginHistoryReplay();
    await store.recovery.recoverBlock(historyBlock(153), [
      historyEvent(153, 'mint', 'BitcoinMint', { accountId, utxoId: null, amount: 1_000n }),
    ]);

    expect(findPendingMints).toHaveBeenCalledTimes(2);
    expect(record.ratchets[0].mintPending).toBe(1_000n);
    expect(record.isHistoryRecoveryPending).toBeUndefined();
    expect(untouchedRecord.isHistoryRecoveryPending).toBeUndefined();

    await store.recovery.commitHistoryReplay(false);

    expect(record.ratchets[0].mintPending).toBe(1_000n);
    expect(record.isHistoryRecoveryPending).toBeUndefined();
  });
});
