import type { FinancialGroup } from '../interfaces/IFinancialPosition.ts';

export const financialMenuGroupOrder: readonly FinancialGroup[] = [
  'liquid',
  'ethereum',
  'base',
  'bitcoin',
  'bonds',
  'stabilizer',
  'mining',
  'vaulting',
];

export const financialMenuLabels: Record<FinancialGroup, string> = {
  liquid: 'Internal App Wallet',
  ethereum: 'Ethereum Wallet',
  base: 'Base Wallet',
  mining: 'Mining',
  vaulting: 'Vaulting',
  bonds: 'Argon(ot) Bonds',
  bitcoin: 'Bitcoin Liquids',
  stabilizer: 'Stabilizer Buys',
};

export const bondAssetMenuItems = [
  { asset: 'ARGN' as const, label: 'Argon Bonds' },
  { asset: 'ARGNOT' as const, label: 'Argonot Stakes' },
];
