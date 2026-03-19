import { describe, expect, it, vi } from 'vitest';
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { MoveCapital } from '../lib/MoveCapital.ts';
import { miningHoldOperationalReserveMicrogons, type IWallet } from '../lib/Wallet.ts';

describe('MoveCapital', () => {
  it('keeps the mining hold operational reserve when sweeping to the bot', async () => {
    const moveCapital = createMoveCapital();
    const calculateFeeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(5n);
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);
    const wallet = createWallet({
      availableMicrogons: miningHoldOperationalReserveMicrogons + 50n,
      availableMicronots: 7n,
    });

    await moveCapital.moveAvailableMiningHoldToBot(wallet);

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
  });

  it('retries the fee calculation without argons when only argonots should move', async () => {
    const moveCapital = createMoveCapital();
    const calculateFeeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValueOnce(5n).mockResolvedValueOnce(2n);
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);
    const wallet = createWallet({
      availableMicrogons: miningHoldOperationalReserveMicrogons + 3n,
      availableMicronots: 4n,
    });

    await moveCapital.moveAvailableMiningHoldToBot(wallet);

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

    await moveCapital.moveAvailableMiningHoldToBot(wallet);

    expect(moveSpy).not.toHaveBeenCalled();
  });

  it('skips the sweep when fee calculation fails', async () => {
    const moveCapital = createMoveCapital();
    vi.spyOn(moveCapital, 'calculateFee').mockImplementation(async () => {
      moveCapital.transactionError = 'Unable to calculate transaction fee.';
      return 0n;
    });
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);

    await moveCapital.moveAvailableMiningHoldToBot(createWallet({ availableMicronots: 4n }));

    expect(moveSpy).not.toHaveBeenCalled();
  });

  it('skips the sweep when there is nothing available to move', async () => {
    const moveCapital = createMoveCapital();
    const feeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(0n);
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);

    await moveCapital.moveAvailableMiningHoldToBot(
      createWallet({ availableMicrogons: miningHoldOperationalReserveMicrogons }),
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
