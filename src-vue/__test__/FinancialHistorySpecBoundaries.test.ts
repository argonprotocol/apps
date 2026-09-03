import { AccountActivityKind, BondLot, Currency } from '@argonprotocol/apps-core';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import type { Codec } from '@polkadot/types-codec/types';
import { describe, expect, it, vi } from 'vitest';
import { ArgonBonds } from '../lib/ArgonBonds.ts';
import { FinancialHistoryImporter } from '../lib/recovery/index.ts';
import { getHistoricalBitcoinLock } from '../lib/recovery/BitcoinLockHistory.ts';
import { VaultHistory } from '../lib/recovery/MyVault.ts';
import { createTestDb } from './helpers/db.ts';
import { createHistoricalEventData } from '../../indexer/__test__/helpers/historicalEvents.ts';
import { encodeAddress } from '@polkadot/util-crypto';
import { numberCodec } from '../../core/__test__/helpers/codecs.ts';
import { runtimeClient, toHistoricalEvent } from '@argonprotocol/runtime-client';
import BigNumber from 'bignumber.js';

const registry = getOfflineRegistry();
const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
const withBackgroundArchiveRead = async <T>(read: () => Promise<T>): Promise<T> => await read();

describe('financial history spec boundaries', () => {
  it.each([
    { specVersion: 130, priceField: 'peggedPrice' },
    { specVersion: 146, priceField: 'lockedMarketRate' },
    { specVersion: 150, priceField: 'lockedMarketRate' },
    { specVersion: 154, priceField: 'lockedTargetPrice' },
    { specVersion: 157, priceField: 'lockedTargetPrice' },
  ] as const)('decodes the complete spec $specVersion Bitcoin lock storage shape', async variant => {
    const rawClient = createBitcoinLockClient(variant);

    const lock = await getHistoricalBitcoinLock(runtimeClient(rawClient) as never, 10);

    expect(lock).toMatchObject({
      utxoId: 10,
      vaultId: 3,
      lockedTargetPrice: 516_350_021n,
      liquidityPromised: 499_433_743n,
      ownerAccount: accountId,
      securitizationRatio: 1,
      securitizedSatoshis: 488_274n,
      fundingExpirationHeight: 923_363,
      vaultClaimHeight: 975_911,
      openClaimHeight: 980_231,
      createdAtHeight: 923_351,
      isFlexible: variant.specVersion === 157,
      couponFeesPaid: variant.specVersion >= 146 ? 2_000_000n : 0n,
      createdAtArgonBlock: variant.specVersion >= 146 ? 472_519 : 0,
    });
    expect(lock?.fundedSatoshis).toBe(variant.specVersion >= 146 ? 488_275n : 0n);
    expect(rawClient.query.bitcoinLocks.locksByUtxoId).toHaveBeenCalledOnce();
  });

  it('normalizes the native spec 159 Lock shape without inventing pre-Fission liquidity', async () => {
    const locksByUtxoId = vi.fn(async () => ({
      vaultId: 3,
      securitizedSatoshis: 488_274n,
      microgonsAtTargetPerBtc: 516_350_021n,
      securitizationCoverageMicrogons: 499_433_743n,
      securitizationTick: 923_350n,
      fundedSatoshis: 488_275n,
      fissionedSatoshis: 200_000n,
      ownerAccount: accountId,
      securitizationRatio: new BigNumber(1),
      securityFees: 3_000_000n,
      couponPaidFees: 2_000_000n,
      vaultPubkey: `0x02${'11'.repeat(32)}`,
      vaultClaimPubkey: `0x02${'22'.repeat(32)}`,
      vaultXpubSources: ['0x01020304', 1, 2],
      ownerPubkey: `0x03${'33'.repeat(32)}`,
      vaultClaimHeight: 975_911,
      openClaimHeight: 980_231,
      createdAtHeight: 923_351,
      fundingExpirationHeight: 923_363n,
      utxoScriptPubkey: { type: 'P2WSH', value: { wscriptHash: `0x${'44'.repeat(32)}` } },
      isFlexible: true,
      fundHoldExtensions: {},
      createdAtArgonBlock: 472_519,
    }));
    const rawClient = {
      consts: { bitcoinLocks: { maxPendingConfirmationBlocks: numberCodec(12) } },
      query: { bitcoinLocks: { locksByUtxoId } },
    };

    const lock = await getHistoricalBitcoinLock(runtimeClient(rawClient) as never, 10);

    expect(lock).toMatchObject({
      utxoId: 10,
      securitizedSatoshis: 488_274n,
      fundedSatoshis: 488_275n,
      lockedTargetPrice: 516_350_021n,
      liquidityPromised: 0n,
      securitizationCoverageMicrogons: 499_433_743n,
      securityFees: 3_000_000n,
      couponFeesPaid: 2_000_000n,
    });
  });

  it('passes supported activity through runtime boundaries while skipping only an unsupported domain block', async () => {
    const recoverBitcoin = vi.fn(async () => undefined);
    const importBondHistory = vi.fn(async () => undefined);
    const blockWatch = {
      withBackgroundArchiveRead,
      getHeader: vi.fn(async ({ blockNumber, blockHash }) => ({
        blockNumber,
        blockHash,
        blockTime: new Date('2026-01-01T00:00:00Z'),
      })),
      getEventsWithSpec: vi.fn(async ({ blockNumber }) => ({ events: [], specVersion: blockNumber })),
    };
    const importer = new FinancialHistoryImporter({
      blockWatch: blockWatch as any,
      argonBonds: { importHistoryBlock: importBondHistory },
      vaultHistory: { importBlock: vi.fn() },
      enabledDomains: ['bitcoin', 'bonds'],
      bitcoinLockRecovery: { markHistoryReplayFailure: vi.fn(), recoverBlock: recoverBitcoin },
    });

    const result = await importer.importBlocks([
      {
        blockNumber: 137,
        blockHash: '0x137',
        specVersion: 137,
        activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.BondPosition,
      },
      {
        blockNumber: 151,
        blockHash: '0x151',
        specVersion: 151,
        activityMask: AccountActivityKind.BondPosition,
      },
    ]);

    expect(recoverBitcoin).toHaveBeenCalledOnce();
    expect(importBondHistory).toHaveBeenCalledOnce();
    expect(result.domainErrors.bitcoin).toBeUndefined();
    expect(result.domainErrors.bonds).toContain('earliest supported for bonds is 151');
  });

  it('persists later valid history while retaining the retry point before a mismatched block', async () => {
    const db = await createTestDb();
    const checkpoints: number[] = [];
    const blockWatch = {
      withBackgroundArchiveRead,
      getHeader: vi.fn(async ({ blockNumber }: { blockNumber: number }) => ({
        blockNumber,
        blockHash: blockNumber === 10 ? '0xdifferent' : `0x${blockNumber}`,
        blockTime: new Date('2026-01-01T00:00:00Z').getTime(),
      })),
      getEventsWithSpec: vi.fn(async () => ({
        events: [
          eventRecord(
            116,
            'VaultCreated',
            {
              vaultId: 7,
              lockedBitcoinArgons: 1_000n,
              bondedBitcoinArgons: 500n,
              addedSecuritizationPercent: 2_000_000_000_000_000_000n,
              operatorAccountId: accountId,
              activationTick: 1,
            },
            1,
          ),
        ],
        specVersion: 116,
      })),
    };
    const importer = new FinancialHistoryImporter({
      blockWatch: blockWatch as any,
      argonBonds: { importHistoryBlock: vi.fn() },
      vaultHistory: new VaultHistory(Promise.resolve(db), accountId),
      enabledDomains: ['vaulting'],
    });

    const result = await importer.importBlocks(
      [10, 11].map(blockNumber => ({
        blockNumber,
        blockHash: `0x${blockNumber}`,
        specVersion: 116,
        activityMask: AccountActivityKind.VaultPosition,
      })),
      {
        onCheckpoint: async blockNumber => {
          checkpoints.push(blockNumber);
        },
      },
    );

    expect(await db.vaultCapitalHistoryTable.fetchAll(accountId, 7)).toEqual([
      expect.objectContaining({ eventType: 'created', blockNumber: 11, securitization: 3_500n }),
    ]);
    expect(checkpoints).toEqual([9]);
    expect(result).toEqual({
      importedBlockCount: 1,
      domainErrors: { vaulting: expect.stringContaining('Indexer hash mismatch at block 10') },
      failedAtBlock: 10,
    });
  });

  it('recovers the mainnet vault fields from spec 137 through the target-aware fields introduced at 147', async () => {
    const db = await createTestDb();
    const eventsByBlock = new Map([
      [
        137,
        [
          eventRecord(
            137,
            'VaultCreated',
            {
              vaultId: 7,
              securitization: 1_000n,
              securitizationRatio: 1,
              operatorAccountId: accountId,
              openedTick: 1,
            },
            1,
          ),
        ],
      ],
      [139, [eventRecord(139, 'VaultModified', { vaultId: 7, securitization: 1_100n, securitizationRatio: 1 }, 2)]],
      [140, [eventRecord(140, 'VaultCollected', { vaultId: 7, revenue: 25n }, 3)]],
      [
        146,
        [
          eventRecord(146, 'FundsScheduledForRelease', { vaultId: 7, amount: 100n, releaseHeight: 500 }, 2),
          eventRecord(146, 'FundsReleased', { vaultId: 7, amount: 100n }, 2),
        ],
      ],
      [
        147,
        [
          eventRecord(
            147,
            'VaultModified',
            { vaultId: 7, securitization: 900n, securitizationTarget: 800n, securitizationRatio: 1 },
            3,
          ),
          eventRecord(147, 'FundsReleased', { vaultId: 7, securitization: 100n }, 3),
        ],
      ],
    ]);
    const blockWatch = {
      withBackgroundArchiveRead,
      getHeader: vi.fn(async ({ blockNumber }: { blockNumber: number }) => ({
        blockNumber,
        blockHash: `0x${blockNumber}`,
        blockTime: new Date('2026-01-01T00:00:00Z'),
      })),
      getEventsWithSpec: vi.fn(async (block: { blockNumber: number }) => ({
        events: eventsByBlock.get(block.blockNumber) ?? [],
        specVersion: block.blockNumber,
      })),
    };
    const importer = new FinancialHistoryImporter({
      blockWatch: blockWatch as any,
      argonBonds: { importHistoryBlock: vi.fn() },
      vaultHistory: new VaultHistory(Promise.resolve(db), accountId),
      enabledDomains: ['vaulting'],
    });

    await importer.importBlocks(
      [137, 139, 140, 146, 147].map(blockNumber => ({
        blockNumber,
        blockHash: `0x${blockNumber}`,
        specVersion: blockNumber,
        activityMask: blockNumber === 140 ? AccountActivityKind.VaultRevenue : AccountActivityKind.VaultPosition,
      })),
    );

    const history = await db.vaultCapitalHistoryTable.fetchAll(accountId, 7);
    expect(history).toEqual([
      expect.objectContaining({ eventType: 'created', securitization: 1_000n, blockNumber: 137 }),
      expect.objectContaining({ eventType: 'modified', securitization: 1_100n, blockNumber: 139 }),
      expect.objectContaining({
        eventType: 'releaseScheduled',
        securitization: 100n,
        releaseHeight: 500n,
        blockNumber: 146,
      }),
      expect.objectContaining({ eventType: 'released', securitization: 100n, blockNumber: 146 }),
      expect.objectContaining({
        eventType: 'modified',
        securitization: 900n,
        securitizationTarget: 800n,
        blockNumber: 147,
      }),
      expect.objectContaining({ eventType: 'released', securitization: 100n, blockNumber: 147 }),
    ]);
    expect(await db.vaultRevenueEventsTable.fetchAll()).toEqual([
      expect.objectContaining({ amount: 25n, blockNumber: 140 }),
    ]);
  });

  it('converts the earlier spec 116 vault allocation fields into operator capital', async () => {
    const db = await createTestDb();
    const events = [
      eventRecord(
        116,
        'VaultCreated',
        {
          vaultId: 7,
          lockedBitcoinArgons: 1_000n,
          bondedBitcoinArgons: 500n,
          addedSecuritizationPercent: 2_000_000_000_000_000_000n,
          operatorAccountId: accountId,
          activationTick: 1,
        },
        1,
      ),
      eventRecord(
        116,
        'VaultModified',
        {
          vaultId: 7,
          lockedBitcoinArgons: 1_200n,
          bondedBitcoinArgons: 500n,
          addedSecuritizationPercent: 2_000_000_000_000_000_000n,
        },
        2,
      ),
      eventRecord(
        116,
        'VaultClosed',
        {
          vaultId: 7,
          remainingSecuritization: 100n,
          released: 4_000n,
        },
        3,
      ),
    ];
    const vaultHistory = new VaultHistory(Promise.resolve(db), accountId);

    await vaultHistory.importBlock(
      {
        blockNumber: 116,
        blockHash: '0x116',
        blockTime: new Date('2026-01-01T00:00:00Z').getTime(),
      } as any,
      events as any,
    );

    expect(await db.vaultCapitalHistoryTable.fetchAll(accountId, 7)).toEqual([
      expect.objectContaining({ eventType: 'created', securitization: 3_500n }),
      expect.objectContaining({ eventType: 'modified', securitization: 4_100n, securitizationTarget: 4_100n }),
      expect.objectContaining({
        eventType: 'closed',
        securitizationRemaining: 100n,
        securitizationReleased: 4_000n,
      }),
    ]);
  });

  it.each([151, 155, 156, 157])('recovers the spec %s BondLot storage shape', async specVersion => {
    const db = await createTestDb();
    const lotOption = createBondLot(specVersion);
    const block = {
      blockNumber: specVersion,
      blockHash: `0x${specVersion}`,
      blockTime: new Date('2026-07-01T12:00:00Z').getTime(),
      isFinalized: true,
    };
    const blockWatch = {
      getApi: vi.fn(async () =>
        runtimeClient({
          runtimeVersion: { specVersion: numberCodec(specVersion) },
          query: { treasury: { bondLotById: vi.fn(async () => lotOption) } },
        }),
      ),
    };
    const argonBonds = new ArgonBonds(
      Promise.resolve(db),
      { isLoadedPromise: Promise.resolve(), upstreamOperator: undefined },
      new Currency({ events: { on: vi.fn() } } as any),
      { blockWatch } as any,
      { defaultArgonAddress: accountId } as any,
      {} as any,
    );
    const eventData = createHistoricalEventData(
      specVersion,
      'treasury',
      'BondLotPurchased',
      specVersion < 156
        ? { vaultId: 4, bondLotId: 7, accountId, bonds: 10 }
        : { programId: { Vault: { vaultId: 4 } }, bondLotId: 7, accountId, bonds: 10 },
    );

    const event = toHistoricalEvent({ section: 'treasury', method: 'BondLotPurchased', data: eventData });
    if (!event) throw new Error('treasury.BondLotPurchased is not a historical event');

    await argonBonds.importHistoryBlock(block as any, [
      { event, phase: { type: 'ApplyExtrinsic', value: 2 }, topics: [] },
    ]);

    expect(await db.bondLotHistoryTable.fetchAll(accountId)).toEqual([
      expect.objectContaining({
        programType: 'Vault',
        vaultId: 4,
        nativePrincipal: 10_000_000n,
        purchaseBlockNumber: specVersion,
      }),
    ]);
  });
});

