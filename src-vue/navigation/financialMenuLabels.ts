import type { FinancialGroup } from '../interfaces/IFinancialPosition.ts';

export const financialMenuLabels: Record<FinancialGroup, string> = {
  liquid: 'Internal App Wallet',
  ethereum: 'Ethereum Wallet',
  base: 'Base Wallet',
  mining: 'Mining',
  vaulting: 'Vaulting',
  bonds: 'Argon(ot) Bonds',
  bitcoin: 'Bitcoin',
};

export const bondAssetMenuItems = [
  { asset: 'ARGN', label: 'Argon' },
  { asset: 'ARGNOT', label: 'Argonot' },
] as const;
