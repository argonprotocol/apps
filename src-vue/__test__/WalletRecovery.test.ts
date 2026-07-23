import { expect, it, vi } from 'vitest';
import { WalletRecovery } from '../lib/WalletRecovery.ts';

it('scans mining history during restore when the mining wallet is currently empty', async () => {
  const miningHistory = [
    {
      frameId: 20,
      bids: [{ bidPosition: 0, microgonsBid: 10n, micronotsStaked: 20n }],
      seats: [],
    },
  ];
  const walletsForArgon = {
    load: vi.fn().mockResolvedValue(undefined),
    defaultArgonWallet: { hasValue: () => false },
    miningBotWallet: { hasValue: () => false },
  };
  const recovery = new WalletRecovery(
    {} as any,
    {} as any,
    walletsForArgon as any,
    {} as any,
    { load: vi.fn().mockResolvedValue(undefined) } as any,
  );
  vi.spyOn(recovery as any, 'loadMiningHistory').mockResolvedValue(miningHistory);

  await expect(recovery.findHistory()).resolves.toEqual({ miningHistory, vaultingRules: undefined });
});
