import { afterEach, describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { BitcoinLock, FIXED_U128_DECIMALS, toFixedNumber, TxSubmitter } from '@argonprotocol/mainchain';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import * as vaultStore from '../stores/vaults.ts';
import { numberCodec, optionCodec } from '../../core/__test__/helpers/codecs.ts';
import { createBitcoinLockConfig, createLock, createStore } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';
import { getMainchainClient } from '../stores/mainchain.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));

afterEach(() => vi.useRealTimers());

it('keeps a funding expiration estimate stable until the oracle Bitcoin height changes', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-11T18:00:00Z'));

  const db = await createTestDb();
  const archiveClient = {
    consts: { bitcoinLocks: { argonTicksPerDay: { toNumber: () => 1_440 } } },
    query: {
      bitcoinLocks: {
        utxoIdsByOwnerAccount: { keys: vi.fn(async () => []) },
      },
    },
  };
  const blockWatch = {
    start: async () => undefined,
    events: { on: () => () => undefined },
    bestBlockHeader: { blockNumber: 0, blockHash: '0x0' },
    getFinalizedApi: vi.fn(async () => archiveClient),
  };
  vi.mocked(getMainchainClient).mockResolvedValue(archiveClient as never);
  vi.spyOn(BitcoinLock, 'getConfig').mockResolvedValue(
    createBitcoinLockConfig({ pendingConfirmationExpirationBlocks: 6 }),
  );
  const store = createStore({ blockWatch: blockWatch as never, db });

  await store.load();
  store.data.oracleBitcoinBlockHeight = 100;

  const lock = createLock({
    uuid: 'pending-lock',
    status: BitcoinLockStatus.LockPendingFunding,
    createdAt: '2026-08-11T18:00:00Z',
  });
  const initialExpiration = store.verifyExpirationTime(lock);

  await vi.advanceTimersByTimeAsync(2_000);

  expect(store.verifyExpirationTime(lock)).toBe(initialExpiration);

  store.data.oracleBitcoinBlockHeight = 101;

  expect(store.verifyExpirationTime(lock)).not.toBe(initialExpiration);

  store.unsubscribeFromArgonBlocks();
});

