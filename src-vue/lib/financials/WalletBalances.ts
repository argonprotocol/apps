import { bigIntMax, bigIntMin, calculatePrincipalPositionValue, Currency } from '@argonprotocol/apps-core';
import type {
  IFinancialPositionSource,
  IWalletBalanceFinancialPosition,
  IWalletHoldingFinancialPosition,
} from '../../interfaces/IFinancialPosition.ts';
import { createFinancialPosition } from '../../interfaces/IFinancialPosition.ts';
import type { IArgonAccountBalance, WalletsForArgon } from '../WalletsForArgon.ts';
import type { IWalletTransferRecord } from '../db/WalletTransfersTable.ts';
import { takeFifoLots } from '../Utils.ts';

type ArgonotHoldingLot = {
  id: string;
  amount: bigint;
  entryRate: bigint;
  startedAt: Date;
};

export type ArgonotHoldingBasis = {
  activeLotsByAccount: ReadonlyMap<string, readonly ArgonotHoldingLot[]>;
  completedPositions: readonly IWalletHoldingFinancialPosition[];
  incompleteAccounts: ReadonlySet<string>;
};

type WalletFinancialPosition = IWalletBalanceFinancialPosition | IWalletHoldingFinancialPosition;

type WalletFinancialPositionArgs = {
  accounts: readonly IArgonAccountBalance[];
  claimedHolds: { treasury: boolean; miningSlot: boolean; vaults: boolean };
  claimedMicronotsByAccount?: ReadonlyMap<string, bigint>;
  liveArgonotRateMicrogons?: bigint;
  hasConfirmedHistoryCoverage?: boolean;
};

type WalletPositionData = Omit<
  WalletFinancialPositionArgs,
  'liveArgonotRateMicrogons' | 'hasConfirmedHistoryCoverage'
> & {
  holdingBasis: ArgonotHoldingBasis;
  liveArgonotRateMicrogons: bigint;
};

