import { getHistoricalBitcoinFissions } from '../lib/recovery/BitcoinFissions.ts';
import { getHistoricalBitcoinLockDetails } from '../lib/recovery/BitcoinLockHistory.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { decorateConstants } from '@polkadot/types/metadata/decorate';
import { getBundledMetadata, runtimeClient } from '@argonprotocol/runtime-client';
import {
  BitcoinLock,
  Currency,
  type ArgonCurrentQueryClient,
  type ArgonApi,
  type MainchainClients,
  type TxSigningAccount,
  Vault,
} from '@argonprotocol/apps-core';
import { type TransactionTracker, TxAttemptState } from '../lib/TransactionTracker.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import * as vaultStore from '../stores/vaults.ts';
import { createBitcoinLockConfig, createLock, createStore } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import BitcoinLocks, { BitcoinLockWalletFundingError, type IBitcoinRequestLockMetadata } from '../lib/BitcoinLocks.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { BitcoinLockCreate } from '../lib/txs/BitcoinLock.create.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));

afterEach(() => vi.useRealTimers());

describe('saved Bitcoin Lock inclusion snapshots', () => {
  it.each([159, 160, 161])('decodes runtime %s Lock and Fission storage through historical readers', async spec => {
    const registry = new TypeRegistry();
    const metadata = new Metadata(
      registry,
      Object.entries(getBundledMetadata()).find(([key]) => key.endsWith(`-${spec}`))![1],
    );
    registry.setMetadata(metadata);
    const record = registry.createType('Option<PalletBitcoinLocksLockedBitcoin>', {
      vaultId: 7,
      ownerAccount: new Uint8Array(32).fill(17),
      fundedSatoshis: 3n,
      fissionedSatoshis: 1n,
      fundingUtxos: new Map([[{ txid: `0x${'22'.repeat(32)}`, outputIndex: 0 }, 3n]]),
      cosignerGuarantee: {
        basis: { satoshis: 3n, microgonsAtTargetPerBtc: 1_000n, tick: 12 },
        guaranteedMicrogons: 31n,
        fundHoldExtensions: {},
      },
      securitizationBasis: { satoshis: 3n, microgonsAtTargetPerBtc: 1_000n },
      securitizationCoverageMicrogons: 31n,
      securitizationRatio: 1_500_000_000_000_000_000n,
      securitizationTick: 12,
      fundHoldExtensions: {},
      securitizationHoldExpirationBitcoinHeight: spec < 161 ? 144 : null,
    });
    const fissionRecord = registry.createType('Option<PalletBitcoinFissionsFission>', {
      lockId: 4,
      liquidId: 12,
      satoshis: 1n,
      liquidityPromised: 10n,
      ratchetNumber: 1,
      cosignerGuarantee: {
        basis: { satoshis: 1n, microgonsAtTargetPerBtc: 1_000n, tick: 12 },
        guaranteedMicrogons: 10n,
        fundHoldExtensions: {},
      },
    });
    const ownerAccount = registry.createType('AccountId32', new Uint8Array(32).fill(17)).toString();
    const api = runtimeClient({
      registry,
      query: {
        bitcoinLocks: { locksById: async () => record },
        bitcoinFissions: {
          fissionByOwnerAndId: { entries: async () => [[{ args: [ownerAccount, 3] }, fissionRecord]] },
        },
      },
    }) as unknown as ArgonApi;
    const lock = await getHistoricalBitcoinLockDetails(api, 4);
    expect(lock?.fundingUtxos[0].satoshis).toBe(3n);
    expect(lock?.fissionedSatoshis).toBe(1n);
    expect(lock?.securitizedSatoshis).toBe(spec < 161 ? 3n : 2n);
    expect(lock?.securitizationCoverageMicrogons).toBe(spec < 161 ? 31n : 20n);
    expect(lock?.securitizationHoldExpirationBitcoinHeight).toBe(spec < 161 ? 144 : null);
    expect(lock?.securitizationRatio).toBe(spec < 161 ? 1.5 : undefined);
    expect(lock?.securitizationTick).toBe(12);
    const [fission] = await getHistoricalBitcoinFissions(api, ownerAccount);
    expect(fission).toMatchObject({
      ownerAccount,
      fissionId: 3,
      lockId: 4,
      satoshis: 1n,
      liquidityPromised: 10n,
      ratchetNumber: 1,
    });
    expect(fission.cosignerGuarantee?.guaranteedMicrogons).toBe(spec === 161 ? 10n : undefined);
  });
});

