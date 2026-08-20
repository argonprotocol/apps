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
  showMainWallet,
  shouldLoadEthereumWalletSelection,
  type IWalletSelection,
  WALLET_MOVE_LABEL,
} from '../wallets/walletOverlayState.ts';

const defaultArgonRecord = {
  id: 1,
  walletType: 'argon',
  role: 'defaultArgon',
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
  role: 'defaultEthereum',
  name: 'Default Ethereum',
  address: '0x0000000000000000000000000000000000000001',
} satisfies IWalletRecord;

const ethereumB = {
  ...ethereumA,
  id: 3,
  role: 'externalEthereum',
  name: 'External Ethereum',
  address: '0x0000000000000000000000000000000000000002',
} satisfies IWalletRecord;

const ethereumSelection = {
  walletType: WalletType.ethereum,
  walletRecord: ethereumA,
} satisfies IWalletSelection;
const defaultArgonSelection = { walletType: WalletType.defaultArgon } satisfies IWalletSelection;

describe('wallet overlay state', () => {
  describe('Ethereum wallet loading', () => {
    it('loads the first wallet when it is already active but has no balance observation', () => {
      expect(shouldLoadEthereumWalletSelection(ethereumSelection, ethereumA.id, undefined)).toBe(true);
    });

    it('does not reload an already-active wallet with a balance observation', () => {
      expect(shouldLoadEthereumWalletSelection(ethereumSelection, ethereumA.id, new Date('2026-07-22T12:00:00Z'))).toBe(
        false,
      );
    });

    it('loads a different Ethereum wallet', () => {
      expect(shouldLoadEthereumWalletSelection(ethereumSelection, ethereumB.id, new Date('2026-07-22T12:00:00Z'))).toBe(
        true,
      );
    });
  });

  it('lists built-in wallets and each wallet other than the open wallet', () => {
    const available = getAvailableWalletSelections(
      [defaultArgonRecord, ethereumA, ethereumB],
      [ethereumSelection],
      true,
    );

    expect(available.map(getWalletSelectionKey)).toEqual([
      WalletType.defaultArgon,
      WalletType.miningBot,
      `ethereum:${ethereumB.id}`,
    ]);
  });

  it('hides the mining wallet without the Operations extension', () => {
    const available = getAvailableWalletSelections([ethereumA], [], false);

    expect(available.map(getWalletSelectionKey)).toEqual([WalletType.defaultArgon, `ethereum:${ethereumA.id}`]);
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

    expect(showMainWallet(addState, { network: 'ethereum', walletRecordId: ethereumB.id })).toEqual({
      centerView: { type: 'main' },
      activeConnector: { network: 'ethereum', walletRecordId: ethereumB.id },
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