function eventRecord(specVersion: number, method: string, values: Readonly<Record<string, unknown>>, index: number) {
  const event = toHistoricalEvent({
    section: 'vaults',
    method,
    data: createHistoricalEventData(specVersion, 'vaults', method, values),
  });
  if (!event) throw new Error(`vaults.${method} is not a historical event`);

  return {
    event,
    phase: { type: 'ApplyExtrinsic' as const, value: index },
    topics: [],
  };
}

function createBondLot(specVersion: number) {
  const fields = {
    owner: 'AccountId32',
    vaultId: 'Compact<u32>',
    bonds: 'Compact<u32>',
    createdFrameId: 'Compact<u64>',
    participatedFrames: 'Compact<u32>',
    lastFrameEarningsFrameId: 'Option<u64>',
    lastFrameEarnings: 'Option<u128>',
    cumulativeEarnings: 'Compact<u128>',
    releaseFrameId: 'Option<u64>',
    releaseReason: 'Option<PalletTreasuryBondReleaseReason>',
  };
  registry.register({
    AppBondLotSpec151: fields,
    AppBondLotSpec155: {
      owner: 'AccountId32',
      vaultId: 'Compact<u32>',
      bonds: 'Compact<u32>',
      sharingPercent: 'Compact<Permill>',
      bonusPercent: 'Compact<Permill>',
      createdFrameId: 'Compact<u64>',
      participatedFrames: 'Compact<u32>',
      lastFrameEarningsFrameId: 'Option<u64>',
      lastFrameEarnings: 'Option<u128>',
      cumulativeEarnings: 'Compact<u128>',
      releaseFrameId: 'Option<u64>',
      releaseReason: 'Option<PalletTreasuryBondReleaseReason>',
    },
    AppBondLotSpec156: {
      owner: 'AccountId32',
      program: 'PalletTreasuryBondProgram',
      bonds: 'Compact<u32>',
      createdFrameId: 'Compact<u64>',
      participatedFrames: 'Compact<u32>',
      lastFrameEarningsFrameId: 'Option<u64>',
      lastFrameEarnings: 'Option<u128>',
      cumulativeEarnings: 'Compact<u128>',
      releaseFrameId: 'Option<u64>',
      releaseReason: 'Option<PalletTreasuryBondReleaseReason>',
    },
    AppBondLotSpec157: {
      owner: 'AccountId32',
      program: 'PalletTreasuryBondProgram',
      bonds: 'Compact<u32>',
      createdFrameId: 'Compact<u64>',
      participatedFrames: 'Compact<u32>',
      lastFrameEarningsFrameId: 'Option<u64>',
      lastFrameEarnings: 'Option<u128>',
      cumulativeEarnings: 'Compact<u128>',
      releaseFrameId: 'Option<u64>',
      releaseReason: 'Option<PalletTreasuryBondReleaseReason>',
      isBackfill: 'bool',
    },
  });
  const value = {
    owner: accountId,
    vaultId: 4,
    bonds: 10,
    createdFrameId: 3,
    participatedFrames: 0,
    lastFrameEarningsFrameId: null,
    lastFrameEarnings: null,
    cumulativeEarnings: 0,
    releaseFrameId: null,
    releaseReason: null,
  };

  if (specVersion === 151) {
    return registry.createType('Option<AppBondLotSpec151>', value);
  }
  if (specVersion === 155) {
    return registry.createType('Option<AppBondLotSpec155>', {
      ...value,
      sharingPercent: 250_000,
      bonusPercent: 100_000,
    });
  }
  if (specVersion === 156) {
    return registry.createType('Option<AppBondLotSpec156>', {
      ...value,
      program: { Vault: { vaultId: 4, sharingPercent: 300_000, bonusPercent: 150_000 } },
    });
  }
  if (specVersion === 157) {
    return registry.createType('Option<AppBondLotSpec157>', {
      ...value,
      program: { Vault: { vaultId: 4, sharingPercent: 300_000, bonusPercent: 150_000 } },
      isBackfill: true,
    });
  }
  return registry.createType('Option<PalletTreasuryBondLot>', {
    ...value,
    program: { Vault: { vaultId: 4, sharingPercent: 300_000, bonusPercent: 150_000 } },
  });
}

