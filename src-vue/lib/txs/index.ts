import type { BitcoinLiquidClose } from './BitcoinLiquid.close.ts';
import type { BitcoinLiquidCreate } from './BitcoinLiquid.create.ts';
import type { BitcoinLiquidRatchet } from './BitcoinLiquid.ratchet.ts';
import type { BitcoinOrphanRelease } from './BitcoinOrphan.release.ts';
import type { BitcoinLockCreate } from './BitcoinLock.create.ts';
import type { BitcoinLockRelease } from './BitcoinLock.release.ts';
import type { BitcoinLockResecuritize } from './BitcoinLock.resecuritize.ts';

export interface TransactionOperations {
  bitcoinLiquidClose: BitcoinLiquidClose;
  bitcoinLiquidCreate: BitcoinLiquidCreate;
  bitcoinLiquidRatchet: BitcoinLiquidRatchet;
  bitcoinOrphanRelease: BitcoinOrphanRelease;
  bitcoinLockCreate: BitcoinLockCreate;
  bitcoinLockRelease: BitcoinLockRelease;
  bitcoinLockResecuritize: BitcoinLockResecuritize;
}

export async function loadTransactionOperations(
  operations: TransactionOperations,
  bitcoinStateLoad: Promise<unknown>,
): Promise<TransactionOperations> {
  await bitcoinStateLoad;

  const {
    bitcoinLiquidClose,
    bitcoinLiquidCreate,
    bitcoinLiquidRatchet,
    bitcoinOrphanRelease,
    bitcoinLockCreate,
    bitcoinLockRelease,
    bitcoinLockResecuritize,
  } = operations;
  await Promise.all([
    bitcoinLiquidClose.load(),
    bitcoinLiquidCreate.load(),
    bitcoinLiquidRatchet.load(),
    bitcoinOrphanRelease.load(),
    bitcoinLockCreate.load(),
    bitcoinLockRelease.load(),
    bitcoinLockResecuritize.load(),
  ]);
  return operations;
}
