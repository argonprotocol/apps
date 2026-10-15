import type { SubmittableExtrinsic } from '@argonprotocol/mainchain';
import { hexToU8a, stringToU8a, u8aConcat } from '@polkadot/util';
import { bigIntMax, bigIntMin, bigNumberToBigInt } from './utils.js';
import { FIXED_U128_ONE, U128_MAX, fixedU128Rational, fixedU128Multiply } from './FixedU128.js';
import BigNumber from 'bignumber.js';
import { BondLot } from './BondLot.js';
import { Currency, MICRONOTS_PER_ARGONOT } from './Currency.js';
import { Vault } from './Vault.js';
import type { ArgonClient, ArgonCurrentQueryClient, ArgonQueryClient } from './MainchainClients.js';
import type {
  CurrentRuntimeQueries,
  LiveQueryRecord,
  LiveRuntimeQueries,
  RuntimeQueryResult,
} from '@argonprotocol/runtime-client';

const U32_MAX = 4_294_967_295n;

export interface IFrameBondLot {
  lot: BondLot;
  /** Frozen participation, including fractional flexible-bond displacement. */
  eligibleMicrogons: bigint;
}

export type VaultBondState = NonNullable<RuntimeQueryResult<CurrentRuntimeQueries['treasury']['bondLotsByVault']>>;

export class TreasuryBonds {
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
    averageMicrogonsPerArgonot?: bigint;
    fullBidPool?: bigint;
    upstreamBitcoinTarget?: bigint;
    upstreamBondTarget?: bigint;
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
        averageMicrogonsPerArgonot: argonotPrices?.[Math.max(0, frameCapitalRaw.frameId - 1)],
        fullBidPool: account.data.free,
        upstreamBitcoinTarget: 'upstreamBitcoinTarget' in constants ? constants.upstreamBitcoinTarget : undefined,
        upstreamBondTarget: 'upstreamBondTarget' in constants ? constants.upstreamBondTarget : undefined,
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

  public static async getActiveArgonotBonds(client: ArgonCurrentQueryClient): Promise<bigint> {
    if ('networkTotals' in client.query.treasuryPositions) {
      const networkTotals = await client.query.treasuryPositions.networkTotals();
      return networkTotals!.stakes;
    }
    return BigInt((await client.query.treasury.totalActiveArgonotBonds()) ?? 0);
  }

