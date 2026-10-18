import {
  BondLot,
  TreasuryBonds,
  bigNumberToBigInt,
  fixedU128Rational,
  fixedU128Multiply,
  type ArgonApi,
  type VaultBondState,
  type Currency,
  type IBlockHeaderInfo,
  type MiningFrames,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import type {
  HistoricalQueryRecord,
  TreasuryCurrentFrameVaultCapitalResultSpec158Variant4,
} from '@argonprotocol/runtime-client';
import type { IBondHistoryFact } from '../ArgonBonds.ts';
import type { IBondLotHistoryRecord, IBondLotEarningsBackfill } from '../db/BondLotHistoryTable.ts';
import BigNumber from 'bignumber.js';

export interface IBondFrameEarnings {
  lot: BondLot;
  bonds?: number;
  isFlexible?: boolean;
  displacedMicrogons?: bigint;
  earningsMicrogons?: bigint;
  earningsDestination: 'Owner' | 'Vault';
}

type HistoricalBondLot = NonNullable<HistoricalQueryRecord<'treasury', 'bondLotById'>>;

export class ArgonBondsRecovery {
  constructor(
    private readonly currency: Pick<Currency, 'fetchMainchainRatesAtBlock'>,
    private readonly miningFrames: MiningFrames,
    private readonly accountId: string,
  ) {}

  public async readBlock(
    block: IBlockHeaderInfo,
    events: readonly RuntimeSystemEventRecord[],
  ): Promise<IBondHistoryFact[]> {
    events = normalizeHistoricalBondEvents(events);

    const facts: IBondHistoryFact[] = [];
    const flexibilityByLot = new Map<number, boolean>();
    const earningsBackfillsByLot = new Map<number, Pick<IBondLotEarningsBackfill, 'addedFrames' | 'addedEarnings'>>();
    const bondEvents = [...events.entries()].filter(([, { event }]) => {
      if (event.section !== 'treasury') return false;
      return [
        'BondLotPurchased',
        'BondLotReleaseScheduled',
        'BondLotReleased',
        'CouldNotReleaseBondLot',
        'BondLotFlexibilityChanged',
        'BondLotEarningsBackfilled',
      ].includes(event.method);
    });
    if (!bondEvents.length) return facts;

    const api = await this.miningFrames.blockWatch.getApi(block);
    const distributesEarnings = events.some(
      ({ event }) => event.section === 'treasury' && event.method === 'FrameEarningsDistributed',
    );
    for (const [index, { event, phase }] of bondEvents) {
      if (event.section !== 'treasury') continue;
      const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : undefined;
      switch (event.method) {
        case 'BondLotEarningsBackfilled': {
          const { bondLotId } = event.data;
          const preceding = earningsBackfillsByLot.get(bondLotId);
          const backfill = {
            addedFrames: (preceding?.addedFrames ?? 0) + event.data.addedFrames,
            addedEarnings: (preceding?.addedEarnings ?? 0n) + event.data.addedEarnings,
          };
          earningsBackfillsByLot.set(bondLotId, backfill);
          let lot = await readHistoricalBondLot(api, bondLotId, this.accountId);
          if (!lot) {
            const parent = await this.miningFrames.blockWatch.getHeader(block.blockNumber - 1);
            const parentApi = await this.miningFrames.blockWatch.getApi(parent);
            const previous = await readHistoricalBondLot(parentApi, bondLotId, this.accountId);
            if (previous) {
              lot = previous.withEarningsBackfill(backfill.addedFrames, backfill.addedEarnings);
            }
          }
          if (!lot) throw new Error(`Backfilled bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);
          if (lot.owner !== this.accountId) continue;
          facts.push({
            kind: 'earnings-backfill',
            lot,
            backfill: {
              blockNumber: block.blockNumber,
              blockHash: block.blockHash,
              eventIndex: index,
              addedFrames: event.data.addedFrames,
              addedEarnings: event.data.addedEarnings,
            },
          });
          break;
        }
        case 'BondLotReleaseScheduled': {
          const { bondLotId } = event.data;
          if (event.data.accountId !== this.accountId) continue;
          const lot = await readHistoricalBondLot(api, bondLotId, this.accountId);
          if (!lot) throw new Error(`Scheduled bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);
          facts.push({
            kind: 'release-scheduled',
            lot,
            block,
            extrinsicIndex,
          });
          break;
        }
        case 'BondLotPurchased': {
          const { bondLotId } = event.data;
          if (event.data.accountId !== this.accountId) continue;
          const lot = await readHistoricalBondLot(api, bondLotId, this.accountId);
          if (!lot) throw new Error(`Purchased bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);

          let isFlexibleAtPurchase = lot.isFlexible;
          for (const { event: later } of events.slice(index + 1)) {
            if (later.section !== 'treasury') continue;
            if (later.method === 'BondLotFlexibilityChanged' && later.data.bondLotId === bondLotId) {
              isFlexibleAtPurchase = !later.data.isFlexible;
              break;
            }
          }
          flexibilityByLot.set(bondLotId, isFlexibleAtPurchase);
          const entryArgonotRateMicrogons =
            lot.programType === 'Argonot'
              ? (await this.currency.fetchMainchainRatesAtBlock({ api, block })).ARGNOT
              : undefined;
          facts.push({ kind: 'purchase', lot, block, extrinsicIndex, entryArgonotRateMicrogons, isFlexibleAtPurchase });
          break;
        }
        case 'BondLotReleased':
        case 'CouldNotReleaseBondLot': {
          const { bondLotId } = event.data;
          if (event.data.accountId !== this.accountId) continue;
          let parent: IBlockHeaderInfo;
          try {
            parent = await this.miningFrames.blockWatch.getParentHeader(block);
          } catch (error) {
            if (!block.isFinalized || block.blockNumber === 0) throw error;
            parent = await this.miningFrames.blockWatch.getHeader(block.blockNumber - 1);
          }
          const parentApi = await this.miningFrames.blockWatch.getApi(parent);
          let lot = await readHistoricalBondLot(parentApi, bondLotId, this.accountId);
          if (!lot) throw new Error(`Released bond lot ${bondLotId} is unavailable before block ${block.blockNumber}`);

          const backfill = earningsBackfillsByLot.get(bondLotId);
          if (backfill) {
            lot = lot.withEarningsBackfill(backfill.addedFrames, backfill.addedEarnings);
          }
          if (event.method === 'CouldNotReleaseBondLot') {
            if (
              !(await didFailedReleaseRemoveHold({
                accountId: this.accountId,
                lot,
                events,
                parentApi,
                api,
              }))
            )
              continue;
          }
          const wasFlexible = flexibilityByLot.get(bondLotId) ?? lot.isFlexible;
          const closingArgonotRateMicrogons =
            lot.programType === 'Argonot'
              ? (await this.currency.fetchMainchainRatesAtBlock({ api, block })).ARGNOT
              : undefined;
          facts.push({
            kind: 'release',
            lot,
            block,
            parent,
            extrinsicIndex,
            closingArgonotRateMicrogons,
            wasFlexible,
            earningsComplete: !distributesEarnings,
          });
          break;
        }
        case 'BondLotFlexibilityChanged': {
          const { bondLotId } = event.data;
          const lot = await readHistoricalBondLot(api, bondLotId, this.accountId);
          if (!lot) throw new Error(`Bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);

          if (lot.owner !== this.accountId) continue;
          if (lot.programType !== 'Vault') throw new Error(`Flexible bond lot ${bondLotId} is not attached to a vault`);

          const { isFlexible } = event.data;
          flexibilityByLot.set(bondLotId, isFlexible);
          facts.push({
            kind: 'flexibility',
            lot,
            transition: {
              isFlexible,
              cumulativeEarningsMicrogons: lot.cumulativeEarnings,
              source: 'flexibility-change',
              blockNumber: block.blockNumber,
              blockHash: block.blockHash,
              blockTime: new Date(block.blockTime),
              extrinsicIndex,
              eventIndex: index,
            },
          });
          break;
        }
      }
    }

    return facts;
  }

  public async readDailyEarnings(
    lifetimes: readonly Pick<IBondLotHistoryRecord, 'createdFrame' | 'releaseFrame'>[],
    throughBlock: number,
    afterBlock: number,
    onProgress?: (completedFrameCount: number, totalFrameCount: number) => void,
  ): Promise<IBondHistoryFact[]> {
    const facts: IBondHistoryFact[] = [];
    const frames = this.miningFrames.frames.filter(frame => {
      if (
        frame.firstBlockNumber === null ||
        frame.firstBlockNumber <= afterBlock ||
        frame.firstBlockNumber > throughBlock
      )
        return false;
      if ((frame.firstBlockSpecVersion ?? 0) < 151) return false;

      const earningFrame = frame.frameId - 1;
      return lifetimes.some(
        lot => lot.createdFrame <= earningFrame && (lot.releaseFrame === undefined || lot.releaseFrame > earningFrame),
      );
    });

    onProgress?.(0, frames.length);
    for (const [index, frame] of frames.entries()) {
      const earningFrame = frame.frameId - 1;
      const block = await this.miningFrames.blockWatch.getHeader(frame.firstBlockNumber!);
      const events = await this.miningFrames.blockWatch.getEvents(block);
      if (
        events.some(
          ({ event }) =>
            event.section === 'treasury' &&
            event.method === 'FrameEarningsDistributed' &&
            event.data.frameId === earningFrame,
        )
      ) {
        facts.push(...(await this.readFrameEarnings(block, earningFrame, events)));
      }
      onProgress?.(index + 1, frames.length);
    }
    return facts;
  }

  public async readFrameEarnings(
    block: IBlockHeaderInfo,
    frameId: number,
    events: readonly RuntimeSystemEventRecord[],
  ): Promise<IBondHistoryFact[]> {
    const paysOwners = events.some(
      ({ event }) =>
        event.section === 'treasury' &&
        event.method === 'FrameEarningsDistributed' &&
        getFrameEarningsDestination(event.data) === 'Owner',
    );
    let participation;
    if (paysOwners) {
      const parent = await this.miningFrames.blockWatch.getHeader(block.blockNumber - 1);
      participation = await this.miningFrames.blockWatch.getApi(parent);
    } else {
      participation = (await this.miningFrames.getFrameStart(frameId)).api;
    }
    const payout = await this.miningFrames.blockWatch.getApi(block);
    const earnings = await readBondFrameEarnings({
      frameId,
      accountId: this.accountId,
      participation,
      payout,
      events,
    });
    return earnings.map(({ lot, ...entry }) => ({
      kind: 'daily-earnings',
      record: {
        ...entry,
        accountId: this.accountId,
        programType: lot.programType,
        bondLotId: lot.id,
        frameId,
        payoutBlockNumber: block.blockNumber,
        payoutBlockHash: block.blockHash,
      },
    }));
  }
}

// Historical runtime translation. Keep storage and event shape differences here;
// the recovery flow above consumes normalized bond lots and earnings facts.

/** Vault payouts consume frame-start participation; owner payouts consume pre-payout participation. */
function getFrameEarningsDestination(
  distribution: Extract<
    RuntimeSystemEventRecord['event'],
    { section: 'treasury'; method: 'FrameEarningsDistributed' }
  >['data'],
): 'Owner' | 'Vault' {
  if ('argonBondPoolDistributed' in distribution) return 'Owner';
  return 'Vault';
}

function decodeHistoricalBondLot(id: number, lot: HistoricalBondLot, accountId: string): BondLot {
  const { vaultId, sharingPercent, bonusPercent, isBackfill, ...state } = lot;
  const bondLot = new BondLot(
    id,
    {
      ...state,
      program: lot.program ?? {
        type: 'Vault',
        value: { vaultId: vaultId!, sharingPercent: sharingPercent!, bonusPercent: bonusPercent! },
      },
      isFlexible: lot.isFlexible ?? isBackfill ?? false,
      lockedFrameTerms: lot.lockedFrameTerms ?? null,
    },
    accountId,
  );
  if (!('lockedFrameTerms' in lot)) bondLot.earningsDestination = 'VaultForFlexible';
  if (bondLot.programType === 'Vault' && bondLot.vaultId === undefined) {
    throw new Error(`Historical vault bond lot ${id} is missing its vault`);
  }
  return bondLot;
}
async function readBondFrameEarnings({
  frameId,
  accountId,
  participation,
  payout,
  events,
}: {
  frameId: number;
  accountId: string;
  participation: ArgonApi;
  payout: ArgonApi;
  events: readonly RuntimeSystemEventRecord[];
}): Promise<IBondFrameEarnings[]> {
  const participationSpec = participation.runtimeVersion.specVersion.toNumber();
  const payoutSpec = payout.runtimeVersion.specVersion.toNumber();
  if (participationSpec > 160 || payoutSpec > 160) {
    throw new Error(`Bond history requires an app update for runtime ${Math.max(participationSpec, payoutSpec)}`);
  }
  const paysOwners = events.some(
    ({ event }) =>
      event.section === 'treasury' &&
      event.method === 'FrameEarningsDistributed' &&
      getFrameEarningsDestination(event.data) === 'Owner',
  );
  const [lots, paidLots, capital] = await Promise.all([
    readHistoricalBondLots(participation, accountId),
    readHistoricalBondLots(payout, accountId),
    participation.query.treasury.currentFrameVaultCapital(),
  ]);
  // A cutover may change participation during migration. Preserve observed earnings
  // without claiming the preceding runtime's quantities were used by the new payout.
  const crossesCutover = paysOwners && capital && 'vaults' in capital && capital.vaults !== undefined;
  let entries: IBondFrameEarnings[] = [];
  if (!crossesCutover) {
    entries = await getEarningParticipation({ client: participation, frameId, lots, capital });
  }
  for (const paid of paidLots) {
    if (paid.lastFrameEarningsFrameId !== frameId || paid.lastFrameEarnings === null) continue;
    let entry = entries.find(x => x.lot.id === paid.id);
    if (!entry) {
      entry = { lot: paid, earningsDestination: 'Owner' };
      entries.push(entry);
    }
    entry.earningsMicrogons = paid.lastFrameEarnings;
  }
  if (crossesCutover) {
    for (const lot of lots) {
      if (!entries.some(x => x.lot.id === lot.id)) entries.push({ lot, earningsDestination: 'Owner' });
    }
  }
  if (!capital || !('vaults' in capital) || !capital.vaults || paysOwners) return entries;
  for (const vaultId of new Set(entries.filter(x => x.earningsDestination === 'Vault').map(x => x.lot.vaultId!))) {
    const rawPosition = capital.vaults[vaultId];
    if (!rawPosition) continue;
    const { flexibleProrata, flexibleBondsEligible } = normalizeHistoricalVaultPosition(rawPosition);
    if (flexibleProrata === undefined || flexibleBondsEligible === undefined) continue;

    const flexible = entries.filter(x => x.lot.vaultId === vaultId && x.earningsDestination === 'Vault');
    const state = normalizeHistoricalVaultBondState(await participation.query.treasury.bondLotsByVault(vaultId));
    if (!state) continue;
    const { flexibleBonds } = state;
    const total = flexible.reduce((sum, x) => sum + x.lot.bonds, 0);
    if (total !== flexibleBonds || flexibleBondsEligible > total) {
      for (const entry of flexible) delete entry.displacedMicrogons;
      continue;
    }
    if (
      events.some(
        ({ event }) =>
          event.section === 'vaults' &&
          event.method === 'TreasuryRecordingError' &&
          event.data.vaultId === vaultId &&
          event.data.frameId === frameId,
      )
    )
      continue;
    const revenue = (await payout.query.vaults.revenuePerFrameByVault(vaultId))?.find(x => x.frameId === frameId);
    if (
      !revenue ||
      !('treasuryTotalEarnings' in revenue) ||
      revenue.treasuryTotalEarnings === undefined ||
      revenue.treasuryVaultEarnings === undefined
    )
      continue;
    const earnings = bigNumberToBigInt(flexibleProrata.times(revenue.treasuryTotalEarnings));
    if (earnings > revenue.treasuryVaultEarnings) continue;
    const shares = TreasuryBonds.allocateFlexibleEarnings(
      earnings,
      flexible.map(x => x.lot),
    );
    for (const entry of flexible) {
      const gross = shares.get(entry.lot.id);
      if (gross === undefined || entry.lot.program.type !== 'Vault') continue;

      const { sharingPercent, bonusPercent } = entry.lot.program.value;
      const bondShare = BigNumber.minimum(1, sharingPercent.plus(bonusPercent));
      entry.earningsMicrogons = bigNumberToBigInt(bondShare.times(gross));
    }
  }
  return entries;
}

// A failed release could historically remove a Treasury hold before provider
// bookkeeping failed. Only a complete same-currency release group whose
// principal exactly matches the hold delta proves that this lot left custody.
export async function didFailedReleaseRemoveHold(args: {
  accountId: string;
  lot: BondLot;
  events: readonly RuntimeSystemEventRecord[];
  parentApi: ArgonApi;
  api: ArgonApi;
}): Promise<boolean> {
  const { accountId, lot, events, parentApi, api } = args;
  const releases = events.flatMap(({ event }) =>
    event.section === 'treasury' &&
    (event.method === 'BondLotReleased' || event.method === 'CouldNotReleaseBondLot') &&
    event.data.accountId === accountId
      ? [event]
      : [],
  );
  for (const { event } of events) {
    if (event.section !== 'treasury' || event.method !== 'BondLotPurchased' || event.data.accountId !== accountId) {
      continue;
    }
    const purchasedLot = await readHistoricalBondLot(api, event.data.bondLotId, accountId);
    if (!purchasedLot || purchasedLot.programType === lot.programType) return false;
  }

  let expectedPrincipal = 0n;
  for (const release of releases) {
    const releasedLot = await readHistoricalBondLot(parentApi, release.data.bondLotId, accountId);
    if (!releasedLot) return false;
    if (releasedLot.programType !== lot.programType) continue;
    const principal = releasedLot.principalMicrogons ?? releasedLot.principalMicronots ?? 0n;
    if (
      releasedLot.owner !== accountId ||
      principal <= 0n ||
      (release.method === 'CouldNotReleaseBondLot'
        ? release.data.amount !== principal
        : release.data.bonds !== releasedLot.bonds)
    ) {
      return false;
    }
    expectedPrincipal += principal;
  }
  if (expectedPrincipal <= 0n) return false;

  const [priorHolds, currentHolds] =
    lot.programType === 'Argonot'
      ? await Promise.all([parentApi.query.ownership.holds(accountId), api.query.ownership.holds(accountId)])
      : await Promise.all([parentApi.query.balances.holds(accountId), api.query.balances.holds(accountId)]);
  const treasuryTotal = (holds: typeof priorHolds): bigint =>
    holds.filter(hold => hold.id.type === 'Treasury').reduce((total, hold) => total + hold.amount, 0n);
  return treasuryTotal(priorHolds) - treasuryTotal(currentHolds) === expectedPrincipal;
}

async function getEarningParticipation({
  client,
  frameId,
  lots,
  capital,
}: {
  client: ArgonApi;
  frameId: number;
  lots: BondLot[];
  capital: HistoricalQueryRecord<'treasury', 'currentFrameVaultCapital'> | null | undefined;
}): Promise<IBondFrameEarnings[]> {
  const stakes = await client.query.treasury.currentFrameArgonotBondParticipants?.();
  const vaultStates = new Map<number, ReturnType<typeof normalizeHistoricalVaultBondState>>();
  const flexibleFractionByVault = new Map<number, bigint>();
  const entries: IBondFrameEarnings[] = [];
  for (const lot of lots) {
    if (lot.programType === 'Argonot') {
      const participant = stakes?.frameId === frameId && stakes.bondLots.find(x => x.bondLotId === lot.id);
      if (participant)
        entries.push({
          lot,
          bonds: participant.bonds,
          isFlexible: false,
          displacedMicrogons: 0n,
          earningsDestination: 'Owner',
        });
      continue;
    }
    if (capital?.frameId !== frameId) continue;
    if ('vaults' in capital && capital.vaults) {
      const rawPosition = capital.vaults[lot.vaultId!];
      if (!rawPosition) continue;
      const position = normalizeHistoricalVaultPosition(rawPosition);
      const regular = position.regularBondAllocations.some(x => x.bondLotId === lot.id);
      if (regular)
        entries.push({
          lot,
          bonds: lot.bonds,
          isFlexible: false,
          displacedMicrogons: 0n,
          earningsDestination: 'Owner',
        });
      else if (lot.isFlexible && !lot.isReleasing) {
        const vaultId = lot.vaultId!;
        let fraction = flexibleFractionByVault.get(vaultId);
        if (fraction === undefined) {
          const { flexibleBondsEligible } = position;
          if (flexibleBondsEligible === undefined) {
            // Early runtimes record the flexible lot but not its eligible share.
            entries.push({ lot, earningsDestination: 'Vault' });
            continue;
          }
          const flexibleLots = lots.filter(x => x.vaultId === vaultId && x.isFlexible && !x.isReleasing);
          const total = flexibleLots.reduce((sum, x) => sum + x.bonds, 0);
          fraction = fixedU128Rational(BigInt(flexibleBondsEligible), BigInt(total));
          flexibleFractionByVault.set(vaultId, fraction);
        }
        const principal = lot.bondMicrogons;
        entries.push({
          lot,
          bonds: lot.bonds,
          isFlexible: true,
          displacedMicrogons: principal - fixedU128Multiply(fraction, principal),
          earningsDestination: 'Vault',
        });
      }
      continue;
    }
    const terms = lot.lockedFrameTerms ?? (lot.isReleasing ? undefined : lot);
    if (!terms?.bonds) continue;
    let displacedMicrogons = 0n;
    if (terms.isFlexible) {
      const vaultId = lot.vaultId!;
      if (!vaultStates.has(vaultId)) {
        vaultStates.set(
          vaultId,
          normalizeHistoricalVaultBondState(await client.query.treasury.bondLotsByVault(vaultId)),
        );
      }
      const frozen = vaultStates.get(vaultId);
      if (frozen?.displacedFlexibleBonds === undefined) continue;
      const principal = BondLot.bondsToMicrogons(terms.bonds);
      const fraction = fixedU128Rational(
        BigInt(Math.max(0, frozen.flexibleBonds - frozen.displacedFlexibleBonds)),
        BigInt(frozen.flexibleBonds),
      );
      displacedMicrogons = principal - fixedU128Multiply(fraction, principal);
    }
    entries.push({
      lot,
      bonds: terms.bonds,
      isFlexible: terms.isFlexible,
      displacedMicrogons,
      earningsDestination: 'Owner',
    });
  }
  return entries;
}

export async function readHistoricalBondLots(client: ArgonApi, accountId: string): Promise<BondLot[]> {
  const specVersion = client.runtimeVersion.specVersion.toNumber();
  if (specVersion > 160) throw new Error(`Bond history requires an app update for runtime ${specVersion}`);
  const keys = await client.query.treasury.bondLotIdsByAccount.keys(accountId);
  const ids = (keys ?? []).map(key => key.args[1]);
  const stored = await client.query.treasury.bondLotById.multi(ids);
  return (stored ?? []).flatMap((lot, index) => (lot ? [decodeHistoricalBondLot(ids[index], lot, accountId)] : []));
}

export async function readHistoricalBondLot(
  client: ArgonApi,
  id: number,
  accountId: string,
): Promise<BondLot | undefined> {
  const specVersion = client.runtimeVersion.specVersion.toNumber();
  if (specVersion > 160) throw new Error(`Bond history requires an app update for runtime ${specVersion}`);
  const stored = await client.query.treasury.bondLotById(id);
  if (stored) return decodeHistoricalBondLot(id, stored, accountId);
}

type VaultPosition = NonNullable<TreasuryCurrentFrameVaultCapitalResultSpec158Variant4>['vaults'][string];

function normalizeHistoricalVaultPosition(
  position: NonNullable<NonNullable<HistoricalQueryRecord<'treasury', 'currentFrameVaultCapital'>>['vaults']>[string],
): Pick<VaultPosition, 'regularBondAllocations'> &
  Partial<Pick<VaultPosition, 'flexibleBondsEligible' | 'flexibleProrata'>> {
  if ('regularBondAllocations' in position) return position;
  if ('backfillBondsEligible' in position) {
    return {
      regularBondAllocations: position.bondLotAllocations,
      flexibleBondsEligible: position.backfillBondsEligible,
      flexibleProrata: position.backfillProrata,
    };
  }
  return { regularBondAllocations: position.bondLotAllocations };
}

function normalizeHistoricalVaultBondState(
  state: HistoricalQueryRecord<'treasury', 'bondLotsByVault'> | null,
): (Pick<VaultBondState, 'flexibleBonds'> & Partial<Pick<VaultBondState, 'displacedFlexibleBonds'>>) | undefined {
  if (!state) return;
  if ('lockedFrameTerms' in state) return state.lockedFrameTerms ?? state;
  if ('flexibleBonds' in state) return state;
  if ('backfillBonds' in state) return { flexibleBonds: state.backfillBonds };
}

function normalizeHistoricalBondEvents(
  events: readonly RuntimeSystemEventRecord[],
): readonly RuntimeSystemEventRecord[] {
  return events.map(record => {
    const { event } = record;
    if (event.section !== 'treasury' || event.method !== 'BondLotBackfillChanged') return record;
    return {
      ...record,
      event: {
        section: 'treasury',
        method: 'BondLotFlexibilityChanged',
        data: { vaultId: event.data.vaultId, bondLotId: event.data.bondLotId, isFlexible: event.data.isBackfill },
      },
    };
  });
}
