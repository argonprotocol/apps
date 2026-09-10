import { describe, expect, it } from 'vitest';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import {
  closeWalletView,
  getInitialAddWalletOverlayState,
  getInitialWalletOverlayState,
  showAddWalletInOverlay,
  showWalletView,
  WALLET_MOVE_LABEL,
} from '../wallets/walletOverlayState.ts';

const defaultArgonRecord = {
  id: 1,
  walletType: 'argon',
  name: 'Internal App Wallet',
  address: 'argon-address',
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies IWalletRecord;

const ethereumA = {
  ...defaultArgonRecord,
  id: 2,
  walletType: 'ethereum',
  name: 'Default Ethereum',
  address: '0x0000000000000000000000000000000000000001',
} satisfies IWalletRecord;

const ethereumB = {
  ...ethereumA,
  id: 3,
  name: 'External Ethereum',
  address: '0x0000000000000000000000000000000000000002',
} satisfies IWalletRecord;
const ethereumWalletA = new WalletForEthereum(ethereumA.address, undefined, ethereumA, true);
const ethereumWalletB = new WalletForEthereum(ethereumB.address, undefined, ethereumB);
const bitcoinWallet = new WalletForBitcoin(
  () => ({}) as never,
  () => '5BitcoinLockOwner',
  {} as never,
);

describe('wallet overlay state', () => {
  it('opens the default Argon main view without selecting another wallet', () => {
    expect(getInitialWalletOverlayState()).toEqual({ centerView: { type: 'main' } });
  });

  it('opens the main view with a requested Ethereum connector', () => {
    expect(getInitialWalletOverlayState(ethereumWalletA)).toEqual({
      centerView: { type: 'main' },
      activeConnector: ethereumWalletA,
    });
  });

  it('returns a directly opened Add Ethereum view to the main panel', () => {
    const state = getInitialAddWalletOverlayState('choice');
    expect(state).toEqual({
      centerView: { type: 'addEthereum', initialStep: 'choice' },
    });
    expect(closeWalletView(state)).toEqual({ centerView: { type: 'main' } });
  });

  it('returns an in-overlay Add Ethereum view to the main panel', () => {
    const state = getInitialWalletOverlayState(bitcoinWallet);

    expect(showAddWalletInOverlay(state, 'external')).toEqual({
      centerView: { type: 'addEthereum', initialStep: 'external' },
      activeConnector: undefined,
    });
    expect(closeWalletView(showAddWalletInOverlay(state, 'external'))).toEqual({
      centerView: { type: 'main' },
      activeConnector: undefined,
    });
  });

  it('closes the overlay from the main panel', () => {
    expect(closeWalletView(getInitialWalletOverlayState())).toBeUndefined();
  });

  it.each(['send', 'receive', 'privateKey'] as const)(
    'returns the %s panel to main while preserving the active connector',
    view => {
      const state = showWalletView(getInitialWalletOverlayState(bitcoinWallet), view, bitcoinWallet);

      expect(closeWalletView(state)).toEqual({
        centerView: { type: 'main' },
        activeConnector: bitcoinWallet,
      });
    },
  );

  it('returns to main and targets the newly added Ethereum connector', () => {
    const addState = showAddWalletInOverlay(getInitialWalletOverlayState(), 'external');

    expect(showWalletView(addState, 'main', ethereumWalletB)).toEqual({
      centerView: { type: 'main' },
      activeConnector: ethereumWalletB,
    });
  });

  it('navigates between wallet views while preserving the active connector', () => {
    const state = getInitialWalletOverlayState(bitcoinWallet);

    const sendState = showWalletView(state, 'send', state.activeConnector);
    expect(sendState).toEqual({
      centerView: { type: 'send' },
      activeConnector: bitcoinWallet,
    });
    expect(showWalletView(sendState, 'receive', sendState.activeConnector)).toEqual({
      centerView: { type: 'receive' },
      activeConnector: bitcoinWallet,
    });
    expect(showWalletView(sendState, 'privateKey', sendState.activeConnector)).toEqual({
      centerView: { type: 'privateKey' },
      activeConnector: bitcoinWallet,
    });
    expect(showWalletView(sendState, 'main', sendState.activeConnector)).toEqual({
      centerView: { type: 'main' },
      activeConnector: bitcoinWallet,
    });
  });

  it('labels cross-network transfers as moves', () => {
    expect(WALLET_MOVE_LABEL).toBe('MOVE');
  });
});
