import type { BondLot, ICapitalFlow, IInvestmentPositionValue } from '@argonprotocol/apps-core';
import type { Vault } from '@argonprotocol/mainchain';
import type { IWallet } from '../lib/Wallet.ts';
import type { IStableSwapPurchaseRecord } from '../lib/db/StableSwapPurchasesTable.ts';
import type { IBondLotHistoryRecord } from '../lib/db/BondLotHistoryTable.ts';
import type { IBitcoinLockRecord } from './IBitcoinLockRecord.ts';
import type { IMiningCohortFinancialRecord } from './db/ICohortFrameRecord.ts';
import type { IFrameBidRecord } from './db/IFrameBidRecord.ts';
import type { IVaultCapitalHistoryRecord } from '../lib/db/VaultCapitalHistoryTable.ts';
import type { IVaultRevenueEventsRecord } from '../lib/db/VaultRevenueEventsTable.ts';

export const financialGroups = ['liquid', 'ethereum', 'base', 'mining', 'vaulting', 'bonds', 'bitcoin'] as const;

export type FinancialGroup = (typeof financialGroups)[number];
type FinancialGroupState = 'loading' | 'ready' | 'stale' | 'error';
type FinancialAggregateReadiness = 'loading' | 'partial' | 'ready' | 'error';
type FinancialPositionLifecycle =
  | 'available'
  | 'held'
  | 'reserved'
  | 'active'
  | 'releasing'
  | 'completed'
  | 'unavailable';

export interface IFinancialScope {
  ownedAccounts: readonly string[];
}

export interface IFinancialObservation {
  observedAt: Date;
  blockNumber?: number;
  blockHash?: string;
}

interface IFinancialPositionBase {
  id: string;
  kind: string;
  group: FinancialGroup;
  label: string;
  lifecycle: FinancialPositionLifecycle;
  currentValue?: bigint;
}

interface IFinancialInvestmentPositionBase
  extends IFinancialPositionBase,
    Pick<IInvestmentPositionValue, 'investedCost' | 'paidIncome' | 'settledPrincipalValue'> {
  startedAt?: Date | number | string;
  endedAt?: Date | number | string;
  capitalFlows?: readonly ICapitalFlow[];
}

export interface IWalletBalanceFinancialPosition extends IFinancialPositionBase {
  kind: 'wallet-balance';
  group: 'liquid';
  wallet: IWallet;
  balanceType: 'transferable' | 'unattributed-hold';
  asset: string;
  accountId?: string;
  nativeAmount?: bigint;
}

export interface IWalletHoldingFinancialPosition extends IFinancialInvestmentPositionBase {
  kind: 'wallet-holding';
  group: 'liquid';
  accountId: string;
  nativeAsset: 'ARGNOT';
  nativeAmount: bigint;
  entryArgonotRateMicrogons?: bigint;
  closingArgonotRateMicrogons?: bigint;
}

export interface IEthereumWalletFinancialPosition extends IFinancialPositionBase {
  kind: 'ethereum-wallet-balance';
  group: 'ethereum';
  wallet: IWallet;
  asset: string;
  nativeAmount?: bigint;
}

export interface IBaseWalletFinancialPosition extends IFinancialPositionBase {
  kind: 'base-wallet-balance';
  group: 'base';
  wallet: IWallet;
  asset: string;
}

export interface IMiningBidFinancialPosition extends IFinancialInvestmentPositionBase {
  kind: 'mining-bid';
  group: 'mining';
  bid: IFrameBidRecord;
  nativeStakedMicronots: bigint;
  entryArgonotRateMicrogons?: bigint;
  currentArgonotRateMicrogons?: bigint;
}

export interface IMiningBalanceFinancialPosition extends IFinancialPositionBase {
  kind: 'mining-balance';
  group: 'mining';
  accountId: string;
  asset: 'ARGN' | 'ARGNOT';
  amount: bigint;
}

export interface IMiningCohortFinancialPosition extends IFinancialInvestmentPositionBase {
  kind: 'mining-cohort';
  group: 'mining';
  cohort: IMiningCohortFinancialRecord;
  recoveredValue: bigint;
  remainingSeatValue: bigint;
  // Mining RTD uses realized income rather than the seat's current asset value.
  performanceEndingCapital?: bigint;
  currentArgonotRateMicrogons?: bigint;
  closingArgonotRateMicrogons?: bigint;
}

