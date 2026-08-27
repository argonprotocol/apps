import { afterEach, describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { createDeferred, BitcoinLock, TxSubmitter } from '@argonprotocol/apps-core';
import { FIXED_U128_DECIMALS, toFixedNumber } from '@argonprotocol/mainchain';
import { type TransactionTracker, TxAttemptState } from '../lib/TransactionTracker.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import * as vaultStore from '../stores/vaults.ts';
import { createBitcoinLockConfig, createLock, createStore } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import type { IBitcoinRequestLockMetadata } from '../lib/BitcoinLocks.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));

afterEach(() => vi.useRealTimers());

describe('BitcoinLocks fee coupon recovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('estimates the full wallet balance needed before initializing with a fee waiver', async () => {
    const walletKeys = createMockWalletKeys('//FeeCouponEstimate');
    const store = createStore({ walletKeys });
    const client = {
      consts: { balances: { existentialDeposit: { toBigInt: () => 5n } } },
    };
    vi.mocked(getMainchainClient).mockResolvedValue(client as never);
    vi.spyOn(BitcoinLock, 'createInitializeTx').mockResolvedValue({
      tx: {} as never,
      securityFee: 70n,
      txFeePlusTip: 3n,
      availableBalance: 0n,
      canAfford: false,
    });

    const estimate = await store.getInitializeFeeEstimate({
      vault: { vaultId: 12 } as never,
      satoshis: 10_000n,
      microgonsAtTargetPerBtc: 80_000_000n,
      feeDiscountMicrogons: 68n,
    });

    expect(estimate).toMatchObject({
      canAfford: false,
      requiredWalletBalanceMicrogons: 10n,
      securityFee: 2n,
      txFeePlusTip: 3n,
    });
  });

  it('reauthorizes a durable initialization after restart and reaches submission after wallet funding', async () => {
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys('//FeeCouponRecovery');
    const existingAttempt = {
      state: TxAttemptState.Pending,
      txInfo: undefined as TransactionInfo<IBitcoinRequestLockMetadata> | undefined,
    };
    const submitAndWatch = vi.fn(async () => {
      throw new Error('submission boundary reached');
    });
    const transactionTracker = Object.assign(Object.create(null), {
      data: { txInfos: [], txInfosByType: {} },
      findLatestTxAttempt: async (args: {
        matches: (candidate: TransactionInfo<IBitcoinRequestLockMetadata>) => boolean;
      }) => {
        const { txInfo } = existingAttempt;
        if (!txInfo || !args.matches(txInfo)) return;
        return { txInfo, txAttemptState: existingAttempt.state };
      },
      load: async () => undefined,
      pendingBlockTxInfosAtLoad: [],
      submitAndWatch,
    }) as TransactionTracker;
    let upstreamSupportsFeeCoupons = true;
    const initializeBitcoinLock = vi.fn(async (_offerCode: string, request: { requestId: string }) => {
      if (!upstreamSupportsFeeCoupons) return { bitcoinLock: {} as never };

      return {
        bitcoinLock: {} as never,
        execution: {
          type: 'FeeCoupon' as const,
          requestId: request.requestId,
          feeCoupon,
        },
      };
    });
    const upstreamOperatorClient = Object.assign(Object.create(null), {
      initializeBitcoinLock,
      recordBitcoinLockFeeCouponUse: async () => undefined,
    }) as UpstreamOperatorClient;
    const store = createStore({ db, transactionTracker, upstreamOperatorClient, walletKeys });
    vi.spyOn(store, 'load').mockResolvedValue();
    vi.spyOn(store, 'minimumSatoshiPerLock').mockResolvedValue(1n);
    vi.spyOn(store, 'argonLiquidityForSatoshis').mockReturnValue(4_000n);

    const vaultId = 12;
    const feeCoupon = {
      feeDiscount: 400n,
      securitizationSpaceToUnreserve: 0n,
      expiresAtFrame: 1_000n,
      nonce: 1n,
      signature: '0xsignature',
    };
    const pendingInitialization = {
      id: 1,
      couponId: 1,
      requestId: 'lock-1',
      status: 'Prepared' as const,
      feeCreditMicrogons: 400n,
      requestedSatoshis: 10_000n,
      ownerAccountId: walletKeys.liquidLockingAddress,
      ownerBitcoinPubkey: '0x1234',
      microgonsAtTargetPerBtc: 75_000_000n,
      feeCoupon,
      createdAt: new Date('2026-08-13T12:00:00Z'),
      updatedAt: new Date('2026-08-13T12:00:00Z'),
    };
    const client = {
      consts: { balances: { existentialDeposit: { toBigInt: () => 5n } } },
      query: { bitcoinLocks: { minimumSatoshis: async () => 1n } },
      tx: { bitcoinLocks: { initialize: vi.fn() } },
    };
    vi.mocked(getMainchainClient).mockResolvedValue(client as never);

    let canAfford = false;
    const createInitializeTx = vi.spyOn(BitcoinLock, 'createInitializeTx').mockImplementation(async args => ({
      tx: {} as never,
      securityFee: args.feeCoupon ? 10n : 410n,
      txFeePlusTip: 1n,
      availableBalance: canAfford ? 16n : 15n,
      canAfford,
      feeCoupon: args.feeCoupon,
    }));
    const initialize = () =>
      store.initializeLock({
        vault: {
          vaultId,
          calculateBitcoinFee: () => 410n,
          terms: { bitcoinBaseFee: 10n },
        } as never,
        satoshis: pendingInitialization.requestedSatoshis + 1n,
        microgonsAtTargetPerBtc: 80_000_000n,
        operatorCoupon: {
          vaultId,
          offerCode: 'offer-code',
          accountId: walletKeys.liquidLockingAddress,
          remainingFeeCreditMicrogons: 600n,
          pendingInitialization,
        } as never,
      });

    await expect(initialize()).rejects.toMatchObject({
      requiredWalletBalanceMicrogons: 16n,
    });
    expect(createInitializeTx).toHaveBeenLastCalledWith(
      expect.objectContaining({
        satoshis: pendingInitialization.requestedSatoshis + 1n,
        microgonsAtTargetPerBtc: 80_000_000n,
      }),
    );
    expect(initializeBitcoinLock).not.toHaveBeenCalled();

    canAfford = true;
    upstreamSupportsFeeCoupons = false;
    await expect(initialize()).rejects.toMatchObject({
      status: 426,
      code: 'UPSTREAM_UPGRADE_REQUIRED',
    });
    expect(submitAndWatch).not.toHaveBeenCalled();

    upstreamSupportsFeeCoupons = true;
    await expect(initialize()).rejects.toThrow('submission boundary reached');
    expect(initializeBitcoinLock).toHaveBeenCalledWith(
      'offer-code',
      expect.objectContaining({
        requestId: pendingInitialization.requestId,
        feeCouponNonce: pendingInitialization.feeCoupon.nonce,
        requestedSatoshis: pendingInitialization.requestedSatoshis + 1n,
        microgonsAtTargetPerBtc: 80_000_000n,
      }),
    );

    const pendingLock = createLock({
      uuid: pendingInitialization.requestId,
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      createdAt: '2026-08-13T12:05:00Z',
    });
    store.data.pendingLocks.push(pendingLock);
    existingAttempt.txInfo = {
      tx: {
        accountAddress: walletKeys.liquidLockingAddress,
        extrinsicType: ExtrinsicType.BitcoinRequestLock,
        metadataJson: {
          bitcoin: {
            uuid: pendingInitialization.requestId,
            vaultId,
            satoshis: pendingInitialization.requestedSatoshis + 1n,
            hdPath: '//Bitcoin//0',
            lockedTargetPrice: 80_000_000n,
            liquidityPromised: 4_000n,
            securityFee: 10n,
            feeCouponNonce: pendingInitialization.feeCoupon.nonce,
            feeCouponRequestId: 'previous-router-request',
          },
        },
      },
    } as TransactionInfo<IBitcoinRequestLockMetadata>;

    await expect(initialize()).resolves.toEqual({ pendingLock, txInfo: existingAttempt.txInfo });

    existingAttempt.state = TxAttemptState.Replace;
    store.data.pendingLocks.splice(store.data.pendingLocks.indexOf(pendingLock), 1);
    await expect(initialize()).rejects.toThrow('submission boundary reached');
    expect(submitAndWatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: {
          bitcoin: expect.objectContaining({
            feeCouponNonce: pendingInitialization.feeCoupon.nonce,
            feeCouponRequestId: pendingInitialization.requestId,
            uuid: expect.not.stringContaining(pendingInitialization.requestId),
          }),
        },
      }),
    );
  });
});

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
          locksByUtxoId: vi.fn(async () => null),
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

    const preview = await store.getRatchetPreview(lock, 2_000n);

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
              locksByUtxoId: async () => ({ securitizationRatio: BigNumber(1) }),
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

    const preview = await store.getRatchetPreview(lock, 2_000n);

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

  it('keeps a ratchet pending from submission through post-processing', async () => {
    const pendingTxInfo = {
      tx: {
        extrinsicType: ExtrinsicType.BitcoinRatchet,
        metadataJson: { utxoId: 7 },
        status: TransactionStatus.Submitted,
        isFinalized: false,
      },
      txResult: {},
      isPostProcessed: true,
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

    await expect(store.ratchet(lock, { address: 'owner' } as never, 2_000n)).resolves.toBe(pendingTxInfo);

    pendingTxInfo.tx.status = TransactionStatus.Finalized;
    pendingTxInfo.tx.isFinalized = true;
    pendingTxInfo.isPostProcessed = false;
    expect(store.getPendingRatchetTxInfo(lock)).toBe(pendingTxInfo);

    pendingTxInfo.isPostProcessed = true;
    expect(store.getPendingRatchetTxInfo(lock)).toBeUndefined();
  });

  it('atomically adds missing securitization and saves the finalized ratchet from tracked events', async () => {
    const finalization = createDeferred<Uint8Array>();
    const postProcessing = createDeferred<void>(false);
    const ratchetEvent = {
      section: 'bitcoinLocks',
      method: 'BitcoinLockRatcheted',
      data: {
        amountBurned: 100n,
        liquidityPromised: 1_300n,
        newTargetPrice: 1_300n,
        oldTargetPrice: 1_000n,
        securityFee: 50n,
      },
    };
    const txResult = {
      blockNumber: 220,
      events: [ratchetEvent],
      extrinsicIndex: 3,
      finalFee: 25n,
      waitForFinalizedBlock: finalization.promise,
    };
    const txInfo = {
      tx: {
        id: 12,
        extrinsicType: ExtrinsicType.BitcoinRatchet,
        isFinalized: false,
        metadataJson: { utxoId: 7 },
      },
      txResult,
      get isPostProcessed() {
        return postProcessing.isSettled;
      },
      get hasPendingPostProcessing() {
        return !postProcessing.isSettled && postProcessing.isRunning;
      },
      createPostProcessor: () => {
        postProcessing.setIsRunning(true);
        return postProcessing;
      },
    };
    const trackTxResult = vi.fn(async () => txInfo);
    const transactionTracker = Object.assign(Object.create(null), {
      data: { txInfos: [], txInfosByType: {} },
      ensureStoredEvents: vi.fn(async () => undefined),
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
    lock.liquidityPromised = 1_000n;
    lock.lockedTargetPrice = 1_000n;
    lock.ratchets.push({
      mintAmount: 1_000n,
      mintPending: 0n,
      liquidityPromised: 1_000n,
      lockedTargetPrice: 1_000n,
      securityFee: 0n,
      txFee: 10n,
      burned: 0n,
      blockHeight: 100,
      extrinsicIndex: 1,
      oracleBitcoinBlockHeight: 400,
    });
    const increaseSecurityTx = { kind: 'increase-security' };
    const ratchetTx = { kind: 'ratchet' };
    const batchTx = { kind: 'batch' };
    const batchAll = vi.fn(() => batchTx);
    const client = {
      query: {
        bitcoinLocks: {
          locksByUtxoId: vi.fn(async () => ({ securitizationRatio: BigNumber(0) })),
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
    const durableWrite = createDeferred<void>();
    const saveNewRatchet = vi.fn(() => durableWrite.promise);
    Object.assign(store, { getRatchetContext, getTable: async () => ({ saveNewRatchet }) });
    vi.spyOn(BitcoinLock, 'calculateRedemptionAmount').mockReturnValue(1_000n);
    const canAfford = vi.spyOn(TxSubmitter.prototype, 'canAfford').mockResolvedValue({
      canAfford: true,
      availableBalance: 500n,
      txFee: 1n,
    });
    vi.spyOn(TxSubmitter.prototype, 'submit').mockResolvedValue(txResult as never);

    await expect(store.ratchet(lock, { address: 'owner' } as never, 3_000n)).resolves.toBe(txInfo);
    expect(client.tx.bitcoinLocks.ratchet).toHaveBeenCalledWith(7, {
      V1: { microgonsAtTargetPerBtc: 3_000n },
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

    const api = {
      query: {
        bitcoinUtxos: {
          confirmedBitcoinBlockTip: vi.fn(async () => ({ blockHeight: 450 })),
        },
      },
    };
    const eventClient = {
      at: vi.fn(async () => api),
      events: { bitcoinLocks: { BitcoinLockRatcheted: { is: (event: unknown) => event === ratchetEvent } } },
    };
    vi.mocked(getMainchainClient).mockResolvedValue(eventClient as never);
    vi.spyOn(BitcoinLock, 'get').mockResolvedValue({
      ...lock.lockDetails,
      couponFeesPaid: 0n,
      liquidityPromised: 1_300n,
      lockedTargetPrice: 1_300n,
    } as never);

    finalization.resolve(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(saveNewRatchet).toHaveBeenCalledOnce());

    expect(lock.ratchets).toHaveLength(1);
    expect(lock.liquidityPromised).toBe(1_000n);
    expect(lock.lockedTargetPrice).toBe(1_000n);

    durableWrite.resolve();
    await postProcessing.promise;

    expect(lock.ratchets.at(-1)).toEqual({
      mintAmount: 300n,
      mintPending: 300n,
      liquidityPromised: 1_300n,
      lockedTargetPrice: 1_300n,
      txFee: 25n,
      burned: 100n,
      securityFee: 50n,
      blockHeight: 220,
      extrinsicIndex: 3,
      oracleBitcoinBlockHeight: 450,
    });
    expect(lock.liquidityPromised).toBe(1_300n);
    expect(lock.lockedTargetPrice).toBe(1_300n);
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
          confirmedBitcoinBlockTip: vi.fn(async () => ({ blockHeight: 600 })),
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
