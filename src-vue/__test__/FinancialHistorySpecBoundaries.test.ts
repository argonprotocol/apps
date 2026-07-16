import { AccountActivityKind, BondLot, Currency } from '@argonprotocol/apps-core';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import { describe, expect, it, vi } from 'vitest';
import { ArgonBonds } from '../lib/ArgonBonds.ts';
import { FinancialHistoryImporter } from '../lib/recovery/index.ts';
import { VaultHistory } from '../lib/recovery/MyVault.ts';
import { createTestDb } from './helpers/db.ts';
import { createHistoricalEventData } from '../../indexer/__test__/helpers/historicalEvents.ts';
import { encodeAddress } from '@polkadot/util-crypto';
import { numberCodec, optionCodec } from '../../core/__test__/helpers/codecs.ts';

const registry = getOfflineRegistry();
const accountId = encodeAddress(new Uint8Array(32).fill(0x33));

describe('financial history spec boundaries', () => {
  it('passes spec 137 Bitcoin activity to recovery while rejecting bond history before spec 151', async () => {
    const recoverBitcoin = vi.fn(async () => undefined);
    const importBondHistory = vi.fn(async () => undefined);
    const blockWatch = {
      getHeader: vi.fn(async () => ({
        blockNumber: 137,
        blockHash: '0x137',
        blockTime: new Date('2026-01-01T00:00:00Z'),
      })),
      getEventsWithSpec: vi.fn(async () => ({ events: [], specVersion: 137 })),
    };
    const importer = new FinancialHistoryImporter({
      blockWatch: blockWatch as any,
      argonBonds: { importHistoryBlock: importBondHistory },
      vaultHistory: { importBlock: vi.fn() },
      enabledDomains: ['bitcoin', 'bonds'],
      bitcoinLockRecovery: { recoverBlock: recoverBitcoin },
    });

    const result = await importer.importBlocks([
      {
        blockNumber: 137,
        blockHash: '0x137',
        specVersion: 137,
        activityMask: AccountActivityKind.BitcoinLock | AccountActivityKind.BondPosition,
      },
    ]);

    expect(recoverBitcoin).toHaveBeenCalledOnce();
    expect(importBondHistory).not.toHaveBeenCalled();
    expect(result.domainErrors.bitcoin).toBeUndefined();
    expect(result.domainErrors.bonds).toContain('earliest supported for bonds is 151');
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
      getHeader: vi.fn(async (blockNumber: number) => ({
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

  it.each([151, 155, 156])('recovers the spec %s BondLot storage shape', async specVersion => {
    const db = await createTestDb();
    const lot = createBondLot(specVersion);
    const lotOption = optionCodec(lot);
    const block = {
      blockNumber: specVersion,
      blockHash: `0x${specVersion}`,
      blockTime: new Date('2026-07-01T12:00:00Z').getTime(),
      isFinalized: true,
    };
    const blockWatch = {
      getApi: vi.fn(async () => ({
        runtimeVersion: { specVersion: numberCodec(specVersion) },
        query: { treasury: { bondLotById: vi.fn(async () => lotOption) } },
      })),
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

    await argonBonds.importHistoryBlock(block as any, [
      {
        event: { section: 'treasury', method: 'BondLotPurchased', data: eventData },
        phase: { isApplyExtrinsic: true, asApplyExtrinsic: numberCodec(2) },
      } as any,
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
  return {
    event: {
      section: 'vaults',
      method,
      data: createHistoricalEventData(specVersion, 'vaults', method, values),
    },
    phase: { isApplyExtrinsic: true, asApplyExtrinsic: numberCodec(index) },
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
    return registry.createType('AppBondLotSpec151', value);
  }
  if (specVersion === 155) {
    return registry.createType('AppBondLotSpec155', {
      ...value,
      sharingPercent: 250_000,
      bonusPercent: 100_000,
    });
  }
  return registry.createType('PalletTreasuryBondLot', {
    ...value,
    program: { Vault: { vaultId: 4, sharingPercent: 300_000, bonusPercent: 150_000 } },
  });
}
