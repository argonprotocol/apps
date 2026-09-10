import type { WalletForArgon } from '../lib/WalletForArgon.ts';
import type { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import type { WalletForEthereum } from '../lib/WalletForEthereum.ts';

export const WALLET_MOVE_LABEL = 'MOVE';

export type IWalletSetupStep = 'choice' | 'external';
export type IWalletOverlayWallet = WalletForArgon<'argon'> | WalletForBitcoin | WalletForEthereum;
export type IWalletConnector = WalletForBitcoin | WalletForEthereum;
export type IWalletView = 'main' | 'send' | 'receive' | 'privateKey';
export type IWalletOverlayCenterView =
  | { type: 'main' }
  | { type: 'send' }
  | { type: 'receive' }
  | { type: 'privateKey' }
  | {
      type: 'addEthereum';
      initialStep: IWalletSetupStep;
    };

export type IWalletOverlayState = {
  centerView: IWalletOverlayCenterView;
  activeConnector?: IWalletConnector;
};

export function getInitialWalletOverlayState(activeConnector?: IWalletConnector): IWalletOverlayState {
  return { centerView: { type: 'main' }, activeConnector };
}

export function getBitcoinDepositAttention(
  wallet: WalletForBitcoin | undefined,
  formatSatoshis: (satoshis: bigint) => string,
): string | undefined {
  if (!wallet) return;

  const pendingSatoshis = wallet.getPendingUnattachedDeposits().reduce((total, record) => total + record.satoshis, 0n);
  if (pendingSatoshis > 0n) {
    return `${formatSatoshis(pendingSatoshis)} BTC unattached deposit pending confirmation`;
  }

  const orphanCount = wallet.getUnresolvedOrphanDeposits().length;
  if (orphanCount) return `${orphanCount} unattached Bitcoin deposit${orphanCount === 1 ? '' : 's'} need review`;
}

export function getInitialAddWalletOverlayState(initialStep: IWalletSetupStep): IWalletOverlayState {
  return {
    centerView: { type: 'addEthereum', initialStep },
  };
}

export function showAddWalletInOverlay(state: IWalletOverlayState, initialStep: IWalletSetupStep): IWalletOverlayState {
  return {
    ...state,
    centerView: { type: 'addEthereum', initialStep },
    activeConnector: undefined,
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
  return { ...state, centerView: { type: view }, activeConnector };
}
