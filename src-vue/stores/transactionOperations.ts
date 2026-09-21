import { watch } from 'vue';
import type { TransactionOperations } from '../lib/txs/index.ts';
import { getArgonBonds, getBondTransactionOperations } from './argonBonds.ts';
import { getBitcoinFissions, getBitcoinLocks, getBitcoinTransactionOperations } from './bitcoin.ts';

let restorationStarted = false;

export function restoreTransactions(): void {
  if (restorationStarted) return;
  restorationStarted = true;

  const bitcoinOperations = getBitcoinTransactionOperations();
  const bondOperations = getBondTransactionOperations();
  const bitcoinLocks = getBitcoinLocks();
  const bitcoinFissions = getBitcoinFissions();
  const bonds = getArgonBonds();
  let bitcoinLoad: Promise<unknown> | undefined;
  let bondLoad: Promise<unknown> | undefined;

  const restore = async (
    operations: Array<Pick<TransactionOperations[keyof TransactionOperations], 'load'>>,
    name: string,
  ) => {
    const pending = new Set(operations);
    let retryDelayMs = 1_000;
    while (pending.size) {
      const batch = [...pending];
      const results = await Promise.allSettled(batch.map(operation => operation.load()));
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          pending.delete(batch[index]);
        } else {
          console.warn(`[Transactions] Retrying pending ${name} operations`, result.reason);
        }
      }
      if (!pending.size) return;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    }
  };

  watch(
    () => [bitcoinLocks.data.readiness, bitcoinFissions.data.readiness, bonds.data.isLoaded] as const,
    ([lockReadiness, fissionReadiness, bondsLoaded]) => {
      if (lockReadiness === 'ready' && fissionReadiness === 'ready' && !bitcoinLoad) {
        bitcoinLoad = restore(Object.values(bitcoinOperations), 'Bitcoin');
      }
      if (bondsLoaded && !bondLoad) {
        bondLoad = restore(Object.values(bondOperations), 'bond and stake');
      }
    },
    { immediate: true },
  );
}