describe('BitcoinLocks fee coupon recovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks for enough wallet funding to cover sub-cent transaction fees without rounding up exact cents', () => {
    expect(new BitcoinLockWalletFundingError(2_010_001n).message).toContain('₳2.02');
    expect(new BitcoinLockWalletFundingError(2_010_000n).message).toContain('₳2.01');
  });

  it('estimates the full wallet balance needed before initializing with a fee waiver', async () => {
    const walletKeys = createMockWalletKeys('//FeeCouponEstimate');
    const store = createStore({ walletKeys });
    const client = {
      consts: { balances: { existentialDeposit: 5n } },
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
      consts: { balances: { existentialDeposit: 5n } },
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
    consts: { bitcoinLocks: { argonTicksPerDay: 1_440 } },
    query: {
      bitcoinLocks: {
        utxoIdsByOwnerAccount: { keys: vi.fn(async () => []) },
      },
    },
  };
  const blockWatch = {
    start: async () => undefined,
    events: { on: () => () => undefined },
    finalizedBlockHeader: { blockNumber: 0, blockHash: '0x0' },
    bestBlockHeader: { blockNumber: 0, blockHash: '0x0' },
    getFinalizedApi: vi.fn(async () => archiveClient),
  };
  vi.mocked(getMainchainClient).mockResolvedValue(archiveClient as never);
  vi.spyOn(BitcoinLock, 'getConfig').mockResolvedValue(createBitcoinLockConfig({ securitizationHoldBlocks: 6 }));
  const store = createStore({ blockWatch: blockWatch as never, db });

  await store.load();
  store.data.oracleBitcoinBlockHeight = 100;

  const lock = createLock({
    uuid: 'pending-lock',
    status: BitcoinLockStatus.LockPendingFunding,
    createdAt: '2026-08-11T18:00:00Z',
  });
  const initialExpiration = store.getSecuritizationHoldExpirationTime(lock);

  await vi.advanceTimersByTimeAsync(2_000);

  expect(store.getSecuritizationHoldExpirationTime(lock)).toBe(initialExpiration);

  store.data.oracleBitcoinBlockHeight = 101;

  expect(store.getSecuritizationHoldExpirationTime(lock)).not.toBe(initialExpiration);

  store.unsubscribeFromArgonBlocks();
});