function createBitcoinLockClient({
  specVersion,
  priceField,
}: {
  specVersion: number;
  priceField: 'peggedPrice' | 'lockedMarketRate' | 'lockedTargetPrice';
}) {
  const commonFields = {
    vaultId: 'Compact<u32>',
    liquidityPromised: specVersion >= 150 ? 'Compact<u128>' : 'u128',
    [priceField]: specVersion >= 150 ? 'Compact<u128>' : 'u128',
    ownerAccount: 'AccountId32',
    ...(specVersion >= 150 ? { securitizationRatio: 'u128' } : {}),
    securityFees: specVersion >= 150 ? 'Compact<u128>' : 'u128',
    ...(specVersion >= 146 ? { couponPaidFees: specVersion >= 150 ? 'Compact<u128>' : 'u128' } : {}),
    satoshis: 'Compact<u64>',
    ...(specVersion >= 146 ? { utxoSatoshis: 'Option<u64>' } : {}),
    vaultPubkey: 'ArgonPrimitivesBitcoinCompressedBitcoinPubkey',
    vaultClaimPubkey: 'ArgonPrimitivesBitcoinCompressedBitcoinPubkey',
    vaultXpubSources: '([u8;4],u32,u32)',
    ownerPubkey: 'ArgonPrimitivesBitcoinCompressedBitcoinPubkey',
    vaultClaimHeight: 'Compact<u64>',
    openClaimHeight: 'Compact<u64>',
    createdAtHeight: 'Compact<u64>',
    utxoScriptPubkey: 'ArgonPrimitivesBitcoinBitcoinCosignScriptPubkey',
    [specVersion >= 150 ? 'isFunded' : 'isVerified']: 'bool',
    ...(specVersion < 146 ? { isRejectedNeedsRelease: 'bool' } : {}),
    ...(specVersion === 157 ? { isBackfill: 'bool' } : {}),
    fundHoldExtensions: 'BTreeMap<u64,u128>',
    ...(specVersion >= 146 ? { createdAtArgonBlock: specVersion >= 150 ? 'Compact<u32>' : 'u32' } : {}),
  };
  const lockType = `AppBitcoinLockSpec${specVersion}`;
  registry.register({ [lockType]: commonFields });

  const lock = registry.createType(lockType, {
    vaultId: 3,
    liquidityPromised: 499_433_743n,
    [priceField]: 516_350_021n,
    ownerAccount: accountId,
    ...(specVersion >= 150 ? { securitizationRatio: 1_000_000_000_000_000_000n } : {}),
    securityFees: 0,
    ...(specVersion >= 146 ? { couponPaidFees: 2_000_000n } : {}),
    satoshis: 488_274,
    ...(specVersion >= 146 ? { utxoSatoshis: 488_275 } : {}),
    vaultPubkey: `0x02${'11'.repeat(32)}`,
    vaultClaimPubkey: `0x02${'22'.repeat(32)}`,
    vaultXpubSources: ['0x01020304', 1, 2],
    ownerPubkey: `0x03${'33'.repeat(32)}`,
    vaultClaimHeight: 975_911,
    openClaimHeight: 980_231,
    createdAtHeight: 923_351,
    utxoScriptPubkey: { P2WSH: { wscriptHash: `0x${'44'.repeat(32)}` } },
    [specVersion >= 150 ? 'isFunded' : 'isVerified']: true,
    ...(specVersion < 146 ? { isRejectedNeedsRelease: false } : {}),
    ...(specVersion === 157 ? { isBackfill: true } : {}),
    fundHoldExtensions: {},
    ...(specVersion >= 146 ? { createdAtArgonBlock: 472_519 } : {}),
  });
  return {
    consts: {
      bitcoinLocks: { maxPendingConfirmationBlocks: numberCodec(12) },
    },
    query: {
      bitcoinLocks: {
        locksByUtxoId: vi.fn(async () => registry.createType<Codec>(`Option<${lockType}>`, lock)),
      },
    },
  };
}
