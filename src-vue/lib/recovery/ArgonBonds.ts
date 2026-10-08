import {
  BondLot,
  type ArgonQueryClient,
  type IBondFrameEarnings,
  type Currency,
  type IBlockHeaderInfo,
  type MiningFrames,
  type RuntimeSystemEventRecord,
  TreasuryBonds,
} from '@argonprotocol/apps-core';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import type { IBondHistoryFact } from '../ArgonBonds.ts';
import type { IBondLotHistoryRecord, IBondLotEarningsBackfill } from '../db/BondLotHistoryTable.ts';

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
        'BondLotBackfillChanged',
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
          let storedLot = await api.query.treasury.bondLotById(bondLotId);
          let lot = storedLot ? this.decodeStoredBondLot(bondLotId, storedLot) : undefined;
          if (!lot) {
            const parent = await this.miningFrames.blockWatch.getHeader(block.blockNumber - 1);
            const parentApi = await this.miningFrames.blockWatch.getApi(parent);
            storedLot = await parentApi.query.treasury.bondLotById(bondLotId);
            if (storedLot) {
              const previous = this.decodeStoredBondLot(bondLotId, storedLot);
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
          const storedLot = await api.query.treasury.bondLotById(bondLotId);
          if (!storedLot)
            throw new Error(`Scheduled bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);
          facts.push({
            kind: 'release-scheduled',
            lot: this.decodeStoredBondLot(bondLotId, storedLot),
            block,
            extrinsicIndex,
          });
          break;
        }
        case 'BondLotPurchased': {
          const { bondLotId } = event.data;
          if (event.data.accountId !== this.accountId) continue;
          const storedLot = await api.query.treasury.bondLotById(bondLotId);
          if (!storedLot)
            throw new Error(`Purchased bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);

          const lot = this.decodeStoredBondLot(bondLotId, storedLot);
          let isFlexibleAtPurchase = lot.isFlexible;
          for (const { event: later } of events.slice(index + 1)) {
            if (later.section !== 'treasury') continue;
            if (later.method === 'BondLotFlexibilityChanged' && later.data.bondLotId === bondLotId) {
              isFlexibleAtPurchase = !later.data.isFlexible;
              break;
            }
            if (later.method === 'BondLotBackfillChanged' && later.data.bondLotId === bondLotId) {
              isFlexibleAtPurchase = !later.data.isBackfill;
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
          const storedLot = await parentApi.query.treasury.bondLotById(bondLotId);
          if (!storedLot)
            throw new Error(`Released bond lot ${bondLotId} is unavailable before block ${block.blockNumber}`);

          let lot = this.decodeStoredBondLot(bondLotId, storedLot);
          const backfill = earningsBackfillsByLot.get(bondLotId);
          if (backfill) {
            lot = lot.withEarningsBackfill(backfill.addedFrames, backfill.addedEarnings);
          }
          if (event.method === 'CouldNotReleaseBondLot') {
            if (
              !(await TreasuryBonds.didFailedReleaseRemoveHold({
                accountId: this.accountId,
                lot,
                events,
                parentApi,
                api,
                readBondLot: async (client, id) => {
                  const stored = await client.query.treasury.bondLotById(id);
                  return stored ? this.decodeStoredBondLot(id, stored) : undefined;
                },
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
        case 'BondLotFlexibilityChanged':
        case 'BondLotBackfillChanged': {
          const { bondLotId } = event.data;
          const storedLot = await api.query.treasury.bondLotById(bondLotId);
          if (!storedLot) throw new Error(`Bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);

          const lot = this.decodeStoredBondLot(bondLotId, storedLot);
          if (lot.owner !== this.accountId) continue;
          if (lot.programType !== 'Vault') throw new Error(`Flexible bond lot ${bondLotId} is not attached to a vault`);

          const isFlexible =
            event.method === 'BondLotFlexibilityChanged' ? event.data.isFlexible : event.data.isBackfill;
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
  ): Promise<IBondHistoryFact[]> {
    const facts: IBondHistoryFact[] = [];
    for (const frame of this.miningFrames.frames) {
      if (
        frame.firstBlockNumber === null ||
        frame.firstBlockNumber <= afterBlock ||
        frame.firstBlockNumber > throughBlock
      )
        continue;
      const earningFrame = frame.frameId - 1;
      if (
        !lifetimes.some(
          lot =>
            lot.createdFrame <= earningFrame && (lot.releaseFrame === undefined || lot.releaseFrame > earningFrame),
        )
      )
        continue;
      if ((frame.firstBlockSpecVersion ?? 0) < 151) continue;
      const block = await this.miningFrames.blockWatch.getHeader(frame.firstBlockNumber);
      const events = await this.miningFrames.blockWatch.getEvents(block);
      if (
        !events.some(
          ({ event }) =>
            event.section === 'treasury' &&
            event.method === 'FrameEarningsDistributed' &&
            event.data.frameId === earningFrame,
        )
      )
        continue;
      const parent = await this.miningFrames.blockWatch.getHeader(block.blockNumber - 1);
      const [payout, beforePayout, frameStart] = await Promise.all([
        this.miningFrames.blockWatch.getApi(block),
        this.miningFrames.blockWatch.getApi(parent),
        this.miningFrames.getFrameStart(earningFrame),
      ]);
      const capital = await frameStart.api.query.treasury.currentFrameVaultCapital();
      const positions = Object.values(capital?.vaults ?? {});
      const supportsFrameReader =
        capital?.vaultSecuritizationPositions !== undefined ||
        positions.some(position => 'regularBondAllocations' in position);
      let earnings: IBondFrameEarnings[];
      if (supportsFrameReader) {
        earnings = await TreasuryBonds.getFrameEarnings({
          frameId: earningFrame,
          accountId: this.accountId,
          frameStart: frameStart.api,
          beforePayout,
          payout,
          events,
          readLots: client => this.readLots(client),
        });
      } else {
        // Earlier snapshots have no complete flexible-lot allocation. Keep native
        // per-lot payouts where recorded and leave the unavailable quantities explicit.
        const [lots, paidLots, stakes] = await Promise.all([
          this.readLots(frameStart.api),
          this.readLots(payout),
          frameStart.api.query.treasury.currentFrameArgonotBondParticipants?.(),
        ]);
        earnings = [];
        for (const lot of lots) {
          const paid = paidLots.find(x => x.id === lot.id);
          const position = capital?.vaults?.[lot.vaultId!];
          const allocation =
            position &&
            'bondLotAllocations' in position &&
            position.bondLotAllocations.some(x => x.bondLotId === lot.id);
          const stake = stakes?.frameId === earningFrame && stakes.bondLots.find(x => x.bondLotId === lot.id);
          const hasPayout = paid?.lastFrameEarningsFrameId === earningFrame && paid.lastFrameEarnings !== null;
          if (!allocation && !stake && !hasPayout && !(lot.isFlexible && !lot.isReleasing)) continue;
          const entry: IBondFrameEarnings = { lot, earningsDestination: lot.isFlexible ? 'Vault' : 'Owner' };
          if (allocation || stake) {
            entry.bonds = stake ? stake.bonds : lot.bonds;
            entry.isFlexible = false;
            entry.displacedMicrogons = 0n;
          }
          if (hasPayout) entry.earningsMicrogons = paid.lastFrameEarnings!;
          earnings.push(entry);
        }
      }
      for (const { lot, ...entry } of earnings) {
        facts.push({
          kind: 'daily-earnings',
          record: {
            ...entry,
            accountId: this.accountId,
            programType: lot.programType,
            bondLotId: lot.id,
            frameId: earningFrame,
            payoutBlockNumber: block.blockNumber,
            payoutBlockHash: block.blockHash,
          },
        });
      }
    }
    return facts;
  }

  private async readLots(client: ArgonQueryClient): Promise<BondLot[]> {
    const keys = await client.query.treasury.bondLotIdsByAccount.keys(this.accountId);
    const ids = (keys ?? []).map(key => key.args[1]);
    const stored = await client.query.treasury.bondLotById.multi(ids);
    const lots: BondLot[] = [];
    for (const [index, lot] of (stored ?? []).entries()) {
      if (lot) lots.push(this.decodeStoredBondLot(ids[index], lot));
    }
    return lots;
  }

  private decodeStoredBondLot(id: number, lot: HistoricalBondLot): BondLot {
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
      this.accountId,
    );
    if (!('lockedFrameTerms' in lot)) bondLot.earningsDestination = 'VaultForFlexible';
    if (bondLot.programType === 'Vault' && bondLot.vaultId === undefined) {
      throw new Error(`Historical vault bond lot ${id} is missing its vault`);
    }
    return bondLot;
  }
}
