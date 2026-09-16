import type { WalletForArgon } from '../lib/WalletForArgon.ts';
import type { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import type { WalletForEthereum } from '../lib/WalletForEthereum.ts';

export const WALLET_MOVE_LABEL = 'MOVE';

export type IWalletSetupStep = 'choice' | 'external';
export type IWalletOverlayWallet = WalletForArgon<'argon'> | WalletForBitcoin | WalletForEthereum;
export type IWalletConnector = WalletForBitcoin | WalletForEthereum;
export type IWalletView = 'main' | 'send' | 'receive' | 'privateKey' | { type: 'unattachedBitcoin'; recordId: number };
export type IWalletOverlayCenterView =
  | { type: 'main' }
  | { type: 'send' }
  | { type: 'receive' }
  | { type: 'privateKey' }
  | { type: 'unattachedBitcoin'; recordId: number }
  | {
      type: 'addEthereum';
      initialStep: IWalletSetupStep;
    };

export type IWalletOverlayState = {
  centerView: IWalletOverlayCenterView;
  activeConnector?: IWalletConnector;
  showBack: boolean;
};

export function getInitialWalletOverlayState(
  activeConnector?: IWalletConnector,
  view: IWalletView = 'main',
): IWalletOverlayState {
  return {
    centerView: typeof view === 'string' ? { type: view } : view,
    activeConnector,
    showBack: false,
  };
}

export function getBitcoinDepositAttention(wallet: WalletForBitcoin | undefined): string | undefined {
  if (!wallet) return;

  const orphanCount = wallet.getUnresolvedOrphanDeposits().length;
  if (orphanCount) return `${orphanCount} unattached Bitcoin deposit${orphanCount === 1 ? '' : 's'} need review`;
}

export function getInitialAddWalletOverlayState(initialStep: IWalletSetupStep): IWalletOverlayState {
  return {
    centerView: { type: 'addEthereum', initialStep },
    showBack: false,
  };
}

export function showAddWalletInOverlay(state: IWalletOverlayState, initialStep: IWalletSetupStep): IWalletOverlayState {
  return {
    ...state,
    centerView: { type: 'addEthereum', initialStep },
    activeConnector: undefined,
    showBack: false,
  };
}

export function closeWalletView(state: IWalletOverlayState): IWalletOverlayState | undefined {
  if (state.centerView.type === 'main') return;
  return showWalletView(state, 'main', state.activeConnector);
}

export function showWalletView(
  state: IWalletOverlayState,
  view: IWalletView,
  activeConnector: IWalletConnector | undefined,
): IWalletOverlayState {
  const centerView = typeof view === 'string' ? { type: view } : view;
  return { ...state, centerView, activeConnector, showBack: centerView.type !== 'main' };
}
