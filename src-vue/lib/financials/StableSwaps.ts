import {
  createFinancialPosition,
  type IFinancialPositionSource,
  type IStableSwapFinancialPosition,
} from '../../interfaces/IFinancialPosition.ts';
import type { IStableSwapWalletSnapshot } from '../../interfaces/IStableSwap.ts';
import type { IWallet } from '../Wallet.ts';
import { calculateStableSwapCurrentValueMicrogons } from '../StableSwapWallet.ts';
import type { useStableSwaps } from '../../stores/stableSwaps.ts';

type StableSwapFinancialPositionArgs = {
  wallet: IWallet;
};

export class StableSwapFinancials
  implements IFinancialPositionSource<StableSwapFinancialPositionArgs, IStableSwapFinancialPosition>
{
  constructor(private readonly swaps: ReturnType<typeof useStableSwaps>) {}

  public async loadPositions(args: StableSwapFinancialPositionArgs): Promise<IStableSwapFinancialPosition[]> {
    await this.swaps.load();

    return this.createFinancialPositions({
      ...args,
      walletSnapshot: this.swaps.walletSnapshot,
      currentPriceMicrogons: this.swaps.marketSnapshot?.currentPriceMicrogons,
    });
  }

  public createFinancialPositions({
    wallet,
    walletSnapshot,
    currentPriceMicrogons,
  }: StableSwapFinancialPositionArgs & {
    walletSnapshot: IStableSwapWalletSnapshot | null;
    currentPriceMicrogons?: bigint;
  }): IStableSwapFinancialPosition[] {
    const nativeAmount = wallet.availableMicrogons + wallet.reservedMicrogons;
    if (nativeAmount <= 0n) return [];

    const purchases = walletSnapshot?.purchases ?? [];
    const isQuantityReconciled =
      walletSnapshot !== null && walletSnapshot.summary.purchasedNativeAmount === nativeAmount;
    const investedCost =
      walletSnapshot &&
      walletSnapshot.syncState.isPurchaseBasisIntact &&
      isQuantityReconciled &&
      walletSnapshot.summary.hasHistoricalBasis
        ? walletSnapshot.summary.capitalAppliedMicrogons
        : undefined;

    return [
      createFinancialPosition(
        'stable-swap',
        {
          id: `stable-swap:${wallet.address.toLowerCase()}:ARGN`,
          label: 'Ethereum ARGN',
          lifecycle: 'active',
          startedAt: walletSnapshot?.summary.startedAt,
          wallet,
          purchases,
          nativeAmount,
          isQuantityReconciled,
        },
        {
          currentValue:
            currentPriceMicrogons === undefined
              ? undefined
              : calculateStableSwapCurrentValueMicrogons(nativeAmount, currentPriceMicrogons),
          investedCost,
          paidIncome: 0n,
          settledPrincipalValue: 0n,
        },
      ),
    ];
  }
}