describe('BitcoinLocks ratchet preview', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { operatorAccountId: 'vault-owner', expectedFee: 50n },
    { operatorAccountId: 'bitcoin-owner', expectedFee: 0n },
  ])('calculates costs for vault operator $operatorAccountId', async ({ operatorAccountId, expectedFee }) => {
    const store = createStore();
    const lock = createLock({
      uuid: 'ratchet-preview',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    lock.lockedTargetPrice = 3_000n;
    lock.lockDetails.ownerAccount = 'stale-bitcoin-owner';

    const client = {
      query: {
        bitcoinLocks: {
          locksByUtxoId: vi.fn(async () => ({ isSome: false })),
        },
      },
    };
    const availableSecuritizationSpace = vi.fn(() => 10_000n);
    const vault = {
      operatorAccountId,
      availableSecuritizationSpace,
      securitizationRatioBN: () => BigNumber(1),
    };
    const calculateRatchetingCosts = vi.fn(async () => ({ burnAmount: 1_500n, ratchetingFee: 50n }));
    Object.assign(store, {
      getRatchetContext: async () => ({
        bitcoinLock: {
          lockedTargetPrice: 3_000n,
          liquidityPromised: 3_000n,
          ownerAccount: 'bitcoin-owner',
          calculateRatchetingCosts,
        },
        client,
        vault,
      }),
    });
    vi.spyOn(BitcoinLock, 'calculateRedemptionAmount').mockReturnValue(2_000n);

    const preview = await store.getRatchetPreview(lock);

    expect(calculateRatchetingCosts).toHaveBeenCalledWith(client, expect.anything(), vault, 2_000n);
    expect(availableSecuritizationSpace).toHaveBeenCalledWith('bitcoin-owner');
    expect(preview.ratchetingFee).toBe(expectedFee);
  });

  it('includes the security needed to support the projected flexible ratchet', async () => {
    const store = createStore();
    const lock = createLock({
      uuid: 'flexible-ratchet-preview',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    lock.lockedTargetPrice = 3_000n;

    Object.assign(store, {
      getRatchetContext: async () => ({
        bitcoinLock: {
          calculateRatchetingCosts: async () => ({ burnAmount: 2_000n, ratchetingFee: 0n }),
          isFlexible: true,
          liquidityPromised: 3_000n,
          lockedTargetPrice: 3_000n,
          ownerAccount: 'vault-owner',
        },
        client: {
          query: {
            bitcoinLocks: {
              locksByUtxoId: async () => ({
                isSome: true,
                unwrap: () => ({
                  securitizationRatio: { toBigInt: () => toFixedNumber(1, FIXED_U128_DECIMALS) },
                }),
              }),
            },
          },
        },
        vault: {
          availableSecuritizationSpace: () => 0n,
          flexibleSecuritizationLocked: 6_000n,
          operatorAccountId: 'vault-owner',
          securitization: 5_000n,
          securitizationLocked: 8_000n,
        },
      }),
    });
    vi.spyOn(BitcoinLock, 'calculateRedemptionAmount').mockReturnValue(2_000n);

    const preview = await store.getRatchetPreview(lock);

    expect(preview.securitizationToAdd).toBe(2_000n);
    expect(preview.canRatchet).toBe(true);
  });
});

describe('BitcoinLocks capacity owners', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps vault capacity while rounding the Bitcoin requirement up', async () => {
    const store = createStore();
    vi.spyOn(BitcoinLock, 'calculateRedemptionAmount').mockImplementation((_priceIndex, targetPrice) => targetPrice);

    expect(await store.satoshisForArgonLiquidity(3n, 200_000_000n)).toBe(2n);

    vi.spyOn(store, 'satoshisForArgonLiquidity').mockResolvedValue(301n);
    const capacity = await store.getLockableBitcoinCapacity({
      vault: { availableBitcoinSpace: () => 300n } as never,
      microgonsAtTargetPerBtc: 200_000_000n,
    });

    expect(capacity.availableLiquidityMicrogons).toBe(300n);
    expect(capacity.availableSatoshis).toBe(301n);
  });

  it('uses the prospective owner for lockable capacity', async () => {
    const store = createStore();
    const availableBitcoinSpace = vi.fn(() => 300n);
    vi.spyOn(BitcoinLock, 'satoshisRequiredForRedemptionAmount').mockReturnValue(300n);
    vi.spyOn(BitcoinLock, 'calculateRedemptionAmountFromSatoshis').mockReturnValue(300n);

    const capacity = await store.getLockableBitcoinCapacity({
      vault: { availableBitcoinSpace } as never,
      lockOwner: 'bitcoin-owner',
    });

    expect(availableBitcoinSpace).toHaveBeenCalledWith('bitcoin-owner');
    expect(capacity.vaultCapacityLiquidityMicrogons).toBe(300n);
  });

  it('includes unused space when projecting flexible capacity changes', async () => {
    const store = createStore();
    const availableBitcoinSpace = vi.fn(() => 200n);
    vi.spyOn(BitcoinLock, 'satoshisRequiredForRedemptionAmount').mockImplementation((_priceIndex, microgons) => {
      return microgons;
    });
    vi.spyOn(BitcoinLock, 'calculateRedemptionAmountFromSatoshis').mockImplementation((_priceIndex, satoshis) => {
      return satoshis;
    });

    const capacity = await store.getLockableBitcoinCapacity({
      vault: {
        availableBitcoinSpace,
        reservedSecuritizationSpace: 100n,
        securitization: 1_000n,
        securitizationLocked: 800n,
        securitizationRatioBN: () => BigNumber(1),
      } as never,
      projectedFlexibleSecuritizationLocked: 300n,
    });

    expect(availableBitcoinSpace).not.toHaveBeenCalled();
    expect(capacity.vaultCapacityLiquidityMicrogons).toBe(400n);
  });

  it('uses the existing lock owner for mismatch capacity', () => {
    const store = createStore();
    const availableBitcoinSpace = vi.fn(() => 300n);
    vi.spyOn(vaultStore, 'getVaults').mockReturnValue({
      vaultsById: { 1: { availableBitcoinSpace } },
    } as never);
    const lock = createLock({
      uuid: 'mismatch-capacity',
      utxoId: 7,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-01T00:00:00Z',
    });
    lock.satoshis = 100n;
    lock.liquidityPromised = 100n;
    lock.lockDetails.ownerAccount = 'bitcoin-owner';
    const candidate = { satoshis: 500n } as never;

    expect(store.getUnderSecuritizedMicrogons(lock, candidate)).toBe(100n);
    expect(store.getIncreaseSecuritizationMicrogons(lock, candidate)).toBe(300n);
    expect(availableBitcoinSpace).toHaveBeenNthCalledWith(1, 'bitcoin-owner');
    expect(availableBitcoinSpace).toHaveBeenNthCalledWith(2, 'bitcoin-owner');
  });
});

