import { describe, expect, it, vi } from 'vitest';
import {
  BitcoinLock,
  type FrameSupportTokensMiscIdAmountRuntimeHoldReason,
  getOfflineRegistry,
  type PalletTreasuryBondLot,
  type Vault,
} from '@argonprotocol/mainchain';
import { BondLot } from '@argonprotocol/apps-core';
import type { IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import type {
  IFinancialGroupSnapshot,
  IFinancialObservedGroupSnapshot,
  IFinancialPosition,
} from '../interfaces/IFinancialPosition.ts';
import { financialGroups } from '../interfaces/IFinancialPosition.ts';
import type { IWallet } from '../lib/Wallet.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import type { Currency } from '../lib/Currency.ts';
import type { IWalletTransferRecord } from '../lib/db/WalletTransfersTable.ts';
import { type IArgonAccountBalance, WalletsForArgon } from '../lib/WalletsForArgon.ts';
import type { IMiningCohortFinancialRecord } from '../interfaces/db/ICohortFrameRecord.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { BitcoinFinancials } from '../lib/financials/BitcoinLocks.ts';
import type { IBitcoinLockSummary } from '../interfaces/IBitcoinLockSummary.ts';
import { ArgonBondsFinancials } from '../lib/financials/ArgonBonds.ts';
import type { WalletForArgon } from '../lib/WalletForArgon.ts';
import { MiningFinancials } from '../lib/financials/MyMiningSeats.ts';
import { VaultFinancials } from '../lib/financials/MyVault.ts';
import { calculatePositionReturn, FinancialPositionBook, reduceFinancialPositions } from '../lib/financials/index.ts';
import { WalletFinancials } from '../lib/financials/WalletBalances.ts';

const wallet: IWallet = {
  address: '5wallet',
  availableMicrogons: 0n,
  availableMicronots: 0n,
  reservedMicrogons: 0n,
  reservedMicronots: 0n,
  totalMicrogons: 0n,
  totalMicronots: 0n,
  otherTokens: [],
  fetchErrorMsg: '',
};
const miningFinancials = new MiningFinancials({} as any);
const bondFinancials = new ArgonBondsFinancials({} as any);
const bitcoinFinancials = new BitcoinFinancials({} as BitcoinLocks);
const vaultFinancials = new VaultFinancials({} as any);

function readySnapshots(positions: IFinancialPosition[] = []): IFinancialObservedGroupSnapshot[] {
  return financialGroups.map(group => ({
    group,
    state: 'ready',
    positions: positions.filter(position => position.group === group),
    observation: {
      observedAt: new Date('2026-07-14T12:00:00Z'),
    },
  }));
}

describe('financial position accounting', () => {
  it('waits for liquid balances before exposing net worth', () => {
    const snapshots: IFinancialGroupSnapshot[] = readySnapshots();
    const liquid = snapshots.find(snapshot => snapshot.group === 'liquid')!;
    liquid.state = 'loading';

    expect(reduceFinancialPositions(snapshots)).toMatchObject({
      netWorth: undefined,
      readiness: 'partial',
    });

    liquid.state = 'ready';
    expect(reduceFinancialPositions(snapshots).netWorth).toBe(0n);
  });

  it('reduces signed current values into assets, liabilities, and net worth', () => {
    const positions: IFinancialPosition[] = [
      {
        id: 'wallet-argon',
        kind: 'wallet-balance',
        group: 'liquid',
        label: 'Available ARGN',
        lifecycle: 'available',

        currentValue: 100n,
        wallet,
        balanceType: 'transferable',
        asset: 'ARGN',
      },
      {
        id: 'bitcoin-debt-1',
        kind: 'bitcoin-liability',
        group: 'bitcoin',
        label: 'Bitcoin redemption',
        lifecycle: 'active',

        currentValue: -40n,
        lock: {} as IBitcoinLockRecord,
      },
    ];

    const aggregate = reduceFinancialPositions(readySnapshots(positions));

    expect(aggregate.grossAssets).toBe(100n);
    expect(aggregate.grossLiabilities).toBe(40n);
    expect(aggregate.netWorth).toBe(60n);
    expect(aggregate.accountReturn).toMatchObject({
      availability: 'not-applicable',
      eligiblePositionCount: 0,
      investmentPositionCount: 0,
    });
  });

  it('keeps EVM balances in assets without treating wallet balances as investments', () => {
    const positions: IFinancialPosition[] = [
      {
        id: 'argon-wallet',
        kind: 'wallet-balance',
        group: 'liquid',
        label: 'Available ARGN',
        lifecycle: 'available',
        currentValue: 100n,
        wallet,
        balanceType: 'transferable',
        asset: 'ARGN',
      },
      {
        id: 'base-wallet',
        kind: 'base-wallet-balance',
        group: 'base',
        label: 'Base ARGN',
        lifecycle: 'available',
        currentValue: 200n,
        wallet,
        asset: 'base:ARGN',
      },
      {
        id: 'ethereum-wallet',
        kind: 'ethereum-wallet-balance',
        group: 'ethereum',
        label: 'Ethereum ARGN',
        lifecycle: 'available',
        currentValue: 300n,
        wallet,
        asset: 'ethereum:ARGN',
      },
      {
        id: 'bitcoin-debt',
        kind: 'bitcoin-liability',
        group: 'bitcoin',
        label: 'Bitcoin redemption',
        lifecycle: 'active',
        currentValue: -40n,
        lock: {} as IBitcoinLockRecord,
      },
    ];

    const snapshots = readySnapshots(positions);
    const aggregate = reduceFinancialPositions(snapshots);

    expect(aggregate.grossAssets).toBe(600n);
    expect(aggregate.grossLiabilities).toBe(40n);
    expect(aggregate.netWorth).toBe(560n);
  });

  it('does not invent a return for cash or add paid income and settlement marks to current value', () => {
    const positions: IFinancialPosition[] = [
      {
        id: 'wallet-argon',
        kind: 'wallet-balance',
        group: 'liquid',
        label: 'Available ARGN',
        lifecycle: 'available',

        currentValue: 50n,
        wallet,
        balanceType: 'transferable',
        asset: 'ARGN',
      },
      {
        id: 'vault-1',
        kind: 'vault',
        group: 'vaulting',
        label: 'Vault 1',
        vaultId: 1,
        lifecycle: 'active',

        currentValue: 100n,
        investedCost: 100n,
        paidIncome: 5n,
        settledPrincipalValue: 10n,
        startedAt: new Date('2026-01-01T00:00:00Z'),
        vault: {} as Vault,
        securitization: 100n,
        uncollectedRevenue: 0n,
        capitalHistory: [],
        revenueHistory: [],
      },
    ];

    const aggregate = reduceFinancialPositions(readySnapshots(positions));
    const liquid = aggregate.groupSummaries.liquid;
    const vaulting = aggregate.groupSummaries.vaulting;

    expect(aggregate.netWorth).toBe(150n);
    expect(liquid?.returnSummary.availability).toBe('not-applicable');
    expect(liquid?.returnSummary.percent).toBeUndefined();
    expect(vaulting?.currentValue).toBe(100n);
    expect(vaulting?.returnSummary.returnAmount).toBe(15n);
    expect(vaulting?.returnSummary.percent).toBe(15);
    expect(aggregate.accountReturn).toMatchObject({
      availability: 'available',
      eligiblePositionCount: 1,
      investmentPositionCount: 1,
      percent: 15,
    });
  });

  it('weights the account return by cost across investment groups', () => {
    const positions: IFinancialPosition[] = [
      {
        id: 'vault-1',
        kind: 'vault',
        group: 'vaulting',
        label: 'Vault 1',
        vaultId: 1,
        lifecycle: 'active',

        currentValue: 120n,
        investedCost: 100n,
        paidIncome: 0n,
        settledPrincipalValue: 0n,
        startedAt: new Date('2026-01-01T00:00:00Z'),
        vault: {} as Vault,
        securitization: 120n,
        uncollectedRevenue: 0n,
        capitalHistory: [],
        revenueHistory: [],
      },
      {
        id: 'swap-1',
        kind: 'stable-swap',
        group: 'ethereum',
        label: 'Stable swap holdings',
        lifecycle: 'active',

        currentValue: 330n,
        investedCost: 300n,
        paidIncome: 0n,
        settledPrincipalValue: 0n,
        startedAt: new Date('2026-01-01T00:00:00Z'),
        wallet,
        purchases: [],
        nativeAmount: 330n,
        isQuantityReconciled: true,
      },
    ];

    const accountReturn = reduceFinancialPositions(readySnapshots(positions)).accountReturn;

    expect(accountReturn).toMatchObject({
      availability: 'available',
      eligiblePositionCount: 2,
      investmentPositionCount: 2,
      percent: 12.5,
    });
  });

  it('keeps an unavailable investment return unavailable instead of reporting zero percent', () => {
    const positions: IFinancialPosition[] = [
      {
        id: 'stable-swap-1',
        kind: 'stable-swap',
        group: 'ethereum',
        label: 'Stable swap holdings',
        lifecycle: 'active',

        currentValue: 100n,
        paidIncome: 0n,
        settledPrincipalValue: 0n,
        startedAt: new Date('2026-01-01T00:00:00Z'),
        wallet,
        purchases: [],
        nativeAmount: 100n,
        isQuantityReconciled: false,
      },
    ];

    const aggregate = reduceFinancialPositions(readySnapshots(positions));
    const stableSwaps = aggregate.groupSummaries.ethereum;

    expect(stableSwaps?.returnSummary.availability).toBe('unavailable');
    expect(stableSwaps?.returnSummary.percent).toBeUndefined();
    expect(stableSwaps?.returnSummary.returnAmount).toBeUndefined();
  });

  it('values wallet ARGNOT without reporting it as an investment return', () => {
    const positions: IFinancialPosition[] = [
      {
        id: 'wallet-holding-known',
        kind: 'wallet-holding',
        group: 'liquid',
        label: 'ARGNOT holding',
        lifecycle: 'active',

        currentValue: 12n,
        investedCost: 8n,
        paidIncome: 0n,
        settledPrincipalValue: 0n,
        startedAt: new Date('2026-01-01T00:00:00Z'),
        accountId: '5wallet',
        nativeAsset: 'ARGNOT',
        nativeAmount: 4n,
        entryArgonotRateMicrogons: 2_000_000n,
      },
      {
        id: 'wallet-holding-unknown',
        kind: 'wallet-holding',
        group: 'liquid',
        label: 'ARGNOT holding basis unavailable',
        lifecycle: 'unavailable',

        currentValue: 0n,
        paidIncome: 0n,
        accountId: '5wallet',
        nativeAsset: 'ARGNOT',
        nativeAmount: 2n,
      },
    ];

    const aggregate = reduceFinancialPositions(readySnapshots(positions));

    expect(aggregate.readiness).toBe('ready');
    expect(aggregate.groupSummaries.liquid.returnSummary).toMatchObject({
      availability: 'not-applicable',
      eligiblePositionCount: 0,
      investmentPositionCount: 0,
    });
    expect(aggregate.accountReturn).toMatchObject({
      availability: 'not-applicable',
      eligiblePositionCount: 0,
      investmentPositionCount: 0,
    });
    expect(aggregate.netWorth).toBe(12n);
  });

  it('counts newly held pending mining collateral once without diluting term RTD', () => {
    const cohort = createMiningCohort({
      progress: 30,
      transactionFeesTotal: 1_000_000n,
      microgonsBidPerSeat: 100_000_000n,
      microgonsToBeMinedPerSeat: 10_000_000n,
      micronotsToBeMinedPerSeat: 10_000_000n,
      micronotsMinedTotal: 10_000_000n,
      microgonsMinedTotal: 10_000_000n,
      microgonFeesCollectedTotal: 5_000_000n,
      closingArgonotPrice: 0n,
      updatedAt: '2026-07-01T00:00:00Z',
    });
    const pendingBid = {
      frameId: 21,
      confirmedAtBlockNumber: 500,
      address: '5miner',
      subAccountIndex: 0,
      microgonsPerSeat: 50_000_000n,
      micronotsStakedPerSeat: 10_000_000n,
      bidPosition: 0,
      createdAt: '2026-07-14T00:00:00Z',
      updatedAt: '2026-07-14T00:00:00Z',
    };

    const positions = miningFinancials.createFinancialPositions({
      cohorts: [cohort],
      latestFrameId: 21,
      pendingBids: [pendingBid],
      heldMicronots: 20_000_000n,
      liveArgonotRateMicrogons: 3_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 20_000_000n,
      frameDates: new Map([[12, new Date('2026-07-01T00:00:00Z')]]),
    });
    const active = positions.find(position => position.kind === 'mining-cohort');
    const custody = positions.find(position => position.kind === 'mining-argonot');
    const pending = positions.find(position => position.kind === 'mining-bid');
    const aggregate = reduceFinancialPositions(readySnapshots(positions));
    const mining = aggregate.groupSummaries.mining;

    expect(positions.filter(position => position.kind === 'mining-argonot')).toHaveLength(1);
    expect(active).toMatchObject({
      currentValue: 70_000_000n,
      investedCost: 101_000_000n,
      paidIncome: 45_000_000n,
      remainingSeatValue: 70_000_000n,
      performanceEndingCapital: 115_000_000n,
    });
    expect(custody).toMatchObject({
      source: 'collateral',
      lifecycle: 'held',
      currentValue: 30_000_000n,
      investedCost: 20_000_000n,
      micronots: 10_000_000n,
    });
    expect(pending).toMatchObject({
      currentValue: 80_000_000n,
      investedCost: 80_000_000n,
      nativeStakedMicronots: 10_000_000n,
    });
    expect(mining?.currentValue).toBe(180_000_000n);
    expect(mining?.returnSummary).toMatchObject({
      investedCost: 101_000_000n,
      returnAmount: 14_000_000n,
      percent: 13.86,
    });
  });

  it('keeps newly activated collateral held while cohort details catch up', () => {
    const positions = miningFinancials.createFinancialPositions({
      cohorts: [
        createMiningCohort({
          id: 12,
          progress: 30,
          micronotsStakedPerSeat: 7_000_000n,
          closingArgonotPrice: 0n,
        }),
      ],
      latestFrameId: 12,
      pendingBids: [],
      heldMicronots: 12_000_000n,
      liveArgonotRateMicrogons: 3_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 12_000_000n,
      frameDates: new Map([[12, new Date('2026-07-01T00:00:00Z')]]),
    });

    expect(positions).toContainEqual(
      expect.objectContaining({
        kind: 'mining-balance',
        lifecycle: 'held',
        asset: 'ARGNOT',
        amount: 5_000_000n,
        currentValue: 15_000_000n,
      }),
    );
    expect(positions.filter(position => position.kind === 'mining-argonot' && position.lifecycle === 'held')).toEqual([
      expect.objectContaining({ micronots: 7_000_000n }),
    ]);
  });

  it('uses live pending holds without requiring custody attribution', () => {
    const pendingBids = [0, 1].map(subAccountIndex => ({
      frameId: 21,
      confirmedAtBlockNumber: 500,
      address: `5miner-${subAccountIndex}`,
      subAccountIndex,
      microgonsPerSeat: 50_000_000n,
      micronotsStakedPerSeat: 5_000_000n,
      bidPosition: subAccountIndex,
      createdAt: '2026-07-14T00:00:00Z',
      updatedAt: '2026-07-14T00:00:00Z',
    }));
    const positions = miningFinancials.createFinancialPositions({
      cohorts: [],
      latestFrameId: 21,
      pendingBids,
      heldMicronots: 4_000_000n,
      liveArgonotRateMicrogons: 3_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 10_000_000n,
      frameDates: new Map(),
      custodyTransfers: [
        createWalletTransfer({
          id: 9,
          amount: -10_000_000n,
          otherParty: '5miner',
          isInternal: true,
          microgonsForArgonot: 2_000_000n,
        }),
      ],
    });

    expect(
      positions.filter(position => position.kind === 'mining-bid').map(position => position.nativeStakedMicronots),
    ).toEqual([4_000_000n, 0n]);
    expect(reduceFinancialPositions(readySnapshots(positions)).groupSummaries.mining.currentValue).toBe(130_000_000n);
  });

  it('does not require released ARGNOT custody for a pending bid', () => {
    const positions = miningFinancials.createFinancialPositions({
      cohorts: [],
      latestFrameId: 21,
      pendingBids: [
        {
          frameId: 21,
          confirmedAtBlockNumber: 500,
          address: '5miner',
          subAccountIndex: 0,
          microgonsPerSeat: 50_000_000n,
          micronotsStakedPerSeat: 10_000_000n,
          bidPosition: 0,
          createdAt: '2026-07-14T00:00:00Z',
          updatedAt: '2026-07-14T00:00:00Z',
        },
      ],
      heldMicronots: 0n,
      liveArgonotRateMicrogons: 3_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 0n,
      frameDates: new Map(),
    });

    expect(positions.find(position => position.kind === 'mining-bid')).toMatchObject({
      currentValue: 50_000_000n,
      investedCost: 50_000_000n,
    });
  });

  it('counts idle mining ARGN without treating it as an investment return', () => {
    const args = {
      cohorts: [],
      latestFrameId: 21,
      pendingBids: [],
      heldMicronots: 0n,
      liveArgonotRateMicrogons: 3_000_000n,
      miningBotAddress: '5miner',
      miningBotMicrogons: 2_000_000n,
      miningBotMicronots: 0n,
      frameDates: new Map<number, Date>(),
    };

    const positions = miningFinancials.createFinancialPositions(args);
    const mining = reduceFinancialPositions(readySnapshots(positions)).groupSummaries.mining;

    expect(positions).toContainEqual(
      expect.objectContaining({
        kind: 'mining-balance',
        asset: 'ARGN',
        currentValue: 2_000_000n,
      }),
    );
    expect(mining.returnSummary.availability).toBe('not-applicable');
  });

  it('does not count held bid ARGN again as an idle mining balance', async () => {
    const registry = getOfflineRegistry();
    const account = createArgonAccount({
      address: '5miner',
      availableMicrogons: 100n,
      microgonHolds: [
        registry.createType('FrameSupportTokensMiscIdAmountRuntimeHoldReason', {
          id: { MiningSlot: 'RegisterAsMiner' },
          amount: 40n,
        }),
      ],
    });
    const financials = new MiningFinancials({
      load: vi.fn(),
      miningCohorts: [],
      latestFrameId: 21,
      currentFrameBids: [
        {
          frameId: 21,
          confirmedAtBlockNumber: 500,
          address: '5miner-0',
          subAccountIndex: 0,
          microgonsPerSeat: 40n,
          micronotsStakedPerSeat: 0n,
          bidPosition: 0,
          createdAt: '2026-07-14T00:00:00Z',
          updatedAt: '2026-07-14T00:00:00Z',
        },
      ],
      currency: { microgonsPer: { ARGNOT: 0n } },
      miningFrames: { getFrameDate: vi.fn() },
    } as any);

    const positions = await financials.loadPositions({
      accounts: [account],
      miningBotAddress: '5miner',
      hasConfirmedHistoryCoverage: false,
    });

    expect(positions.find(position => position.kind === 'mining-balance')).toMatchObject({
      asset: 'ARGN',
      currentValue: 60n,
    });
    expect(reduceFinancialPositions(readySnapshots(positions)).groupSummaries.mining.currentValue).toBe(100n);
  });

  it('retires a completed mining seat while withholding RTD when its closing ARGNOT mark is missing', () => {
    const positions = miningFinancials.createFinancialPositions({
      cohorts: [
        createMiningCohort({
          transactionFeesTotal: 1_000_000n,
          microgonsBidPerSeat: 100_000_000n,
          microgonsToBeMinedPerSeat: 10_000_000n,
          micronotsToBeMinedPerSeat: 10_000_000n,
          closingArgonotPrice: 0n,
          micronotsMinedTotal: 10_000_000n,
          microgonsMinedTotal: 100_000_000n,
        }),
      ],
      latestFrameId: 22,
      pendingBids: [],
      heldMicronots: 0n,
      liveArgonotRateMicrogons: 3_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 20_000_000n,
      frameDates: new Map([
        [12, new Date('2026-07-01T00:00:00Z')],
        [22, new Date('2026-07-11T00:00:00Z')],
      ]),
    });
    const aggregate = reduceFinancialPositions(readySnapshots(positions));
    const mining = aggregate.groupSummaries.mining;

    expect(positions[0]).toMatchObject({
      kind: 'mining-cohort',
      currentValue: 0n,
      settledPrincipalValue: 0n,
    });
    const collateral = positions.find(
      position => position.kind === 'mining-argonot' && position.source === 'collateral',
    );
    const rewards = positions.find(position => position.kind === 'mining-argonot' && position.source === 'rewards');

    expect(collateral).toMatchObject({
      lifecycle: 'active',
      currentValue: 30_000_000n,
      investedCost: 20_000_000n,
    });
    expect(rewards).toMatchObject({
      lifecycle: 'active',
      currentValue: 30_000_000n,
      investedCost: undefined,
    });
    expect(mining?.returnSummary.availability).toBe('unavailable');
    expect(mining?.returnSummary.returnAmount).toBeUndefined();
  });

  it('keeps unbased mining ARGNOT in net worth without making the investment return partial', () => {
    const positions = miningFinancials.createFinancialPositions({
      cohorts: [
        createMiningCohort({
          progress: 30,
          micronotsStakedPerSeat: 7_000_000n,
          microgonsBidPerSeat: 100_000_000n,
          microgonsToBeMinedPerSeat: 10_000_000n,
          micronotsToBeMinedPerSeat: 10_000_000n,
          closingArgonotPrice: 0n,
          microgonsMinedTotal: 10_000_000n,
          updatedAt: '2026-07-01T00:00:00Z',
        }),
      ],
      latestFrameId: 12,
      pendingBids: [],
      heldMicronots: 7_000_000n,
      liveArgonotRateMicrogons: 3_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 10_000_000n,
      frameDates: new Map([[12, new Date('2026-07-01T00:00:00Z')]]),
      hasConfirmedHistoryCoverage: false,
    });
    const custody = positions.filter(position => position.kind === 'mining-argonot');
    const unbasedBalance = positions.find(position => {
      return position.kind === 'mining-balance' && position.asset === 'ARGNOT';
    });
    const mining = reduceFinancialPositions(readySnapshots(positions)).groupSummaries.mining;

    expect(custody).toEqual([
      expect.objectContaining({
        source: 'collateral',
        lifecycle: 'held',
        currentValue: 21_000_000n,
        investedCost: 14_000_000n,
        micronots: 7_000_000n,
      }),
    ]);
    expect(unbasedBalance).toMatchObject({
      lifecycle: 'available',
      currentValue: 9_000_000n,
      amount: 3_000_000n,
    });
    expect(mining.currentValue).toBe(100_000_000n);
    expect(mining.returnSummary.availability).toBe('available');
  });

  it('does not publish released mining ARGNOT that left without a recovered custody boundary', () => {
    const positions = miningFinancials.createFinancialPositions({
      cohorts: [createMiningCohort()],
      latestFrameId: 22,
      pendingBids: [],
      heldMicronots: 0n,
      liveArgonotRateMicrogons: 4_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 0n,
      frameDates: new Map([
        [12, new Date('2026-07-01T00:00:00Z')],
        [22, new Date('2026-07-11T00:00:00Z')],
      ]),
    });

    expect(positions.filter(position => position.kind === 'mining-argonot')).toEqual([]);
  });

  it('preserves active collateral when available mining custody left without a recovered boundary', () => {
    const positions = miningFinancials.createFinancialPositions({
      cohorts: [
        createMiningCohort({
          id: 12,
          progress: 30,
          micronotsStakedPerSeat: 7_000_000n,
          closingArgonotPrice: 0n,
        }),
      ],
      latestFrameId: 12,
      pendingBids: [],
      heldMicronots: 7_000_000n,
      liveArgonotRateMicrogons: 4_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 7_000_000n,
      frameDates: new Map([
        [12, new Date('2026-07-01T00:00:00Z')],
        [22, new Date('2026-07-11T00:00:00Z')],
      ]),
      custodyTransfers: [
        createWalletTransfer({
          id: 9,
          amount: -5_000_000n,
          otherParty: '5miner',
          isInternal: true,
          microgonsForArgonot: 3_000_000n,
          blockTime: new Date('2026-07-02T00:00:00Z'),
        }),
      ],
    });

    expect(positions.filter(position => position.kind === 'mining-argonot')).toEqual([
      expect.objectContaining({
        source: 'collateral',
        lifecycle: 'held',
        micronots: 7_000_000n,
      }),
    ]);
  });

  it('starts return tracking at the ordinary-to-mining ARGNOT handoff', async () => {
    const receivedAt = new Date('2026-06-20T00:00:00Z');
    const committedAt = new Date('2026-07-01T00:00:00Z');
    const transfers: IWalletTransferRecord[] = [
      createWalletTransfer({
        id: 1,
        amount: 10_000_000n,
        microgonsForArgonot: 2_000_000n,
        blockNumber: 90,
        blockTime: receivedAt,
      }),
      createWalletTransfer({
        id: 2,
        amount: -5_000_000n,
        otherParty: '5legacy',
        isInternal: true,
        blockNumber: 100,
        blockTime: committedAt,
      }),
      createWalletTransfer({
        id: 3,
        amount: -5_000_000n,
        otherParty: '5legacy',
        isInternal: true,
        blockNumber: 101,
        blockTime: committedAt,
      }),
      createWalletTransfer({
        id: 4,
        walletAddress: '5legacy',
        amount: -10_000_000n,
        otherParty: '5miner',
        isInternal: true,
        extrinsicIndex: 2,
        microgonsForArgonot: 3_000_000n,
        blockNumber: 102,
        blockTime: committedAt,
      }),
    ];
    const ordinary = await createWalletsForFinancialTest('5default', transfers).loadPositions({
      accounts: [createArgonAccount({ address: '5default' })],
      claimedHolds: { treasury: false, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 4_000_000n,
    });
    const mining = miningFinancials.createFinancialPositions({
      cohorts: [
        createMiningCohort({
          argonotPriceAtBid: 3_000_000n,
        }),
      ],
      latestFrameId: 22,
      pendingBids: [],
      heldMicronots: 0n,
      liveArgonotRateMicrogons: 4_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 10_000_000n,
      frameDates: new Map([
        [12, committedAt],
        [22, new Date('2026-07-11T00:00:00Z')],
      ]),
    });

    const aggregate = reduceFinancialPositions(readySnapshots([...ordinary, ...mining]));
    expect(ordinary).toContainEqual(
      expect.objectContaining({
        id: 'wallet-holding:transfer:1:exit:4',
        nativeAmount: 10_000_000n,
      }),
    );
    expect(aggregate.groupSummaries.liquid.returnSummary).toMatchObject({
      availability: 'not-applicable',
      investmentPositionCount: 0,
    });
    expect(aggregate.groupSummaries.mining.returnSummary.returnAmount).toBe(0n);
    expect(aggregate.accountReturn).toMatchObject({
      availability: 'available',
      basisPoints: 0n,
      investmentPositionCount: 1,
    });
  });

  it('keeps uncommitted mining-bot ARGNOT as a basis-bearing mining custody position', () => {
    const depositedAt = new Date('2026-06-30T00:00:00Z');
    const bidAt = new Date('2026-07-01T00:00:00Z');
    const positions = miningFinancials.createFinancialPositions({
      cohorts: [
        createMiningCohort({
          progress: 0,
          micronotsStakedPerSeat: 7_000_000n,
          argonotPriceAtBid: 3_000_000n,
          closingArgonotPrice: 0n,
          microgonsMinedTotal: 0n,
          createdAt: bidAt.toISOString(),
          updatedAt: bidAt.toISOString(),
        }),
      ],
      latestFrameId: 12,
      pendingBids: [],
      heldMicronots: 7_000_000n,
      liveArgonotRateMicrogons: 4_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 10_000_000n,
      frameDates: new Map([
        [12, bidAt],
        [22, new Date('2026-07-11T00:00:00Z')],
      ]),
      custodyTransfers: [
        createWalletTransfer({
          id: 9,
          amount: -10_000_000n,
          otherParty: '5miner',
          isInternal: true,
          microgonsForArgonot: 2_000_000n,
          blockNumber: 90,
          blockTime: depositedAt,
        }),
      ],
    });
    const custody = positions.filter(position => position.kind === 'mining-argonot');

    expect(custody).toEqual([
      expect.objectContaining({
        source: 'custody',
        lifecycle: 'completed',
        micronots: 7_000_000n,
        investedCost: 14_000_000n,
        settledPrincipalValue: 21_000_000n,
      }),
      expect.objectContaining({
        source: 'custody',
        lifecycle: 'active',
        micronots: 3_000_000n,
        investedCost: 6_000_000n,
        currentValue: 12_000_000n,
      }),
      expect.objectContaining({
        source: 'collateral',
        lifecycle: 'held',
        micronots: 7_000_000n,
        investedCost: 21_000_000n,
        currentValue: 28_000_000n,
      }),
    ]);
  });

  it('hands matured mining ARGNOT into the next cohort at one continuous FIFO mark', () => {
    const firstCohort = createMiningCohort({ id: 1 });
    const secondCohort = {
      ...firstCohort,
      id: 11,
      progress: 0,
      microgonsBidPerSeat: 30_000_000n,
      argonotPriceAtBid: 3_000_000n,
      closingArgonotPrice: 0n,
      microgonsMinedTotal: 0n,
      createdAt: '2026-07-11T00:00:00Z',
      updatedAt: '2026-07-11T00:00:00Z',
    };

    const positions = miningFinancials.createFinancialPositions({
      cohorts: [firstCohort, secondCohort],
      latestFrameId: 11,
      pendingBids: [],
      heldMicronots: 10_000_000n,
      liveArgonotRateMicrogons: 4_000_000n,
      miningBotAddress: '5miner',
      miningBotMicronots: 10_000_000n,
      frameDates: new Map([
        [1, new Date('2026-07-01T00:00:00Z')],
        [11, new Date('2026-07-11T00:00:00Z')],
        [21, new Date('2026-07-21T00:00:00Z')],
      ]),
    });
    const custody = positions.filter(position => position.kind === 'mining-argonot');

    expect(custody).toEqual([
      expect.objectContaining({
        lifecycle: 'completed',
        investedCost: 20_000_000n,
        settledPrincipalValue: 30_000_000n,
        closingArgonotRateMicrogons: 3_000_000n,
      }),
      expect.objectContaining({
        lifecycle: 'held',
        investedCost: 30_000_000n,
        currentValue: 40_000_000n,
        entryArgonotRateMicrogons: 3_000_000n,
      }),
    ]);
  });

  it('closes internal and recorded external FIFO exits from released mining ARGNOT', () => {
    const blockTime = new Date('2026-07-12T00:00:00Z');
    const positions = miningFinancials.createFinancialPositions({
      cohorts: [createMiningCohort({ id: 1 })],
      latestFrameId: 12,
      pendingBids: [],
      heldMicronots: 0n,
      liveArgonotRateMicrogons: 4_000_000n,
      frameDates: new Map([
        [1, new Date('2026-07-01T00:00:00Z')],
        [11, new Date('2026-07-11T00:00:00Z')],
      ]),
      custodyTransfers: [
        createWalletTransfer({
          id: 7,
          amount: 4_000_000n,
          otherParty: '5miner',
          isInternal: true,
          extrinsicIndex: 2,
          microgonsForArgonot: 3_500_000n,
          blockNumber: 100,
          blockTime,
        }),
        createWalletTransfer({
          id: 8,
          walletAddress: '5miner',
          walletName: 'miningBot',
          amount: -2_000_000n,
          otherParty: '5outside',
          microgonsForArgonot: 3_600_000n,
          blockNumber: 101,
          blockTime: new Date('2026-07-13T00:00:00Z'),
        }),
      ],
      miningBotAddress: '5miner',
      miningBotMicronots: 4_000_000n,
    });
    const custody = positions.filter(position => position.kind === 'mining-argonot');

    expect(custody).toEqual([
      expect.objectContaining({
        lifecycle: 'completed',
        micronots: 4_000_000n,
        investedCost: 8_000_000n,
        settledPrincipalValue: 14_000_000n,
      }),
      expect.objectContaining({
        lifecycle: 'completed',
        micronots: 2_000_000n,
        investedCost: 4_000_000n,
        settledPrincipalValue: 7_200_000n,
      }),
      expect.objectContaining({
        lifecycle: 'active',
        micronots: 4_000_000n,
        investedCost: 8_000_000n,
        currentValue: 16_000_000n,
      }),
    ]);
  });

  it('does not invent address-level pending mining collateral when aggregate holds are ambiguous', () => {
    const pendingBids = [
      {
        frameId: 21,
        confirmedAtBlockNumber: 500,
        address: '5miner-1',
        subAccountIndex: 0,
        microgonsPerSeat: 50_000_000n,
        micronotsStakedPerSeat: 10_000_000n,
        bidPosition: 0,
        createdAt: '2026-07-14T00:00:00Z',
        updatedAt: '2026-07-14T00:00:00Z',
      },
      {
        frameId: 21,
        confirmedAtBlockNumber: 500,
        address: '5miner-2',
        subAccountIndex: 1,
        microgonsPerSeat: 50_000_000n,
        micronotsStakedPerSeat: 10_000_000n,
        bidPosition: 1,
        createdAt: '2026-07-14T00:00:00Z',
        updatedAt: '2026-07-14T00:00:00Z',
      },
    ];

    expect(() =>
      miningFinancials.createFinancialPositions({
        cohorts: [],
        latestFrameId: 21,
        pendingBids,
        heldMicronots: 10_000_000n,
        liveArgonotRateMicrogons: 3_000_000n,
        miningBotAddress: '5miner',
        miningBotMicronots: 0n,
        frameDates: new Map(),
      }),
    ).toThrow('ARGNOT MiningSlot holds exceed the mining account balance');
  });

  it('subtracts burned Bitcoin liquidity while keeping ratchets in one lock position', () => {
    const lock = {
      uuid: 'lock-1',
      status: BitcoinLockStatus.LockedAndMinted,
      satoshis: 10_000n,
      lockedTargetPrice: 120n,
      ratchets: [
        {
          mintAmount: 30n,
          mintPending: 10n,
          lockedTargetPrice: 100n,
          securityFee: 7n,
          txFee: 3n,
          burned: 4n,
          blockHeight: 1,
          oracleBitcoinBlockHeight: 1,
        },
        {
          mintAmount: 20n,
          mintPending: 0n,
          lockedTargetPrice: 120n,
          securityFee: 8n,
          txFee: 2n,
          burned: 1n,
          blockHeight: 2,
          oracleBitcoinBlockHeight: 2,
        },
      ],
      lockDetails: { couponFeesPaid: 5n },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as unknown as IBitcoinLockRecord;
    const currency = {
      priceIndex: {},
      convertSatToBtc: vi.fn(() => 0.0001),
      convertBtcToMicrogon: vi.fn(() => 150n),
    } as unknown as Currency;
    const bitcoinLocks = new BitcoinLocks(
      Promise.resolve({} as never),
      {} as never,
      {} as never,
      currency,
      {} as never,
      {} as never,
    );
    vi.spyOn(bitcoinLocks, 'getMismatchViewState').mockReturnValue({
      phase: 'none',
      candidateCount: 0,
      isFundingExpired: false,
      candidates: [],
    });
    vi.spyOn(bitcoinLocks, 'getLockProcessingDetails').mockReturnValue({ confirmations: 3 } as never);
    vi.spyOn(bitcoinLocks, 'getLockProcessingError').mockReturnValue('');
    vi.spyOn(bitcoinLocks, 'hasObservedFundingSignal').mockReturnValue(true);
    const redemption = vi.spyOn(BitcoinLock, 'calculateRedemptionAmountFromSatoshis').mockReturnValue(60n);

    try {
      const summary = bitcoinLocks.createLockSummary(lock);
      const positions = bitcoinFinancials.createFinancialPositions({ summaries: [summary], hasCurrentPrice: true });
      const aggregate = reduceFinancialPositions(readySnapshots(positions));
      const bitcoin = aggregate.groupSummaries.bitcoin;

      expect(summary).toMatchObject({
        valueOfBtc: 150n,
        totalLiquidity: 50n,
        pendingLiquidity: 10n,
        receivedLiquidity: 35n,
        valueBeyondLiquidity: 30n,
        startingCapital: 100n,
        endingCapital: 120n,
        securityFees: 10n,
        totalFees: 15n,
        unlockAmount: 60n,
        totalReturn: 20,
      });
      expect(positions.map(position => position.id)).toEqual([
        `bitcoin-asset:${lock.uuid}`,
        `bitcoin-liability:${lock.uuid}`,
      ]);
      expect(positions.map(position => [position.kind, position.currentValue])).toEqual([
        ['bitcoin-asset', 160n],
        ['bitcoin-liability', -60n],
      ]);
      expect(positions.every(position => position.lock.uuid === lock.uuid)).toBe(true);
      expect(positions[0]).toMatchObject({ investedCost: 100n, paidIncome: 20n });
      expect(bitcoin).toMatchObject({ grossAssets: 160n, grossLiabilities: 60n, currentValue: 100n });
      expect(bitcoin?.returnSummary.paidIncome).toBe(20n);
      expect(bitcoin?.returnSummary.returnAmount).toBe(20n);
      expect(bitcoin?.returnSummary.percent).toBe(20);
    } finally {
      redemption.mockRestore();
    }
  });

  it('keeps total Bitcoin return at breakeven after a down-ratchet offsets the price loss', () => {
    const lock = {
      uuid: 'down-ratchet',
      status: BitcoinLockStatus.LockedAndIsMinting,
      satoshis: 10_000n,
      lockedTargetPrice: 100n,
      ratchets: [
        {
          mintAmount: 120n,
          mintPending: 0n,
          liquidityPromised: 120n,
          lockedTargetPrice: 120n,
          securityFee: 0n,
          txFee: 0n,
          burned: 0n,
          blockHeight: 1,
          oracleBitcoinBlockHeight: 1,
        },
        {
          mintAmount: 100n,
          mintPending: 100n,
          liquidityPromised: 100n,
          lockedTargetPrice: 100n,
          securityFee: 0n,
          txFee: 0n,
          burned: 100n,
          blockHeight: 2,
          oracleBitcoinBlockHeight: 2,
        },
      ],
      lockDetails: { couponFeesPaid: 0n },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as unknown as IBitcoinLockRecord;
    const currency = {
      priceIndex: {},
      convertSatToBtc: vi.fn(() => 0.0001),
      convertBtcToMicrogon: vi.fn(() => 100n),
    } as unknown as Currency;
    const bitcoinLocks = new BitcoinLocks(
      Promise.resolve({} as never),
      {} as never,
      {} as never,
      currency,
      {} as never,
      {} as never,
    );
    vi.spyOn(bitcoinLocks, 'getMismatchViewState').mockReturnValue({
      phase: 'none',
      candidateCount: 0,
      isFundingExpired: false,
      candidates: [],
    });
    vi.spyOn(bitcoinLocks, 'getLockProcessingDetails').mockReturnValue({ confirmations: 3 } as never);
    vi.spyOn(bitcoinLocks, 'getLockProcessingError').mockReturnValue('');
    vi.spyOn(bitcoinLocks, 'hasObservedFundingSignal').mockReturnValue(true);
    const redemption = vi.spyOn(BitcoinLock, 'calculateRedemptionAmountFromSatoshis').mockReturnValue(100n);

    try {
      const summary = bitcoinLocks.createLockSummary(lock);
      const positions = bitcoinFinancials.createFinancialPositions({ summaries: [summary], hasCurrentPrice: true });
      const bitcoin = reduceFinancialPositions(readySnapshots(positions)).groupSummaries.bitcoin;

      expect(summary).toMatchObject({
        valueOfBtc: 100n,
        pendingLiquidity: 100n,
        receivedLiquidity: 20n,
        startingCapital: 120n,
        endingCapital: 120n,
        totalReturn: 0,
      });
      expect(bitcoin).toMatchObject({
        grossAssets: 200n,
        grossLiabilities: 100n,
        currentValue: 100n,
      });
      expect(bitcoin.returnSummary).toMatchObject({
        investedCost: 120n,
        paidIncome: 20n,
        returnAmount: 0n,
        percent: 0,
      });
    } finally {
      redemption.mockRestore();
    }
  });

  it('preserves native Bitcoin quantity while converted values wait for a current price', () => {
    const lock = {
      uuid: 'lock-2',
      status: BitcoinLockStatus.LockedAndMinted,
      satoshis: 20_000n,
      ratchets: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as unknown as IBitcoinLockRecord;
    const summary = {
      uuid: lock.uuid,
      status: lock.status,
      satoshis: lock.satoshis,
      valueOfBtc: 1n,
      startingCapital: 100n,
      totalLiquidity: 30n,
      pendingLiquidity: 0n,
      receivedLiquidity: 30n,
      totalFees: 5n,
      unlockAmount: 1n,
      endingCapital: 124n,
      record: lock,
    } as IBitcoinLockSummary;

    const positions = bitcoinFinancials.createFinancialPositions({ summaries: [summary], hasCurrentPrice: false });
    const aggregate = reduceFinancialPositions(readySnapshots(positions));

    expect(positions).toHaveLength(2);
    expect(positions[0].lock.satoshis).toBe(20_000n);
    expect(positions[0]).toMatchObject({ investedCost: 100n });
    expect(positions.every(position => position.currentValue === undefined)).toBe(true);
    expect(aggregate.readiness).toBe('partial');
    expect(aggregate.groupSummaries.bitcoin.returnSummary.availability).toBe('unavailable');
  });

  it('settles a released Bitcoin lock from its durable removal economics', () => {
    const removedAt = new Date('2026-01-31T12:00:00Z');
    const lock = {
      uuid: 'lock-released',
      status: BitcoinLockStatus.Released,
      satoshis: 10_000n,
      lockedTargetPrice: 100n,
      ratchets: [{ mintPending: 0n }],
      releaseRedemptionMicrogons: 40n,
      releaseArgonTxFeeMicrogons: 3n,
      removalBlockTime: removedAt,
      removalReason: 'released',
      btcPriceAtRemovalMicrogons: 1_200_000n,
      fundingUtxoRecord: { releaseBitcoinNetworkFee: 1_000n },
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    } as unknown as IBitcoinLockRecord;
    const summary = {
      uuid: lock.uuid,
      status: lock.status,
      satoshis: lock.satoshis,
      valueOfBtc: 999n,
      startingCapital: 100n,
      totalLiquidity: 30n,
      pendingLiquidity: 10n,
      receivedLiquidity: 30n,
      totalFees: 5n,
      unlockAmount: 999n,
      endingCapital: 999n,
      record: lock,
    } as IBitcoinLockSummary;

    const positions = bitcoinFinancials.createFinancialPositions({
      summaries: [summary],
      hasCurrentPrice: true,
      hasConfirmedHistoryCoverage: true,
    });
    const bitcoin = reduceFinancialPositions(readySnapshots(positions)).groupSummaries.bitcoin;

    expect(positions).toEqual([
      expect.objectContaining({
        lifecycle: 'completed',
        currentValue: 10n,
        investedCost: 100n,
        paidIncome: 22n,
        settledPrincipalValue: 68n,
        performanceEndingCapital: 100n,
        endedAt: removedAt,
      }),
    ]);
    expect(bitcoin?.currentValue).toBe(10n);
    expect(bitcoin?.returnSummary.returnAmount).toBe(0n);
  });

  it('keeps an incomplete released lock visible without inventing a settlement return', () => {
    const lock = {
      uuid: 'lock-released-incomplete',
      status: BitcoinLockStatus.Released,
      satoshis: 10_000n,
      lockedTargetPrice: 100n,
      ratchets: [],
      releaseRedemptionMicrogons: 40n,
      releaseArgonTxFeeMicrogons: 3n,
      removalReason: 'released',
      removalBlockTime: new Date('2026-02-01T00:00:00Z'),
      btcPriceAtRemovalMicrogons: 1_200_000n,
      fundingUtxoRecord: { releaseBitcoinNetworkFee: 1_000n },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as unknown as IBitcoinLockRecord;
    const summary = {
      uuid: lock.uuid,
      status: lock.status,
      satoshis: lock.satoshis,
      valueOfBtc: 999n,
      startingCapital: 100n,
      totalLiquidity: 30n,
      pendingLiquidity: 6n,
      receivedLiquidity: 30n,
      totalFees: 5n,
      unlockAmount: 999n,
      endingCapital: 999n,
      record: lock,
    } as IBitcoinLockSummary;

    const positions = bitcoinFinancials.createFinancialPositions({ summaries: [summary], hasCurrentPrice: true });
    const bitcoin = reduceFinancialPositions(readySnapshots(positions)).groupSummaries.bitcoin;

    expect(positions).toEqual([
      expect.objectContaining({
        id: `bitcoin-asset:${lock.uuid}`,
        lifecycle: 'completed',
        currentValue: 6n,
        investedCost: undefined,
        settledPrincipalValue: undefined,
        performanceEndingCapital: undefined,
      }),
    ]);
    expect(bitcoin?.currentValue).toBe(6n);
    expect(bitcoin?.returnSummary.availability).toBe('unavailable');
    expect(bitcoin?.returnSummary.returnAmount).toBeUndefined();
  });

  it('keeps only recovered pending mint after removed Bitcoin locks stop being live', () => {
    const lock = {
      uuid: 'lock-expired-unspent',
      status: BitcoinLockStatus.Releasing,
      satoshis: 10_000n,
      lockedTargetPrice: 100n,
      ratchets: [{ mintPending: 10n }],
      removalReason: 'expired',
      removalBlockTime: new Date('2026-02-01T00:00:00Z'),
      btcPriceAtRemovalMicrogons: 1_200_000n,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as unknown as IBitcoinLockRecord;
    const summary = {
      uuid: lock.uuid,
      status: lock.status,
      satoshis: lock.satoshis,
      valueOfBtc: 150n,
      startingCapital: 100n,
      totalLiquidity: 30n,
      pendingLiquidity: 10n,
      receivedLiquidity: 20n,
      totalFees: 5n,
      unlockAmount: 40n,
      endingCapital: 125n,
      record: lock,
    } as IBitcoinLockSummary;
    const spentLock = {
      ...lock,
      uuid: 'lock-spent',
      status: BitcoinLockStatus.Released,
      removalReason: 'spent',
    } as IBitcoinLockRecord;
    const spentSummary = {
      ...summary,
      uuid: spentLock.uuid,
      status: spentLock.status,
      valueOfBtc: 999n,
      pendingLiquidity: 7n,
      record: spentLock,
    } as IBitcoinLockSummary;

    const positions = bitcoinFinancials.createFinancialPositions({
      summaries: [summary, spentSummary],
      hasCurrentPrice: true,
    });
    const bitcoin = reduceFinancialPositions(readySnapshots(positions)).groupSummaries.bitcoin;

    expect(positions).toEqual([
      expect.objectContaining({
        id: `bitcoin-asset:${lock.uuid}`,
        label: 'Expired Bitcoin lock',
        lifecycle: 'held',
        currentValue: 160n,
        investedCost: undefined,
        settledPrincipalValue: undefined,
      }),
      expect.objectContaining({
        id: `bitcoin-asset:${spentLock.uuid}`,
        label: 'Spent Bitcoin lock',
        lifecycle: 'completed',
        currentValue: 7n,
        investedCost: undefined,
        settledPrincipalValue: undefined,
      }),
    ]);
    expect(bitcoin?.grossAssets).toBe(167n);
    expect(bitcoin?.grossLiabilities).toBe(0n);
    expect(bitcoin?.returnSummary.availability).toBe('unavailable');
  });

  it('excludes ARGNOT principal price movement from bond and account returns', async () => {
    const vaultLot = createBondLot({ id: 1, bonds: 10, cumulativeEarnings: 1_000_000n });
    const argonotLot = createBondLot({
      id: 2,
      bonds: 10,
      cumulativeEarnings: 4_000_000n,
      program: { Argonot: null },
    });
    const account = createArgonAccount({
      address: vaultLot.accountId,
      availableMicrogons: 15_000_000n,
      reservedMicrogons: 10_000_000n,
      availableMicronots: 15_000_000n,
      reservedMicronots: 10_000_000n,
      microgonTreasuryHold: 10_000_000n,
      micronotTreasuryHold: 10_000_000n,
    });
    const walletPositions = await createWalletsForFinancialTest(account.address).loadPositions({
      accounts: [account],
      claimedHolds: { treasury: true, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 3_000_000n,
    });
    const bonds = bondFinancials.createFinancialPositions({
      bondLots: [vaultLot, argonotLot],
      hasConfirmedBondHistoryCoverage: true,
      liveArgonotRateMicrogons: 3_000_000n,
      entryArgonotMarksByLot: new Map([
        [`${argonotLot.accountId}:${argonotLot.programType}:${argonotLot.id}`, 2_000_000n],
      ]),
      frameDates: new Map([[argonotLot.createdFrame, new Date('2026-01-01T00:00:00Z')]]),
    });
    const vaultPosition = bonds.find(position => position.bondLot?.id === 1);
    const argonotPosition = bonds.find(position => position.bondLot?.id === 2);

    expect(vaultPosition).toMatchObject({
      nativeAsset: 'ARGN',
      nativePrincipal: 10_000_000n,
      investedCost: 10_000_000n,
      currentValue: 10_000_000n,
      paidIncome: 1_000_000n,
    });
    expect(argonotPosition).toMatchObject({
      nativeAsset: 'ARGNOT',
      nativePrincipal: 10_000_000n,
      investedCost: 20_000_000n,
      currentValue: 30_000_000n,
      paidIncome: 4_000_000n,
    });
    expect(calculatePositionReturn([argonotPosition!])).toMatchObject({
      investedCost: 20_000_000n,
      paidIncome: 4_000_000n,
      returnAmount: 4_000_000n,
      percent: 20,
    });
    const vaultBondGroup = reduceFinancialPositions(readySnapshots([vaultPosition!])).groupSummaries.bonds;
    expect(vaultBondGroup?.returnSummary).toMatchObject({
      investedCost: 10_000_000n,
      paidIncome: 1_000_000n,
      returnAmount: 1_000_000n,
      percent: 10,
    });

    const [operatorBond] = bondFinancials.createFinancialPositions({
      bondLots: [vaultLot],
      hasConfirmedBondHistoryCoverage: true,
      entryArgonotMarksByLot: new Map(),
      frameDates: new Map([[vaultLot.createdFrame, new Date('2026-01-01T00:00:00Z')]]),
      ownedVaultId: vaultLot.vaultId,
    });
    const operatorAggregate = reduceFinancialPositions(readySnapshots([operatorBond]));
    expect(operatorAggregate.groupSummaries.bonds.returnSummary.percent).toBe(10);
    expect(operatorAggregate.groupSummaries.bonds.currentValue).toBe(10_000_000n);
    expect(operatorAggregate.grossAssets).toBe(0n);
    expect(operatorAggregate.netWorth).toBe(0n);
    expect(operatorAggregate.accountReturn).toMatchObject({
      availability: 'not-applicable',
      eligiblePositionCount: 0,
      investmentPositionCount: 0,
    });

    const mixedAggregate = reduceFinancialPositions(readySnapshots([operatorBond, argonotPosition!]));
    expect(mixedAggregate.groupSummaries.bonds.returnSummary).toMatchObject({
      investedCost: 30_000_000n,
      paidIncome: 5_000_000n,
      returnAmount: 5_000_000n,
      percent: 16.67,
    });
    expect(mixedAggregate.accountReturn).toMatchObject({
      availability: 'available',
      eligiblePositionCount: 1,
      investmentPositionCount: 1,
      percent: 20,
    });
    expect(mixedAggregate.grossAssets).toBe(30_000_000n);
    expect(mixedAggregate.netWorth).toBe(30_000_000n);

    const aggregate = reduceFinancialPositions(readySnapshots([...walletPositions, ...bonds]));
    const bondGroup = aggregate.groupSummaries.bonds;

    expect(bondGroup?.currentValue).toBe(40_000_000n);
    expect(bondGroup?.returnSummary.paidIncome).toBe(5_000_000n);
    expect(bondGroup?.returnSummary.returnAmount).toBe(5_000_000n);
  });

  it('partitions transferable and unattributed Argon balances without double counting named holds', async () => {
    const registry = getOfflineRegistry();
    const account = createArgonAccount({
      availableMicrogons: 30n,
      reservedMicrogons: 20n,
      availableMicronots: 300n,
      reservedMicronots: 200n,
      microgonHolds: [
        registry.createType('FrameSupportTokensMiscIdAmountRuntimeHoldReason', {
          id: { BlockRewards: 'MaturationPeriod' },
          amount: 10n,
        }),
        registry.createType('FrameSupportTokensMiscIdAmountRuntimeHoldReason', {
          id: { MiningSlot: 'RegisterAsMiner' },
          amount: 5n,
        }),
      ],
      micronotHolds: [
        registry.createType('FrameSupportTokensMiscIdAmountRuntimeHoldReason', {
          id: { CrosschainTransfer: 'TransferOutMintingAuthorityTip' },
          amount: 100n,
        }),
      ],
    });
    const result = await createWalletsForFinancialTest(account.address).loadPositions({
      accounts: [account],
      claimedHolds: { treasury: false, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 1_000_000n,
    });

    const balances = result.filter(position => position.kind === 'wallet-balance');
    expect(balances.map(position => [position.asset, position.balanceType, position.nativeAmount])).toEqual([
      ['ARGN', 'transferable', 30n],
      ['ARGN', 'unattributed-hold', 20n],
      ['ARGNOT', 'transferable', 300n],
      ['ARGNOT', 'unattributed-hold', 200n],
    ]);
  });

  it('does not remove a claimed vault commitment from the free ARGNOT balance twice', async () => {
    const registry = getOfflineRegistry();
    const account = createArgonAccount({
      availableMicronots: 7n,
      reservedMicronots: 10n,
      micronotHolds: [
        registry.createType('FrameSupportTokensMiscIdAmountRuntimeHoldReason', {
          id: { Vaults: 'EnterVault' },
          amount: 10n,
        }),
      ],
    });
    const result = await createWalletsForFinancialTest(account.address, [
      createWalletTransfer({ id: 1, amount: 17n, walletAddress: account.address }),
    ]).loadPositions({
      accounts: [account],
      claimedHolds: { treasury: false, miningSlot: false, vaults: true },
      claimedMicronotsByAccount: new Map([[account.address, 10n]]),
      liveArgonotRateMicrogons: 1_000_000n,
    });

    expect(result).toContainEqual(
      expect.objectContaining({
        kind: 'wallet-holding',
        nativeAmount: 7n,
        investedCost: 7n,
        currentValue: 7n,
      }),
    );
  });

  it('does not mark an empty ARGNOT balance unavailable while history catches up', async () => {
    const account = createArgonAccount({ availableMicrogons: 10n });
    const positions = await createWalletsForFinancialTest(account.address).loadPositions({
      accounts: [account],
      claimedHolds: { treasury: false, miningSlot: false, vaults: false },
      liveArgonotRateMicrogons: 1_000_000n,
      hasConfirmedHistoryCoverage: false,
    });

    expect(positions).not.toContainEqual(expect.objectContaining({ lifecycle: 'unavailable' }));
  });

  it('fails the wallet group when holds exceed the reserved chain balance', async () => {
    const account = createArgonAccount({
      reservedMicrogons: 9n,
      microgonTreasuryHold: 10n,
    });

    await expect(
      createWalletsForFinancialTest(account.address).loadPositions({
        accounts: [account],
        claimedHolds: { treasury: false, miningSlot: false, vaults: false },
        liveArgonotRateMicrogons: 1_000_000n,
      }),
    ).rejects.toThrow('ARGN holds exceed reserved balance');
  });

  it('uses live vault holds while subscription data catches up', async () => {
    const registry = getOfflineRegistry();
    const account = createArgonAccount({
      reservedMicrogons: 8n,
      reservedMicronots: 400n,
      microgonHolds: [
        registry.createType('FrameSupportTokensMiscIdAmountRuntimeHoldReason', {
          id: { Vaults: 'EnterVault' },
          amount: 8n,
        }),
      ],
      micronotHolds: [
        registry.createType('FrameSupportTokensMiscIdAmountRuntimeHoldReason', {
          id: { Vaults: 'EnterVault' },
          amount: 400n,
        }),
      ],
    });
    const source = new VaultFinancials({
      load: vi.fn(async () => undefined),
      createdVault: { vaultId: 10, securitization: 8n, isClosed: false } as Vault,
      data: {
        pendingCollectRevenue: 100n,
        argonotCommitment: { committedMicronots: 500n },
      },
      history: {
        loadPositionHistory: vi.fn(async () => ({ capital: [], revenue: [] })),
      },
    } as any);
    const positions = await source.loadPositions({
      hasConfirmedHistoryCoverage: true,
      account,
      liveArgonotRateMicrogons: 1_000_000n,
    });

    expect(positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'vault-balance',
          asset: 'ARGNOT',
          amount: 400n,
        }),
        expect.objectContaining({
          kind: 'vault',
          id: 'vault:10',
          uncollectedRevenue: 0n,
        }),
      ]),
    );
  });
});

describe('financial group snapshots', () => {
  it('rejects duplicate position ids across financial groups', () => {
    const book = new FinancialPositionBook();
    const observation = { observedAt: new Date('2026-07-14T12:00:00Z') };
    book.setScope({ ownedAccounts: ['5wallet'] });
    book.publish(
      book.beginRefresh('liquid'),
      [
        {
          id: 'shared-position',
          kind: 'wallet-balance',
          group: 'liquid',
          label: 'Available ARGN',
          lifecycle: 'available',

          currentValue: 75n,
          wallet,
          balanceType: 'transferable',
          asset: 'ARGN',
        },
      ],
      observation,
    );

    expect(() => {
      book.publish(
        book.beginRefresh('bitcoin'),
        [
          {
            id: 'shared-position',
            kind: 'bitcoin-liability',
            group: 'bitcoin',
            label: 'Bitcoin redemption',
            lifecycle: 'active',

            currentValue: -50n,
            lock: { uuid: 'lock-1' } as IBitcoinLockRecord,
          },
        ],
        observation,
      );
    }).toThrow('Financial position id shared-position is already used by liquid');
  });

  it('retains a coherent receivable handoff until every group covers the required observation', () => {
    const block10 = {
      observedAt: new Date('2026-07-14T12:00:00Z'),
      blockNumber: 10,
      blockHash: '0x10',
    };
    const block11 = {
      observedAt: new Date('2026-07-14T12:01:00Z'),
      blockNumber: 11,
      blockHash: '0x11',
    };
    const walletPosition = {
      id: 'wallet-settlement',
      kind: 'wallet-balance',
      group: 'liquid',
      label: 'Available ARGN',
      lifecycle: 'available',

      currentValue: 100n,
      wallet,
      balanceType: 'transferable',
      asset: 'ARGN',
    } satisfies IFinancialPosition;
    const receivables: IFinancialPosition[] = [
      {
        id: 'bitcoin-pending-mint',
        kind: 'bitcoin-asset',
        group: 'bitcoin',
        label: 'Pending Bitcoin mint',
        lifecycle: 'active',

        currentValue: 20n,
        paidIncome: 0n,
        settledPrincipalValue: 0n,
        lock: { uuid: 'lock-1' } as IBitcoinLockRecord,
      },
      {
        id: 'mining-seat',
        kind: 'mining-cohort',
        group: 'mining',
        label: 'Remaining mining seat',
        lifecycle: 'active',

        currentValue: 20n,
        paidIncome: 0n,
        settledPrincipalValue: 0n,
        cohort: {} as IMiningCohortFinancialRecord,
        recoveredValue: 0n,
        remainingSeatValue: 20n,
      },
    ];

    for (const receivable of receivables) {
      const book = new FinancialPositionBook();
      book.setScope({ ownedAccounts: ['5wallet'] });
      book.publish(book.beginRefresh('liquid'), [walletPosition], block10);
      book.publish(book.beginRefresh(receivable.group), [receivable], block10, block10);
      expect(reduceFinancialPositions(book.snapshots).netWorth).toBe(120n);

      const didCommit = book.commit([
        {
          refresh: book.beginRefresh('liquid'),
          positions: [{ ...walletPosition, currentValue: 120n }],
          observation: block11,
        },
        {
          refresh: book.beginRefresh(receivable.group),
          positions: [receivable],
          observation: block10,
          requiredObservation: block11,
        },
      ]);

      expect(didCommit).toBe(false);
      const aggregate = reduceFinancialPositions(book.snapshots);
      const group = aggregate.groupSummaries[receivable.group];
      expect(aggregate.netWorth).toBe(120n);
      expect(aggregate.readiness).toBe('partial');
      expect(aggregate.groupSummaries.liquid).toMatchObject({ state: 'stale', currentValue: 100n });
      expect(group).toMatchObject({ state: 'stale', currentValue: 20n });

      const revisionBeforeCompletion = book.revision;
      const didComplete = book.commit([
        {
          refresh: book.beginRefresh('liquid'),
          positions: [{ ...walletPosition, currentValue: 120n }],
          observation: block11,
        },
        {
          refresh: book.beginRefresh(receivable.group),
          positions: [],
          observation: block11,
          requiredObservation: block11,
        },
      ]);
      expect(didComplete).toBe(true);
      expect(book.revision).toBe(revisionBeforeCompletion + 1);
      expect(book.snapshots.find(snapshot => snapshot.group === receivable.group)).toMatchObject({
        state: 'ready',
        positions: [],
      });
    }
  });

  it('keeps prior bond principal or vault revenue when hold reconciliation cannot align', () => {
    const observation = {
      observedAt: new Date('2026-07-14T12:10:00Z'),
      blockNumber: 20,
      blockHash: '0x20',
    };
    const releasedNativeValue = {
      id: 'wallet-with-unattributed-release',
      kind: 'wallet-balance',
      group: 'liquid',
      label: 'Available and held ARGN',
      lifecycle: 'available',

      currentValue: 120n,
      wallet,
      balanceType: 'unattributed-hold',
      asset: 'ARGN',
    } satisfies IFinancialPosition;
    const positions: IFinancialPosition[] = [
      {
        id: 'bond-1',
        kind: 'bond',
        group: 'bonds',
        label: 'Vault bond',
        lifecycle: 'active',

        currentValue: 20n,
        paidIncome: 0n,
        settledPrincipalValue: 0n,
        bondLot: createBondLot({ id: 1, bonds: 20, cumulativeEarnings: 0n }),
        nativeAsset: 'ARGN',
        nativePrincipal: 20n,
      },
      {
        id: 'vault-1',
        kind: 'vault',
        group: 'vaulting',
        label: 'Vault 1',
        vaultId: 1,
        lifecycle: 'active',

        currentValue: 20n,
        paidIncome: 0n,
        settledPrincipalValue: 0n,
        vault: {} as Vault,
        securitization: 0n,
        uncollectedRevenue: 20n,
        capitalHistory: [],
        revenueHistory: [],
      },
    ];

    for (const position of positions) {
      const book = new FinancialPositionBook();
      book.setScope({ ownedAccounts: ['5wallet'] });
      book.publish(book.beginRefresh('liquid'), [releasedNativeValue], observation);
      book.publish(book.beginRefresh(position.group), [position], observation);
      expect(reduceFinancialPositions(book.snapshots).netWorth).toBe(140n);

      book.fail(
        [book.beginRefresh('liquid'), book.beginRefresh(position.group)],
        'Native holds do not match domain state',
      );

      const aggregate = reduceFinancialPositions(book.snapshots);
      expect(aggregate.netWorth).toBe(140n);
      expect(aggregate.readiness).toBe('partial');
      expect(aggregate.groupSummaries.liquid).toMatchObject({ state: 'stale', currentValue: 120n });
      expect(aggregate.groupSummaries[position.group]).toMatchObject({
        state: 'stale',
        currentValue: 20n,
      });
    }
  });
});

function createWalletsForFinancialTest(
  defaultArgonAddress: string,
  transfers: readonly IWalletTransferRecord[] = [],
): WalletFinancials {
  const wallets = new WalletsForArgon({
    walletKeys: {
      defaultArgonAddress,
      miningBotAddress: '5miner',
      operationalAddress: '5operational',
      legacyMiningHoldAddress: '5legacy',
    } as any,
    dbPromise: Promise.resolve({
      walletTransfersTable: { revision: 0, fetchArgonotCustody: async () => transfers },
    } as any),
    blockWatch: {} as any,
    currency: {} as any,
  });
  return new WalletFinancials(wallets);
}

function createArgonAccount(
  values: Partial<
    Pick<
      IArgonAccountBalance,
      | 'availableMicrogons'
      | 'reservedMicrogons'
      | 'availableMicronots'
      | 'reservedMicronots'
      | 'microgonHolds'
      | 'micronotHolds'
    >
  > & {
    address?: string;
    microgonTreasuryHold?: bigint;
    micronotTreasuryHold?: bigint;
  },
): IArgonAccountBalance {
  const registry = getOfflineRegistry();
  const microgonHolds = [...(values.microgonHolds ?? [])];
  const micronotHolds = [...(values.micronotHolds ?? [])];

  if (values.microgonTreasuryHold !== undefined) {
    microgonHolds.push(
      registry.createType('FrameSupportTokensMiscIdAmountRuntimeHoldReason', {
        id: { Treasury: 'ContributedToTreasury' },
        amount: values.microgonTreasuryHold,
      }),
    );
  }
  if (values.micronotTreasuryHold !== undefined) {
    micronotHolds.push(
      registry.createType('FrameSupportTokensMiscIdAmountRuntimeHoldReason', {
        id: { Treasury: 'ContributedToTreasury' },
        amount: values.micronotTreasuryHold,
      }),
    );
  }

  return {
    address: values.address ?? '5default',
    wallet: { ...wallet, address: values.address ?? '5default' } as unknown as WalletForArgon,
    availableMicrogons: values.availableMicrogons ?? 0n,
    reservedMicrogons: values.reservedMicrogons ?? 0n,
    availableMicronots: values.availableMicronots ?? 0n,
    reservedMicronots: values.reservedMicronots ?? 0n,
    microgonHolds,
    micronotHolds,
  };
}

function createWalletTransfer(
  values: Pick<IWalletTransferRecord, 'id' | 'amount'> & Partial<IWalletTransferRecord>,
): IWalletTransferRecord {
  const blockNumber = values.blockNumber ?? values.id;
  const blockTime = values.blockTime ?? new Date('2026-07-01T00:00:00Z');

  return {
    walletAddress: '5default',
    walletName: 'defaultArgon',
    currency: 'argonot',
    transferType: 'transfer',
    isInternal: false,
    extrinsicIndex: 1,
    microgonsForArgonot: 1_000_000n,
    microgonsForUsd: 1_000_000n,
    blockHash: `0x${blockNumber}`,
    ...values,
    blockNumber,
    blockTime,
    createdAt: values.createdAt ?? blockTime,
    updatedAt: values.updatedAt ?? blockTime,
  };
}

function createMiningCohort(values: Partial<IMiningCohortFinancialRecord> = {}): IMiningCohortFinancialRecord {
  return {
    id: 12,
    progress: 100,
    transactionFeesTotal: 0n,
    micronotsStakedPerSeat: 10_000_000n,
    microgonsBidPerSeat: 20_000_000n,
    seatCountWon: 1,
    microgonsToBeMinedPerSeat: 0n,
    micronotsToBeMinedPerSeat: 0n,
    argonotPriceAtBid: 2_000_000n,
    closingArgonotPrice: 3_000_000n,
    micronotsMinedTotal: 0n,
    microgonsMinedTotal: 20_000_000n,
    microgonsMintedTotal: 0n,
    microgonFeesCollectedTotal: 0n,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-11T00:00:00Z',
    ...values,
  };
}

function createBondLot(args: {
  id: number;
  bonds: number;
  cumulativeEarnings: bigint;
  program?: { Vault: { vaultId: number; sharingPercent: number; bonusPercent: number } } | { Argonot: null };
}): BondLot {
  const lot = getOfflineRegistry().createType<PalletTreasuryBondLot>('PalletTreasuryBondLot', {
    owner: `0x${'11'.repeat(32)}`,
    program: args.program ?? { Vault: { vaultId: 1, sharingPercent: 0, bonusPercent: 0 } },
    bonds: args.bonds,
    createdFrameId: 7,
    participatedFrames: 2,
    lastFrameEarningsFrameId: 8,
    lastFrameEarnings: args.cumulativeEarnings,
    cumulativeEarnings: args.cumulativeEarnings,
    releaseFrameId: null,
    releaseReason: null,
  });

  return BondLot.fromRuntime(args.id, lot, lot.owner.toString());
}