export class WalletFinancials
  implements IFinancialPositionSource<WalletFinancialPositionArgs, WalletFinancialPosition>
{
  private argonotHoldingBasis?: { key: string; promise: Promise<ArgonotHoldingBasis> };

  constructor(private readonly wallets: WalletsForArgon) {}

  public async loadPositions(args: WalletFinancialPositionArgs): Promise<WalletFinancialPosition[]> {
    // MiningFinancials reconstructs all mining-bot custody from owned-side boundaries and claims it below.
    // Do not replay the mining bot's high-volume balance and reward history here.
    const trackedAddresses = [
      ...new Set(
        [
          this.wallets.defaultArgonWallet.address,
          this.wallets.operationalWallet.address,
          this.wallets.legacyMiningHoldAddress,
        ].filter(Boolean),
      ),
    ];
    const holdingBasis =
      args.hasConfirmedHistoryCoverage !== false
        ? await this.loadArgonotHoldingBasis(trackedAddresses, this.wallets.miningBotWallet.address)
        : {
            activeLotsByAccount: new Map(),
            completedPositions: [],
            incompleteAccounts: new Set<string>(),
          };

    return this.createFinancialPositions({
      ...args,
      holdingBasis,
      liveArgonotRateMicrogons: args.liveArgonotRateMicrogons ?? 0n,
    });
  }

  public createFinancialPositions(args: WalletPositionData): WalletFinancialPosition[] {
    const balancesByAccount = new Map(
      args.accounts.map(account => [account.address, getBalanceBuckets(account, args.claimedHolds)] as const),
    );
    const holdingPositions = createArgonotHoldingPositions({
      ...args,
      balancesByAccount,
    });

    return [
      ...createResidualWalletBalancePositions({
        ...args,
        balancesByAccount,
        holdingPositions,
      }),
      ...holdingPositions,
    ];
  }

  public reduceArgonotHoldingBasis({
    transfers,
    trackedAddresses,
    miningBotAddress,
  }: {
    transfers: readonly IWalletTransferRecord[];
    trackedAddresses: ReadonlySet<string>;
    miningBotAddress: string;
  }): ArgonotHoldingBasis {
    const lotsByAccount = new Map<string, ArgonotHoldingLot[]>();
    const completedPositions: IWalletHoldingFinancialPosition[] = [];
    const incompleteAccounts = new Set<string>();
    for (const transfer of transfers) {
      if (transfer.amount === 0n) continue;

      if (transfer.amount > 0n) {
        // Matching owned-account credits are moved by their debit row below. A
        // mining-bot credit is a new wallet position at the custody handoff mark.
        const isBasisCredit = !transfer.isInternal || transfer.otherParty === miningBotAddress;
        if (!isBasisCredit) continue;

        // Local ingestion and historical recovery both enrich receipts with the
        // block time and ARGNOT rate. Preserve the asset but withhold its return
        // if an older row still could not be enriched.
        if (!transfer.blockTime || transfer.microgonsForArgonot <= 0n) {
          if (trackedAddresses.has(transfer.walletAddress)) incompleteAccounts.add(transfer.walletAddress);
          continue;
        }

        const lots = lotsByAccount.get(transfer.walletAddress) ?? [];
        lots.push({
          id: `transfer:${transfer.id}`,
          amount: transfer.amount,
          entryRate: transfer.microgonsForArgonot,
          startedAt: transfer.blockTime,
        });
        lotsByAccount.set(transfer.walletAddress, lots);
        continue;
      }

      const quantity = -transfer.amount;
      const lots = takeFifoLots(lotsByAccount.get(transfer.walletAddress) ?? [], quantity);
      const trackedQuantity = lots.reduce((sum, lot) => sum + lot.amount, 0n);
      const hasIncompleteQuantity = trackedQuantity < quantity && trackedAddresses.has(transfer.walletAddress);
      if (hasIncompleteQuantity) {
        incompleteAccounts.add(transfer.walletAddress);
      }

      if (!transfer.isInternal || transfer.otherParty === miningBotAddress) {
        for (const lot of lots) completedPositions.push(createCompletedWalletHoldingPosition(lot, transfer));
        continue;
      }

      const destination = transfer.otherParty;
      if (!destination || !trackedAddresses.has(destination)) continue;
      if (hasIncompleteQuantity) incompleteAccounts.add(destination);

      const destinationLots = lotsByAccount.get(destination) ?? [];
      destinationLots.push(...lots);
      lotsByAccount.set(destination, destinationLots);
    }

    return { activeLotsByAccount: lotsByAccount, completedPositions, incompleteAccounts };
  }

  private async loadArgonotHoldingBasis(
    trackedAddresses: readonly string[],
    miningBotAddress: string,
  ): Promise<ArgonotHoldingBasis> {
    const db = await this.wallets.dbPromise;
    const transfers = db.walletTransfersTable;
    const scope = JSON.stringify([trackedAddresses, miningBotAddress]);
    const revision = transfers.argonotCustodyRevision;
    const key = `${revision}:${scope}`;
    if (this.argonotHoldingBasis?.key === key) return this.argonotHoldingBasis.promise;

    const promise = transfers.fetchArgonotCustody(trackedAddresses).then(records => {
      if (transfers.argonotCustodyRevision !== revision) {
        return this.loadArgonotHoldingBasis(trackedAddresses, miningBotAddress);
      }
      return this.reduceArgonotHoldingBasis({
        transfers: records,
        trackedAddresses: new Set(trackedAddresses),
        miningBotAddress,
      });
    });
    this.argonotHoldingBasis = { key, promise };
    void promise.catch(() => {
      if (this.argonotHoldingBasis?.promise === promise) this.argonotHoldingBasis = undefined;
    });
    return promise;
  }
}

function getBalanceBuckets(
  account: IArgonAccountBalance,
  claimedHolds: { treasury: boolean; miningSlot: boolean; vaults: boolean },
) {
  const totalMicrogonHolds = account.microgonHolds.reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
  const totalMicronotHolds = account.micronotHolds.reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
  if (totalMicrogonHolds > account.availableMicrogons) {
    throw new Error(`ARGN holds exceed free balance for ${account.address}`);
  }
  if (totalMicronotHolds > account.availableMicronots) {
    throw new Error(`ARGNOT holds exceed free balance for ${account.address}`);
  }

  const claimedMicrogons = account.microgonHolds.reduce((sum, hold) => {
    return isClaimedFinancialHold(hold, claimedHolds) ? sum + hold.amount.toBigInt() : sum;
  }, 0n);
  const claimedMicronots = account.micronotHolds.reduce((sum, hold) => {
    return isClaimedFinancialHold(hold, claimedHolds) ? sum + hold.amount.toBigInt() : sum;
  }, 0n);

  return [
    {
      asset: 'ARGN' as const,
      transferable: account.availableMicrogons - totalMicrogonHolds,
      unattributed: account.reservedMicrogons + totalMicrogonHolds - claimedMicrogons,
    },
    {
      asset: 'ARGNOT' as const,
      transferable: account.availableMicronots - totalMicronotHolds,
      unattributed: account.reservedMicronots + totalMicronotHolds - claimedMicronots,
    },
  ];
}