  public static getArgonotBondPurchaseCapacity(args: {
    totalIssuanceMicronots: bigint;
    maxBondedPercent: number;
    totalActiveBonds: number | bigint;
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
    argonotSecuritizationRewardRatio,
  }: {
    securitizationMicrogons: bigint;
    averageMicrogonsPerArgonot?: bigint;
    argonotSecuritizationRewardRatio: bigint;
  }): bigint | undefined {
    if (argonotSecuritizationRewardRatio === 0n) return 0n;
    if (securitizationMicrogons <= 0n) return 0n;
    if (!averageMicrogonsPerArgonot || averageMicrogonsPerArgonot <= 0n) return;
    const capacity = bigIntMin(U128_MAX, securitizationMicrogons * FIXED_U128_ONE * argonotSecuritizationRewardRatio);
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
    minimumVaultProfitRate,
    argonotSecuritizationRewardRatio,
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
    minimumVaultProfitRate: BigNumber;
    argonotSecuritizationRewardRatio: bigint;
  }): bigint {
    const { securitization } = position;
    const denominator = bigIntMax(frameCapital.targetSecuritization, frameCapital.totalSecuritization);
    if (securitization <= 0n || denominator <= 0n || fullBidPool <= 0n) return 0n;
    const rate = this.vaultPoolRewardRate({
      position,
      percentForVaultPool,
      minimumVaultProfitRate,
      argonotSecuritizationRewardRatio,
    });
    return fixedU128Multiply(fixedU128Multiply(fixedU128Rational(securitization, denominator), rate), fullBidPool);
  }

  public static vaultRevenuePotential(args: Parameters<typeof TreasuryBonds.vaultPoolEarnings>[0]) {
    const { position, frameCapital, argonotSecuritizationRewardRatio } = args;
    const maximumPosition = {
      ...position,
      activatedSecuritization: position.securitization,
      bitcoinLockedMicrogons: position.securitization,
      activeBondMicrogons: position.securitization,
      argonotSecuritizationInMicrogons: bigIntMin(U128_MAX, position.securitization * argonotSecuritizationRewardRatio),
      upstreamParticipation: new BigNumber(1),
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
    const maximumRate = denominator > 0n ? this.vaultPoolRewardRate({ ...args, position: maximumPosition }) : 0n;
    const actualRate = this.vaultPoolRewardRate(args);
    const maximumArgonotRate = this.vaultPoolRewardRate({ ...args, position: maximumArgonotPosition });
    return {
      actualEarnings,
      maximumEarnings,
      upstreamParticipationPercent: position.upstreamParticipation.times(100).toNumber(),
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

  public static async getBondLotsByAccount(client: ArgonQueryClient, accountId: string): Promise<BondLot[]> {
    const accountKeys = await client.query.treasury.bondLotIdsByAccount.keys(accountId);
    const ids = [...new Set((accountKeys ?? []).map(key => key.args[1]))];
    const lotsById = await TreasuryBonds.getBondLotsById(client, ids, accountId);

    return ids.flatMap(id => {
      const lot = lotsById.get(id);
      return lot ? [lot] : [];
    });
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

  private static vaultPoolRewardRate({
    position,
    percentForVaultPool,
    minimumVaultProfitRate,
    argonotSecuritizationRewardRatio,
  }: Pick<
    Parameters<typeof TreasuryBonds.vaultPoolEarnings>[0],
    'position' | 'percentForVaultPool' | 'minimumVaultProfitRate' | 'argonotSecuritizationRewardRatio'
  >): bigint {
    const {
      securitization,
      activatedSecuritization,
      bitcoinLockedMicrogons,
      activeBondMicrogons,
      argonotSecuritizationInMicrogons,
      upstreamParticipation,
    } = position;
    if (securitization <= 0n) return 0n;
    const excessBitcoinValue = bigIntMax(0n, bitcoinLockedMicrogons - securitization);
    const bitcoinUtilization = fixedU128Rational(
      bigIntMax(0n, bigIntMin(activatedSecuritization, securitization) - excessBitcoinValue),
      securitization,
    );
    const bondUtilization = fixedU128Rational(bigIntMin(activeBondMicrogons, securitization), securitization);
    const argonotCapacity = bigIntMin(U128_MAX, securitization * argonotSecuritizationRewardRatio);
    const argonotValue = bigIntMin(argonotSecuritizationInMicrogons, argonotCapacity);
    const argonotUtilization = argonotCapacity > 0n ? fixedU128Rational(argonotValue, argonotCapacity) : 0n;
    const maximumRate = bigNumberToBigInt(percentForVaultPool.times(FIXED_U128_ONE));
    const minimumRate = bigNumberToBigInt(minimumVaultProfitRate.times(FIXED_U128_ONE));
    let maximumCoreRate = maximumRate;
    if (argonotSecuritizationRewardRatio > 0n) {
      const maximumArgonotMultiplier = fixedU128Rational((1n + argonotSecuritizationRewardRatio) * 129n, 100n);
      maximumCoreRate = fixedU128Rational(maximumRate, maximumArgonotMultiplier);
    }
    const coreUtilization = fixedU128Multiply(
      bitcoinUtilization,
      fixedU128Rational(9n, 10n) + fixedU128Multiply(fixedU128Rational(1n, 10n), bondUtilization),
    );
    const coreRate = minimumRate + fixedU128Multiply(coreUtilization, bigIntMax(0n, maximumCoreRate - minimumRate));
    const capitalMultiplier = fixedU128Rational(bigIntMin(U128_MAX, securitization + argonotValue), securitization);
    const argonotBonus =
      FIXED_U128_ONE +
      fixedU128Multiply(fixedU128Multiply(fixedU128Rational(29n, 100n), argonotUtilization), bitcoinUtilization);
    const profitRate = bigIntMin(
      maximumRate,
      fixedU128Multiply(fixedU128Multiply(coreRate, capitalMultiplier), argonotBonus),
    );
    const participation = bigNumberToBigInt(upstreamParticipation.times(FIXED_U128_ONE));
    return minimumRate + fixedU128Multiply(participation, bigIntMax(0n, profitRate - minimumRate));
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
    client: ArgonQueryClient,
    ids: number[],
    ownAddress?: string,
  ): Promise<Map<number, BondLot>> {
    if (ids.length === 0) return new Map();

    const bondLotById = client.query.treasury.bondLotById as LiveRuntimeQueries['treasury']['bondLotById'];
    const lots = (await bondLotById.multi(ids)) ?? [];
    const result = new Map<number, BondLot>();

    for (let i = 0; i < ids.length; i += 1) {
      const lot = lots[i];
      if (lot) result.set(ids[i], BondLot.fromRuntime(ids[i], lot, ownAddress));
    }

    return result;
  }
}
