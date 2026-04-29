import { Core } from '@walletconnect/core';
import { WalletKit } from '@reown/walletkit';
import type { IWalletKit } from '@reown/walletkit';
import type { SignClientTypes } from '@walletconnect/types';

export const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim() || undefined;
export const walletConnectChains = ['eip155:1', 'eip155:8453'];
export const walletConnectMethods = [
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
];
export const walletConnectEvents = ['accountsChanged', 'chainChanged'];
export const allowedWalletConnectHosts = ['wallet.coinbase.com', 'app.uniswap.org'];

type TreasuryWalletKitHandlers = {
  onSessionRequest?: (event: SignClientTypes.EventArguments['session_request']) => void;
  onSessionDelete?: () => void;
};

let walletKitPromise: Promise<IWalletKit> | undefined;
let walletKitAddress: string | undefined;
let walletKitListenersAttached = false;
let walletKitHandlers: TreasuryWalletKitHandlers = {};

export function setTreasuryWalletKitHandlers(handlers: TreasuryWalletKitHandlers) {
  walletKitHandlers = handlers;
}

export async function getTreasuryWalletKit(ethereumAddress: string): Promise<IWalletKit> {
  if (!walletConnectProjectId) {
    throw new Error('Set VITE_WALLETCONNECT_PROJECT_ID before using WalletConnect.');
  }

  const normalizedAddress = ethereumAddress.trim().toLowerCase();

  if (!walletKitPromise || walletKitAddress !== normalizedAddress) {
    walletKitPromise = WalletKit.init({
      core: new Core({
        projectId: walletConnectProjectId,
        customStoragePrefix: `argon-wallet-${normalizedAddress}`,
      }),
      metadata: {
        name: 'Argon Treasury Wallet',
        description: 'Treasury wallet approval surface for WalletConnect sessions.',
        url: 'https://argon.network',
        icons: [],
      },
    });
    walletKitAddress = normalizedAddress;
    walletKitListenersAttached = false;
  }

  const walletKit = await walletKitPromise;

  if (!walletKitListenersAttached) {
    walletKit.on('session_request', event => {
      walletKitHandlers.onSessionRequest?.(event);
    });
    walletKit.on('session_delete', () => {
      walletKitHandlers.onSessionDelete?.();
    });
    walletKitListenersAttached = true;
  }

  return walletKit;
}
