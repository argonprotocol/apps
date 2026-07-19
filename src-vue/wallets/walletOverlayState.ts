import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { WalletType } from '../lib/Wallet.ts';

export const WALLET_MOVE_LABEL = 'MOVE';

export type IWalletSelection =
  | { walletType: WalletType.defaultArgon | WalletType.miningBot }
  | { walletType: WalletType.ethereum; walletRecord: IWalletRecord };

export type IWalletTransferDirection = 'in' | 'out';
export type IWalletTransferSideState = { wallet?: IWalletSelection };

export type IWalletOverlayState = {
  primaryWallet: IWalletSelection;
  transferIn?: IWalletTransferSideState;
  transferOut?: IWalletTransferSideState;
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
  return { primaryWallet: requestedWallet };
}

export function selectPrimaryWallet(state: IWalletOverlayState, wallet: IWalletSelection): IWalletOverlayState {
  return { primaryWallet: wallet };
}

export function toggleWalletTransferDirection(
  state: IWalletOverlayState,
  direction: IWalletTransferDirection,
): IWalletOverlayState {
  const key = direction === 'in' ? 'transferIn' : 'transferOut';
  return { ...state, [key]: state[key] ? undefined : {} };
}

export function selectTransferWallet(
  state: IWalletOverlayState,
  direction: IWalletTransferDirection,
  wallet: IWalletSelection,
): IWalletOverlayState {
  const key = direction === 'in' ? 'transferIn' : 'transferOut';
  if (!state[key] || getWalletSelectionKey(state.primaryWallet) === getWalletSelectionKey(wallet)) {
    return state;
  }

  return { ...state, [key]: { wallet } };
}

export function returnToTransferWalletChooser(
  state: IWalletOverlayState,
  direction: IWalletTransferDirection,
): IWalletOverlayState {
  const key = direction === 'in' ? 'transferIn' : 'transferOut';
  return state[key] ? { ...state, [key]: {} } : state;
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
