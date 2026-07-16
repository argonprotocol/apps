import type { FinancialGroup } from '../interfaces/IFinancialPosition.ts';

export const financialMenuLabels: Record<FinancialGroup, string> = {
  liquid: 'Liquid holdings',
  mining: 'Mining',
  vaulting: 'Vaulting',
  bonds: 'Argon Bonds',
  bitcoin: 'Bitcoin locks',
  stableSwaps: 'Stable swaps',
};
