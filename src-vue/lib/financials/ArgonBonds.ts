import { BondLot, calculatePrincipalPositionValue } from '@argonprotocol/apps-core';
import {
  createFinancialPosition,
  type IBondFinancialPosition,
  type IFinancialPositionSource,
  withInvestmentBasis,
} from '../../interfaces/IFinancialPosition.ts';
import type { IBondLotHistoryRecord } from '../db/BondLotHistoryTable.ts';
import type { ArgonBonds } from '../ArgonBonds.ts';
import type { IArgonAccountBalance } from '../WalletsForArgon.ts';

type ArgonBondFinancialPositionArgs = {
  account: IArgonAccountBalance;
  hasConfirmedBondHistoryCoverage: boolean;
  liveArgonotRateMicrogons?: bigint;
  ownedVaultId?: number;
};

type ArgonBondPositionData = {
  bondLots?: readonly BondLot[];
  completedRecords?: readonly IBondLotHistoryRecord[];
  hasConfirmedBondHistoryCoverage: boolean;
  liveArgonotRateMicrogons?: bigint;
  entryArgonotMarksByLot?: ReadonlyMap<string, bigint>;
  frameDates: ReadonlyMap<number, Date>;
  ownedVaultId?: number;
};

export class ArgonBondsFinancials
  implements IFinancialPositionSource<ArgonBondFinancialPositionArgs, IBondFinancialPosition>
{
  constructor(private readonly bonds: ArgonBonds) {}

  public async loadPositions(args: ArgonBondFinancialPositionArgs): Promise<IBondFinancialPosition[]> {
    await this.bonds.load();

    const treasuryMicrogons = args.account.microgonHolds
      .filter(hold => hold.id.isTreasury)
      .reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
    const treasuryMicronots = args.account.micronotHolds
      .filter(hold => hold.id.isTreasury)
      .reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
    const totals = this.bonds.bondTotals;
    if (treasuryMicrogons !== totals.totalBondMicrogons) {
      throw new Error(`ARGN Treasury holds do not match live bond principal for ${args.account.address}`);
    }
    if (treasuryMicronots !== totals.totalArgonotBondMicronots) {
      throw new Error(`ARGNOT Treasury holds do not match live bond principal for ${args.account.address}`);
    }

    const frameIds = new Set<number>();
    for (const lot of this.bonds.data.bondLots) frameIds.add(lot.createdFrame);
    for (const record of this.bonds.data.bondHistory) frameIds.add(record.createdFrame);
    const frameDates = new Map(
      [...frameIds].map(frameId => [frameId, this.bonds.miningFrames.getFrameDate(frameId)] as const),
    );
    const entryArgonotMarksByLot = new Map(
      this.bonds.data.bondHistory.flatMap(record => {
        if (record.entryArgonotRateMicrogons === undefined) return [];
        return [
          [`${record.accountId}:${record.programType}:${record.bondLotId}`, record.entryArgonotRateMicrogons] as const,
        ];
      }),
    );

    return this.createFinancialPositions({
      ...args,
      bondLots: this.bonds.data.bondLots,
      completedRecords: this.bonds.completedBondHistory,
      entryArgonotMarksByLot,
      frameDates,
    });
  }

  public createFinancialPositions({
    bondLots = [],
    completedRecords = [],
    hasConfirmedBondHistoryCoverage,
    liveArgonotRateMicrogons,
    entryArgonotMarksByLot = new Map(),
    frameDates,
    ownedVaultId,
  }: ArgonBondPositionData): IBondFinancialPosition[] {
    const positions: IBondFinancialPosition[] = [];
    const liveBondKeys = new Set(
      bondLots.map(bondLot => `${bondLot.accountId}:${bondLot.programType.toLowerCase()}:${bondLot.id}`),
    );
    const currentArgonotRateMicrogons = liveArgonotRateMicrogons ?? 0n;
    const canValueArgonot = currentArgonotRateMicrogons > 0n;

    for (const bondLot of bondLots) {
      const startedAt = frameDates.get(bondLot.createdFrame);
      const lifecycle = bondLot.isReleasing ? 'releasing' : 'active';

      if (bondLot.programType === 'Vault') {
        const nativePrincipal = bondLot.principalMicrogons ?? 0n;
        const value = calculatePrincipalPositionValue({
          nativeAsset: 'ARGN',
          nativePrincipal,
          cumulativeEarnings: bondLot.lifetimeEarnings,
          lifecycle,
        });
        positions.push(
          createFinancialPosition(
            'bond',
            {
              id: `bond:${bondLot.accountId}:${bondLot.programType.toLowerCase()}:${bondLot.id}`,
              label: bondLot.vaultId == null ? 'Vault bond' : `Vault ${bondLot.vaultId} bond`,
              lifecycle,
              excludeFromAccountAggregate: ownedVaultId !== undefined && bondLot.vaultId === ownedVaultId,
              startedAt,
              bondLot,
              nativeAsset: 'ARGN',
              nativePrincipal,
            },
            withInvestmentBasis(value, hasConfirmedBondHistoryCoverage),
          ),
        );
        continue;
      }

      const nativePrincipal = bondLot.principalMicronots ?? 0n;
      const entryArgonotRateMicrogons = entryArgonotMarksByLot.get(
        `${bondLot.accountId}:${bondLot.programType}:${bondLot.id}`,
      );
      const value = calculatePrincipalPositionValue({
        nativeAsset: 'ARGNOT',
        nativePrincipal,
        cumulativeEarnings: bondLot.lifetimeEarnings,
        lifecycle,
        entryArgonotPrice: entryArgonotRateMicrogons,
        currentArgonotPrice: canValueArgonot ? currentArgonotRateMicrogons : undefined,
      });
      positions.push(
        createFinancialPosition(
          'bond',
          {
            id: `bond:${bondLot.accountId}:${bondLot.programType.toLowerCase()}:${bondLot.id}`,
            label: 'ARGNOT bond',
            lifecycle,
            startedAt,
            bondLot,
            nativeAsset: 'ARGNOT',
            nativePrincipal,
            entryArgonotRateMicrogons,
            currentArgonotRateMicrogons: canValueArgonot ? currentArgonotRateMicrogons : undefined,
          },
          withInvestmentBasis(value, hasConfirmedBondHistoryCoverage),
        ),
      );
    }

    for (const record of completedRecords) {
      if (!record.releaseBlockHash) continue;
      if (liveBondKeys.has(`${record.accountId}:${record.programType.toLowerCase()}:${record.bondLotId}`)) continue;

      const isArgonot = record.programType === 'Argonot';
      let label = record.vaultId == null ? 'Vault bond' : `Vault ${record.vaultId} bond`;
      if (isArgonot) label = 'ARGNOT bond';

      const value = calculatePrincipalPositionValue({
        nativeAsset: record.nativeAsset,
        nativePrincipal: record.nativePrincipal,
        cumulativeEarnings: record.cumulativeEarningsMicrogons ?? 0n,
        lifecycle: 'completed',
        entryArgonotPrice: record.entryArgonotRateMicrogons,
        closingArgonotPrice: record.closingArgonotRateMicrogons,
      });
      positions.push(
        createFinancialPosition(
          'bond',
          {
            id: `bond:${record.accountId}:${record.programType.toLowerCase()}:${record.bondLotId}`,
            label,
            lifecycle: 'completed',
            excludeFromAccountAggregate: ownedVaultId !== undefined && record.vaultId === ownedVaultId,
            startedAt: record.purchaseBlockTime ?? frameDates.get(record.createdFrame),
            endedAt: record.releaseBlockTime,
            history: record,
            nativeAsset: record.nativeAsset,
            nativePrincipal: record.nativePrincipal,
            entryArgonotRateMicrogons: record.entryArgonotRateMicrogons,
            closingArgonotRateMicrogons: record.closingArgonotRateMicrogons,
          },
          withInvestmentBasis(value, hasConfirmedBondHistoryCoverage),
        ),
      );
    }

    return positions;
  }
}
