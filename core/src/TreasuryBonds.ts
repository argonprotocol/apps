import type { SubmittableExtrinsic } from '@argonprotocol/mainchain';
import { hexToU8a, stringToU8a, u8aConcat } from '@polkadot/util';
import { bigIntMax, bigIntMin, bigNumberToBigInt } from './utils.js';
import { FIXED_U128_ONE, U128_MAX, fixedU128Rational, fixedU128Multiply } from './FixedU128.js';
import BigNumber from 'bignumber.js';
import { BondLot } from './BondLot.js';
import { Currency, MICRONOTS_PER_ARGONOT } from './Currency.js';
import { Vault } from './Vault.js';
import type { ArgonClient, ArgonCurrentQueryClient, ArgonQueryClient } from './MainchainClients.js';
import type { RuntimeSystemEventRecord } from './BlockWatch.js';
import type {
  CurrentRuntimeQueries,
  HistoricalQueryRecord,
  LiveQueryRecord,
  RuntimeQueryResult,
} from '@argonprotocol/runtime-client';
import { runtimeClient } from '@argonprotocol/runtime-client';

const U32_MAX = 4_294_967_295n;

export interface IFrameBondLot {
  lot: BondLot;
  /** Frozen participation, including fractional flexible-bond displacement. */
  eligibleMicrogons: bigint;
}

export type VaultBondState = NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['treasury']['bondLotsByVault']>>;

export interface IBondFrameEarnings {
  lot: BondLot;
  bonds?: number;
  isFlexible?: boolean;
  displacedMicrogons?: bigint;
  earningsMicrogons?: bigint;
  earningsDestination: 'Owner' | 'Vault';
}

export class TreasuryBonds {
  public static async getFrameEarnings({
    frameId,
    accountId,
    frameStart,
    beforePayout,
    payout,
    events,
    readLots = (client, owner) => TreasuryBonds.getBondLotsByAccount(runtimeClient(client), owner),
  }: {
    frameId: number;
    accountId: string;
    frameStart: ArgonQueryClient;
    beforePayout: ArgonQueryClient;
    payout: ArgonQueryClient;
    events: readonly RuntimeSystemEventRecord[];
    readLots?: (client: ArgonQueryClient, accountId: string) => Promise<BondLot[]>;
  }): Promise<IBondFrameEarnings[]> {
    const paysOwners = events.some(
      ({ event }) =>
        event.section === 'treasury' &&
        event.method === 'FrameEarningsDistributed' &&
        'argonBondPoolDistributed' in event.data,
    );
    const snapshot = paysOwners ? beforePayout : frameStart;
    const [lots, paidLots, capital] = await Promise.all([
      readLots(snapshot, accountId),
      readLots(payout, accountId),
      snapshot.query.treasury.currentFrameVaultCapital(),
    ]);
    // A cutover may change participation during migration. Preserve observed earnings
    // without claiming the preceding runtime's quantities were used by the new payout.
    const crossesCutover = paysOwners && capital && 'vaults' in capital && capital.vaults !== undefined;
    const entries = crossesCutover
      ? []
      : await TreasuryBonds.getEarningParticipation({ client: snapshot, frameId, lots, capital });
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
      const position = capital.vaults[vaultId];
      if (!position || !('flexibleProrata' in position)) continue;
      const flexible = entries.filter(x => x.lot.vaultId === vaultId && x.earningsDestination === 'Vault');
      const state = await snapshot.query.treasury.bondLotsByVault(vaultId);
      const total = flexible.reduce((sum, x) => sum + x.lot.bonds, 0);
      if (
        !state ||
        !('flexibleBonds' in state) ||
        total !== state.flexibleBonds ||
        position.flexibleBondsEligible > total
      ) {
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
      const earnings = bigNumberToBigInt(position.flexibleProrata.times(revenue.treasuryTotalEarnings));
      if (earnings > revenue.treasuryVaultEarnings) continue;
      const shares = TreasuryBonds.allocateFlexibleEarnings(
        earnings,
        flexible.map(x => x.lot),
      );
      for (const entry of flexible) entry.earningsMicrogons = shares.get(entry.lot.id);
    }
    return entries;
  }

