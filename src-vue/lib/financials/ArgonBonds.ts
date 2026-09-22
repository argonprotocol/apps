import { BondLot, calculatePrincipalPositionValue } from '@argonprotocol/apps-core';
import {
  createFinancialPosition,
  type IBondFinancialPosition,
  type IFinancialPositionSource,
} from '../../interfaces/IFinancialPosition.ts';
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
      lot => !released.has(this.bondKey(lot.accountId, lot.programType, lot.id)),
    );
    const totals = BondLot.getTotals(bondLots);
    const overdueAmbiguity = bondLots.some(
      lot => lot.isReleasing && lot.releaseFrame !== null && lot.releaseFrame <= this.bonds.data.currentFrameId,
    );
    const detail = overdueAmbiguity ? '; an overdue release has no verified close event or hold transition' : '';
    if (treasuryMicrogons !== totals.totalBondMicrogons) {
      throw new Error(`ARGN Treasury holds do not match live bond principal for ${args.account.address}${detail}`);
    }
    if (treasuryMicronots !== totals.totalArgonotBondMicronots) {
      throw new Error(`ARGNOT Treasury holds do not match live bond principal for ${args.account.address}${detail}`);
    }

    const frameIds = new Set<number>();
    for (const lot of bondLots) frameIds.add(lot.createdFrame);
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
      entryArgonotMarksByLot,
      frameDates,
    });
  }

  public createFinancialPositions({
    bondLots = [],
    historyRecords = [],
    liveArgonotRateMicrogons,
    entryArgonotMarksByLot = new Map(),
    frameDates,
  }: ArgonBondPositionData): IBondFinancialPosition[] {
    const positions: IBondFinancialPosition[] = [];
    const liveBondKeys = new Set(
      bondLots.map(bondLot => this.bondKey(bondLot.accountId, bondLot.programType, bondLot.id)),
    );
    const currentArgonotRateMicrogons = liveArgonotRateMicrogons ?? 0n;
    const canValueArgonot = currentArgonotRateMicrogons > 0n;
    const historyByLot = new Map(
      historyRecords.map(record => [this.bondKey(record.accountId, record.programType, record.bondLotId), record]),
    );
    for (const bondLot of bondLots) {
      const startedAt = frameDates.get(bondLot.createdFrame);
      const lifecycle = bondLot.isReleasing ? 'releasing' : 'active';

      if (bondLot.programType === 'Vault') {
        const key = this.bondKey(bondLot.accountId, bondLot.programType, bondLot.id);
        positions.push(...this.createVaultBondPositions(bondLot, historyByLot.get(key), frameDates));
        continue;
      }

      const nativePrincipal = bondLot.principalMicronots ?? 0n;
      const entryArgonotRateMicrogons = entryArgonotMarksByLot.get(
        this.bondKey(bondLot.accountId, bondLot.programType, bondLot.id),
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
            id: this.bondPositionId(bondLot),
            label: 'ARGNOT bond',
            lifecycle,
            startedAt,
            bondLot,
            nativeAsset: 'ARGNOT',
            nativePrincipal,
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
        positions.push(...this.createVaultBondPositions(record, record, frameDates));
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
            entryArgonotRateMicrogons: record.entryArgonotRateMicrogons,
            closingArgonotRateMicrogons: record.closingArgonotRateMicrogons,
          },
          value,
        ),
      );
    }

    return positions;
  }

  private createVaultBondPositions(
    value: BondLot | IBondLotHistoryRecord,
    history: IBondLotHistoryRecord | undefined,
    frameDates: ReadonlyMap<number, Date>,
  ): IBondFinancialPosition[] {
    const bondLot = value instanceof BondLot ? value : undefined;
    const lifecycle = bondLot ? (bondLot.isReleasing ? 'releasing' : 'active') : 'completed';
    const nativePrincipal = value instanceof BondLot ? value.bondMicrogons : value.nativePrincipal;
    const cumulativeEarnings =
      value instanceof BondLot ? value.lifetimeEarnings : (value.cumulativeEarningsMicrogons ?? 0n);
    const source = value instanceof BondLot ? { bondLot: value } : { history: value };
    const label = value.vaultId == null ? 'Vault bond' : `Vault ${value.vaultId} bond`;
    const id = this.bondPositionId(value);
    const returnIsComplete =
      history?.flexibilityHistoryComplete === true &&
      (bondLot !== undefined || history.releaseBlockNumber !== undefined);
    const flexibility = history?.flexibilityHistory ?? [];
    const positions: IBondFinancialPosition[] = [];
    let segmentStartedAt = history?.purchaseBlockTime ?? frameDates.get(value.createdFrame);
    let earningsAtStart = 0n;
    let isFlexible = false;
    let segment = 0;
    let flexibleStartedAt: Date | undefined;
    let flexibleSegment = 0;

    for (const transition of flexibility) {
      if (transition.isFlexible && !isFlexible) {
        if (transition.source !== 'purchase') {
          positions.push(
            this.createVaultBondSegment({
              id: `${id}:segment-${segment++}`,
              label,
              startedAt: segmentStartedAt,
              endedAt: transition.blockTime,
              nativePrincipal,
              cumulativeEarnings: transition.cumulativeEarningsMicrogons - earningsAtStart,
              returnIsComplete,
              source,
            }),
          );
        }
        isFlexible = true;
        flexibleStartedAt = transition.blockTime;
      } else if (!transition.isFlexible && isFlexible) {
        positions.push(
          this.createFlexibleVaultBondPosition({
            id: `${id}:flexible-${flexibleSegment++}`,
            label,
            lifecycle: 'completed',
            startedAt: flexibleStartedAt,
            endedAt: transition.blockTime,
            nativePrincipal,
            returnIsComplete,
            source,
          }),
        );
        isFlexible = false;
        if (transition.source !== 'release') {
          segmentStartedAt = transition.blockTime;
          earningsAtStart = transition.cumulativeEarningsMicrogons;
        }
      }
    }

    if (bondLot && (bondLot.isFlexible || isFlexible)) {
      positions.push(
        this.createFlexibleVaultBondPosition({
          id,
          label,
          lifecycle,
          startedAt: flexibleStartedAt,
          nativePrincipal,
          returnIsComplete,
          source,
        }),
      );
    } else if (!isFlexible && flexibility.at(-1)?.source !== 'release') {
      positions.push(
        this.createVaultBondSegment({
          id: segment ? `${id}:segment-${segment}` : id,
          label,
          startedAt: segmentStartedAt,
          endedAt: bondLot ? undefined : history?.releaseBlockTime,
          lifecycle,
          nativePrincipal,
          cumulativeEarnings: cumulativeEarnings - earningsAtStart,
          returnIsComplete,
          source,
        }),
      );
    }
    return positions;
  }

  private createFlexibleVaultBondPosition(args: {
    id: string;
    label: string;
    lifecycle: 'active' | 'releasing' | 'completed';
    startedAt?: Date;
    endedAt?: Date;
    nativePrincipal: bigint;
    returnIsComplete: boolean;
    source: { bondLot: BondLot; history?: never } | { bondLot?: never; history: IBondLotHistoryRecord };
  }): IBondFinancialPosition {
    const { id, label, lifecycle, startedAt, endedAt, nativePrincipal, returnIsComplete, source } = args;
    return createFinancialPosition(
      'bond',
      {
        id,
        label,
        lifecycle,
        startedAt,
        endedAt,
        ...source,
        nativeAsset: 'ARGN',
        nativePrincipal,
        returnIsComplete,
        returnAttribution: 'vault',
      },
      calculatePrincipalPositionValue({
        nativeAsset: 'ARGN',
        nativePrincipal,
        cumulativeEarnings: 0n,
        lifecycle,
      }),
    );
  }

  private createVaultBondSegment(args: {
    id: string;
    label: string;
    startedAt?: Date;
    endedAt?: Date;
    lifecycle?: 'active' | 'releasing' | 'completed';
    nativePrincipal: bigint;
    cumulativeEarnings: bigint;
    returnIsComplete: boolean;
    source: { bondLot: BondLot; history?: never } | { bondLot?: never; history: IBondLotHistoryRecord };
  }): IBondFinancialPosition {
    const {
      id,
      label,
      startedAt,
      endedAt,
      lifecycle = 'completed',
      nativePrincipal,
      cumulativeEarnings,
      returnIsComplete,
      source,
    } = args;
    return createFinancialPosition(
      'bond',
      {
        id,
        label,
        lifecycle,
        startedAt,
        endedAt,
        ...source,
        returnIsComplete,
        nativeAsset: 'ARGN',
        nativePrincipal,
      },
      calculatePrincipalPositionValue({
        nativeAsset: 'ARGN',
        nativePrincipal,
        cumulativeEarnings,
        lifecycle,
      }),
    );
  }

  private bondPositionId(value: BondLot | IBondLotHistoryRecord): string {
    const id = value instanceof BondLot ? value.id : value.bondLotId;
    return `bond:${value.accountId}:${value.programType.toLowerCase()}:${id}`;
  }

  private bondKey(accountId: string, programType: BondLot['programType'], bondLotId: number): string {
    return `${accountId}:${programType}:${bondLotId}`;
  }
}
