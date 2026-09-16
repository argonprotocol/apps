import { describe, expect, it, vi } from 'vitest';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { BitcoinLockStatus } from '../interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus } from '../interfaces/IBitcoinUtxoRecord.ts';
import { createLock, createStore } from './helpers/bitcoin.ts';
import {
  closeWalletView,
  getBitcoinDepositAttention,
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

  it('keeps an observed UTXO on an older channel as pending inbound funding', () => {
    const bitcoinLocks = createStore();
    const lock = createLock({
      uuid: 'multi-utxo-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-09-13T00:00:00.000Z',
    });
    lock.fundedSatoshis = 5_000_000n;
    lock.fundingUtxoIds = [1];
    bitcoinLocks.data.locksByLockId[lock.lockId!] = lock;

    const firstSeenAt = new Date('2026-09-13T00:01:00.000Z');
    const observedUtxo = {
      id: 2,
      lockId: lock.lockId!,
      txid: 'b'.repeat(64),
      vout: 1,
      satoshis: 5_000_000n,
      network: 'testnet',
      status: BitcoinUtxoStatus.SeenOnMempool,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt,
      firstSeenBitcoinHeight: 101,
      createdAt: firstSeenAt,
      updatedAt: firstSeenAt,
    };
    bitcoinLocks.utxoTracking.load([
      {
        id: 1,
        lockId: lock.lockId!,
        txid: 'a'.repeat(64),
        vout: 0,
        satoshis: 5_000_000n,
        network: 'testnet',
        status: BitcoinUtxoStatus.FundingUtxo,
        spendStatus: BitcoinUtxoSpendStatus.Unspent,
        firstSeenAt,
        firstSeenBitcoinHeight: 100,
        createdAt: firstSeenAt,
        updatedAt: firstSeenAt,
      },
      observedUtxo,
    ]);
    vi.spyOn(bitcoinLocks, 'isSecuritizationHoldExpired').mockReturnValue(true);
    const wallet = new WalletForBitcoin(
      () => bitcoinLocks,
      () => lock.ownerAccount!,
      {} as never,
    );

    expect(wallet.getPendingInboundUtxos()).toEqual([observedUtxo]);
    expect(getBitcoinDepositAttention(wallet)).toBeUndefined();
  });

  it('selects the current channel by its securitization hold rather than its insurance', () => {
    const bitcoinLocks = createStore();
    const expired = createLock({
      uuid: 'expired-hold',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-09-13T00:00:00.000Z',
    });
    const current = createLock({
      uuid: 'current-hold',
      utxoId: 8,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-09-13T00:01:00.000Z',
    });
    const released = createLock({
      uuid: 'released-hold',
      utxoId: 9,
      status: BitcoinLockStatus.Released,
      createdAt: '2026-09-13T00:02:00.000Z',
    });
    current.securitizationCoverageMicrogons = 0n;
    bitcoinLocks.data.locksByLockId[expired.lockId!] = expired;
    bitcoinLocks.data.locksByLockId[current.lockId!] = current;
    bitcoinLocks.data.locksByLockId[released.lockId!] = released;
    vi.spyOn(bitcoinLocks, 'isSecuritizationHoldExpired').mockImplementation(lock => lock === expired);

    const wallet = new WalletForBitcoin(
      () => bitcoinLocks,
      () => current.ownerAccount!,
      {} as never,
    );

    expect(wallet.getChannelWithActiveSecuritizationHold()).toBe(current);
  });
});
