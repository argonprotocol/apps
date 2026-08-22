import { describe, expect, it } from 'vitest';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { WalletType } from '../lib/Wallet.ts';
import {
  closeAddWalletView,
  getAvailableWalletSelections,
  getInitialAddWalletOverlayState,
  getInitialWalletOverlayState,
  getWalletSelectionKey,
  getWalletSelectionName,
  showAddWalletInOverlay,
  showWalletView,
  type IWalletSelection,
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

const ethereumSelection = {
  walletType: WalletType.ethereum,
  walletRecord: ethereumA,
} satisfies IWalletSelection;
const defaultArgonSelection = { walletType: WalletType.argon } satisfies IWalletSelection;

describe('wallet overlay state', () => {
  it('lists built-in wallets and each wallet other than the open wallet', () => {
    const available = getAvailableWalletSelections(
      [defaultArgonRecord, ethereumA, ethereumB],
      [ethereumSelection],
      true,
    );

    expect(available.map(getWalletSelectionKey)).toEqual([
      WalletType.argon,
      WalletType.miningBot,
      `ethereum:${ethereumB.id}`,
    ]);
  });

  it('hides the mining wallet without the Operations extension', () => {
    const available = getAvailableWalletSelections([ethereumA], [], false);

    expect(available.map(getWalletSelectionKey)).toEqual([WalletType.argon, `ethereum:${ethereumA.id}`]);
  });

  it('opens the default Argon main view without selecting another wallet', () => {
    expect(getInitialWalletOverlayState()).toEqual({ centerView: { type: 'main' } });
  });

  it('opens the main view with a requested Ethereum connector', () => {
    expect(getInitialWalletOverlayState({ network: 'ethereum', walletRecordId: ethereumA.id })).toEqual({
      centerView: { type: 'main' },
      activeConnector: { network: 'ethereum', walletRecordId: ethereumA.id },
    });
  });

  it('closes a directly opened Add Ethereum view with the overlay', () => {
    const state = getInitialAddWalletOverlayState('choice', 'closeOverlay');
    expect(state).toEqual({
      centerView: { type: 'addEthereum', initialStep: 'choice', closeBehavior: 'closeOverlay' },
    });
    expect(closeAddWalletView(state)).toBeUndefined();
  });

  it('returns an in-overlay Add Ethereum view to the main panel', () => {
    const state = getInitialWalletOverlayState({ network: 'bitcoin' });

    expect(showAddWalletInOverlay(state, 'external')).toEqual({
      centerView: { type: 'addEthereum', initialStep: 'external', closeBehavior: 'returnToMain' },
      activeConnector: undefined,
    });
    expect(closeAddWalletView(showAddWalletInOverlay(state, 'external'))).toEqual({
      centerView: { type: 'main' },
      activeConnector: undefined,
    });
  });

  it('returns to main and targets the newly added Ethereum connector', () => {
    const addState = showAddWalletInOverlay(getInitialWalletOverlayState(), 'external');

    expect(showWalletView(addState, 'main', { network: 'ethereum', walletRecordId: ethereumB.id })).toEqual({
      centerView: { type: 'main' },
      activeConnector: { network: 'ethereum', walletRecordId: ethereumB.id },
    });
  });

  it('navigates between wallet views while preserving the active connector', () => {
    const state = getInitialWalletOverlayState({ network: 'bitcoin' });

    const sendState = showWalletView(state, 'send', state.activeConnector);
    expect(sendState).toEqual({
      centerView: { type: 'send' },
      activeConnector: { network: 'bitcoin' },
    });
    expect(showWalletView(sendState, 'receive', sendState.activeConnector)).toEqual({
      centerView: { type: 'receive' },
      activeConnector: { network: 'bitcoin' },
    });
    expect(showWalletView(sendState, 'privateKey', sendState.activeConnector)).toEqual({
      centerView: { type: 'privateKey' },
      activeConnector: { network: 'bitcoin' },
    });
    expect(showWalletView(sendState, 'main', sendState.activeConnector)).toEqual({
      centerView: { type: 'main' },
      activeConnector: { network: 'bitcoin' },
    });
  });

  it('keeps the established default Argon wallet name', () => {
    expect(getWalletSelectionName(defaultArgonSelection)).toBe('Internal App Wallet');
  });

  it('appends Wallet to Ethereum display names without duplicating the suffix', () => {
    expect(getWalletSelectionName(ethereumSelection)).toBe('Default Ethereum Wallet');
    expect(
      getWalletSelectionName({
        walletType: WalletType.ethereum,
        walletRecord: { ...ethereumA, name: 'Trading Wallet' },
      }),
    ).toBe('Trading Wallet');
  });

  it('labels cross-network transfers as moves', () => {
    expect(WALLET_MOVE_LABEL).toBe('MOVE');
  });
});
