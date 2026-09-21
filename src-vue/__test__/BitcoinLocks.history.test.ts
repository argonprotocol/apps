import { describe, expect, it, vi } from 'vitest';
import type { BlockWatch, RuntimeSystemEventRecord } from '@argonprotocol/apps-core';
import * as BitcoinHistory from '../lib/recovery/BitcoinLockHistory.ts';
import { hexToU8a } from '@argonprotocol/mainchain';
import { encodeAddress } from '@polkadot/util-crypto';
import BigNumber from 'bignumber.js';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { publishBitcoinHistoryReplay } from '../lib/recovery/index.ts';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { BitcoinReleaseKind, BitcoinReleaseStatus } from '../interfaces/IBitcoinReleaseRecord.ts';
import { createHistoricalBitcoinLockRecord } from '../lib/recovery/BitcoinLockReplay.ts';
import { bigintCodec, numberCodec, optionCodec } from '../../core/__test__/helpers/codecs.ts';
import { createLock, createStore, createHistoricalLock, historyBlock, historyEvent } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));
vi.mock('../lib/recovery/BitcoinLockHistory.ts', async importOriginal => ({
  ...(await importOriginal()),
  getHistoricalBitcoinFundingUtxos: vi.fn(),
  getHistoricalBitcoinLock: vi.fn(),
  getHistoricalBitcoinPendingMints: vi.fn(),
  getHistoricalBitcoinReleaseRequest: vi.fn(),
}));