interface IMiningArgonotFinancialPositionBase extends IFinancialInvestmentPositionBase {
  kind: 'mining-argonot';
  group: 'mining';
  micronots: bigint;
  entryArgonotRateMicrogons?: bigint;
  currentArgonotRateMicrogons?: bigint;
  closingArgonotRateMicrogons?: bigint;
}

export type IMiningArgonotFinancialPosition = IMiningArgonotFinancialPositionBase &
  ({ source: 'collateral' | 'rewards'; cohort: IMiningCohortFinancialRecord } | { source: 'custody'; cohort?: never });

interface IBondFinancialPositionBase extends IFinancialInvestmentPositionBase {
  kind: 'bond';
  group: 'bonds';
  nativeAsset: BondLot['nativeAsset'];
  nativePrincipal: bigint;
  entryArgonotRateMicrogons?: bigint;
  currentArgonotRateMicrogons?: bigint;
  closingArgonotRateMicrogons?: bigint;
  // The owned vault already carries this bond's principal at the account level.
  excludeFromAccountAggregate?: boolean;
}

export type IBondFinancialPosition = IBondFinancialPositionBase &
  ({ bondLot: BondLot; history?: never } | { bondLot?: never; history: IBondLotHistoryRecord });

export interface IVaultFinancialPosition extends IFinancialInvestmentPositionBase {
  kind: 'vault';
  group: 'vaulting';
  vaultId: number;
  vault?: Vault;
  securitization: bigint;
  uncollectedRevenue: bigint;
  capitalHistory: readonly IVaultCapitalHistoryRecord[];
  revenueHistory: readonly IVaultRevenueEventsRecord[];
}

export interface IVaultBalanceFinancialPosition extends IFinancialPositionBase {
  kind: 'vault-balance';
  group: 'vaulting';
  asset: 'ARGNOT';
  amount: bigint;
}

export interface IBitcoinAssetFinancialPosition extends IFinancialInvestmentPositionBase {
  kind: 'bitcoin-asset';
  group: 'bitcoin';
  lock: IBitcoinLockRecord;
  // Bitcoin keeps its established return model while exposing the asset and redemption liability separately.
  performanceEndingCapital?: bigint;
}

export interface IBitcoinLiabilityFinancialPosition extends IFinancialPositionBase {
  kind: 'bitcoin-liability';
  group: 'bitcoin';
  lock: IBitcoinLockRecord;
}

export interface IStableSwapFinancialPosition extends IFinancialInvestmentPositionBase {
  kind: 'stable-swap';
  group: 'ethereum';
  wallet: IWallet;
  purchases: readonly IStableSwapPurchaseRecord[];
  nativeAmount: bigint;
  isQuantityReconciled: boolean;
}

export type IFinancialInvestmentPosition =
  | IWalletHoldingFinancialPosition
  | IMiningBidFinancialPosition
  | IMiningCohortFinancialPosition
  | IMiningArgonotFinancialPosition
  | IBondFinancialPosition
  | IVaultFinancialPosition
  | IBitcoinAssetFinancialPosition
  | IStableSwapFinancialPosition;

export type IFinancialPosition =
  | IWalletBalanceFinancialPosition
  | IEthereumWalletFinancialPosition
  | IBaseWalletFinancialPosition
  | IMiningBalanceFinancialPosition
  | IVaultBalanceFinancialPosition
  | IFinancialInvestmentPosition
  | IBitcoinLiabilityFinancialPosition;

export interface IFinancialPositionSource<Args, Position extends IFinancialPosition> {
  loadPositions(args: Args): Promise<Position[]>;
}

type IFinancialPositionByKind = {
  [Position in IFinancialPosition as Position['kind']]: Position;
};

type FinancialPositionKind = keyof IFinancialPositionByKind;

const financialGroupByPositionKind = {
  'wallet-balance': 'liquid',
  'wallet-holding': 'liquid',
  'ethereum-wallet-balance': 'ethereum',
  'base-wallet-balance': 'base',
  'mining-balance': 'mining',
  'mining-bid': 'mining',
  'mining-cohort': 'mining',
  'mining-argonot': 'mining',
  bond: 'bonds',
  vault: 'vaulting',
  'vault-balance': 'vaulting',
  'bitcoin-asset': 'bitcoin',
  'bitcoin-liability': 'bitcoin',
  'stable-swap': 'ethereum',
} as const satisfies { [Kind in FinancialPositionKind]: IFinancialPositionByKind[Kind]['group'] };