describe('BitcoinLocks ratchet transaction tracking', () => {
  afterEach(() => vi.restoreAllMocks());

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

  it('atomically adds missing securitization before ratcheting a flexible lock', async () => {
    const waitForFinalizedBlock = new Promise<Uint8Array>(() => undefined);
    const txResult = { waitForFinalizedBlock };
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
    const increaseSecurityTx = { kind: 'increase-security' };
    const ratchetTx = { kind: 'ratchet' };
    const batchTx = { kind: 'batch' };
    const batchAll = vi.fn(() => batchTx);
    const client = {
      query: {
        bitcoinLocks: {
          locksByUtxoId: vi.fn(async () => ({
            isSome: true,
            unwrap: () => ({ securitizationRatio: { toBigInt: () => 0n } }),
          })),
        },
      },
      tx: {
        bitcoinLocks: {
          ratchet: vi.fn(() => ratchetTx),
        },
        vaults: {
          modifyFunding: vi.fn(() => increaseSecurityTx),
        },
        utility: { batchAll },
      },
    };
    const calculateRatchetingCosts = vi.fn(async () => ({ burnAmount: 400n, ratchetingFee: 0n }));
    const getRatchetContext = vi.fn(async () => ({
      bitcoinLock: {
        calculateRatchetingCosts,
        isFlexible: true,
        liquidityPromised: 1_000n,
        lockedTargetPrice: 1_000n,
        ownerAccount: 'owner',
      },
      client,
      vault: {
        availableSecuritizationSpace: () => 0n,
        flexibleSecuritizationLocked: 1_000n,
        operatorAccountId: 'owner',
        securitization: 0n,
        securitizationRatio: 1,
        securitizationLocked: 1_000n,
      },
    }));
    Object.assign(store, { getRatchetContext });
    vi.spyOn(BitcoinLock, 'calculateRedemptionAmount').mockReturnValue(1_000n);
    const canAfford = vi.spyOn(TxSubmitter.prototype, 'canAfford').mockResolvedValue({
      canAfford: true,
      availableBalance: 500n,
      txFee: 1n,
    });
    vi.spyOn(TxSubmitter.prototype, 'submit').mockResolvedValue(txResult as never);

    await expect(store.ratchet(lock, { address: 'owner' } as never)).resolves.toBe(txInfo);
    expect(client.tx.bitcoinLocks.ratchet).toHaveBeenCalledWith(7, {
      V1: { microgonsAtTargetPerBtc: 2_000n },
    });
    expect(client.tx.vaults.modifyFunding).toHaveBeenCalledWith(1, 1_000n, toFixedNumber(1, FIXED_U128_DECIMALS));
    expect(batchAll).toHaveBeenCalledWith([increaseSecurityTx, ratchetTx]);
    expect(canAfford).toHaveBeenCalledWith({
      tip: 0n,
      unavailableBalance: 1_400n,
    });
    expect(getRatchetContext).toHaveBeenCalledOnce();
    expect(trackTxResult).toHaveBeenCalledWith({
      txResult,
      extrinsicType: ExtrinsicType.BitcoinRatchet,
      metadata: { addedSecuritizationMicrogons: 1_000n, utxoId: 7 },
    });
  });
});

describe('BitcoinLocks live state processing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads active pending mint state at the supplied financial block without advancing the settled record', async () => {
    const store = createStore();
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
    vi.spyOn(store.utxoTracking, 'getAcceptedFundingRecordForLock').mockReturnValue({
      id: 1,
      status: BitcoinUtxoStatus.FundingUtxo,
    } as never);
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
    const clientAt = { query: {} } as never;

    const summary = await store.createLockSummaryAt(record, clientAt);

    expect(findPendingMints).toHaveBeenCalledWith(clientAt);
    expect(summary.pendingLiquidity).toBe(0n);
    expect(summary.receivedLiquidity).toBe(1_000n);
    expect(summary.record).not.toBe(record);
    expect(record.ratchets[0].mintPending).toBe(1_000n);
  });

  it('continues settling pending liquidity after a Bitcoin lock is released', async () => {
    const clientAt = {
      query: {
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn(async () => optionCodec({ blockHeight: numberCodec(600) })),
        },
      },
    };
    const previousHeader = { blockNumber: 152, blockHash: '0x152' };
    const blockWatch = {
      getHeaderByBlockNumber: vi.fn(async () => previousHeader),
      getEventsWithSpec: vi.fn(async () => ({ api: clientAt, events: [], specVersion: 157 })),
    };
    const store = createStore({ blockWatch: blockWatch as never });
    const record = createLock({
      uuid: 'released-with-pending-liquidity',
      utxoId: 7,
      status: BitcoinLockStatus.Released,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.removalReason = 'released';
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
    store.data.locksByUtxoId[7] = record;
    store.data.oracleBitcoinBlockHeight = 600;
    vi.spyOn(store, 'getTable').mockResolvedValue({ updateMintState: vi.fn(async () => undefined) } as never);
    vi.spyOn(store.utxoTracking, 'syncArgonOrphans').mockResolvedValue([]);
    vi.spyOn(store.utxoTracking, 'getAcceptedFundingRecordForLock').mockReturnValue({
      id: 1,
      status: BitcoinUtxoStatus.ReleaseComplete,
    } as never);
    vi.spyOn(BitcoinLock.prototype, 'findPendingMints').mockResolvedValue([400n]);

    await (
      store as unknown as {
        checkIncomingArgonBlock: (header: { blockNumber: number; blockHash: string }) => Promise<void>;
      }
    ).checkIncomingArgonBlock({ blockNumber: 153, blockHash: '0x153' });

    expect(record.ratchets[0].mintPending).toBe(400n);
  });
});