async function publishRecoveredHistory(store: ReturnType<typeof createStore>) {
  return publishBitcoinHistoryReplay({ bitcoinLocks: store, asOfBlock: 0 });
}

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
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce(createdLock)
      .mockResolvedValueOnce(verifiedLock)
      .mockResolvedValueOnce(ratchetedLock)
      .mockResolvedValueOnce(twiceRatchetedLock);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinFundingUtxos)
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ utxoRef: { txid: 'funding-txid', vout: 0 }, satoshis: verifiedLock.fundedSatoshis }]);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinPendingMints).mockResolvedValueOnce([]).mockResolvedValue([100n]);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinReleaseRequest).mockResolvedValue({
      toScriptPubkey: '0x0014',
      bitcoinNetworkFee: 8n,
      liquidRedemptionAmount: 900n,
    });
    const ownerLockKeys = vi.fn(async () => [{ args: [{}, 7] }, { args: [{}, 8] }]);
    const api = {
      runtimeVersion: { specVersion: numberCodec(158) },
      query: {
        ticks: { currentTick: vi.fn(async () => 700) },
        vaults: { vaultsById: vi.fn(async () => undefined) },
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

    const prepared = await store.recovery.prepareHistoryReplay();
    expect(prepared.historicalLiquidCloseByUtxoId.get(7)).toEqual({
      redemptionAmount: 900n,
      closeTxFee: 19n,
    });

    const [recovered] = await publishRecoveredHistory(store);
    const [fundingUtxo] = await db.bitcoinUtxosTable.fetchAll();
    expect(recovered.utxoId).toBe(7);
    expect(recovered.satoshis).toBe(9_900n);
    expect(recovered.ratchets).toEqual([
      expect.objectContaining({
        mintAmount: 900n,
        mintPending: 0n,
        txFee: 11n,
        blockHash: '0x151',
        blockTime: new Date(historyBlock(151).blockTime),
        extrinsicIndex: 2,
      }),
      expect.objectContaining({
        mintAmount: 300n,
        mintPending: 0n,
        burned: 50n,
        txFee: 13n,
        blockHash: '0x153',
        blockTime: new Date(historyBlock(153).blockTime),
        extrinsicIndex: 2,
      }),
      expect.objectContaining({
        mintAmount: 200n,
        mintPending: 100n,
        burned: 25n,
        txFee: 17n,
        blockHash: '0x153',
        blockTime: new Date(historyBlock(153).blockTime),
        extrinsicIndex: 3,
      }),
    ]);
    expect(recovered.status).toBe(BitcoinLockStatus.Releasing);
    expect(recovered).toMatchObject({
      removalBlockNumber: 155,
      removalBlockHash: '0x155',
      removalBlockTime: new Date(historyBlock(155).blockTime),
      removalTick: historyBlock(155).tick,
      removalExtrinsicIndex: 2,
      btcPriceAtRemovalMicrogons: 4_000_000n,
    });
    expect(recovered.removalReason).toBeUndefined();
    expect(fundingUtxo).toMatchObject({
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
    });
    expect(await db.bitcoinReleasesTable.fetchAll()).toEqual([
      expect.objectContaining({
        kind: BitcoinReleaseKind.Lock,
        status: BitcoinReleaseStatus.ReadyForBitcoinBroadcast,
        argonTxFeeMicrogons: 19n,
        vaultSignatures: [hexToU8a('0x11')],
        cosignBlockNumber: 155,
      }),
    ]);
    expect(ownerLockKeys).toHaveBeenCalledWith(accountId);
  });

  it('restores a missing removal tick from the recorded removal block', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const db = await createTestDb();
    const removalBlock = { ...historyBlock(158), tick: 540 };
    const getHeader = vi.fn(async () => removalBlock);
    const withBackgroundArchiveRead = vi.fn(async <T>(read: () => Promise<T>) => await read());
    const api = {
      runtimeVersion: { specVersion: numberCodec(158) },
      query: { vaults: { vaultsById: vi.fn(async () => undefined) } },
    };
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => api), getHeader, withBackgroundArchiveRead } as unknown as BlockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    const record = createLock({
      uuid: 'missing-removal-tick',
      utxoId: 7,
      status: BitcoinLockStatus.Released,
      createdAt: '2026-01-01T00:00:00Z',
    });
    Object.assign(record, {
      removalBlockNumber: 158,
      removalBlockHash: '0x158',
      removalBlockTime: new Date('2026-01-02T00:00:00Z'),
      removalReason: 'released',
    });
    store.data.locksByLockId[7] = record;
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
    ]);

    const prepared = await store.recovery.prepareHistoryReplay();

    expect(prepared.records).toEqual([expect.objectContaining({ utxoId: 7, removalTick: 540 })]);
    expect(withBackgroundArchiveRead).toHaveBeenCalledOnce();
    expect(getHeader).toHaveBeenCalledWith({ blockNumber: 158, blockHash: '0x158' });
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
    store.data.locksByLockId[7] = record;
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
    vi.mocked(BitcoinHistory.getHistoricalBitcoinFundingUtxos).mockResolvedValue([]);
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
        ...createHistoricalLock({
          accountId,
          liquidityPromised: 1_400n,
          lockedTargetPrice: 1_500n,
        }),
        lockedTargetPrice: 1_500n,
        liquidityPromised: 1_400n,
      });
    await expect(store.recovery.findMissingActiveLockIds(api as never)).resolves.toEqual([]);

    const [recovered] = await publishRecoveredHistory(store);
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
    record.microgonsAtTargetPerBtc = 1_100n;
    record.securitizedSatoshis = 11_000n;
    record.isHistoryRecoveryPending = true;
    store.data.locksByLockId[7] = record;
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue(
      createHistoricalLock({ accountId, liquidityPromised: 1_000n }),
    );
    const event = historyEvent(158, 'bitcoinLocks', 'BitcoinLockFlexibleChanged', {
      utxoId: 7,
      vaultId: 1,
      isFlexible: true,
    });

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await expect(store.recovery.recoverBlock(historyBlock(200), [event])).resolves.toBeUndefined();

    expect(store.data.locksByLockId[7].isFlexible).not.toBe(true);
    expect(record.microgonsAtTargetPerBtc).toBe(1_100n);
    expect(record.securitizedSatoshis).toBe(11_000n);
    await expect(store.recovery.prepareHistoryReplay()).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          isFlexible: true,
          microgonsAtTargetPerBtc: 1_100n,
          securitizedSatoshis: 11_000n,
        }),
      ],
    });
  });

  it('recovers a down-ratchet as a full remint at the new cumulative liquidity', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x41));
    const db = await createTestDb();
    const api = {
      runtimeVersion: { specVersion: numberCodec(130) },
      query: {
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn(async () => ({ blockHeight: 600 })),
        },
        vaults: { vaultsById: vi.fn(async () => undefined) },
      },
    };
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => api) } as unknown as BlockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce(createHistoricalLock({ accountId, liquidityPromised: 1_000n, lockedTargetPrice: 1_000n }))
      .mockResolvedValueOnce(createHistoricalLock({ accountId, liquidityPromised: 800n, lockedTargetPrice: 800n }));
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
    ]);

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

    const [recovered] = await publishRecoveredHistory(store);
    expect(recovered.liquidityPromised).toBe(800n);
    expect(recovered.lockedTargetPrice).toBe(800n);
    expect(recovered.ratchets).toHaveLength(2);
    expect(recovered.ratchets.at(-1)).toMatchObject({
      mintAmount: 800n,
      mintPending: 800n,
      liquidityPromised: 800n,
      burned: 800n,
    });
  });

  it('recovers a pre-158 promise reset but rejects the regression in newer history', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x42));
    const db = await createTestDb();
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
          locksByLockId: {
            multi: vi.fn(async () => [{ liquidityPromised: 800n, lockedTargetPrice: 1_400n }]),
          },
        },
        vaults: { vaultsById: vi.fn(async () => undefined) },
      },
    };
    const newerApi = { ...api, runtimeVersion: { specVersion: numberCodec(158) } };
    const store = createStore({
      blockWatch: {
        getApi: vi.fn().mockResolvedValueOnce(api).mockResolvedValueOnce(api).mockResolvedValueOnce(newerApi),
      } as unknown as BlockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce(createHistoricalLock({ accountId, liquidityPromised: 1_000n }))
      .mockResolvedValueOnce(createHistoricalLock({ accountId, liquidityPromised: 800n, lockedTargetPrice: 1_400n }))
      .mockResolvedValueOnce(createHistoricalLock({ accountId, liquidityPromised: 700n, lockedTargetPrice: 1_500n }));
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
    ]);

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

    const [recovered] = await publishRecoveredHistory(store);
    expect(recovered).toMatchObject({ liquidityPromised: 800n, lockedTargetPrice: 1_400n });
    expect(recovered.ratchets.at(-1)).toMatchObject({
      mintAmount: 540n,
      mintPending: 540n,
      liquidityPromised: 800n,
      lockedTargetPrice: 1_400n,
    });
  });

  it('rebuilds pending liquidity before applying a partial scoped mint', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x35));
    const db = await createTestDb();
    const record = createHistoricalBitcoinLockRecord(
      createLock({
        uuid: 'partially-minted',
        utxoId: 7,
        status: BitcoinLockStatus.LockFunded,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    );
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
    store.data.locksByLockId[7] = record;
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

    const [recovered] = await publishRecoveredHistory(store);
    expect(recovered.ratchets[0].mintPending).toBe(600n);
  });

  it('does not apply a scoped mint twice when its block is retried before the history checkpoint', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x46));
    const db = await createTestDb();
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue(
      createHistoricalLock({ accountId, liquidityPromised: 1_000n, lockedTargetPrice: 1_000n }),
    );
    vi.mocked(BitcoinHistory.getHistoricalBitcoinPendingMints).mockResolvedValue([600n]);
    const events = [historyEvent(151, 'mint', 'BitcoinMint', { accountId, utxoId: 7, amount: 400n })];
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
    ]);
    await store.recovery.recoverBlock(historyBlock(152), events);
    await store.recovery.recoverBlock(historyBlock(152), events);

    const [recovered] = await publishRecoveredHistory(store);
    expect(recovered.ratchets[0].mintPending).toBe(600n);
  });

  it('ignores unrelated scoped and account-less events in an owned activity block', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x47));
    const unrelatedAccountId = encodeAddress(new Uint8Array(32).fill(0x48));
    const db = await createTestDb();
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    const getByLockId = vi.spyOn(db.bitcoinLocksTable, 'getByLockId');
    vi.mocked(BitcoinHistory.getHistoricalBitcoinPendingMints).mockResolvedValue([600n]);
    const getLock = vi.mocked(BitcoinHistory.getHistoricalBitcoinLock);
    getLock.mockResolvedValue(
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
    ]);
    getByLockId.mockClear();
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

    expect(getByLockId).toHaveBeenCalledOnce();
    expect(getByLockId).toHaveBeenCalledWith(97);
    expect(getLock).not.toHaveBeenCalled();
    const [recovered] = await publishRecoveredHistory(store);
    expect(recovered.ratchets[0].mintPending).toBe(600n);
  });

  it('reconciles an unscoped historical mint after restarting beyond the lock creation checkpoint', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x37));
    const db = await createTestDb();
    const record = createLock({
      uuid: 'loaded-before-mint-replay',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const untouchedRecord = createLock({
      uuid: 'unrelated-pending-mint',
      utxoId: 8,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-02T00:00:00Z',
    });
    await db.bitcoinFissionsTable.replaceRecords(
      [record, untouchedRecord].map(lock => ({
        origin: 'lock-migration' as const,
        ownerAccount: accountId,
        fissionId: lock.lockId!,
        liquidId: lock.lockId!,
        lockId: lock.lockId!,
        satoshis: 10_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 1_000n,
        createdAtArgonBlock: 151,
        ratchetNumber: 0,
        lastUpdatedArgonBlock: 151,
        ratchets: [
          {
            source: 'lock' as const,
            sourceRatchetIndex: 0,
            microgonsAtTargetPerBtc: 1_000n,
            liquidityPromised: 1_000n,
            amountMinted: 1_000n,
            amountBurned: 0n,
            mintPending: 1_000n,
            securityFee: 20n,
            txFee: 0n,
            blockNumber: 151,
          },
        ],
        createdAt: lock.createdAt,
        updatedAt: lock.updatedAt,
      })),
    );
    const blockWatch = { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch;
    const store = createStore({
      blockWatch,
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByLockId[7] = record;
    store.data.locksByLockId[8] = untouchedRecord;
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
    const prepared = await store.recovery.prepareHistoryReplay();
    expect(prepared.records).toEqual([
      expect.objectContaining({
        utxoId: 7,
        ratchets: [expect.objectContaining({ mintPending: 0n })],
      }),
    ]);
    expect(record.isHistoryRecoveryPending).toBeUndefined();
    expect(untouchedRecord.isHistoryRecoveryPending).toBeUndefined();

    await store.recovery.cancelHistoryReplay();

    expect(record.isHistoryRecoveryPending).toBeUndefined();
  });
});
