import { bigIntMax, bigIntMin, percentOf } from './utils.js';
import { Currency } from './Currency.js';

export type IVaultCapitalEvent =
  | {
      eventType: 'created';
      vaultId: number;
      securitization: bigint;
    }
  | {
      eventType: 'modified';
      vaultId: number;
      securitization: bigint;
      securitizationTarget: bigint;
    }
  | {
      eventType: 'releaseScheduled';
      vaultId: number;
      securitization: bigint;
      releaseHeight: bigint;
    }
  | {
      eventType: 'released';
      vaultId: number;
      securitization: bigint;
    }
  | {
      eventType: 'closed';
      vaultId: number;
      securitizationRemaining: bigint;
      securitizationReleased: bigint;
    }
  | {
      eventType: 'capitalLost';
      vaultId: number;
      amount: bigint;
    };

export type IInvestmentPositionValue = {
  currentValue?: bigint;
  investedCost?: bigint;
  paidIncome: bigint;
  settledPrincipalValue?: bigint;
};

export function calculatePrincipalPositionValue(args: {
  nativeAsset: 'ARGN' | 'ARGNOT';
  nativePrincipal: bigint;
  cumulativeEarnings: bigint;
  lifecycle: 'active' | 'releasing' | 'completed';
  entryArgonotPrice?: bigint;
  currentArgonotPrice?: bigint;
  closingArgonotPrice?: bigint;
}): IInvestmentPositionValue {
  if (args.nativeAsset === 'ARGN') {
    return {
      currentValue: args.lifecycle === 'completed' ? 0n : args.nativePrincipal,
      investedCost: args.nativePrincipal,
      paidIncome: args.cumulativeEarnings,
      settledPrincipalValue: args.lifecycle === 'completed' ? args.nativePrincipal : 0n,
    };
  }

  return {
    currentValue: args.lifecycle === 'completed' ? 0n : valueMicronots(args.nativePrincipal, args.currentArgonotPrice),
    investedCost: valueMicronots(args.nativePrincipal, args.entryArgonotPrice),
    paidIncome: args.cumulativeEarnings,
    settledPrincipalValue:
      args.lifecycle === 'completed' ? valueMicronots(args.nativePrincipal, args.closingArgonotPrice) : 0n,
  };
}

export function calculateVaultPositionValue(args: {
  securitization?: bigint;
  uncollectedRevenue: bigint;
  capitalHistory: readonly IVaultCapitalEvent[];
  collectedRevenue: readonly { amount: bigint }[];
}): IInvestmentPositionValue & { hasCompleteCapitalHistory: boolean; remainingPrincipal: bigint } {
  let observedSecuritization = 0n;
  let securitizationTarget = 0n;
  let investedCost = 0n;
  let settledPrincipalValue = 0n;

  for (const event of args.capitalHistory) {
    if (event.eventType === 'created') {
      observedSecuritization = event.securitization;
      securitizationTarget = event.securitization;
      investedCost += event.securitization;
    } else if (event.eventType === 'modified') {
      if (event.securitization > observedSecuritization) {
        investedCost += event.securitization - observedSecuritization;
      } else if (event.securitization < observedSecuritization) {
        settledPrincipalValue += observedSecuritization - event.securitization;
      }
      observedSecuritization = event.securitization;
      securitizationTarget = event.securitizationTarget;
    } else if (event.eventType === 'released') {
      const releasablePrincipal = bigIntMax(observedSecuritization - securitizationTarget, 0n);
      const releasedPrincipal = bigIntMin(event.securitization, releasablePrincipal);
      observedSecuritization -= releasedPrincipal;
      settledPrincipalValue += releasedPrincipal;
    } else if (event.eventType === 'closed') {
      observedSecuritization = event.securitizationRemaining;
      securitizationTarget = 0n;
      settledPrincipalValue += event.securitizationReleased;
    } else if (event.eventType === 'capitalLost') {
      observedSecuritization = bigIntMax(observedSecuritization - event.amount, 0n);
    }
  }

  const currentSecuritization = args.securitization ?? observedSecuritization;
  const hasCompleteCapitalHistory =
    args.capitalHistory[0]?.eventType === 'created' && observedSecuritization === currentSecuritization;

  return {
    currentValue: currentSecuritization + args.uncollectedRevenue,
    investedCost: hasCompleteCapitalHistory ? investedCost : undefined,
    paidIncome: args.collectedRevenue.reduce((total, event) => total + event.amount, 0n),
    settledPrincipalValue: hasCompleteCapitalHistory ? settledPrincipalValue : undefined,
    hasCompleteCapitalHistory,
    remainingPrincipal: observedSecuritization,
  };
}

