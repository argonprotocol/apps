import { describe, expect, it } from 'vitest';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { WalletType } from '../lib/Wallet.ts';
import {
  closeWalletOverlaySide,
  flipWalletOverlay,
  getAvailableWalletSelections,
  getInitialWalletOverlayState,
  getWalletSelectionKey,
  getWalletSelectionName,
  selectWalletOverlaySide,
  type IWalletOverlayState,
  WALLET_JUMP_LABEL,
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

const openPair = {
  leftWallet: { walletType: WalletType.ethereum, walletRecord: ethereumA },
  rightWallet: { walletType: WalletType.defaultArgon },
} satisfies IWalletOverlayState;

describe('wallet overlay state', () => {
  it('lists built-in wallets and each unopened Ethereum record', () => {
    const available = getAvailableWalletSelections(
      [defaultArgonRecord, ethereumA, ethereumB],
      [openPair.leftWallet],
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

  it('empties only the left slot when the left wallet closes', () => {
    expect(closeWalletOverlaySide(openPair, 'left')).toEqual({
      rightWallet: openPair.rightWallet,
    });
  });

  it('empties only the right slot when the right wallet closes', () => {
    expect(closeWalletOverlaySide(openPair, 'right')).toEqual({
      leftWallet: openPair.leftWallet,
    });
  });

  it('leaves two empty slots after the final wallet closes', () => {
    expect(closeWalletOverlaySide({ rightWallet: openPair.rightWallet }, 'right')).toEqual({});
  });

  it('swaps source and recipient', () => {
    expect(flipWalletOverlay(openPair)).toEqual({
      leftWallet: openPair.rightWallet,
      rightWallet: openPair.leftWallet,
    });
  });

  it('closes the opposite panel when selecting its wallet', () => {
    expect(selectWalletOverlaySide(openPair, 'left', openPair.rightWallet)).toEqual({
      leftWallet: openPair.rightWallet,
    });
    expect(selectWalletOverlaySide(openPair, 'right', openPair.leftWallet)).toEqual({
      rightWallet: openPair.leftWallet,
    });
  });

  it('keeps the established default Argon wallet name', () => {
    expect(getWalletSelectionName({ walletType: WalletType.defaultArgon })).toBe('Native Argon Wallet');
  });

  it('loads Native Argon on the right when another wallet is requested', () => {
    expect(getInitialWalletOverlayState(openPair.leftWallet)).toEqual({
      leftWallet: openPair.leftWallet,
      rightWallet: { walletType: WalletType.defaultArgon },
    });
  });

  it('labels transfers between loaded wallets as jumps', () => {
    expect(WALLET_JUMP_LABEL).toBe('JUMP');
  });
});