  /** Attribute an actual vault payout to its frozen flexible lots, including deterministic dust. */
  public static allocateFlexibleEarnings(
    earnings: bigint,
    lots: readonly Pick<BondLot, 'id' | 'bonds'>[],
  ): Map<number, bigint> {
    const total = lots.reduce((sum, lot) => sum + BigInt(lot.bonds), 0n);
    if (total === 0n) return new Map();
    const shares = lots.map(lot => {
      const weightedEarnings = earnings * BigInt(lot.bonds);
      return { id: lot.id, earnings: weightedEarnings / total, remainder: weightedEarnings % total };
    });
    let dust = earnings - shares.reduce((sum, share) => sum + share.earnings, 0n);
    shares.sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
      return a.id - b.id;
    });
    for (const share of shares) {
      if (dust === 0n) break;
      share.earnings += 1n;
      dust -= 1n;
    }
    return new Map(shares.map(share => [share.id, share.earnings]));
  }

  public static async getActiveBonds(
    client: ArgonCurrentQueryClient,
    frameCapital?: LiveQueryRecord<'treasury', 'currentFrameVaultCapital'>,
  ): Promise<{
    totalActiveBonds: number;
    frameCapital?: NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['treasury']['currentFrameVaultCapital']>>;
    vaultRewardRate?: BigNumber;
    averageMicrogonsPerArgonot?: bigint;
    fullBidPool?: bigint;
  }> {
    const frameCapitalRaw =
      frameCapital === undefined ? await client.query.treasury.currentFrameVaultCapital() : frameCapital;
    if (!frameCapitalRaw) {
      return {
        totalActiveBonds: 0,
      };
    }

    let totalActiveBonds = 0;
    if ('vaultSecuritizationPositions' in frameCapitalRaw) {
      const constants = client.consts.treasury;
      const [argonotPrices, account] = await Promise.all([
        client.query.priceIndex.historicArgonotAverageByFrame(),
        client.query.system.account(TreasuryBonds.getBidPoolAccountId(client)),
      ]);
      return {
        totalActiveBonds: Number(frameCapitalRaw.totalActiveBonds),
        frameCapital: frameCapitalRaw,
        vaultRewardRate: 'percentForVaultPool' in constants ? constants.percentForVaultPool : undefined,
        averageMicrogonsPerArgonot: argonotPrices?.[Math.max(0, frameCapitalRaw.frameId - 1)],
        fullBidPool: account.data.free,
      };
    }
    for (const capital of Object.values(frameCapitalRaw.vaults)) {
      totalActiveBonds += capital.eligibleBonds;
    }

    return {
      totalActiveBonds,
    };
  }

  public static getBidPoolPercentForVaults(client: ArgonQueryClient): number {
    if ('percentForArgonBondPool' in client.consts.treasury)
      return client.consts.treasury.percentForArgonBondPool.toNumber();
    return new BigNumber(1).minus(client.consts.treasury.percentForTreasuryReserves).toNumber();
  }

  public static async getDistributableBidPool(client: ArgonQueryClient): Promise<bigint> {
    const bidPoolAccountId = TreasuryBonds.getBidPoolAccountId(client);
    const accountInfo = await client.query.system.account(bidPoolAccountId);
    const revenue = accountInfo.data.free;
    const percentForVaults = TreasuryBonds.getBidPoolPercentForVaults(client);
    return bigNumberToBigInt(BigNumber(revenue).times(percentForVaults));
  }

  public static getBidPoolAccountId(client: ArgonQueryClient): Uint8Array {
    const palletId = hexToU8a(client.consts.treasury.palletId);
    const raw = u8aConcat(stringToU8a('modl'), palletId, new Uint8Array(32 - 4 - palletId.length));
    return client.registry.createType('AccountId32', raw).toU8a();
  }

  public static getBondPurchaseCapacity(totalBondCapacityMicrogons: bigint): number {
    if (totalBondCapacityMicrogons <= 0n) return 0;
    return Math.min(Number(U32_MAX), BondLot.microgonsToWholeBonds(totalBondCapacityMicrogons));
  }

  public static getArgonotBondPurchaseCapacity(args: {
    totalIssuanceMicronots: bigint;
    maxBondedPercent: number;
    totalActiveBonds: number;
    replacedBonds?: number;
  }): bigint {
    const { totalIssuanceMicronots, maxBondedPercent, totalActiveBonds, replacedBonds = 0 } = args;
    const unitsPerBond = BigInt(MICRONOTS_PER_ARGONOT);
    const maximumActiveBonds = (totalIssuanceMicronots * BigInt(maxBondedPercent)) / 100n / unitsPerBond;
    const remainingBonds = maximumActiveBonds - BigInt(totalActiveBonds) + BigInt(replacedBonds);

    return remainingBonds > 0n ? remainingBonds * unitsPerBond : 0n;
  }

  public static getBondMinimumPurchase({
    configuredMinimumMicrounits,
    replacementBonds = 0,
  }: {
    configuredMinimumMicrounits: bigint;
    replacementBonds?: number;
  }): number {
    const unitsPerBond = BigInt(MICRONOTS_PER_ARGONOT);
    const configuredMinimum = (configuredMinimumMicrounits + unitsPerBond - 1n) / unitsPerBond;
    let minimumBonds = configuredMinimum > 1n ? configuredMinimum : 1n;
    minimumBonds = minimumBonds < U32_MAX ? minimumBonds : U32_MAX;

    return Math.max(Number(minimumBonds), replacementBonds + 1);
  }

  public static getArgonotBondPurchaseLimit(args: {
    totalIssuanceMicronots: bigint;
    maxBondedPercent: number;
  }): bigint {
    const { totalIssuanceMicronots, maxBondedPercent } = args;
    const unitsPerBond = BigInt(MICRONOTS_PER_ARGONOT);
    const maximumActiveBonds = (totalIssuanceMicronots * BigInt(maxBondedPercent)) / 100n / unitsPerBond;
    const maximumPurchaseBonds = maximumActiveBonds / 10n;

    return maximumPurchaseBonds * unitsPerBond;
  }

  public static getVaultArgonotSecuritizationTarget({
    securitizationMicrogons,
    averageMicrogonsPerArgonot,
  }: {
    securitizationMicrogons: bigint;
    averageMicrogonsPerArgonot?: bigint;
  }): bigint | undefined {
    if (securitizationMicrogons <= 0n) return 0n;
    if (!averageMicrogonsPerArgonot || averageMicrogonsPerArgonot <= 0n) return;
    const capacity = bigIntMin(U128_MAX, securitizationMicrogons * FIXED_U128_ONE * 2n);
    const price = fixedU128Rational(averageMicrogonsPerArgonot, 1_000_000n);
    const required = fixedU128Rational(capacity, price);
    return (required + FIXED_U128_ONE - 1n) / FIXED_U128_ONE;
  }

  public static potentialDailyRevenue(args: {
    distributableBidPool: bigint;
    globalActiveBonds: number;
    myActiveBonds: number;
    fullTreasuryBondCapacity: number;
    operatorKeepPct: number;
  }): bigint {
    const { distributableBidPool, globalActiveBonds, myActiveBonds, fullTreasuryBondCapacity, operatorKeepPct } = args;
    if (distributableBidPool <= 0n || fullTreasuryBondCapacity <= 0) return 0n;

    const globalWithoutMe = globalActiveBonds - myActiveBonds;
    const projectedGlobal = globalWithoutMe + fullTreasuryBondCapacity;
    if (projectedGlobal <= 0) return 0n;

    const grossRevenue = bigNumberToBigInt(
      BigNumber(distributableBidPool).multipliedBy(
        BigNumber(fullTreasuryBondCapacity).dividedBy(BigNumber(projectedGlobal)),
      ),
    );
    return bigNumberToBigInt(BigNumber(grossRevenue).multipliedBy(operatorKeepPct).dividedBy(100));
  }

  public static vaultPoolEarnings({
    position,
    frameCapital,
    fullBidPool,
    percentForVaultPool,
  }: {
    position: Omit<
      NonNullable<
        RuntimeQueryResult<CurrentRuntimeQueries['treasury']['currentFrameVaultCapital']>
      >['vaultSecuritizationPositions'][string],
      'operatorAccountId'
    >;
    frameCapital: Pick<
      NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['treasury']['currentFrameVaultCapital']>>,
      'targetSecuritization' | 'totalSecuritization'
    >;
    fullBidPool: bigint;
    percentForVaultPool: BigNumber;
  }): bigint {
    const { securitization } = position;
    const denominator = bigIntMax(frameCapital.targetSecuritization, frameCapital.totalSecuritization);
    if (securitization <= 0n || denominator <= 0n || fullBidPool <= 0n) return 0n;
    const rate = this.vaultPoolRewardRate(position, percentForVaultPool);
    return fixedU128Multiply(fixedU128Multiply(fixedU128Rational(securitization, denominator), rate), fullBidPool);
  }

  public static vaultRevenuePotential(args: Parameters<typeof TreasuryBonds.vaultPoolEarnings>[0]) {
    const { position, frameCapital, percentForVaultPool } = args;
    const maximumPosition = {
      ...position,
      activatedSecuritization: position.securitization,
      bitcoinLockedMicrogons: position.securitization,
      activeBondMicrogons: position.securitization,
      argonotSecuritizationInMicrogons: bigIntMin(U128_MAX, position.securitization * 2n),
    };
    const maximumArgonotPosition = {
      ...position,
      argonotSecuritizationInMicrogons: maximumPosition.argonotSecuritizationInMicrogons,
    };
    const actualEarnings = this.vaultPoolEarnings(args);
    const maximumEarnings = this.vaultPoolEarnings({
      ...args,
      position: maximumPosition,
    });
    const denominator = bigIntMax(frameCapital.targetSecuritization, frameCapital.totalSecuritization);
    const maximumRate = denominator > 0n ? this.vaultPoolRewardRate(maximumPosition, percentForVaultPool) : 0n;
    const actualRate = this.vaultPoolRewardRate(position, percentForVaultPool);
    const maximumArgonotRate = this.vaultPoolRewardRate(maximumArgonotPosition, percentForVaultPool);
    return {
      actualEarnings,
      maximumEarnings,
      capturedPercent: maximumRate > 0n ? BigNumber(actualRate).div(maximumRate).times(100).toNumber() : undefined,
      capturedWithMaximumArgonotsPercent:
        maximumRate > 0n ? BigNumber(maximumArgonotRate).div(maximumRate).times(100).toNumber() : undefined,
    };
  }

  public static argonBondPoolEarnings({
    eligibleMicrogons,
    frameCapital,
    bondPool,
  }: {
    eligibleMicrogons: bigint;
    frameCapital: Pick<
      NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['treasury']['currentFrameVaultCapital']>>,
      'targetSecuritization' | 'totalActiveBonds'
    >;
    bondPool: bigint;
  }): bigint {
    const denominator = bigIntMax(frameCapital.targetSecuritization, frameCapital.totalActiveBonds * 1_000_000n);
    if (denominator <= 0n || eligibleMicrogons <= 0n || bondPool <= 0n) return 0n;
    return fixedU128Multiply(fixedU128Rational(eligibleMicrogons, denominator), bondPool);
  }

  public static externalActiveBonds(bondLots: BondLot[]): number {
    return bondLots.filter(lot => !lot.isOwn).reduce((sum, lot) => sum + lot.activeBonds, 0);
  }

  public static totalActiveBonds(bondLots: BondLot[]): number {
    return bondLots.reduce((sum, lot) => sum + lot.activeBonds, 0);
  }

  public static async getBondLots(
    client: ArgonCurrentQueryClient,
    vaultId: number,
    ownAddress?: string,
  ): Promise<BondLot[]> {
    return (await TreasuryBonds.getVaultBondState(client, vaultId, ownAddress)).bondLots;
  }

  public static async getVaultBondState(client: ArgonCurrentQueryClient, vaultId: number, ownAddress?: string) {
    const { bondLotIds, state, replacementBonds } = await TreasuryBonds.getVaultBondSources(client, vaultId);
    const idsBySourceOrder = [...bondLotIds];

    if (ownAddress) {
      const accountKeys = await client.query.treasury.bondLotIdsByAccount.keys(ownAddress);
      idsBySourceOrder.push(...(accountKeys ?? []).map(key => key.args[1]));
    }

    const ids = [...new Set(idsBySourceOrder)];
    const lotsById = await TreasuryBonds.getBondLotsById(client, ids, ownAddress);
    const bondLots = ids.flatMap(id => {
      const lot = lotsById.get(id);
      if (!lot) return [];

      return lot.vaultId === vaultId ? [lot] : [];
    });

    const constants = client.consts.treasury;
    const minimumPurchaseBonds = TreasuryBonds.getBondMinimumPurchase({
      configuredMinimumMicrounits: constants.minimumArgonsPerContributor,
      replacementBonds,
    });
    const isAtBondLotLimit =
      'maxArgonBondLots' in constants &&
      ((await client.query.treasury.totalArgonBondLots()) ?? 0) >= constants.maxArgonBondLots;

    return { ...state, bondLots, replacementBonds, minimumPurchaseBonds, isAtBondLotLimit };
  }

  public static availableBondSpace({
    capacityMicrogons,
    bondState,
    vault,
  }: {
    capacityMicrogons: bigint;
    bondState?: Pick<
      Awaited<ReturnType<typeof TreasuryBonds.getVaultBondState>>,
      'regularBonds' | 'reservedBondSpace' | 'replacementBonds' | 'isAtBondLotLimit'
    >;
    vault?: Vault;
  }): bigint {
    if (vault?.isClosed || bondState?.isAtBondLotLimit) return 0n;
    const bondCapacity = TreasuryBonds.getBondPurchaseCapacity(capacityMicrogons);
    if (bondCapacity === 0) return 0n;
    const regularBonds = bondState?.regularBonds ?? 0;
    const reservedBonds = bondState?.reservedBondSpace ?? 0;
    const replacementBonds = bondState?.replacementBonds ?? 0;
    let availableBonds = Math.max(0, bondCapacity - regularBonds - reservedBonds) + replacementBonds;
    if (vault?.securitizationExitNoticeBlocks !== undefined) {
      let scheduledWithdrawals = 0n;
      for (const entry of vault.securitizationReleaseSchedule.values()) scheduledWithdrawals += entry.argonWithdrawals;
      const uncommittedBonds = TreasuryBonds.getBondPurchaseCapacity(
        bigIntMax(0n, vault.securitization - scheduledWithdrawals),
      );
      availableBonds = Math.min(availableBonds, Math.max(0, uncommittedBonds - regularBonds));
    }

    return BondLot.bondsToMicrogons(availableBonds);
  }

  public static async getBondLotsByAccount(client: ArgonCurrentQueryClient, accountId: string): Promise<BondLot[]> {
    const accountKeys = await client.query.treasury.bondLotIdsByAccount.keys(accountId);
    const ids = [...new Set((accountKeys ?? []).map(key => key.args[1]))];
    const lotsById = await TreasuryBonds.getBondLotsById(client, ids, accountId);

    return ids.flatMap(id => {
      const lot = lotsById.get(id);
      return lot ? [lot] : [];
    });
  }

  // A failed release could historically remove a Treasury hold before provider
  // bookkeeping failed. Only a complete same-currency release group whose
  // principal exactly matches the hold delta proves that this lot left custody.
  public static async didFailedReleaseRemoveHold(args: {
    accountId: string;
    lot: BondLot;
    events: readonly RuntimeSystemEventRecord[];
    parentApi: ArgonQueryClient;
    api: ArgonQueryClient;
    readBondLot?: (client: ArgonQueryClient, id: number) => Promise<BondLot | undefined>;
  }): Promise<boolean> {
    const { accountId, lot, events, parentApi, api } = args;
    const readBondLot = args.readBondLot ?? ((client, id) => BondLot.get(runtimeClient(client), id, accountId));
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
      const purchasedLot = await readBondLot(api, event.data.bondLotId);
      if (!purchasedLot || purchasedLot.programType === lot.programType) return false;
    }

    let expectedPrincipal = 0n;
    for (const release of releases) {
      const releasedLot = await readBondLot(parentApi, release.data.bondLotId);
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

  public static async getCurrentFrameBondLots(
    client: ArgonCurrentQueryClient,
    vaultId: number,
    operatorAddress: string,
    snapshot?: {
      frameCapital: LiveQueryRecord<'treasury', 'currentFrameVaultCapital'>;
      bondState: Awaited<ReturnType<typeof TreasuryBonds.getVaultBondState>>;
    },
  ) {
    const bondLots: IFrameBondLot[] = [];
    const frameCapitalRaw = snapshot ? snapshot.frameCapital : await client.query.treasury.currentFrameVaultCapital();
    if (!frameCapitalRaw) {
      return {
        bondLots,
        totalActiveBonds: 0,
        flexibleBondsEligible: 0,
      };
    }

    if ('vaultSecuritizationPositions' in frameCapitalRaw) {
      let state: VaultBondState;
      let lots: BondLot[];
      if (snapshot) {
        state = snapshot.bondState;
        lots = snapshot.bondState.bondLots;
      } else {
        const sources = await TreasuryBonds.getVaultBondSources(client, vaultId);
        state = sources.state;
        lots = [...(await TreasuryBonds.getBondLotsById(client, sources.bondLotIds, operatorAddress)).values()];
      }
      const { flexibleBonds, displacedFlexibleBonds: displacedBonds } = state.lockedFrameTerms ?? state;
      const flexibleFraction =
        flexibleBonds > 0
          ? fixedU128Rational(BigInt(Math.max(0, flexibleBonds - displacedBonds)), BigInt(flexibleBonds))
          : 0n;
      let totalActiveBonds = 0;
      let flexibleBondsEligible = 0;
      for (const lot of lots) {
        const terms = lot.lockedFrameTerms ?? (lot.releaseReason ? undefined : lot);
        if (!terms?.bonds) continue;
        const principal = BondLot.bondsToMicrogons(terms.bonds);
        const eligibleMicrogons = terms.isFlexible ? fixedU128Multiply(flexibleFraction, principal) : principal;
        const eligibleBonds = BigNumber(eligibleMicrogons).div(BondLot.bondsToMicrogons(1)).toNumber();
        totalActiveBonds += eligibleBonds;
        if (terms.isFlexible) flexibleBondsEligible += eligibleBonds;
        bondLots.push({ lot, eligibleMicrogons });
      }
      return { bondLots, totalActiveBonds, flexibleBondsEligible };
    }
    const vaultCapital = frameCapitalRaw.vaults[String(vaultId)];
    if (!vaultCapital) {
      return {
        bondLots,
        totalActiveBonds: 0,
        flexibleBondsEligible: 0,
      };
    }

    const totalActiveBonds = vaultCapital.eligibleBonds;
    const flexibleBondsEligible = vaultCapital.flexibleBondsEligible;
    const allocations = vaultCapital.regularBondAllocations;
    const regularMicrogons = BondLot.bondsToMicrogons(totalActiveBonds - flexibleBondsEligible);
    // Deployed payout shares divide by capacity, including unfilled space.
    // Normalize those shares across regular participation, not the whole vault.
    const regularShare = allocations.reduce((sum, allocation) => sum.plus(allocation.prorata), BigNumber(0));
    const bondLotIds = allocations.map(allocation => allocation.bondLotId);
    const bondLotsById = await TreasuryBonds.getBondLotsById(client, bondLotIds, operatorAddress);

    for (const allocation of allocations) {
      const bondLotId = allocation.bondLotId;
      const lot = bondLotsById.get(bondLotId);
      if (!lot) continue;

      const eligibleMicrogons = regularShare.isZero()
        ? 0n
        : bigNumberToBigInt(BigNumber(regularMicrogons).times(allocation.prorata).div(regularShare));
      bondLots.push({ lot, eligibleMicrogons });
    }

    return {
      bondLots,
      totalActiveBonds,
      flexibleBondsEligible,
    };
  }

  public static async buildBuyBondTx(args: {
    client: ArgonClient;
    vaultId: number;
    bondPurchaseMicrogons: bigint;
  }): Promise<SubmittableExtrinsic> {
    const { client, vaultId } = args;
    const bonds = BondLot.microgonsToBonds(args.bondPurchaseMicrogons);
    return client.tx.treasury.buyBonds(vaultId, bonds, null);
  }

  public static async buildReleaseBondLotTx(args: {
    client: ArgonClient;
    bondLotId: number;
  }): Promise<SubmittableExtrinsic> {
    return args.client.tx.treasury.liquidateBondLot(args.bondLotId);
  }

  private static vaultPoolRewardRate(
    position: Parameters<typeof TreasuryBonds.vaultPoolEarnings>[0]['position'],
    percentForVaultPool: BigNumber,
  ): bigint {
    const {
      securitization,
      activatedSecuritization,
      bitcoinLockedMicrogons,
      activeBondMicrogons,
      argonotSecuritizationInMicrogons,
    } = position;
    if (securitization <= 0n) return 0n;
    const excessBitcoinValue = bigIntMax(0n, bitcoinLockedMicrogons - securitization);
    const bitcoinUtilization = fixedU128Rational(
      bigIntMax(0n, bigIntMin(activatedSecuritization, securitization) - excessBitcoinValue),
      securitization,
    );
    const bondUtilization = fixedU128Rational(bigIntMin(activeBondMicrogons, securitization), securitization);
    const argonotCapacity = bigIntMin(U128_MAX, securitization * 2n);
    const argonotValue = bigIntMin(argonotSecuritizationInMicrogons, argonotCapacity);
    const argonotUtilization = fixedU128Rational(argonotValue, argonotCapacity);
    const maximumRate = bigNumberToBigInt(percentForVaultPool.times(FIXED_U128_ONE));
    const minimumRate = fixedU128Rational(1n, 100n);
    const maximumCoreRate = fixedU128Rational(maximumRate, fixedU128Rational(387n, 100n));
    const coreUtilization = fixedU128Multiply(
      bitcoinUtilization,
      fixedU128Rational(9n, 10n) + fixedU128Multiply(fixedU128Rational(1n, 10n), bondUtilization),
    );
    const coreRate = minimumRate + fixedU128Multiply(coreUtilization, bigIntMax(0n, maximumCoreRate - minimumRate));
    const capitalMultiplier = fixedU128Rational(bigIntMin(U128_MAX, securitization + argonotValue), securitization);
    const argonotBonus =
      FIXED_U128_ONE +
      fixedU128Multiply(fixedU128Multiply(fixedU128Rational(29n, 100n), argonotUtilization), bitcoinUtilization);
    return bigIntMin(maximumRate, fixedU128Multiply(fixedU128Multiply(coreRate, capitalMultiplier), argonotBonus));
  }

  /** Read the quantity frozen for a payout, before that payout clears the frame terms. */
  private static async getEarningParticipation({
    client,
    frameId,
    lots,
    capital,
  }: {
    client: ArgonQueryClient;
    frameId: number;
    lots: BondLot[];
    capital: HistoricalQueryRecord<'treasury', 'currentFrameVaultCapital'> | null | undefined;
  }): Promise<IBondFrameEarnings[]> {
    const stakes = await client.query.treasury.currentFrameArgonotBondParticipants();
    const vaultStates = new Map<number, HistoricalQueryRecord<'treasury', 'bondLotsByVault'> | null>();
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
        const position = capital.vaults[lot.vaultId!];
        if (!position || !('regularBondAllocations' in position)) continue;
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
            const flexibleLots = lots.filter(x => x.vaultId === vaultId && x.isFlexible && !x.isReleasing);
            const total = flexibleLots.reduce((sum, x) => sum + x.bonds, 0);
            fraction = fixedU128Rational(BigInt(position.flexibleBondsEligible), BigInt(total));
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
        if (!vaultStates.has(vaultId)) vaultStates.set(vaultId, await client.query.treasury.bondLotsByVault(vaultId));
        const state = vaultStates.get(vaultId)!;
        if (!('lockedFrameTerms' in state)) continue;
        const frozen = state.lockedFrameTerms ?? state;
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

  private static async getVaultBondSources(client: ArgonCurrentQueryClient, vaultId: number) {
    const vaultState = await client.query.treasury.bondLotsByVault(vaultId);
    if ('regularBonds' in vaultState) {
      const keys = await client.query.treasury.bondLotIdsByVault.keys(vaultId);
      return { bondLotIds: (keys ?? []).map(key => key.args[1]), state: vaultState, replacementBonds: 0 };
    }

    const summaries = vaultState.regularBondLots;
    const regularBonds = summaries.reduce((total, summary) => total + summary.bonds, 0);
    let displacedFlexibleBonds = 0;
    if (vaultState.flexibleBonds > 0) {
      const [vault, priceIndex] = await Promise.all([Vault.get(client, vaultId), Currency.fetchPriceIndex(client)]);
      const capacity = TreasuryBonds.getBondPurchaseCapacity(vault.bondCapacityMicrogons(priceIndex));
      displacedFlexibleBonds = Math.max(0, vaultState.flexibleBonds - Math.max(0, capacity - regularBonds));
    }
    let replacementBonds = 0;
    const constants = client.consts.treasury;
    if ('maxTreasuryContributors' in constants && summaries.length >= constants.maxTreasuryContributors) {
      replacementBonds = summaries.at(-1)?.bonds ?? 0;
    }

    return {
      bondLotIds: summaries.map(summary => summary.bondLotId),
      state: {
        regularBonds,
        flexibleBonds: vaultState.flexibleBonds,
        reservedBondSpace: vaultState.reservedBondSpace,
        displacedFlexibleBonds,
        lockedFrameTerms: null,
      } satisfies VaultBondState,
      replacementBonds,
    };
  }

  private static async getBondLotsById(
    client: ArgonCurrentQueryClient,
    ids: number[],
    ownAddress?: string,
  ): Promise<Map<number, BondLot>> {
    if (ids.length === 0) return new Map();

    const lots = (await client.query.treasury.bondLotById.multi(ids)) ?? [];
    const result = new Map<number, BondLot>();

    for (let i = 0; i < ids.length; i += 1) {
      const lot = lots[i];
      if (lot) result.set(ids[i], BondLot.fromRuntime(ids[i], lot, ownAddress));
    }

    return result;
  }
}