function isClaimedFinancialHold(
  hold: IArgonAccountBalance['microgonHolds'][number],
  claimedHolds: { treasury: boolean; miningSlot: boolean; vaults: boolean },
): boolean {
  if (hold.id.isTreasury) return claimedHolds.treasury;
  if (hold.id.isMiningSlot) return claimedHolds.miningSlot;
  if (!hold.id.isVaults) return false;
  return claimedHolds.vaults && (hold.id.asVaults.isEnterVault || hold.id.asVaults.isPendingCollect);
}

function createResidualWalletBalancePositions(args: {
  accounts: readonly IArgonAccountBalance[];
  balancesByAccount: ReadonlyMap<string, ReturnType<typeof getBalanceBuckets>>;
  holdingPositions: readonly IWalletHoldingFinancialPosition[];
  liveArgonotRateMicrogons: bigint;
  claimedMicronotsByAccount?: ReadonlyMap<string, bigint>;
}): IWalletBalanceFinancialPosition[] {
  const positions: IWalletBalanceFinancialPosition[] = [];
  const trackedMicronotsByAccount = new Map<string, bigint>();
  for (const position of args.holdingPositions) {
    if (position.lifecycle !== 'active') continue;

    trackedMicronotsByAccount.set(
      position.accountId,
      (trackedMicronotsByAccount.get(position.accountId) ?? 0n) + position.nativeAmount,
    );
  }

  for (const account of args.accounts) {
    const balances = args.balancesByAccount.get(account.address)!;
    let trackedMicronots = trackedMicronotsByAccount.get(account.address) ?? 0n;

    for (const balance of balances) {
      const asset = balance.asset;
      let transferable = balance.transferable;
      let unattributed = balance.unattributed;
      if (asset === 'ARGNOT') {
        let claimedMicronots = args.claimedMicronotsByAccount?.get(account.address) ?? 0n;
        const claimedTransferable = bigIntMin(transferable, claimedMicronots);
        transferable -= claimedTransferable;
        claimedMicronots -= claimedTransferable;

        const claimedUnattributed = bigIntMin(unattributed, claimedMicronots);
        unattributed -= claimedUnattributed;

        const trackedTransferable = bigIntMin(transferable, trackedMicronots);
        transferable -= trackedTransferable;
        trackedMicronots -= trackedTransferable;

        const trackedUnattributed = bigIntMin(unattributed, trackedMicronots);
        unattributed -= trackedUnattributed;
        trackedMicronots -= trackedUnattributed;
      }

      for (const [balanceType, amount] of [
        ['transferable', transferable],
        ['unattributed-hold', unattributed],
      ] as const) {
        if (amount <= 0n) continue;

        let currentValue: bigint | undefined;
        if (asset === 'ARGN') {
          currentValue = amount;
        } else if (args.liveArgonotRateMicrogons > 0n) {
          currentValue = Currency.convertMicronotToMicrogonAtPrice(amount, args.liveArgonotRateMicrogons);
        }
        positions.push(
          createFinancialPosition('wallet-balance', {
            id: `${account.address}:${asset}:${balanceType}`,
            label: `${balanceType === 'transferable' ? 'Available' : 'Other held'} ${asset}`,
            lifecycle: balanceType === 'transferable' ? 'available' : 'held',
            currentValue,
            wallet: account.wallet,
            balanceType,
            asset,
            accountId: account.address,
            nativeAmount: amount,
          }),
        );
      }
    }
  }

  return positions;
}

