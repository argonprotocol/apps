import {
  bigIntAbs,
  bigIntMin,
  calculateMiningPositionValue,
  calculateMiningTermPositionValue,
  calculatePrincipalPositionValue,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import type { IMiningCohortFinancialRecord } from '../../interfaces/db/ICohortFrameRecord.ts';
import type { IFrameBidRecord } from '../../interfaces/db/IFrameBidRecord.ts';
import {
  createFinancialPosition,
  type IFinancialPosition,
  type IFinancialPositionSource,
  type IMiningArgonotFinancialPosition,
  type IMiningCohortFinancialPosition,
} from '../../interfaces/IFinancialPosition.ts';
import type { IWalletTransferRecord } from '../db/WalletTransfersTable.ts';
import { takeFifoLots } from '../Utils.ts';
import type { IArgonAccountBalance } from '../WalletsForArgon.ts';
import type { MyMiningSeats } from '../MyMiningSeats.ts';

export type MiningFinancialPosition = Extract<IFinancialPosition, { group: 'mining' }>;

type MiningFinancialPositionArgs = {
  accounts: readonly IArgonAccountBalance[];
  miningBotAddress: string;
  hasConfirmedHistoryCoverage: boolean;
};

type MiningPositionData = {
  cohorts: readonly IMiningCohortFinancialRecord[];
  latestFrameId: number;
  pendingBids: readonly IFrameBidRecord[];
  heldMicrogons: bigint;
  heldMicronots: bigint;
  liveArgonotRateMicrogons?: bigint;
  frameDates: ReadonlyMap<number, Date>;
  custodyTransfers?: readonly IWalletTransferRecord[];
  miningBotAddress: string;
  miningBotMicronots: bigint;
  hasConfirmedHistoryCoverage?: boolean;
};

type MiningArgonotLot = {
  id: string;
  source: 'custody' | 'collateral' | 'rewards';
  cohort?: IMiningCohortFinancialRecord;
  amount: bigint;
  entryRate?: bigint;
  startedAt?: Date;
  releaseFrame: number;
  releaseAt?: Date;
  closing?: {
    id: string;
    rate?: bigint;
    endedAt?: Date;
  };
};

type MiningArgonotBoundary =
  | {
      kind: 'cohort' | 'rewards';
      order: number;
      cohort: IMiningCohortFinancialRecord;
      occurredAt?: Date;
      sortOrder: number;
    }
  | {
      kind: 'deposit' | 'exit';
      order: number;
      transfer: IWalletTransferRecord;
      occurredAt: Date;
      sortOrder: number;
    };

export class MiningFinancials
  implements IFinancialPositionSource<MiningFinancialPositionArgs, MiningFinancialPosition>
{
  constructor(private readonly seats: MyMiningSeats) {}

  public async loadPositions(args: MiningFinancialPositionArgs): Promise<MiningFinancialPosition[]> {
    await this.seats.load();

    const frameIds = new Set<number>();
    for (const cohort of this.seats.miningCohorts) {
      frameIds.add(cohort.id);
      frameIds.add(cohort.id + NetworkConfig.framesPerCohort);
    }
    const custodyTransfers = args.hasConfirmedHistoryCoverage
      ? await this.seats.db.walletTransfersTable.fetchArgonotCustodyBoundaries(args.miningBotAddress)
      : [];
    const heldMicrogons = args.accounts.reduce((total, account) => total + getMiningHolds(account.microgonHolds), 0n);
    const heldMicronots = args.accounts.reduce((total, account) => total + getMiningHolds(account.micronotHolds), 0n);
    const miningBotAccount = args.accounts.find(account => account.address === args.miningBotAddress);
    if (!miningBotAccount) throw new Error('Mining account is missing from the Argon wallet snapshot');

    return this.createFinancialPositions({
      ...args,
      cohorts: this.seats.miningCohorts,
      latestFrameId: this.seats.latestFrameId,
      pendingBids: this.seats.currentFrameBids,
      heldMicrogons,
      heldMicronots,
      miningBotMicronots: miningBotAccount.availableMicronots + miningBotAccount.reservedMicronots,
      liveArgonotRateMicrogons: this.seats.currency.microgonsPer.ARGNOT,
      frameDates: new Map(
        [...frameIds].map(frameId => [frameId, this.seats.miningFrames.getFrameDate(frameId)] as const),
      ),
      custodyTransfers,
    });
  }

  public createFinancialPositions({
    cohorts,
    latestFrameId,
    pendingBids,
    heldMicrogons,
    heldMicronots,
    liveArgonotRateMicrogons,
    frameDates,
    custodyTransfers = [],
    miningBotAddress,
    miningBotMicronots,
    hasConfirmedHistoryCoverage = true,
  }: MiningPositionData): MiningFinancialPosition[] {
    const positions: MiningFinancialPosition[] = cohorts.map(cohort => {
      return createMiningCohortFinancialPosition({
        cohort,
        latestFrameId,
        liveArgonotRateMicrogons,
        frameDates,
      });
    });
    const custodyPositions = createMiningArgonotPositions({
      cohorts,
      latestFrameId,
      liveArgonotRateMicrogons,
      frameDates,
      custodyTransfers,
      miningBotAddress,
      miningBotMicronots,
      hasConfirmedHistoryCoverage,
    });
    positions.push(...custodyPositions);

    const activeStakedMicronots = custodyPositions.reduce((sum, position) => {
      return position.lifecycle === 'held' ? sum + position.micronots : sum;
    }, 0n);
    const pendingBidMicrogons = pendingBids.reduce((sum, bid) => sum + bid.microgonsPerSeat, 0n);
    if (heldMicrogons !== pendingBidMicrogons) {
      throw new Error('ARGN MiningSlot holds do not match pending mining bids');
    }
    if (heldMicronots < activeStakedMicronots) {
      throw new Error('ARGNOT MiningSlot holds do not cover active mining collateral');
    }

    const requestedPendingMicronots = pendingBids.reduce((sum, bid) => sum + bid.micronotsStakedPerSeat, 0n);
    const pendingMicronotHolds = heldMicronots - activeStakedMicronots;
    if (pendingMicronotHolds > requestedPendingMicronots) {
      throw new Error('ARGNOT MiningSlot holds exceed active and pending mining collateral');
    }
    if (pendingMicronotHolds !== 0n && pendingMicronotHolds !== requestedPendingMicronots) {
      throw new Error('ARGNOT MiningSlot holds cannot be attributed across pending mining bids');
    }

    const currentArgonotRate = liveArgonotRateMicrogons || undefined;
    let reusableMiningMicronots = custodyPositions.reduce((sum, position) => {
      return position.lifecycle === 'active' ? sum + position.micronots : sum;
    }, 0n);
    for (const bid of pendingBids) {
      const reusedMicronots = bigIntMin(reusableMiningMicronots, bid.micronotsStakedPerSeat);
      reusableMiningMicronots -= reusedMicronots;
      const nativeStakedMicronots = pendingMicronotHolds === 0n ? 0n : bid.micronotsStakedPerSeat - reusedMicronots;
      const value = calculateMiningPositionValue({
        isActive: true,
        bidPrincipal: bid.microgonsPerSeat,
        nativeStakedMicronots,
        microgonsMined: 0n,
        microgonsMinted: 0n,
        micronotsMined: 0n,
        feeIncome: 0n,
        transactionFees: 0n,
        entryArgonotPrice: currentArgonotRate,
        currentArgonotPrice: currentArgonotRate,
      });
      positions.push(
        createFinancialPosition(
          'mining-bid',
          {
            id: `mining-bid:${bid.frameId}:${bid.address}`,
            label: 'Pending mining bid',
            lifecycle: 'reserved',
            startedAt: new Date(bid.createdAt),
            bid,
            nativeStakedMicronots,
            entryArgonotRateMicrogons: currentArgonotRate,
            currentArgonotRateMicrogons: currentArgonotRate,
          },
          value,
        ),
      );
    }

    return positions;
  }
}

export function createMiningCohortFinancialPosition({
  cohort,
  latestFrameId,
  liveArgonotRateMicrogons,
  frameDates,
}: {
  cohort: IMiningCohortFinancialRecord;
  latestFrameId: number;
  liveArgonotRateMicrogons?: bigint;
  frameDates: ReadonlyMap<number, Date>;
}): IMiningCohortFinancialPosition {
  const isActive = cohort.id > latestFrameId - NetworkConfig.framesPerCohort;
  const seatCount = BigInt(cohort.seatCountWon);
  const currentArgonotRateMicrogons = isActive ? liveArgonotRateMicrogons || undefined : undefined;
  const closingArgonotRateMicrogons = isActive ? undefined : cohort.closingArgonotPrice || undefined;
  const value = calculateMiningTermPositionValue({
    isActive,
    bidPrincipal: cohort.microgonsBidPerSeat * seatCount,
    microgonsMined: cohort.microgonsMinedTotal,
    microgonsMinted: cohort.microgonsMintedTotal,
    micronotsMined: cohort.micronotsMinedTotal,
    feeIncome: cohort.microgonFeesCollectedTotal,
    transactionFees: cohort.transactionFeesTotal,
    currentArgonotPrice: currentArgonotRateMicrogons,
    closingArgonotPrice: closingArgonotRateMicrogons,
  });
  let lifecycle: IMiningCohortFinancialPosition['lifecycle'] = 'completed';
  if (isActive) lifecycle = 'active';
  else if (value.remainingGuaranteedValue > 0n) lifecycle = 'releasing';

  return createFinancialPosition(
    'mining-cohort',
    {
      id: `mining-cohort:${cohort.id}`,
      label: `Mining cohort ${cohort.id}`,
      lifecycle,
      startedAt: frameDates.get(cohort.id),
      endedAt: isActive ? undefined : frameDates.get(cohort.id + NetworkConfig.framesPerCohort),
      cohort,
      recoveredValue: value.recoveredValue,
      remainingGuaranteedValue: value.remainingGuaranteedValue,
      currentArgonotRateMicrogons,
      closingArgonotRateMicrogons,
    },
    value,
  );
}

// Released collateral is reused FIFO. Exits must remain interleaved with cohorts because a withdrawal can occur
// before a later cohort recommits the remaining ARGNOT. Recovered exits can lag, so live custody caps open lots.
function createMiningArgonotPositions({
  cohorts,
  latestFrameId,
  liveArgonotRateMicrogons,
  frameDates,
  custodyTransfers,
  miningBotAddress,
  miningBotMicronots,
  hasConfirmedHistoryCoverage,
}: {
  cohorts: readonly IMiningCohortFinancialRecord[];
  latestFrameId: number;
  liveArgonotRateMicrogons?: bigint;
  frameDates: ReadonlyMap<number, Date>;
  custodyTransfers: readonly IWalletTransferRecord[];
  miningBotAddress: string;
  miningBotMicronots: bigint;
  hasConfirmedHistoryCoverage: boolean;
}): IMiningArgonotFinancialPosition[] {
  // CohortFrames already aggregate block rewards. A completed cohort therefore opens one reward lot
  // at its closing mark; retaining the per-block reward stream would add data without changing the basis.
  const boundaries: MiningArgonotBoundary[] = [];
  for (const cohort of cohorts) {
    const releaseFrame = cohort.id + NetworkConfig.framesPerCohort;
    if (releaseFrame <= latestFrameId && cohort.micronotsMinedTotal > 0n) {
      boundaries.push({
        kind: 'rewards',
        order: 0,
        cohort,
        occurredAt: frameDates.get(releaseFrame),
        sortOrder: releaseFrame,
      });
    }
    boundaries.push({
      kind: 'cohort',
      order: 1,
      cohort,
      occurredAt: frameDates.get(cohort.id),
      sortOrder: cohort.id,
    });
  }
  for (const transfer of hasConfirmedHistoryCoverage ? custodyTransfers : []) {
    const occurredAt = transfer.blockTime;
    if (!occurredAt || transfer.microgonsForArgonot <= 0n) continue;

    const depositedFromOwnedWallet =
      transfer.isInternal && transfer.amount < 0n && transfer.otherParty === miningBotAddress;
    const depositedFromExternalWallet =
      !transfer.isInternal && transfer.amount > 0n && transfer.walletAddress === miningBotAddress;
    if (depositedFromOwnedWallet || depositedFromExternalWallet) {
      boundaries.push({ kind: 'deposit', order: 0, transfer, occurredAt, sortOrder: transfer.blockNumber });
      continue;
    }

    const returnedToOwnedWallet =
      transfer.isInternal && transfer.amount > 0n && transfer.otherParty === miningBotAddress;
    const sentFromMiningWallet =
      !transfer.isInternal && transfer.amount < 0n && transfer.walletAddress === miningBotAddress;
    if (returnedToOwnedWallet || sentFromMiningWallet) {
      boundaries.push({ kind: 'exit', order: 2, transfer, occurredAt, sortOrder: transfer.blockNumber });
    }
  }
  boundaries.sort((left, right) => {
    const leftTime = left.occurredAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.occurredAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    if (left.order !== right.order) return left.order - right.order;
    return left.sortOrder - right.sortOrder;
  });
  const openLots: MiningArgonotLot[] = [];
  const closedLots: MiningArgonotLot[] = [];

  for (const boundary of boundaries) {
    if (boundary.kind === 'deposit') {
      const { transfer, occurredAt } = boundary;
      openLots.push({
        id: `custody:${transfer.id}`,
        source: 'custody',
        amount: bigIntAbs(transfer.amount),
        entryRate: transfer.microgonsForArgonot,
        startedAt: occurredAt,
        releaseFrame: 0,
        releaseAt: occurredAt,
      });
      continue;
    }

    if (boundary.kind === 'exit') {
      const { transfer, occurredAt } = boundary;
      const amount = bigIntAbs(transfer.amount);
      closedLots.push(
        ...closeMiningArgonotLots(openLots, {
          amount,
          closing: {
            id: `transfer:${transfer.id}`,
            rate: transfer.microgonsForArgonot,
            endedAt: occurredAt,
          },
          isAvailable: lot => {
            return lot.releaseAt !== undefined && lot.releaseAt <= occurredAt;
          },
        }),
      );
      continue;
    }

    if (boundary.kind === 'rewards') {
      const { cohort, occurredAt } = boundary;
      const releaseFrame = cohort.id + NetworkConfig.framesPerCohort;
      openLots.push({
        id: `rewards:${cohort.id}`,
        source: 'rewards',
        cohort,
        amount: cohort.micronotsMinedTotal,
        entryRate: cohort.closingArgonotPrice || undefined,
        startedAt: occurredAt,
        releaseFrame,
        releaseAt: occurredAt,
      });
      continue;
    }
    if (boundary.kind !== 'cohort') continue;

    const { cohort, occurredAt } = boundary;
    const amount = cohort.micronotsStakedPerSeat * BigInt(cohort.seatCountWon);
    const entryRate = cohort.argonotPriceAtBid || undefined;
    closedLots.push(
      ...closeMiningArgonotLots(openLots, {
        amount,
        closing: { id: `cohort:${cohort.id}`, rate: entryRate, endedAt: occurredAt },
        isAvailable: lot => lot.releaseFrame <= cohort.id,
      }),
    );
    if (amount === 0n) continue;

    const releaseFrame = cohort.id + NetworkConfig.framesPerCohort;
    openLots.push({
      id: `collateral:${cohort.id}`,
      source: 'collateral',
      cohort,
      amount,
      entryRate,
      startedAt: occurredAt,
      releaseFrame,
      releaseAt: frameDates.get(releaseFrame),
    });
  }

  const openMicronots = openLots.reduce((sum, lot) => sum + lot.amount, 0n);
  let unreconciledMicronots = 0n;
  if (openMicronots > miningBotMicronots) {
    takeFifoLots(openLots, openMicronots - miningBotMicronots);
  } else if (openMicronots < miningBotMicronots) {
    unreconciledMicronots = miningBotMicronots - openMicronots;
  }

  const currentRate = liveArgonotRateMicrogons || undefined;
  const lots = hasConfirmedHistoryCoverage ? [...closedLots, ...openLots] : openLots;
  const positions = lots.map(lot => {
    let lifecycle: IMiningArgonotFinancialPosition['lifecycle'] = 'active';
    if (lot.closing) lifecycle = 'completed';
    else if (lot.releaseFrame > latestFrameId) lifecycle = 'held';

    const entryRate = lot.entryRate;
    const value = calculatePrincipalPositionValue({
      nativeAsset: 'ARGNOT',
      nativePrincipal: lot.amount,
      cumulativeEarnings: 0n,
      lifecycle: lot.closing ? 'completed' : 'active',
      entryArgonotPrice: entryRate,
      currentArgonotPrice: currentRate,
      closingArgonotPrice: lot.closing?.rate,
    });

    let label = 'Mining collateral';
    if (lot.source === 'rewards') label = 'Mined ARGNOT';
    if (lot.source === 'custody') label = 'Mining custody';

    return createFinancialPosition(
      'mining-argonot',
      {
        id: `mining-argonot:${lot.id}:${lot.closing?.id ?? 'active'}`,
        label,
        lifecycle,
        source: lot.source,
        startedAt: lot.startedAt,
        endedAt: lot.closing?.endedAt,
        cohort: lot.cohort,
        micronots: lot.amount,
        entryArgonotRateMicrogons: entryRate,
        currentArgonotRateMicrogons: lot.closing ? undefined : currentRate,
        closingArgonotRateMicrogons: lot.closing?.rate,
      },
      value,
    );
  });

  if (unreconciledMicronots > 0n) {
    positions.push(
      createFinancialPosition(
        'mining-argonot',
        {
          id: 'mining-argonot:history-unavailable',
          label: 'Mining ARGNOT history unavailable',
          lifecycle: 'active',
          source: 'unattributed',
          micronots: unreconciledMicronots,
          currentArgonotRateMicrogons: currentRate,
        },
        calculatePrincipalPositionValue({
          nativeAsset: 'ARGNOT',
          nativePrincipal: unreconciledMicronots,
          cumulativeEarnings: 0n,
          lifecycle: 'active',
          currentArgonotPrice: currentRate,
        }),
      ),
    );
  }
  return positions;
}

function closeMiningArgonotLots(
  lots: MiningArgonotLot[],
  {
    amount,
    closing,
    isAvailable,
  }: {
    amount: bigint;
    closing: NonNullable<MiningArgonotLot['closing']>;
    isAvailable: (lot: MiningArgonotLot) => boolean;
  },
): MiningArgonotLot[] {
  return takeFifoLots(lots, amount, isAvailable).map(lot => ({ ...lot, closing }));
}

function getMiningHolds(holds: IArgonAccountBalance['microgonHolds']): bigint {
  return holds.filter(hold => hold.id.isMiningSlot).reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
}
