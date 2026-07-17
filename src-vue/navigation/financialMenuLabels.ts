import type { FinancialGroup } from '../interfaces/IFinancialPosition.ts';

export const financialMenuLabels: Record<FinancialGroup, string> = {
  liquid: 'Argon Wallet',
  ethereum: 'Ethereum Wallet',
  mining: 'Mining',
  vaulting: 'Vaulting',
  bonds: 'Argon(ot) Bonds',
  bitcoin: 'Bitcoin locks',
};
