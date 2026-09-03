import { defineStore } from 'pinia';
import * as Vue from 'vue';

import { getArgonBonds } from './argonBonds.ts';
import { getBitcoinFissions, getBitcoinLocks } from './bitcoin.ts';
import { getConfig } from './config.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getBlockWatch, getMainchainClients } from './mainchain.ts';
import { getMyVault } from './vaults.ts';
import { useWallets } from './wallets.ts';
import {
  getEnabledFinancialHistoryDomains,
  type IFinancialHistoryDomain,
  needsFinancialHistoryRecovery,
  restoreFinancialHistory as restoreFinancialHistoryFromIndex,
} from '../lib/recovery/index.ts';
import { FinalizedHistoryScheduler } from '../lib/recovery/Scheduler.ts';

export type IFinancialHistoryRecoveryState = {
  state: 'checking' | 'restoring' | 'waiting' | 'ready' | 'error';
  recoveredBlockCount: number;
  currentDomain?: IFinancialHistoryDomain;
  currentDomainRecoveredBlockCount?: number;
  currentDomainTotalBlockCount?: number;
  message?: string;
};

export const useFinancialHistory = defineStore('financialHistory', () => {
  const config = getConfig();
  const wallets = useWallets();
  const argonBonds = getArgonBonds();
  const bitcoinLocks = getBitcoinLocks();
  const bitcoinFissions = getBitcoinFissions();
  const myVault = getMyVault();
  const historyRecovery = Vue.ref<IFinancialHistoryRecoveryState>({ state: 'ready', recoveredBlockCount: 0 });
  const historyRecoveryByDomain = Vue.reactive<Record<IFinancialHistoryDomain, IFinancialHistoryRecoveryState>>({
    bitcoin: { state: 'ready', recoveredBlockCount: 0 },
    bonds: { state: 'ready', recoveredBlockCount: 0 },
    vaulting: { state: 'ready', recoveredBlockCount: 0 },
  });
  const activeBitcoinLockCount = Vue.ref<number>();
  const isHistoryRecoveryInProgress = Vue.computed(() => {
    return (
      historyRecovery.value.state === 'checking' ||
      historyRecovery.value.state === 'restoring' ||
      historyRecovery.value.state === 'waiting'
    );
  });

  let isLoaded = false;
  let hasConfirmedCoverage = false;
  let loadPromise: Promise<void> | undefined;
  const scheduler = new FinalizedHistoryScheduler(async (finalizedBlockNumber, force) => {
    if (!isLoaded) return 0;
    return runRecovery(force, finalizedBlockNumber);
  });

  function getEnabledDomains(force: boolean): IFinancialHistoryDomain[] {
    return getEnabledFinancialHistoryDomains({
      force,
      hasExtensionTreasury: config.hasExtensionTreasury,
      hasExtensionOperations: config.hasExtensionOperations,
      walletAccountsHadPreviousLife: config.walletAccountsHadPreviousLife,
    });
  }

  async function initialize(): Promise<void> {
    activeBitcoinLockCount.value = undefined;
    const enabledDomains = getEnabledDomains(false);
    if (!enabledDomains.length) return;

    historyRecovery.value = { state: 'checking', recoveredBlockCount: 0 };
    for (const domain of enabledDomains) {
      historyRecoveryByDomain[domain] = { state: 'checking', recoveredBlockCount: 0 };
    }

    const needsRecovery = await needsFinancialHistoryRecovery({
      db: await getDbPromise(),
      accountId: wallets.defaultArgonWallet.address,
      enabledDomains,
      bitcoinLockRecovery: bitcoinLocks.recovery,
      recoverMissingCheckpointsFor: enabledDomains,
    });
    if (needsRecovery) {
      await scheduler.runNow(getBlockWatch().finalizedBlockHeader.blockNumber, false);
      return;
    }

    hasConfirmedCoverage = true;
    for (const domain of enabledDomains) {
      historyRecoveryByDomain[domain] = { state: 'ready', recoveredBlockCount: 0 };
    }
    historyRecovery.value = { state: 'ready', recoveredBlockCount: 0 };
  }

  async function restoreFinancialHistory(force = false, minimumAsOfBlock?: number): Promise<void> {
    await load();
    const targetBlock = minimumAsOfBlock ?? getBlockWatch().finalizedBlockHeader.blockNumber;
    await scheduler.runNow(targetBlock, force);
  }

  async function runRecovery(force: boolean, targetBlock: number): Promise<number> {
    const shouldShowRecovery = force || !hasConfirmedCoverage;
    const enabledDomains = getEnabledDomains(force);
    let recoveryFailed = false;
    if (shouldShowRecovery) {
      for (const domain of enabledDomains) {
        historyRecoveryByDomain[domain] = { state: 'checking', recoveredBlockCount: 0 };
      }
    }

    const completedDomains = new Set<IFinancialHistoryDomain>();
    try {
      const historyLoads: Promise<unknown>[] = [];
      if (enabledDomains.includes('bonds')) historyLoads.push(argonBonds.load());
      if (enabledDomains.includes('bitcoin')) historyLoads.push(bitcoinLocks.load(), bitcoinFissions.load());
      if (enabledDomains.includes('vaulting')) historyLoads.push(myVault.load());
      await Promise.all(historyLoads);

      const result = await restoreFinancialHistoryFromIndex({
        db: await getDbPromise(),
        blockWatch: getBlockWatch(),
        accountId: wallets.defaultArgonWallet.address,
        argonBonds,
        bitcoinLockRecovery: bitcoinLocks.recovery,
        bitcoinFissionRecovery: bitcoinFissions.recovery,
        vaultHistory: myVault.history,
        enabledDomains,
        recoverMissingCheckpointsFor: force || config.walletAccountsHadPreviousLife ? enabledDomains : [],
        mainchainClients: getMainchainClients(),
        force,
        minimumAsOfBlock: targetBlock,
        onCheckStart() {
          if (shouldShowRecovery) historyRecovery.value = { state: 'checking', recoveredBlockCount: 0 };
        },
        onActiveBitcoinLocksFound(count) {
          if (shouldShowRecovery) activeBitcoinLockCount.value = count;
        },
        onProgress(recoveredBlockCount, domainProgress) {
          if (!shouldShowRecovery) return;
          if (!domainProgress) {
            historyRecovery.value = { state: 'checking', recoveredBlockCount };
            return;
          }

          const state: IFinancialHistoryRecoveryState['state'] = domainProgress.totalBlockCount
            ? 'restoring'
            : 'checking';
          const domainState = {
            state,
            recoveredBlockCount: domainProgress.recoveredBlockCount,
            currentDomain: domainProgress.domain,
            currentDomainRecoveredBlockCount: domainProgress.recoveredBlockCount,
            currentDomainTotalBlockCount: domainProgress.totalBlockCount,
          };
          historyRecoveryByDomain[domainProgress.domain] = domainState;
          historyRecovery.value = { ...domainState, recoveredBlockCount };
        },
        onDomainComplete({ domain, asOfBlock, error }) {
          if (!error) completedDomains.add(domain);
          if (!shouldShowRecovery) return;

          if (error) {
            historyRecoveryByDomain[domain] = {
              state: 'error',
              recoveredBlockCount: historyRecoveryByDomain[domain].recoveredBlockCount,
              message: error,
            };
          } else if (asOfBlock >= targetBlock) {
            historyRecoveryByDomain[domain] = {
              state: 'ready',
              recoveredBlockCount: historyRecoveryByDomain[domain].recoveredBlockCount,
            };
          } else {
            historyRecoveryByDomain[domain] = {
              state: 'waiting',
              recoveredBlockCount: historyRecoveryByDomain[domain].recoveredBlockCount,
              message: `History is indexed through block ${asOfBlock.toLocaleString()} and is still catching up`,
            };
          }
        },
      });

      const isRecoveryComplete = result.asOfBlock >= targetBlock;
      if (isRecoveryComplete) {
        hasConfirmedCoverage = true;
        historyRecovery.value = { state: 'ready', recoveredBlockCount: result.importedBlockCount };
      } else if (shouldShowRecovery) {
        historyRecovery.value = {
          state: 'waiting',
          recoveredBlockCount: result.importedBlockCount,
          message: `Investment history is indexed through block ${result.asOfBlock.toLocaleString()} and is still catching up`,
        };
      }
      return result.asOfBlock;
    } catch (error) {
      recoveryFailed = true;
      if (shouldShowRecovery) {
        const message = error instanceof Error ? error.message : 'Unable to restore investment history';
        for (const domain of enabledDomains) {
          if (!['checking', 'restoring'].includes(historyRecoveryByDomain[domain].state)) continue;
          historyRecoveryByDomain[domain] = {
            state: 'error',
            recoveredBlockCount: historyRecoveryByDomain[domain].recoveredBlockCount,
            message,
          };
        }
        historyRecovery.value = { ...historyRecovery.value, state: 'error', message };
      }
      throw error;
    } finally {
      const publications: Array<{ domain: IFinancialHistoryDomain; promise: Promise<unknown> }> = [];
      if (completedDomains.has('bonds')) {
        publications.push({ domain: 'bonds', promise: argonBonds.publishRecoveredHistory() });
      }
      if (completedDomains.has('vaulting')) {
        publications.push({ domain: 'vaulting', promise: Promise.resolve(myVault.publishRecoveredHistory()) });
      }
      // Bitcoin lock and Fission replay publishes atomically while it releases its recovery quarantine.

      const publicationResults = await Promise.allSettled(publications.map(({ promise }) => promise));
      const publicationFailure = publicationResults.find(result => result.status === 'rejected');
      for (const [index, result] of publicationResults.entries()) {
        if (result.status !== 'rejected') continue;

        const domain = publications[index].domain;
        const message = result.reason instanceof Error ? result.reason.message : `Unable to publish ${domain} history`;
        historyRecoveryByDomain[domain] = {
          state: 'error',
          recoveredBlockCount: historyRecoveryByDomain[domain].recoveredBlockCount,
          message,
        };
        historyRecovery.value = { ...historyRecovery.value, state: 'error', message };
      }
      if (publicationFailure && !recoveryFailed) throw publicationFailure.reason;
      if (publicationFailure) {
        console.error('[FinancialHistory] Unable to publish recovered domain history', publicationFailure.reason);
      }
    }
  }

  async function load(): Promise<void> {
    loadPromise ??= (async () => {
      try {
        await Promise.all([config.isLoadedPromise, wallets.isLoadedPromise]);
        isLoaded = true;
        if (!config.walletAccountsHadPreviousLife) {
          hasConfirmedCoverage = true;
          return;
        }
        await initialize();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to restore investment history';
        historyRecovery.value = { ...historyRecovery.value, state: 'error', message };
        loadPromise = undefined;
        throw error;
      }
    })();
    return loadPromise;
  }

  void load().catch(error => {
    console.error('[FinancialHistory] Unable to initialize recovery', error);
  });

  return {
    activeBitcoinLockCount,
    historyRecovery,
    historyRecoveryByDomain,
    isHistoryRecoveryInProgress,
    restoreFinancialHistory,
  };
});