type FinancialInvestmentPositionKind = IFinancialInvestmentPosition['kind'];
type FinancialPositionFields = 'kind' | 'group';
type FinancialValueFields = keyof IInvestmentPositionValue;
type FinancialPositionInput<Kind extends FinancialPositionKind> = Kind extends FinancialInvestmentPositionKind
  ? Omit<IFinancialPositionByKind[Kind], FinancialPositionFields | FinancialValueFields>
  : Omit<IFinancialPositionByKind[Kind], FinancialPositionFields>;
type FinancialPositionValue<Kind extends FinancialPositionKind> = Kind extends FinancialInvestmentPositionKind
  ? [value: IInvestmentPositionValue]
  : [];

/** Adds shared position identity and value fields while domain callers provide only domain facts. */
export function createFinancialPosition<Kind extends FinancialPositionKind>(
  kind: Kind,
  position: FinancialPositionInput<Kind>,
  ...value: FinancialPositionValue<Kind>
): IFinancialPositionByKind[Kind] {
  const result = {
    ...position,
    ...(value[0] ? toInvestmentPositionValue(value[0]) : {}),
    kind,
    group: financialGroupByPositionKind[kind],
  } as IFinancialPosition;

  return result as IFinancialPositionByKind[Kind];
}

export function withInvestmentBasis(
  value: IInvestmentPositionValue,
  hasConfirmedBasis: boolean,
): IInvestmentPositionValue {
  if (hasConfirmedBasis) return toInvestmentPositionValue(value);
  return { currentValue: value.currentValue, paidIncome: value.paidIncome };
}

function toInvestmentPositionValue(value: IInvestmentPositionValue): IInvestmentPositionValue {
  return {
    currentValue: value.currentValue,
    investedCost: value.investedCost,
    paidIncome: value.paidIncome,
    settledPrincipalValue: value.settledPrincipalValue,
  };
}

interface IFinancialGroupSnapshotBase {
  group: FinancialGroup;
  positions: readonly IFinancialPosition[];
  message?: string;
}

interface IFinancialUnavailableGroupSnapshot extends IFinancialGroupSnapshotBase {
  state: 'loading' | 'error';
  observation?: IFinancialObservation;
}

export interface IFinancialObservedGroupSnapshot extends IFinancialGroupSnapshotBase {
  state: 'ready' | 'stale';
  observation: IFinancialObservation;
}

export type IFinancialGroupSnapshot = IFinancialUnavailableGroupSnapshot | IFinancialObservedGroupSnapshot;

type FinancialReturnAvailability = 'not-applicable' | 'available' | 'partial' | 'unavailable';

export interface IFinancialReturnSummary {
  availability: FinancialReturnAvailability;
  investedCost: bigint;
  paidIncome: bigint;
  settledPrincipalValue: bigint;
  returnAmount?: bigint;
  basisPoints?: bigint;
  percent?: number;
  eligiblePositionCount: number;
  investmentPositionCount: number;
}

export interface IFinancialGroupSummary {
  group: FinancialGroup;
  state: FinancialGroupState;
  isStale: boolean;
  positions: readonly IFinancialPosition[];
  currentValue: bigint;
  grossAssets: bigint;
  grossLiabilities: bigint;
  observation?: IFinancialObservation;
  message?: string;
  returnSummary: IFinancialReturnSummary;
}

export type IFinancialAccountReturnSummary = Pick<
  IFinancialReturnSummary,
  'availability' | 'basisPoints' | 'percent' | 'eligiblePositionCount' | 'investmentPositionCount'
>;

export interface IFinancialAggregate {
  groups: readonly IFinancialGroupSummary[];
  groupSummaries: Record<FinancialGroup, IFinancialGroupSummary>;
  accountReturn: IFinancialAccountReturnSummary;
  grossAssets: bigint;
  grossLiabilities: bigint;
  netWorth?: bigint;
  readiness: FinancialAggregateReadiness;
  isStale: boolean;
}

export interface IFinancialRefreshToken {
  group: FinancialGroup;
  generation: number;
  scopeKey: string;
}
