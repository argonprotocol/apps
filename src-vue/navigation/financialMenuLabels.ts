import type { FinancialGroup } from '../interfaces/IFinancialPosition.ts';

export const financialMenuLabels: Record<FinancialGroup, string> = {
  liquid: 'Default Argon',
  ethereum: 'Ethereum Wallet',
  base: 'Base Wallet',
  mining: 'Mining',
  vaulting: 'Vaulting',
  bonds: 'Argon(ot) Bonds',
  bitcoin: 'Bitcoin locks',
};
