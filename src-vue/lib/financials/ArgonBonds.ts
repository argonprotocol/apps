import { BondLot, calculatePrincipalPositionValue } from '@argonprotocol/apps-core';
import {
  createFinancialPosition,
  type IBondFinancialPosition,
  type IFinancialPositionSource,
} from '../../interfaces/IFinancialPosition.ts';
import { getBondEarnings } from '../BondEarnings.ts';
import type { IBondEarningsRecord } from '../db/BondEarningsTable.ts';
import type { IBondLotHistoryRecord } from '../db/BondLotHistoryTable.ts';
import type { ArgonBonds } from '../ArgonBonds.ts';
import type { IArgonAccountBalance } from '../WalletsForArgon.ts';

type ArgonBondFinancialPositionArgs = {
  account: IArgonAccountBalance;
  liveArgonotRateMicrogons?: bigint;
};

type ArgonBondPositionData = {
  bondLots?: readonly BondLot[];
  historyRecords?: readonly IBondLotHistoryRecord[];
  dailyEarnings?: readonly IBondEarningsRecord[];
  completedFrame?: number;
  liveArgonotRateMicrogons?: bigint;
  entryArgonotMarksByLot?: ReadonlyMap<string, bigint>;
  frameDates: ReadonlyMap<number, Date>;
};