export function calculateMiningPositionValue(args: {
  isActive: boolean;
  bidPrincipal: bigint;
  nativeStakedMicronots: bigint;
  microgonsMined: bigint;
  microgonsMinted: bigint;
  micronotsMined: bigint;
  feeIncome: bigint;
  transactionFees: bigint;
  entryArgonotPrice?: bigint;
  currentArgonotPrice?: bigint;
  closingArgonotPrice?: bigint;
}): IInvestmentPositionValue & {
  recoveredValue: bigint;
  remainingGuaranteedValue: bigint;
} {
  const term = calculateMiningTermPositionValue(args);
  const entryStakeValue = valueMicronots(args.nativeStakedMicronots, args.entryArgonotPrice);
  const currentStakeValue = valueMicronots(args.nativeStakedMicronots, args.currentArgonotPrice);
  const settledStakeValue = valueMicronots(args.nativeStakedMicronots, args.closingArgonotPrice);
  let currentValue = term.currentValue;
  if (args.isActive) {
    currentValue = currentStakeValue === undefined ? undefined : (term.currentValue ?? 0n) + currentStakeValue;
  }

  return {
    ...term,
    currentValue,
    investedCost: entryStakeValue === undefined ? undefined : (term.investedCost ?? 0n) + entryStakeValue,
    settledPrincipalValue: args.isActive ? 0n : settledStakeValue,
  };
}

export function calculateMiningTermPositionValue(args: {
  isActive: boolean;
  bidPrincipal: bigint;
  microgonsMined: bigint;
  microgonsMinted: bigint;
  micronotsMined: bigint;
  feeIncome: bigint;
  transactionFees: bigint;
  currentArgonotPrice?: bigint;
  closingArgonotPrice?: bigint;
}): IInvestmentPositionValue & {
  recoveredValue: bigint;
  remainingGuaranteedValue: bigint;
} {
  const microgonIncome = args.microgonsMined + args.microgonsMinted;
  const performanceArgonotPrice = args.isActive ? args.currentArgonotPrice : args.closingArgonotPrice;
  const performanceArgonotIncome = valueMicronots(args.micronotsMined, performanceArgonotPrice);
  const hasRewardValue = performanceArgonotIncome !== undefined;
  const recoveredPerformanceValue = microgonIncome + (performanceArgonotIncome ?? 0n);
  // The runtime's mint floor values all rewards at the current mark, so the
  // outstanding receivable must use that same value rather than the bid mark.
  const remainingGuaranteedValue = bigIntMax(args.bidPrincipal - recoveredPerformanceValue, 0n);

  return {
    currentValue: hasRewardValue ? remainingGuaranteedValue : undefined,
    investedCost: args.bidPrincipal + args.transactionFees,
    paidIncome: recoveredPerformanceValue + args.feeIncome,
    settledPrincipalValue: 0n,
    recoveredValue: recoveredPerformanceValue + args.feeIncome,
    remainingGuaranteedValue,
  };
}

export function calculateMiningRewardProjection(args: {
  bidPrincipal: bigint;
  microgonsPerTerm: bigint;
  micronotsPerTerm: bigint;
  argonotPrice: bigint;
  percentOfTerm: number;
}): {
  microgonsMined: bigint;
  microgonsMinted: bigint;
  micronotsMined: bigint;
  microgonValue: bigint;
} {
  const microgonsMintedPerTerm =
    args.argonotPrice > 0n
      ? Currency.microgonsMintedForMiningFloor({
          microgonsMined: args.microgonsPerTerm,
          microgonsMinted: 0n,
          micronotsMined: args.micronotsPerTerm,
          argonotPrice: args.argonotPrice,
          microgonFloor: args.bidPrincipal,
        })
      : 0n;
  const microgonsMined = percentOf(args.microgonsPerTerm, args.percentOfTerm);
  const microgonsMinted = percentOf(microgonsMintedPerTerm, args.percentOfTerm);
  const micronotsMined = percentOf(args.micronotsPerTerm, args.percentOfTerm);

  return {
    microgonsMined,
    microgonsMinted,
    micronotsMined,
    microgonValue: Currency.microgonValueOfMiningRewards({
      microgonsMined,
      microgonsMinted,
      micronotsMined,
      argonotPrice: args.argonotPrice,
    }),
  };
}

function valueMicronots(micronots: bigint, argonotPrice?: bigint): bigint | undefined {
  if (micronots === 0n) return 0n;
  if (!argonotPrice || argonotPrice <= 0n) return;

  return Currency.convertMicronotToMicrogonAtPrice(micronots, argonotPrice);
}
