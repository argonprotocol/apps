import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { MoveCapital } from '../lib/MoveCapital.ts';
import { type IWallet, miningHoldOperationalReserveMicrogons } from '../lib/Wallet.ts';
import { ensureOperatorAccountRegistered } from '../lib/OperationalAccount.ts';
import { Config } from '../lib/Config.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { createTestDb } from './helpers/db.ts';
import { setDbPromise } from '../stores/helpers/dbPromise.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

vi.mock('../lib/OperationalAccount.ts', () => ({
  ensureOperatorAccountRegistered: vi.fn().mockResolvedValue(undefined),
}));

describe('MoveCapital', () => {
  let config: Config;
  let walletKeys: WalletKeys;
  beforeAll(async () => {
    const db = await createTestDb();
    setDbPromise(Promise.resolve(db));
    walletKeys = createMockWalletKeys();
    config = new Config(Promise.resolve(db), walletKeys);
  });
  it('keeps the mining hold operational reserve when sweeping to the bot', async () => {
    const moveCapital = createMoveCapital();
    const calculateFeeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(5n);
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);
    const wallet = createWallet({
      availableMicrogons: miningHoldOperationalReserveMicrogons + 50n,
      availableMicronots: 7n,
    });

    await moveCapital.moveAvailableMiningHoldToBot(wallet, walletKeys, config);

    expect(calculateFeeSpy).toHaveBeenCalledWith(
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGN: 50n, ARGNOT: 7n },
      wallet,
      'mining-bot-address',
    );
    expect(moveSpy).toHaveBeenCalledWith(
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGN: 45n, ARGNOT: 7n },
      wallet,
      'mining-bot-address',
    );
    expect(ensureOperatorAccountRegistered).toHaveBeenCalledOnce();
  });

  it('retries the fee calculation without argons when only argonots should move', async () => {
    const moveCapital = createMoveCapital();
    const calculateFeeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValueOnce(5n).mockResolvedValueOnce(2n);
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);
    const wallet = createWallet({
      availableMicrogons: miningHoldOperationalReserveMicrogons + 3n,
      availableMicronots: 4n,
    });

    await moveCapital.moveAvailableMiningHoldToBot(wallet, walletKeys, config);

    expect(calculateFeeSpy).toHaveBeenNthCalledWith(
      1,
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGN: 3n, ARGNOT: 4n },
      wallet,
      'mining-bot-address',
    );
    expect(calculateFeeSpy).toHaveBeenNthCalledWith(
      2,
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGNOT: 4n },
      wallet,
      'mining-bot-address',
    );
    expect(moveSpy).toHaveBeenCalledWith(
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGNOT: 4n },
      wallet,
      'mining-bot-address',
    );
  });

  it('skips the sweep when fee calculation reports insufficient funds', async () => {
    const moveCapital = createMoveCapital();
    vi.spyOn(moveCapital, 'calculateFee').mockImplementation(async () => {
      moveCapital.transactionError = 'Your wallet has insufficient funds for this transaction.';
      return 0n;
    });
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);
    const wallet = createWallet({ availableMicrogons: 10n, availableMicronots: 4n });

    await moveCapital.moveAvailableMiningHoldToBot(wallet, walletKeys, config);

    expect(moveSpy).not.toHaveBeenCalled();
  });

  it('skips the sweep when fee calculation fails', async () => {
    const moveCapital = createMoveCapital();
    vi.spyOn(moveCapital, 'calculateFee').mockImplementation(async () => {
      moveCapital.transactionError = 'Unable to calculate transaction fee.';
      return 0n;
    });
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);

    await moveCapital.moveAvailableMiningHoldToBot(createWallet({ availableMicronots: 4n }), walletKeys, config);

    expect(moveSpy).not.toHaveBeenCalled();
  });

  it('skips the sweep when there is nothing available to move', async () => {
    const moveCapital = createMoveCapital();
    const feeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(0n);
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);

    await moveCapital.moveAvailableMiningHoldToBot(
      createWallet({ availableMicrogons: miningHoldOperationalReserveMicrogons }),
      walletKeys,
      config,
    );

    expect(feeSpy).not.toHaveBeenCalled();
    expect(moveSpy).not.toHaveBeenCalled();
  });
});

function createMoveCapital() {
  return new MoveCapital({ miningBotAddress: 'mining-bot-address' } as any, {} as any, {} as any);
}

function createWallet(partial: Partial<IWallet>): IWallet {
  return {
    address: 'mining-hold-address',
    availableMicrogons: 0n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
    totalMicrogons: partial.availableMicrogons ?? 0n,
    totalMicronots: partial.availableMicronots ?? 0n,
    ...partial,
  };
}