function createCompletedWalletHoldingPosition(
  lot: ArgonotHoldingLot,
  transfer: IWalletTransferRecord,
): IWalletHoldingFinancialPosition {
  const closingRate = transfer.microgonsForArgonot || undefined;
  const value = calculatePrincipalPositionValue({
    nativeAsset: 'ARGNOT',
    nativePrincipal: lot.amount,
    cumulativeEarnings: 0n,
    lifecycle: 'completed',
    entryArgonotPrice: lot.entryRate,
    closingArgonotPrice: closingRate,
  });

  return createFinancialPosition(
    'wallet-holding',
    {
      id: `wallet-holding:${lot.id}:exit:${transfer.id}`,
      label: 'ARGNOT holding',
      lifecycle: 'completed',
      startedAt: lot.startedAt,
      endedAt: transfer.blockTime,
      accountId: transfer.walletAddress,
      nativeAsset: 'ARGNOT',
      nativeAmount: lot.amount,
      entryArgonotRateMicrogons: lot.entryRate,
      closingArgonotRateMicrogons: closingRate,
    },
    value,
  );
}

function createArgonotHoldingPositions(args: {
  holdingBasis: ArgonotHoldingBasis;
  accounts: readonly IArgonAccountBalance[];
  balancesByAccount: ReadonlyMap<string, ReturnType<typeof getBalanceBuckets>>;
  liveArgonotRateMicrogons: bigint;
  claimedMicronotsByAccount?: ReadonlyMap<string, bigint>;
}): IWalletHoldingFinancialPosition[] {
  const active: IWalletHoldingFinancialPosition[] = [];
  const unavailableQuantities = new Map<string, bigint>();
  for (const account of args.accounts) {
    const lots = (args.holdingBasis.activeLotsByAccount.get(account.address) ?? []).map(lot => ({ ...lot }));
    const balances = args.balancesByAccount.get(account.address);
    const argonot = balances?.find(balance => balance.asset === 'ARGNOT');
    const walletQuantity = (argonot?.transferable ?? 0n) + (argonot?.unattributed ?? 0n);
    const claimedQuantity = bigIntMin(walletQuantity, args.claimedMicronotsByAccount?.get(account.address) ?? 0n);
    const availableQuantity = walletQuantity - claimedQuantity;
    const holdingQuantity = availableQuantity;
    const trackedQuantity = lots.reduce((sum, lot) => sum + lot.amount, 0n);

    takeFifoLots(lots, bigIntMax(trackedQuantity - holdingQuantity, 0n));
    for (const lot of lots) {
      const value = calculatePrincipalPositionValue({
        nativeAsset: 'ARGNOT',
        nativePrincipal: lot.amount,
        cumulativeEarnings: 0n,
        lifecycle: 'active',
        entryArgonotPrice: lot.entryRate,
        currentArgonotPrice: args.liveArgonotRateMicrogons || undefined,
      });

      active.push(
        createFinancialPosition(
          'wallet-holding',
          {
            id: `wallet-holding:${lot.id}:${account.address}:active`,
            label: 'ARGNOT holding',
            lifecycle: 'active',
            startedAt: lot.startedAt,
            accountId: account.address,
            nativeAsset: 'ARGNOT',
            nativeAmount: lot.amount,
            entryArgonotRateMicrogons: lot.entryRate,
          },
          value,
        ),
      );
    }

    const basedQuantity = lots.reduce((sum, lot) => sum + lot.amount, 0n);
    if (basedQuantity < holdingQuantity || args.holdingBasis.incompleteAccounts.has(account.address)) {
      const unknownQuantity = bigIntMax(holdingQuantity - basedQuantity, 0n);
      unavailableQuantities.set(account.address, unknownQuantity);
    }
  }

  for (const accountId of args.holdingBasis.incompleteAccounts) {
    if (!unavailableQuantities.has(accountId)) unavailableQuantities.set(accountId, 0n);
  }
  for (const [accountId, nativeAmount] of unavailableQuantities) {
    active.push(
      createFinancialPosition(
        'wallet-holding',
        {
          id: `wallet-holding:${accountId}:unavailable`,
          label: 'ARGNOT holding basis unavailable',
          lifecycle: 'unavailable',
          accountId,
          nativeAsset: 'ARGNOT',
          nativeAmount,
        },
        // The residual wallet-balance position already carries this quantity's
        // current value. This marker withholds only its return basis.
        { currentValue: 0n, paidIncome: 0n },
      ),
    );
  }
  return [...args.holdingBasis.completedPositions, ...active];
}
