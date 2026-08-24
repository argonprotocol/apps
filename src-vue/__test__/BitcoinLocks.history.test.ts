import { describe, expect, it, vi } from 'vitest';
import type { BlockWatch } from '@argonprotocol/apps-core';
import { BitcoinLock, hexToU8a } from '@argonprotocol/mainchain';
import { encodeAddress } from '@polkadot/util-crypto';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { bigintCodec, numberCodec, optionCodec } from '../../core/__test__/helpers/codecs.ts';
import { createLock, createStore, createHistoricalLock, historyBlock, historyEvent } from './helpers/bitcoin.ts';
import * as BitcoinLockHistory from '../lib/recovery/BitcoinLockHistory.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));
vi.mock('../lib/recovery/BitcoinLockHistory.ts', () => ({
  getHistoricalBitcoinLock: vi.fn(),
}));

describe('BitcoinLocks historical event replay', () => {
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
    const fundingRecordId = 1;
    const fundingRecord = { id: fundingRecordId, status: BitcoinUtxoStatus.FundingCandidate } as never;
    vi.spyOn(store.utxoTracking, 'getAcceptedFundingRecordForLock').mockImplementation(lock => {
      return lock.fundingUtxoRecord;
    });
    vi.spyOn(store.utxoTracking, 'upsertUtxoRecord').mockResolvedValue(fundingRecord);
    vi.spyOn(store.utxoTracking, 'setAcceptedFundingRecordForLock').mockImplementation(async (lock, funding) => {
      lock.fundingUtxoRecordId = funding.id;
      lock.fundingUtxoRecord = funding;
    });
    const setReleaseRequest = vi.spyOn(store.utxoTracking, 'setReleaseRequest').mockImplementation(async funding => {
      funding.status = BitcoinUtxoStatus.ReleaseIsProcessingOnArgon;
    });
    vi.spyOn(store.utxoTracking, 'setReleaseCosign').mockImplementation(async (funding, cosign) => {
      Object.assign(funding, cosign);
    });
    const createdLock = new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_000n }));
    const verifiedLock = new BitcoinLock({
      ...createHistoricalLock({ accountId, liquidityPromised: 900n, lockedTargetPrice: 900n }),
      utxoSatoshis: 9_900n,
    });
    const ratchetedLock = new BitcoinLock(
      createHistoricalLock({ accountId, liquidityPromised: 1_200n, lockedTargetPrice: 1_300n }),
    );
    const twiceRatchetedLock = new BitcoinLock(
      createHistoricalLock({ accountId, liquidityPromised: 1_400n, lockedTargetPrice: 1_500n }),
    );
    const record = createLock({
      uuid: 'recovered',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.lockDetails = new BitcoinLock({
      ...createHistoricalLock({ accountId, liquidityPromised: 9_000n }),
      utxoId: 41,
    });
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
    const table = {
      getByUtxoId: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(record),
      saveRecoveredHistory: vi.fn(async () => undefined),
      setFundingUtxoRecordId: vi.fn(async (lock: IBitcoinLockRecord, fundingUtxoRecordId: number) => {
        lock.fundingUtxoRecordId = fundingUtxoRecordId;
      }),
      updateMintState: vi.fn(async () => undefined),
      recordReleaseRequest: vi.fn(async (lock: IBitcoinLockRecord, facts: Partial<IBitcoinLockRecord>) => {
        Object.assign(lock, facts, { status: BitcoinLockStatus.Releasing });
      }),
      recordReleaseCosign: vi.fn(async (lock: IBitcoinLockRecord, facts: Partial<IBitcoinLockRecord>) => {
        Object.assign(lock, facts);
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
    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce(createdLock)
      .mockResolvedValueOnce(verifiedLock);
    vi.spyOn(BitcoinLock, 'get').mockResolvedValueOnce(ratchetedLock).mockResolvedValueOnce(twiceRatchetedLock);
    vi.spyOn(BitcoinLock.prototype, 'getFundingUtxoRef')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ txid: 'funding-txid', bitcoinTxid: 'funding-txid', vout: 0 });
    vi.spyOn(BitcoinLock.prototype, 'findPendingMints').mockResolvedValueOnce([]).mockResolvedValue([100n]);
    vi.spyOn(BitcoinLock.prototype, 'getReleaseRequest').mockResolvedValue({
      toScriptPubkey: '0x0014',
      bitcoinNetworkFee: 8n,
      dueFrame: 20,
      vaultId: 1,
      redemptionAmount: 900n,
    });
    const ownerLockKeys = vi.fn(async () => [{ args: [{}, numberCodec(7)] }, { args: [{}, numberCodec(8)] }]);
    const activeLocks = vi.fn(async () => [
      optionCodec({
        liquidityPromised: bigintCodec(1_400n),
        lockedTargetPrice: bigintCodec(1_500n),
      }),
      optionCodec({
        liquidityPromised: bigintCodec(2_000n),
        lockedTargetPrice: bigintCodec(2_000n),
      }),
    ]);
    const api = {
      query: {
        ticks: { currentTick: vi.fn(async () => numberCodec(700)) },
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn(async () => optionCodec({ blockHeight: numberCodec(600) })),
        },
        bitcoinLocks: {
          utxoIdsByOwnerAccount: { keys: ownerLockKeys },
          locksByUtxoId: { multi: activeLocks },
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

    const recovered = store.data.locksByUtxoId[7];
    expect(recovered).toBe(record);
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
    expect(table.setFundingUtxoRecordId).toHaveBeenCalledWith(expect.anything(), fundingRecordId);
    expect(table.recordReleaseCosign).toHaveBeenCalledOnce();
    expect(setReleaseRequest).toHaveBeenCalledOnce();
    expect(table.saveRecoveredHistory).toHaveBeenCalledTimes(4);
    expect(table.updateMintState).toHaveBeenCalledTimes(2);
    await expect(store.recovery.findMissingActiveLockIds(api as never)).resolves.toEqual([8]);
    expect(ownerLockKeys).toHaveBeenCalledWith(accountId);
    expect(activeLocks).toHaveBeenCalledWith([7, 8]);
  });

  it('rebuilds current snapshot economics before replaying historical ratchets', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const api = {
      query: {
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn(async () => optionCodec({ blockHeight: numberCodec(600) })),
        },
        bitcoinLocks: {
          utxoIdsByOwnerAccount: { keys: vi.fn(async () => [{ args: [{}, numberCodec(7)] }]) },
          locksByUtxoId: {
            multi: vi.fn(async () => [
              optionCodec({ liquidityPromised: bigintCodec(1_400n), lockedTargetPrice: bigintCodec(1_500n) }),
            ]),
          },
        },
      },
    };
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => api) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    const record = createLock({
      uuid: 'pre-funding-history',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndIsMinting,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.liquidityPromised = 1_400n;
    record.lockedTargetPrice = 1_500n;
    record.lockDetails = new BitcoinLock({
      ...createHistoricalLock({ accountId, liquidityPromised: 1_400n, lockedTargetPrice: 1_500n }),
      utxoId: 7,
    });
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

    const table = {
      getByUtxoId: vi.fn(async () => record),
      saveRecoveredHistory: vi.fn(async () => undefined),
    };
    vi.spyOn(store, 'getTable').mockResolvedValue(table as never);
    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce(
        new BitcoinLock({
          ...createHistoricalLock({ accountId, liquidityPromised: 1_000n, lockedTargetPrice: 1_000n }),
          isFunded: false,
        }),
      )
      .mockResolvedValueOnce(
        new BitcoinLock({
          ...createHistoricalLock({ accountId, liquidityPromised: 1_050n, lockedTargetPrice: 1_050n }),
          satoshis: 10_500n,
        }),
      );
    vi.spyOn(BitcoinLock.prototype, 'getFundingUtxoRef').mockResolvedValue(undefined);
    vi.spyOn(BitcoinLock, 'get')
      .mockResolvedValueOnce(
        new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_200n, lockedTargetPrice: 1_300n })),
      )
      .mockResolvedValueOnce(
        new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_400n, lockedTargetPrice: 1_500n })),
      );

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

    expect(record.ratchets[0].liquidityPromised).toBeUndefined();

    await store.recovery.recoverBlock(historyBlock(153), [
      historyEvent(157, 'bitcoinLocks', 'UtxoFundedFromCandidate', {
        utxoId: 7,
        utxoRef: { txid: `0x${'44'.repeat(32)}`, outputIndex: 2 },
        vaultId: 1,
        accountId,
      }),
    ]);

    expect(record).toMatchObject({
      status: BitcoinLockStatus.LockedAndIsMinting,
      satoshis: 10_500n,
      liquidityPromised: 1_050n,
      lockedTargetPrice: 1_050n,
    });
    expect(record.ratchets[0]).toMatchObject({
      mintAmount: 1_050n,
      mintPending: 1_050n,
      lockedTargetPrice: 1_050n,
    });

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

    expect(record.ratchets).toEqual([
      expect.objectContaining({ mintAmount: 1_050n, lockedTargetPrice: 1_050n }),
      expect.objectContaining({ mintAmount: 150n, lockedTargetPrice: 1_300n }),
      expect.objectContaining({ mintAmount: 200n, lockedTargetPrice: 1_500n }),
    ]);
    await expect(store.recovery.findMissingActiveLockIds(api as never)).resolves.toEqual([]);

    expect(table.saveRecoveredHistory).toHaveBeenCalledTimes(4);
  });

  it('expires an unfunded lock when its UTXO is no longer watched', async () => {
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
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async () => record),
      setLockExpiredWaitingForFunding: vi.fn(async (lock: IBitcoinLockRecord) => {
        lock.status = BitcoinLockStatus.LockExpiredWaitingForFunding;
      }),
    } as never);
    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock).mockResolvedValue(undefined);

    await store.recovery.recoverBlock(historyBlock(157), [
      historyEvent(157, 'bitcoinUtxos', 'UtxoUnwatched', { utxoId: 7 }),
    ]);

    expect(record.status).toBe(BitcoinLockStatus.LockExpiredWaitingForFunding);
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
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.liquidityPromised = 1_000n;
    record.lockedTargetPrice = 1_000n;
    record.lockDetails = new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_000n }));
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
    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock).mockResolvedValue(
      new BitcoinLock({
        ...createHistoricalLock({ accountId, liquidityPromised: recoveredLiquidity }),
        isFlexible: isBackfill,
      }),
    );
    const unknownEvent = historyEvent(157, 'bitcoinLocks', 'BitcoinLockBackfillChanged', {
      utxoId: 7,
      vaultId: 1,
      isBackfill,
    });
    unknownEvent.event.method = method;

    const replay = store.recovery.recoverBlock(historyBlock(157), [unknownEvent]);
    if (expectedError) {
      await expect(replay).rejects.toThrow(expectedError);
      return;
    }

    await expect(replay).resolves.toBeUndefined();
    expect(record.lockDetails.isFlexible).toBe(true);
    expect(saveRecoveredHistory).toHaveBeenCalledWith(record);
  });

  it('replays a flexibility change without replacing later lock economics', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
    });
    const record = createLock({
      uuid: 'flexibility-change',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.liquidityPromised = 1_100n;
    record.lockedTargetPrice = 1_100n;
    record.lockDetails = new BitcoinLock(
      createHistoricalLock({ accountId, liquidityPromised: 1_100n, lockedTargetPrice: 1_100n }),
    );
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
    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock).mockResolvedValue(
      new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_000n })),
    );
    const event = historyEvent(158, 'bitcoinLocks', 'BitcoinLockFlexibleChanged', {
      utxoId: 7,
      vaultId: 1,
      isFlexible: true,
    });

    await expect(store.recovery.recoverBlock(historyBlock(200), [event])).resolves.toBeUndefined();

    expect(record.lockDetails.isFlexible).toBe(true);
    expect(record.liquidityPromised).toBe(1_100n);
    expect(record.lockedTargetPrice).toBe(1_100n);
    expect(saveRecoveredHistory).toHaveBeenCalledWith(record);
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

  it('recovers a pre-158 promise reset but rejects the regression in newer history', async () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(0x42));
    const record = createLock({
      uuid: 'legacy-up-ratchet',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
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
          confirmedBitcoinBlockTip: vi.fn(async () => optionCodec({ blockHeight: numberCodec(600) })),
        },
        priceIndex: {
          current: vi.fn(async () =>
            optionCodec({
              btcUsdPrice: bigintCodec(1_000_000_000_000_000_000n),
              argonotUsdPrice: bigintCodec(1_000_000_000_000_000_000n),
              argonUsdPrice: bigintCodec(500_000_000_000_000_000n),
              argonUsdTargetPrice: bigintCodec(1_000_000_000_000_000_000n),
              argonTimeWeightedAverageLiquidity: bigintCodec(1_000_000_000_000_000_000n),
              tick: numberCodec(152),
            }),
          ),
        },
        bitcoinLocks: {
          utxoIdsByOwnerAccount: { keys: vi.fn(async () => [{ args: [{}, numberCodec(7)] }]) },
          locksByUtxoId: {
            multi: vi.fn(async () => [
              optionCodec({ liquidityPromised: bigintCodec(800n), lockedTargetPrice: bigintCodec(1_400n) }),
            ]),
          },
        },
      },
    };
    const newerApi = { ...api, runtimeVersion: { specVersion: numberCodec(158) } };
    const store = createStore({
      blockWatch: {
        getApi: vi.fn().mockResolvedValueOnce(api).mockResolvedValueOnce(newerApi),
      } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    const saveRecoveredHistory = vi.fn(async () => undefined);
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async () => record),
      saveRecoveredHistory,
    } as never);
    vi.spyOn(BitcoinLock, 'get').mockResolvedValue(
      new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 800n, lockedTargetPrice: 1_400n })),
    );

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

    const recovered = store.data.locksByUtxoId[7];
    expect(recovered).toMatchObject({ liquidityPromised: 800n, lockedTargetPrice: 1_400n });
    expect(recovered.ratchets.at(-1)).toMatchObject({
      mintAmount: 540n,
      mintPending: 540n,
      liquidityPromised: 800n,
      lockedTargetPrice: 1_400n,
    });
    await expect(store.recovery.findMissingActiveLockIds(api as never)).resolves.toEqual([]);
    expect(saveRecoveredHistory).toHaveBeenCalledWith(recovered);

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
    expect(store.data.locksByUtxoId[7]).toBe(recovered);
    expect(saveRecoveredHistory).toHaveBeenCalledTimes(1);
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
      findPendingByHdPath: vi.fn(async () => pending),
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
    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock).mockResolvedValue(chainLock);
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

    await store.recovery.beginHistoryReplay();
    await store.recovery.recoverBlock(historyBlock(153), [
      historyEvent(153, 'mint', 'BitcoinMint', { accountId, utxoId: null, amount: 1_000n }),
    ]);

    expect(findPendingMints).toHaveBeenCalledTimes(2);
    expect(store.data.locksByUtxoId[7].ratchets[0].mintPending).toBe(1_000n);
    expect(record.isHistoryRecoveryPending).toBeUndefined();
    expect(untouchedRecord.isHistoryRecoveryPending).toBeUndefined();

    await store.recovery.commitHistoryReplay(false);

    expect(store.data.locksByUtxoId[7].ratchets[0].mintPending).toBe(1_000n);
    expect(record.isHistoryRecoveryPending).toBeUndefined();
  });
});
