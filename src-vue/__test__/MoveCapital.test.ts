import { describe, expect, it, vi } from 'vitest';
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { MoveCapital } from '../lib/MoveCapital.ts';
import type { IWallet } from '../lib/Wallet.ts';

describe('MoveCapital', () => {
  it('moves all available mining hold funds to the bot', async () => {
    const moveCapital = createMoveCapital();
    const calculateFeeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(5n);
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);
    const wallet = createWallet({ availableMicrogons: 50n, availableMicronots: 7n });

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
      { ARGN: 50n, ARGNOT: 7n },
      wallet,
      'mining-bot-address',
      true,
    );
  });

  it('skips the sweep when there are not enough argons to pay the fee', async () => {
    const moveCapital = createMoveCapital();
    vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(11n);
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);
    const wallet = createWallet({ availableMicrogons: 10n, availableMicronots: 4n });

    await moveCapital.moveAvailableMiningHoldToBot(wallet);

    expect(moveSpy).not.toHaveBeenCalled();
  });

  it('skips the sweep when there is nothing available to move', async () => {
    const moveCapital = createMoveCapital();
    const feeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(0n);
    const moveSpy = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as any);

    await moveCapital.moveAvailableMiningHoldToBot(createWallet({}));

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
