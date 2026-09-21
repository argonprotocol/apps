import {
  BondLot,
  type Currency,
  type IBlockHeaderInfo,
  type MiningFrames,
  type RuntimeSystemEventRecord,
  TreasuryBonds,
} from '@argonprotocol/apps-core';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import type { IBondHistoryFact } from '../ArgonBonds.ts';

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
    if (
      !events.some(
        ({ event }) =>
          event.section === 'treasury' &&
          (event.method === 'BondLotPurchased' ||
            event.method === 'BondLotReleaseScheduled' ||
            event.method === 'BondLotReleased' ||
            event.method === 'CouldNotReleaseBondLot' ||
            event.method === 'BondLotFlexibilityChanged' ||
            event.method === 'BondLotBackfillChanged'),
      )
    ) {
      return facts;
    }
    const api = await this.miningFrames.blockWatch.getApi(block);

    for (const [index, { event, phase }] of events.entries()) {
      if (event.section !== 'treasury') continue;
      if (
        event.method !== 'BondLotPurchased' &&
        event.method !== 'BondLotReleaseScheduled' &&
        event.method !== 'BondLotReleased' &&
        event.method !== 'CouldNotReleaseBondLot' &&
        event.method !== 'BondLotFlexibilityChanged' &&
        event.method !== 'BondLotBackfillChanged'
      ) {
        continue;
      }

      const { bondLotId } = event.data;
      const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : undefined;
      if (event.method === 'BondLotReleaseScheduled') {
        if (event.data.accountId !== this.accountId) continue;
        const storedLot = await api.query.treasury.bondLotById(bondLotId);
        if (!storedLot) throw new Error(`Scheduled bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);
        facts.push({
          kind: 'release-scheduled',
          lot: this.decodeStoredBondLot(bondLotId, storedLot),
          block,
          extrinsicIndex,
        });
      } else if (event.method === 'BondLotPurchased') {
        if (event.data.accountId !== this.accountId) continue;
        const storedLot = await api.query.treasury.bondLotById(bondLotId);
        if (!storedLot) throw new Error(`Purchased bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);

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
      } else if (event.method === 'BondLotReleased' || event.method === 'CouldNotReleaseBondLot') {
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

        const lot = this.decodeStoredBondLot(bondLotId, storedLot);
        if (event.method === 'CouldNotReleaseBondLot') {
          if (
            !(await TreasuryBonds.didFailedReleaseRemoveHold({
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
        facts.push({ kind: 'release', lot, block, parent, extrinsicIndex, closingArgonotRateMicrogons, wasFlexible });
      } else {
        const storedLot = await api.query.treasury.bondLotById(bondLotId);
        if (!storedLot) throw new Error(`Bond lot ${bondLotId} is unavailable at block ${block.blockNumber}`);

        const lot = this.decodeStoredBondLot(bondLotId, storedLot);
        if (lot.accountId !== this.accountId) continue;
        if (lot.programType !== 'Vault') throw new Error(`Flexible bond lot ${bondLotId} is not attached to a vault`);

        const isFlexible = event.method === 'BondLotFlexibilityChanged' ? event.data.isFlexible : event.data.isBackfill;
        flexibilityByLot.set(bondLotId, isFlexible);
        facts.push({
          kind: 'flexibility',
          lot,
          transition: {
            isFlexible,
            cumulativeEarningsMicrogons: lot.lifetimeEarnings,
            source: 'flexibility-change',
            blockNumber: block.blockNumber,
            blockHash: block.blockHash,
            blockTime: new Date(block.blockTime),
            extrinsicIndex,
            eventIndex: index,
          },
        });
      }
    }

    return facts;
  }

  private decodeStoredBondLot(id: number, lot: HistoricalBondLot): BondLot {
    const bondLot = BondLot.fromRuntime(id, lot, this.accountId);
    if (bondLot.programType === 'Vault' && bondLot.vaultId === undefined) {
      throw new Error(`Historical vault bond lot ${id} is missing its vault`);
    }
    return bondLot;
  }
}