export class ArgonBondsFinancials
  implements IFinancialPositionSource<ArgonBondFinancialPositionArgs, IBondFinancialPosition>
{
  constructor(private readonly bonds: ArgonBonds) {}

  public async loadPositions(args: ArgonBondFinancialPositionArgs): Promise<IBondFinancialPosition[]> {
    const treasuryMicrogons = args.account.microgonHolds
      .filter(hold => hold.id.type === 'Treasury')
      .reduce((sum, hold) => sum + hold.amount, 0n);
    const treasuryMicronots = args.account.micronotHolds
      .filter(hold => hold.id.type === 'Treasury')
      .reduce((sum, hold) => sum + hold.amount, 0n);
    const released = new Set(
      this.bonds.data.bondHistory
        .filter(record => record.releaseBlockHash !== undefined)
        .map(record => this.bondKey(record.accountId, record.programType, record.bondLotId)),
    );
    const bondLots = this.bonds.data.bondLots.filter(
      lot => !released.has(this.bondKey(lot.owner, lot.programType, lot.id)),
    );
    const totals = BondLot.getTotals(bondLots);
    const overdueAmbiguity = bondLots.some(
      lot => lot.isReleasing && lot.releaseFrameId !== null && lot.releaseFrameId <= this.bonds.data.currentFrameId,
    );
    const detail = overdueAmbiguity ? '; an overdue release has no verified close event or hold transition' : '';
    if (treasuryMicrogons !== totals.totalBondMicrogons) {
      throw new Error(`ARGN Treasury holds do not match live bond principal for ${args.account.address}${detail}`);
    }
    if (treasuryMicronots !== totals.totalArgonotBondMicronots) {
      throw new Error(`ARGNOT Treasury holds do not match live bond principal for ${args.account.address}${detail}`);
    }

    const frameIds = new Set<number>();
    for (const lot of bondLots) frameIds.add(lot.createdFrameId);
    for (const record of this.bonds.data.bondHistory) frameIds.add(record.createdFrame);
    const frameDates = new Map(
      [...frameIds].map(frameId => [frameId, this.bonds.miningFrames.getFrameDate(frameId)] as const),
    );
    const entryArgonotMarksByLot = new Map(
      this.bonds.data.bondHistory.flatMap(record => {
        if (record.entryArgonotRateMicrogons === undefined) return [];
        return [
          [
            this.bondKey(record.accountId, record.programType, record.bondLotId),
            record.entryArgonotRateMicrogons,
          ] as const,
        ];
      }),
    );

    return this.createFinancialPositions({
      ...args,
      bondLots,
      historyRecords: this.bonds.data.bondHistory,
      dailyEarnings: this.bonds.data.dailyEarnings,
      completedFrame: this.bonds.data.currentFrameId - 1,
      entryArgonotMarksByLot,
      frameDates,
    });
  }

  public createFinancialPositions({
    bondLots = [],
    historyRecords = [],
    dailyEarnings = [],
    completedFrame,
    liveArgonotRateMicrogons,
    entryArgonotMarksByLot = new Map(),
    frameDates,
  }: ArgonBondPositionData): IBondFinancialPosition[] {
    const positions: IBondFinancialPosition[] = [];
    const liveBondKeys = new Set(bondLots.map(bondLot => this.bondKey(bondLot.owner, bondLot.programType, bondLot.id)));
    const currentArgonotRateMicrogons = liveArgonotRateMicrogons ?? 0n;
    const canValueArgonot = currentArgonotRateMicrogons > 0n;
    const historyByLot = new Map(
      historyRecords.map(record => [this.bondKey(record.accountId, record.programType, record.bondLotId), record]),
    );
    for (const bondLot of bondLots) {
      const startedAt = frameDates.get(bondLot.createdFrameId);
      const lifecycle = bondLot.isReleasing ? 'releasing' : 'active';

      if (bondLot.programType === 'Vault') {
        const key = this.bondKey(bondLot.owner, bondLot.programType, bondLot.id);
        positions.push(
          this.createVaultBondPosition(bondLot, historyByLot.get(key), frameDates, dailyEarnings, completedFrame),
        );
        continue;
      }

      const nativePrincipal = bondLot.principalMicronots ?? 0n;
      const history = historyByLot.get(this.bondKey(bondLot.owner, bondLot.programType, bondLot.id));
      const entryArgonotRateMicrogons = entryArgonotMarksByLot.get(
        this.bondKey(bondLot.owner, bondLot.programType, bondLot.id),
      );
      const value = calculatePrincipalPositionValue({
        nativeAsset: 'ARGNOT',
        nativePrincipal,
        cumulativeEarnings: bondLot.cumulativeEarnings,
        lifecycle,
        entryArgonotPrice: entryArgonotRateMicrogons,
        currentArgonotPrice: canValueArgonot ? currentArgonotRateMicrogons : undefined,
      });
      positions.push(
        createFinancialPosition(
          'bond',
          {
            id: this.bondPositionId(bondLot),
            label: 'ARGNOT bond',
            lifecycle,
            startedAt,
            bondLot,
            nativeAsset: 'ARGNOT',
            nativePrincipal,
            returnIsComplete:
              history?.earningsComplete !== false && (!history || history.nativePrincipal === nativePrincipal),
            entryArgonotRateMicrogons,
            currentArgonotRateMicrogons: canValueArgonot ? currentArgonotRateMicrogons : undefined,
          },
          value,
        ),
      );
    }

    for (const record of historyRecords) {
      if (!record.releaseBlockHash) continue;
      if (liveBondKeys.has(this.bondKey(record.accountId, record.programType, record.bondLotId))) continue;

      const isArgonot = record.programType === 'Argonot';
      if (!isArgonot) {
        positions.push(this.createVaultBondPosition(record, record, frameDates, dailyEarnings, completedFrame));
        continue;
      }
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
            id: this.bondPositionId(record),
            label: 'ARGNOT bond',
            lifecycle: 'completed',
            startedAt: record.purchaseBlockTime ?? frameDates.get(record.createdFrame),
            endedAt: record.releaseBlockTime,
            history: record,
            nativeAsset: record.nativeAsset,
            nativePrincipal: record.nativePrincipal,
            returnIsComplete: record.earningsComplete !== false,
            entryArgonotRateMicrogons: record.entryArgonotRateMicrogons,
            closingArgonotRateMicrogons: record.closingArgonotRateMicrogons,
          },
          value,
        ),
      );
    }

    return positions;
  }

  private createVaultBondPosition(
    value: BondLot | IBondLotHistoryRecord,
    history: IBondLotHistoryRecord | undefined,
    frameDates: ReadonlyMap<number, Date>,
    dailyEarnings: readonly IBondEarningsRecord[],
    completedFrame?: number,
  ): IBondFinancialPosition {
    const bondLot = value instanceof BondLot ? value : undefined;
    const lotId = bondLot?.id ?? history!.bondLotId;
    const nativePrincipal = bondLot?.principalMicrogons ?? history!.nativePrincipal;
    let lifecycle: IBondFinancialPosition['lifecycle'] = 'completed';
    if (bondLot) lifecycle = bondLot.isReleasing ? 'releasing' : 'active';
    const earnings = getBondEarnings(
      bondLot,
      history,
      dailyEarnings.filter(record => record.bondLotId === lotId),
      completedFrame,
    );
    const source = value instanceof BondLot ? { bondLot: value } : { history: value };
    let returnIsComplete = history?.flexibilityHistoryComplete === true && history.earningsComplete !== false;
    if (history?.nativePrincipal !== nativePrincipal) returnIsComplete = false;
    if (!bondLot && history?.releaseBlockNumber === undefined) returnIsComplete = false;
    if (!earnings.attributionIsComplete) returnIsComplete = false;
    return createFinancialPosition(
      'bond',
      {
        id: this.bondPositionId(value),
        label: value.vaultId == null ? 'Vault bond' : `Vault ${value.vaultId} bond`,
        lifecycle,
        startedAt: history?.purchaseBlockTime ?? frameDates.get(bondLot?.createdFrameId ?? history!.createdFrame),
        endedAt: bondLot ? undefined : history?.releaseBlockTime,
        ...source,
        returnIsComplete,
        nativeAsset: 'ARGN',
        nativePrincipal,
      },
      calculatePrincipalPositionValue({
        nativeAsset: 'ARGN',
        nativePrincipal,
        cumulativeEarnings: earnings.lifetimeEarnings ?? 0n,
        lifecycle,
      }),
    );
  }

  private bondPositionId(value: BondLot | IBondLotHistoryRecord): string {
    const id = value instanceof BondLot ? value.id : value.bondLotId;
    return `bond:${value instanceof BondLot ? value.owner : value.accountId}:${value.programType.toLowerCase()}:${id}`;
  }

  private bondKey(accountId: string, programType: BondLot['programType'], bondLotId: number): string {
    return `${accountId}:${programType}:${bondLotId}`;
  }
}