describe('BitcoinLocks capacity owners', () => {
  let store: BitcoinLocks;

  beforeEach(() => {
    const currency = new Currency({ events: { on: vi.fn() } } as unknown as MainchainClients);
    currency.isLoaded = true;
    currency.priceIndex.btcUsdPrice = new BigNumber(200);
    currency.priceIndex.argonUsdPrice = new BigNumber(1);
    currency.priceIndex.argonUsdTargetPrice = new BigNumber(1);
    vi.spyOn(currency, 'load').mockRejectedValue(new Error('Capacity calculation must use loaded prices.'));
    store = createStore({ currency });
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, 200_000_000n])(
    'keeps Max within whole-satoshi capacity at price %s',
    async microgonsAtTargetPerBtc => {
      const vault = Object.assign(Object.create(Vault.prototype) as Vault, {
        securitization: 3n,
        securitizationLocked: 0n,
        flexibleSecuritizationLocked: 0n,
        reservedSecuritizationSpace: 0n,
        securitizationRatio: new BigNumber(1),
      });
      const capacity = await store.getLockableBitcoinCapacity({
        vault,
        microgonsAtTargetPerBtc,
      });

      expect(await store.satoshisForArgonLiquidity(3n, 200_000_000n)).toBe(2n);
      expect(capacity.vaultCapacityLiquidityMicrogons).toBe(3n);
      expect(capacity.availableSatoshis).toBe(1n);
      expect(capacity.availableLiquidityMicrogons).toBe(2n);
      expect(store.argonLiquidityForSatoshis(capacity.availableSatoshis + 1n, microgonsAtTargetPerBtc)).toBeGreaterThan(
        3n,
      );

      vault.securitization = 1n;
      const subSatoshiCapacity = await store.getLockableBitcoinCapacity({ vault, microgonsAtTargetPerBtc });
      expect(subSatoshiCapacity.availableSatoshis).toBe(0n);
      expect(subSatoshiCapacity.availableLiquidityMicrogons).toBe(0n);

      vault.securitization = 4n;
      const exactCapacity = await store.getLockableBitcoinCapacity({ vault, microgonsAtTargetPerBtc });
      expect(exactCapacity.availableSatoshis).toBe(2n);
      expect(exactCapacity.availableLiquidityMicrogons).toBe(4n);

      const limitedCapacity = await store.getLockableBitcoinCapacity({
        vault,
        microgonsAtTargetPerBtc,
        maxSatoshis: 1n,
      });
      expect(limitedCapacity.availableSatoshis).toBe(1n);
      expect(limitedCapacity.availableLiquidityMicrogons).toBe(2n);

      vault.securitization = 0n;
      const emptyCapacity = await store.getLockableBitcoinCapacity({ vault, microgonsAtTargetPerBtc });
      expect(emptyCapacity.availableSatoshis).toBe(0n);
      expect(emptyCapacity.availableLiquidityMicrogons).toBe(0n);
    },
  );

  it('uses the prospective owner for lockable capacity', async () => {
    const vault = Object.assign(Object.create(Vault.prototype) as Vault, {
      operatorAccountId: 'vault-operator',
      securitization: 1_000n,
      securitizationLocked: 800n,
      flexibleSecuritizationLocked: 300n,
      reservedSecuritizationSpace: 100n,
      securitizationRatio: new BigNumber(1),
    });
    const ownerCapacity = await store.getLockableBitcoinCapacity({ vault, lockOwner: 'vault-operator' });
    const memberCapacity = await store.getLockableBitcoinCapacity({ vault, lockOwner: 'bitcoin-owner' });

    expect(ownerCapacity.availableLiquidityMicrogons).toBe(200n);
    expect(memberCapacity.availableLiquidityMicrogons).toBe(400n);
  });

  it.each([160, 161])('projects flexible capacity without changing the loaded Vault on runtime %s', async spec => {
    const registry = new TypeRegistry();
    const metadata = new Metadata(
      registry,
      Object.entries(getBundledMetadata()).find(([key]) => key.endsWith(`-${spec}`))![1],
    );
    registry.setMetadata(metadata);
    const record = registry.createType('Option<ArgonPrimitivesVault>', {
      operatorAccountId: new Uint8Array(32).fill(17),
      securitization: 1_000n,
      securitizationTarget: 1_000n,
      securitizationLocked: 800n,
      flexibleSecuritizationLocked: 0n,
      reservedSecuritizationSpace: 100n,
      securitizationRatio: 1_500_000_000_000_000_000n,
    });
    const client = runtimeClient({
      registry,
      consts: decorateConstants(registry, metadata.asLatest, metadata.version),
      query: { vaults: { vaultsById: async () => record } },
    }) as unknown as ArgonCurrentQueryClient;
    const vault = await Vault.get(client, 7, 1_000);
    const capacity = await store.getLockableBitcoinCapacity({
      vault,
      lockOwner: 'bitcoin-owner',
      projectedFlexibleSecuritizationLocked: 300n,
    });

    // 1,000 - (800 - 300) - 100 leaves 400 collateral; only 160 divides by its 1.5 ratio.
    expect(capacity.vaultCapacityLiquidityMicrogons).toBe(spec === 160 ? 266n : 400n);
    expect(capacity.availableSatoshis).toBe(spec === 160 ? 133n : 200n);
    expect(capacity.availableLiquidityMicrogons).toBe(spec === 160 ? 266n : 400n);

    const operatorCapacity = await store.getLockableBitcoinCapacity({
      vault,
      lockOwner: vault.operatorAccountId,
      projectedFlexibleSecuritizationLocked: 300n,
    });
    // Operators can use only the 200 physically free collateral, with whole-satoshi rounding.
    expect(operatorCapacity.vaultCapacityLiquidityMicrogons).toBe(spec === 160 ? 133n : 200n);
    expect(operatorCapacity.availableSatoshis).toBe(spec === 160 ? 66n : 100n);
    expect(operatorCapacity.availableLiquidityMicrogons).toBe(spec === 160 ? 132n : 200n);

    expect(vault.flexibleSecuritizationLocked).toBe(0n);
    expect(vault.availableBitcoinSpace('bitcoin-owner')).toBe(spec === 160 ? 66n : 100n);
  });
});
