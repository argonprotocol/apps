import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { getEthereumWalletDisplayName, WalletType } from '../lib/Wallet.ts';

export const WALLET_MOVE_LABEL = 'MOVE';

export type IWalletSelection =
  | { walletType: WalletType.argon | WalletType.miningBot }
  | { walletType: WalletType.ethereum; walletRecord: IWalletRecord };

export type IWalletSetupStep = 'choice' | 'external';
export type IWalletConnectorTarget = { network: 'bitcoin' } | { network: 'ethereum'; walletRecordId: number };
export type IWalletView = 'main' | 'send' | 'receive' | 'privateKey';
export type IWalletOverlayCenterView =
  | { type: 'main' }
  | { type: 'send' }
  | { type: 'receive' }
  | { type: 'privateKey' }
  | {
      type: 'addEthereum';
      initialStep: IWalletSetupStep;
      closeBehavior: 'returnToMain' | 'closeOverlay';
    };

export type IWalletOverlayState = {
  centerView: IWalletOverlayCenterView;
  activeConnector?: IWalletConnectorTarget;
};

export function getAvailableWalletSelections(
  walletRecords: IWalletRecord[],
  openWallets: IWalletSelection[],
  includeMiningWallet: boolean,
): IWalletSelection[] {
  const openWalletKeys = new Set(openWallets.map(getWalletSelectionKey));
  const availableWallets: IWalletSelection[] = [{ walletType: WalletType.argon }];
  if (includeMiningWallet) {
    availableWallets.push({ walletType: WalletType.miningBot });
  }
  availableWallets.push(
    ...walletRecords
      .filter(record => record.walletType === 'ethereum')
      .map<IWalletSelection>(walletRecord => ({ walletType: WalletType.ethereum, walletRecord })),
  );

  return availableWallets.filter(wallet => !openWalletKeys.has(getWalletSelectionKey(wallet)));
}

export function getInitialWalletOverlayState(activeConnector?: IWalletConnectorTarget): IWalletOverlayState {
  return { centerView: { type: 'main' }, activeConnector };
}

export function getInitialAddWalletOverlayState(
  initialStep: IWalletSetupStep,
  closeBehavior: 'returnToMain' | 'closeOverlay',
): IWalletOverlayState {
  return {
    centerView: { type: 'addEthereum', initialStep, closeBehavior },
  };
}

export function showAddWalletInOverlay(state: IWalletOverlayState, initialStep: IWalletSetupStep): IWalletOverlayState {
  return {
    ...state,
    centerView: { type: 'addEthereum', initialStep, closeBehavior: 'returnToMain' },
    activeConnector: undefined,
  };
}

export function closeAddWalletView(state: IWalletOverlayState): IWalletOverlayState | undefined {
  if (state.centerView.type !== 'addEthereum') return state;
  if (state.centerView.closeBehavior === 'closeOverlay') return;
  return showWalletView(state, 'main', state.activeConnector);
}

export function showWalletView(
  state: IWalletOverlayState,
  view: IWalletView,
  activeConnector: IWalletConnectorTarget | undefined,
): IWalletOverlayState {
  return { ...state, centerView: { type: view }, activeConnector };
}

export function getWalletSelectionKey(wallet: IWalletSelection): string {
  if (wallet.walletType === WalletType.ethereum) {
    return `ethereum:${wallet.walletRecord.id}`;
  }

  return wallet.walletType;
}

export function getWalletSelectionName(wallet: IWalletSelection): string {
  if (wallet.walletType === WalletType.ethereum) {
    return getEthereumWalletDisplayName(wallet.walletRecord.name);
  }

  return wallet.walletType === WalletType.miningBot ? 'Mining Wallet' : 'Internal App Wallet';
}

export function isEthereumWalletSelection(
  wallet: IWalletSelection,
): wallet is Extract<IWalletSelection, { walletType: WalletType.ethereum }> {
  return wallet.walletType === WalletType.ethereum;
}
