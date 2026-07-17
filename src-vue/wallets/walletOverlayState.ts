import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { WalletType } from '../lib/Wallet.ts';

export const WALLET_JUMP_LABEL = 'JUMP';

export type IWalletSelection =
  | { walletType: WalletType.defaultArgon | WalletType.miningBot }
  | { walletType: WalletType.ethereum; walletRecord: IWalletRecord };

export type IWalletOverlayState = {
  leftWallet?: IWalletSelection;
  rightWallet?: IWalletSelection;
};

export function getAvailableWalletSelections(
  walletRecords: IWalletRecord[],
  openWallets: IWalletSelection[],
  includeMiningWallet: boolean,
): IWalletSelection[] {
  const openWalletKeys = new Set(openWallets.map(getWalletSelectionKey));
  const availableWallets: IWalletSelection[] = [{ walletType: WalletType.defaultArgon }];
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

export function getInitialWalletOverlayState(requestedWallet: IWalletSelection): IWalletOverlayState {
  const rightWallet: IWalletSelection = { walletType: WalletType.defaultArgon };
  if (requestedWallet.walletType === WalletType.defaultArgon) {
    return { rightWallet };
  }

  return { leftWallet: requestedWallet, rightWallet };
}

export function flipWalletOverlay(state: IWalletOverlayState): IWalletOverlayState {
  if (!state.leftWallet || !state.rightWallet) return state;

  return {
    leftWallet: state.rightWallet,
    rightWallet: state.leftWallet,
  };
}

export function closeWalletOverlaySide(state: IWalletOverlayState, side: 'left' | 'right'): IWalletOverlayState {
  if (side === 'left') {
    return state.rightWallet ? { rightWallet: state.rightWallet } : {};
  }

  return state.leftWallet ? { leftWallet: state.leftWallet } : {};
}

export function selectWalletOverlaySide(
  state: IWalletOverlayState,
  side: 'left' | 'right',
  wallet: IWalletSelection,
): IWalletOverlayState {
  const walletKey = getWalletSelectionKey(wallet);
  if (side === 'left') {
    if (state.rightWallet && getWalletSelectionKey(state.rightWallet) === walletKey) {
      return { leftWallet: wallet };
    }
    return state.rightWallet ? { leftWallet: wallet, rightWallet: state.rightWallet } : { leftWallet: wallet };
  }

  if (state.leftWallet && getWalletSelectionKey(state.leftWallet) === walletKey) {
    return { rightWallet: wallet };
  }
  return state.leftWallet ? { leftWallet: state.leftWallet, rightWallet: wallet } : { rightWallet: wallet };
}

export function getWalletSelectionKey(wallet: IWalletSelection): string {
  if (wallet.walletType === WalletType.ethereum) {
    return `ethereum:${wallet.walletRecord.id}`;
  }

  return wallet.walletType;
}

export function getWalletSelectionName(wallet: IWalletSelection): string {
  if (wallet.walletType === WalletType.ethereum) {
    return wallet.walletRecord.name;
  }

  return wallet.walletType === WalletType.miningBot ? 'Mining Wallet' : 'Native Argon Wallet';
}

export function isEthereumWalletSelection(
  wallet: IWalletSelection,
): wallet is Extract<IWalletSelection, { walletType: WalletType.ethereum }> {
  return wallet.walletType === WalletType.ethereum;
}
