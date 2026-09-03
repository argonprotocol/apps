import { afterEach, describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { BitcoinLock, type Currency, type TxSigningAccount } from '@argonprotocol/apps-core';
import { type TransactionTracker, TxAttemptState } from '../lib/TransactionTracker.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import * as vaultStore from '../stores/vaults.ts';
import { createBitcoinLockConfig, createLock, createStore } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import type { IBitcoinRequestLockMetadata } from '../lib/BitcoinLocks.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { BitcoinLockCreate } from '../lib/txs/BitcoinLock.create.ts';

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
    vi.spyOn(store, 'getInitializePreviewPubkey').mockResolvedValue({
      ownerBitcoinPubkey: new Uint8Array(33).fill(2),
    } as never);
    const operation = new BitcoinLockCreate(
      store,
      {} as TransactionTracker,
      { priceIndex: {} } as Currency,
      {} as UpstreamOperatorClient,
    );

    const estimate = await operation.preview({
      vault: { vaultId: 12 } as never,
      satoshis: 10_000n,
      txSigner: { address: walletKeys.liquidLockingAddress } as TxSigningAccount,
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
      createIntentForFollowOnTx: () => ({ resolve: vi.fn(), reject: vi.fn() }),
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
    const store = createStore({ db, transactionTracker, walletKeys });
    vi.spyOn(store, 'load').mockResolvedValue();
    vi.spyOn(store, 'minimumSatoshiPerLock').mockResolvedValue(1n);
    vi.spyOn(store, 'argonLiquidityForSatoshis').mockReturnValue(4_000n);
    vi.spyOn(store, 'getInitializePreviewPubkey').mockResolvedValue({
      ownerBitcoinPubkey: new Uint8Array(33).fill(2),
    } as never);
    vi.spyOn(store, 'allocateUtxoPubkey').mockResolvedValue({
      ownerBitcoinPubkey: new Uint8Array(33).fill(3),
      hdPath: '//Bitcoin//0',
    } as never);
    const operation = new BitcoinLockCreate(
      store,
      transactionTracker,
      {
        priceIndex: {
          btcUsdPrice: BigNumber(1),
          getSatoshiPriceInTargetMicrogons: () => 80_000_000n,
        },
      } as unknown as Currency,
      upstreamOperatorClient,
    );

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
      operation.submit({
        vault: {
          vaultId,
          calculateBitcoinFee: () => 410n,
          terms: { bitcoinBaseFee: 10n },
        } as never,
        satoshis: pendingInitialization.requestedSatoshis + 1n,
        txSigner: { address: walletKeys.liquidLockingAddress } as TxSigningAccount,
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
      hasPendingPostProcessing: true,
      txResult: {},
      tx: {
        id: 7,
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

    await expect(initialize()).resolves.toBe(existingAttempt.txInfo);

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
});
