import { describe, expect, it } from 'vitest';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { WalletType } from '../lib/Wallet.ts';
import {
  getAvailableWalletSelections,
  getInitialWalletOverlayState,
  getWalletSelectionKey,
  getWalletSelectionName,
  returnToTransferWalletChooser,
  selectPrimaryWallet,
  selectTransferWallet,
  toggleWalletTransferDirection,
  type IWalletOverlayState,
  type IWalletSelection,
  WALLET_MOVE_LABEL,
} from '../wallets/walletOverlayState.ts';

const defaultArgonRecord = {
  id: 1,
  walletType: 'argon',
  role: 'defaultArgon',
  name: 'Argon Wallet',
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

const primaryWallet = {
  walletType: WalletType.ethereum,
  walletRecord: ethereumA,
} satisfies IWalletSelection;
const transferWallet = { walletType: WalletType.defaultArgon } satisfies IWalletSelection;

describe('wallet overlay state', () => {
  it('lists built-in wallets and each wallet other than the primary wallet', () => {
    const available = getAvailableWalletSelections([defaultArgonRecord, ethereumA, ethereumB], [primaryWallet], true);

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

  it('opens with only the requested primary wallet', () => {
    expect(getInitialWalletOverlayState(primaryWallet)).toEqual({ primaryWallet });
  });

  it('opens and closes a transfer direction without changing the primary wallet', () => {
    const open = toggleWalletTransferDirection({ primaryWallet }, 'out');
    expect(open).toEqual({ primaryWallet, transferOut: {} });
    expect(toggleWalletTransferDirection(open, 'out')).toEqual({ primaryWallet });
  });

  it('opens both transfer sides without clearing either one', () => {
    const state = { primaryWallet, transferOut: { wallet: transferWallet } } satisfies IWalletOverlayState;
    expect(toggleWalletTransferDirection(state, 'in')).toEqual({
      primaryWallet,
      transferIn: {},
      transferOut: { wallet: transferWallet },
    });
  });

  it('selects a transfer wallet only while a direction is open', () => {
    expect(selectTransferWallet({ primaryWallet }, 'out', transferWallet)).toEqual({ primaryWallet });
    expect(selectTransferWallet({ primaryWallet, transferOut: {} }, 'out', transferWallet)).toEqual({
      primaryWallet,
      transferOut: { wallet: transferWallet },
    });
  });

  it('returns from a transfer wallet to its chooser', () => {
    expect(returnToTransferWalletChooser({ primaryWallet, transferIn: { wallet: transferWallet } }, 'in')).toEqual({
      primaryWallet,
      transferIn: {},
    });
  });

  it('replacing the primary wallet closes both transfer sidecars', () => {
    expect(
      selectPrimaryWallet({ primaryWallet, transferIn: {}, transferOut: { wallet: transferWallet } }, transferWallet),
    ).toEqual({ primaryWallet: transferWallet });
  });

  it('keeps the established default Argon wallet name', () => {
    expect(getWalletSelectionName(transferWallet)).toBe('Native Argon Wallet');
  });

  it('labels cross-network transfers as moves', () => {
    expect(WALLET_MOVE_LABEL).toBe('MOVE');
  });
});
