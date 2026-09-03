import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { ask as askDialog } from '@tauri-apps/plugin-dialog';
import handleFatalError from './helpers/handleFatalError.ts';
import { getConfig } from './config.ts';
import { createDeferred, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { getMyMiningSeats } from './myMiningSeats.ts';
import { getCurrency } from './currency.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { SECURITY } from '../lib/Env.ts';
import { getSpendableDefaultArgonMicrogons, IArgonWalletType, WalletForArgon } from '../lib/WalletForArgon.ts';
import { IWallet, defaultWalletData, WalletType } from '../lib/Wallet.ts';
import { WalletsForArgon, IWalletEvents, readArgonWalletBalanceValues } from '../lib/WalletsForArgon.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getBlockWatch, getFinalizedClient, getMainchainClient } from './mainchain.ts';
import { loadEthereumChainConfig } from '../lib/EthereumClient.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { WalletForBase } from '../lib/WalletForBase.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import { getBitcoinLocks, getBitcoinTransactionOperations } from './bitcoin.ts';
import { invokeWithTimeout } from '../lib/tauriApi.ts';
import { MoveCapital } from '../lib/MoveCapital.ts';
import { getTransactionTracker } from './transactions.ts';
import { WalletHistoryRecovery } from '../lib/recovery/WalletHistory.ts';
import { logStartupTiming } from '../lib/Utils.ts';

let legacyMiningHoldCleanupPromise: Promise<void> | undefined;

// Wallet Keys //////////////////
let walletKeys: WalletKeys;
export function getWalletKeys() {
  walletKeys ??= new WalletKeys(
    SECURITY,
    async () => {
      const walletsForArgon = getWalletsForArgon();
      await walletsForArgon.load();
      return walletsForArgon.didWalletHavePreviousLife();
    },
    async () => {
      const client = await getMainchainClient(false);
      return client.consts.mint.maxPossibleMiners.toNumber();
    },
  );
  return walletKeys;
}

let walletsForArgon: WalletsForArgon;
export function getWalletsForArgon() {
  if (!walletsForArgon) {
    walletsForArgon = new WalletsForArgon({
      walletKeys: getWalletKeys(),
      dbPromise: getDbPromise(),
      blockWatch: getBlockWatch(),
      currency: getCurrency(),
    });
  }
  return walletsForArgon;
}

let walletsForEthereum: WalletsForEthereum | undefined;
export function getWalletsForEthereum() {
  walletsForEthereum ??= new WalletsForEthereum(
    getWalletKeys(),
    getDbPromise(),
    getDbPromise().then(db => db.financialCacheTable),
  );
  return walletsForEthereum;
}

let walletForBitcoin: Vue.Raw<WalletForBitcoin> | undefined;
export function getWalletForBitcoin() {
  if (!walletForBitcoin) {
    walletForBitcoin = new WalletForBitcoin(
      getBitcoinLocks,
      () => getWalletKeys().liquidLockingAddress,
      getBitcoinTransactionOperations().bitcoinLockCreate,
    );
    walletForBitcoin.data = Vue.reactive(walletForBitcoin.data);
    walletForBitcoin = Vue.markRaw(walletForBitcoin);
  }
  return walletForBitcoin;
}

// Wallet History //////////////////
let walletHistoryRecoveryInstance: WalletHistoryRecovery | undefined;
export function getWalletHistoryRecovery() {
  if (walletHistoryRecoveryInstance) return walletHistoryRecoveryInstance;

  const dbPromise = getDbPromise();
  const wallets = getWalletsForArgon();
  const keys = getWalletKeys();
  const legacyMiningHoldWallet = new WalletForArgon('miningBot', keys.legacyMiningHoldAddress, dbPromise);
  const recoveryWallets = [
    wallets.defaultArgonWallet,
    wallets.miningBotWallet,
    legacyMiningHoldWallet,
    wallets.operationalWallet,
  ]
    .filter(wallet => wallet.address)
    .filter((wallet, index, all) => all.findIndex(candidate => candidate.address === wallet.address) === index);
  walletHistoryRecoveryInstance = new WalletHistoryRecovery({
    dbPromise,
    blockWatch: getBlockWatch(),
    currency: getCurrency(),
    recoveryWallets,
    ownedAddresses: wallets.ownedAddresses,
    onRecovered: revision => wallets.events.emit('history:recovered', revision),
  });
  return walletHistoryRecoveryInstance;
}

export const useWallets = defineStore('wallets', () => {
  const myMiningSeats = getMyMiningSeats();
  const currency = getCurrency();
  const config = getConfig();
  const walletKeys = getWalletKeys();
  const financialCache = getDbPromise().then(db => db.financialCacheTable);

  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  let walletHistoryRecovery: WalletHistoryRecovery | undefined;

  const argonWallets = Vue.markRaw(getWalletsForArgon());
  const bitcoinWallet = getWalletForBitcoin();
  const walletForBase = new WalletForBase(walletKeys.coreEthereumAddress, financialCache);
  const ethereumWallets = getWalletsForEthereum();

  void config.isLoadedPromise.then(() => refreshEthereumSignerPolicy()).catch(handleFatalError);

  let hasConfiguredEthereumSignerPolicy = false;
  let ethereumSignerPolicyPromise: Promise<void> | undefined;

  async function refreshEthereumSignerPolicy() {
    await config.isLoadedPromise;
    if (hasConfiguredEthereumSignerPolicy) {
      return;
    }
    if (ethereumSignerPolicyPromise) {
      return await ethereumSignerPolicyPromise;
    }

    ethereumSignerPolicyPromise = (async () => {
      const chainConfig = await loadEthereumChainConfig(config.ethereumExecutionRpcUrl).catch(error => {
        console.warn('Ethereum wallet chain-config load failed', error);
        return undefined;
      });
      if (!chainConfig) {
        return;
      }

      await walletKeys.configureEthereumSignerPolicy({
        chainId: chainConfig.chainId,
        gatewayAddress: chainConfig.gatewayAddress,
        tokenAddresses: [chainConfig.argonTokenAddress, chainConfig.argonotTokenAddress],
      });
      hasConfiguredEthereumSignerPolicy = true;
    })();

    try {
      await ethereumSignerPolicyPromise;
    } finally {
      ethereumSignerPolicyPromise = undefined;
    }
  }

  if (typeof window !== 'undefined') {
    const onFocus = () => {
      void refreshEthereumSignerPolicy().catch(handleFatalError.bind('useWallets'));
    };
    window.addEventListener('focus', onFocus);
    Vue.onScopeDispose(() => window.removeEventListener('focus', onFocus));
  }

  const defaultArgonWalletData = Vue.reactive(argonWallets.defaultArgonWallet.data);
  argonWallets.defaultArgonWallet.data = defaultArgonWalletData;
  const defaultArgonWallet: IWallet = defaultArgonWalletData;

  const miningBotWalletData = Vue.reactive(argonWallets.miningBotWallet.data);
  argonWallets.miningBotWallet.data = miningBotWalletData;
  const miningBotWallet: IWallet = miningBotWalletData;

  const operationalWalletData = Vue.reactive(argonWallets.operationalWallet.data);
  argonWallets.operationalWallet.data = operationalWalletData;
  const operationalWallet: IWallet = operationalWalletData;

  const ethereumFinancialPositions = Vue.computed(() => {
    return ethereumWallets.createFinancialPositions(currency);
  });

  const defaultArgonSpendableMicrogons = Vue.computed(() => {
    return getSpendableDefaultArgonMicrogons(defaultArgonWallet.availableMicrogons);
  });

  const defaultArgonDisplayedMicrogons = Vue.computed(() => {
    return defaultArgonSpendableMicrogons.value + defaultArgonWallet.reservedMicrogons;
  });

  const previousHistoryValue = Vue.computed(() => {
    if (!config.miningBotAccountPreviousHistory) return;
    const bids = { microgons: 0n, micronots: 0n };
    const seats = { microgons: 0n, micronots: 0n };

    for (const item of config.miningBotAccountPreviousHistory) {
      for (const seat of item.seats) {
        seats.microgons += seat.microgonsBid;
        seats.micronots += seat.micronotsStaked;
      }
      for (const bid of item.bids) {
        bids.microgons += bid.microgonsBid;
        bids.micronots += bid.micronotsStaked;
      }
    }

    return { bids, seats };
  });

  const miningSeatMicrogons = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.seats.microgons;
    }
    return myMiningSeats.activeSeats.microgonsToBeMined + myMiningSeats.activeSeats.microgonsToBeMinted;
  });

  const miningSeatMicronots = Vue.computed(() => {
    return myMiningSeats.activeSeats.micronotsToBeMined;
  });

  const miningSeatStakedMicronots = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.seats.micronots;
    }
    return myMiningSeats.activeSeats.micronotsStakedTotal;
  });

  const miningSeatValue = Vue.computed(() => {
    const stakedValue = currency.convertMicronotTo(miningSeatStakedMicronots.value, UnitOfMeasurement.Microgon);
    return myMiningSeats.activeSeats.microgonValueRemaining + stakedValue;
  });

  const miningBidMicrogons = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.bids.microgons;
    }
    return myMiningSeats.pendingBids.microgonsBidTotal;
  });

  const miningBidMicronots = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.bids.micronots;
    }
    return myMiningSeats.pendingBids.micronotsStakedTotal;
  });

  const miningBidValue = Vue.computed(() => {
    return miningBidMicrogons.value + currency.convertMicronotTo(miningBidMicronots.value, UnitOfMeasurement.Microgon);
  });

  const totalMiningMicrogons = Vue.computed(() => {
    return (
      defaultArgonSpendableMicrogons.value +
      miningBotWallet.availableMicrogons +
      miningSeatMicrogons.value +
      miningBidMicrogons.value -
      config.biddingRules.sidelinedMicrogons
    );
  });

  const totalMiningMicronots = Vue.computed(() => {
    return (
      defaultArgonWallet.availableMicronots +
      defaultArgonWallet.reservedMicronots +
      miningBotWallet.availableMicronots +
      miningBotWallet.reservedMicronots -
      config.biddingRules.sidelinedMicronots
    );
  });

  const totalVaultingMicrogons = Vue.computed(() => {
    // TBD: add in current vault value
    return defaultArgonWallet.availableMicrogons + defaultArgonWallet.reservedMicrogons;
  });

  const totalMiningResources = Vue.computed(() => {
    const holdings =
      defaultArgonDisplayedMicrogons.value +
      currency.convertMicronotTo(defaultArgonWallet.totalMicronots, UnitOfMeasurement.Microgon);

    return (
      holdings +
      miningBotWallet.availableMicrogons +
      currency.convertMicronotTo(miningBotWallet.availableMicronots, UnitOfMeasurement.Microgon) +
      miningBidValue.value +
      miningSeatValue.value
    );
  });

  const totalWalletMicrogons = Vue.ref(0n);
  const totalWalletMicronots = Vue.ref(0n);

  const walletMapping = {
    [WalletType.argon]: defaultArgonWallet,
    [WalletType.miningBot]: miningBotWallet,
    [WalletType.operational]: operationalWallet,
  } satisfies Record<IArgonWalletType, IWallet>;
  let walletHistoryPreparation: Promise<boolean> | undefined;
  function queueWalletHistoryRecovery({
    blockNumber,
    onlyIfIncomplete = false,
  }: {
    blockNumber: number;
    onlyIfIncomplete?: boolean;
  }): void {
    const recovery = walletHistoryRecovery;
    if (!recovery) return;

    walletHistoryPreparation ??= recovery.prepare().catch(error => {
      walletHistoryPreparation = undefined;
      throw error;
    });
    void walletHistoryPreparation
      .then(async needsInitialization => {
        if (onlyIfIncomplete && !needsInitialization && (await recovery.hasCompleteCoverage(blockNumber))) return;

        recovery.queue(blockNumber);
      })
      .catch(error => console.warn('Wallet history recovery preparation failed', error));
  }

  //////////////////////////////////////////////////////////////////////////////
  const unsubscribeBalanceChanges = argonWallets.events.on('balance-change', (_entry, type) => {
    const wallet = walletMapping[type];
    if (!wallet) return;

    totalWalletMicrogons.value = 0n;
    totalWalletMicronots.value = 0n;
    for (const currentWallet of Object.values(walletMapping)) {
      totalWalletMicrogons.value += currentWallet.totalMicrogons;
      totalWalletMicronots.value += currentWallet.totalMicronots;
    }
  });
  const unsubscribeHistoryGap = argonWallets.events.on('history:gap', gap => {
    walletHistoryRecovery?.markLiveGap(gap);
    queueWalletHistoryRecovery({ blockNumber: gap.toBlock });
  });
  const unsubscribeFinalizedSync = argonWallets.events.on('sync:finalized', block => {
    walletHistoryRecovery?.advanceLiveCoverage(block.blockNumber);
  });

  Vue.onScopeDispose(() => {
    unsubscribeBalanceChanges();
    unsubscribeHistoryGap();
    unsubscribeFinalizedSync();
    ethereumWallets.dispose();
    if (walletsForEthereum === ethereumWallets) walletsForEthereum = undefined;
    if (walletHistoryRecovery && walletHistoryRecoveryInstance === walletHistoryRecovery) {
      walletHistoryRecoveryInstance = undefined;
    }
    if (walletHistoryRecovery) {
      void walletHistoryRecovery.close().catch(error => {
        console.warn('Wallet history recovery shutdown failed', error);
      });
    }
  });

  async function load() {
    const loadStartedAt = performance.now();
    for (let i = 0; i < 2; i++) {
      const attempt = i + 1;
      const attemptStartedAt = Date.now();
      try {
        await config.isLoadedPromise;
        const configReadyAt = performance.now();

        await ensureWalletRecordsLoaded();
        const walletIdentitiesReadyAt = performance.now();

        walletHistoryRecovery ??= getWalletHistoryRecovery();

        await argonWallets.load();
        const argonBalancesReadyAt = performance.now();

        queueWalletHistoryRecovery({
          blockNumber: argonWallets.finalizedBlock?.blockNumber ?? getBlockWatch().finalizedBlockHeader.blockNumber,
          onlyIfIncomplete: true,
        });
        await ensureLegacyMiningHoldCleanup().catch(error => {
          console.warn('Legacy mining hold cleanup failed', error);
        });
        const legacyCleanupReadyAt = performance.now();

        totalWalletMicrogons.value = argonWallets.totalWalletMicrogons;
        totalWalletMicronots.value = argonWallets.totalWalletMicronots;
        await currency.isLoadedPromise;
        isLoadedResolve();
        isLoaded.value = true;
        logStartupTiming({
          milestone: 'native-wallets-ready',
          startedAt: loadStartedAt,
          details: {
            attempt,
            configMs: Math.round(configReadyAt - loadStartedAt),
            walletIdentitiesMs: Math.round(walletIdentitiesReadyAt - configReadyAt),
            argonBalancesMs: Math.round(argonBalancesReadyAt - walletIdentitiesReadyAt),
            legacyCleanupMs: Math.round(legacyCleanupReadyAt - argonBalancesReadyAt),
            currencyMs: Math.round(performance.now() - legacyCleanupReadyAt),
          },
        });
        void loadExternalWallets().catch(error => {
          console.error('Unable to load external wallet balances', error);
        });
        return;
      } catch (error) {
        console.error(`[useWallets] Load attempt ${attempt} failed after ${Date.now() - attemptStartedAt}ms`, error);
        // TODO: this is a bit of a hack to make sure we don't get stuck in a loop. We should replace this with setting
        //  fetchErrorMsg on each wallet.
        const shouldRetry = await askDialog('Wallets failed to load correctly. Would you like to retry?', {
          title: 'Difficulty Loading Wallets',
          kind: 'warning',
        });
        if (!shouldRetry) {
          throw error;
        }
      }
    }
  }

  async function ensureWalletRecordsLoaded() {
    const db = await getDbPromise();
    const defaultArgon = await db.walletsTable.getDefaultArgon();
    if (!defaultArgon) {
      const fallbackVaultingAddress = SECURITY.vaultingAddress?.trim();
      const keyReference = fallbackVaultingAddress ? '//vaulting' : '//default';
      const [address] = fallbackVaultingAddress
        ? [fallbackVaultingAddress]
        : await invokeWithTimeout<string[]>('derive_sr25519_address', { suris: [keyReference] }, 60e3);
      const record = await db.walletsTable.upsertDefaultArgon({
        address,
        keyReference,
      });
      walletKeys.configureDefaultArgonWallet({
        address: record.address,
        keyReference: record.keyReference ?? keyReference,
      });
      argonWallets.configureDefaultArgonWallet(record.address);
    } else {
      walletKeys.configureDefaultArgonWallet({
        address: defaultArgon.address,
        keyReference: defaultArgon.keyReference ?? '//vaulting',
      });
      argonWallets.configureDefaultArgonWallet(defaultArgon.address);
    }

    const currentDefaultArgon = await db.walletsTable.getDefaultArgon();
    if (currentDefaultArgon) {
      defaultArgonWallet.address = currentDefaultArgon.address;
      argonWallets.defaultArgonWallet.setRecord(currentDefaultArgon);
    }

    await ethereumWallets.loadCachedBalances();
  }

  async function loadExternalWallets(): Promise<void> {
    const externalLoadStartedAt = performance.now();
    const ethereumLoad = (async () => {
      await ethereumWallets.load();
      logStartupTiming({
        milestone: 'ethereum-wallet-refresh-finished',
        startedAt: externalLoadStartedAt,
        details: {
          walletCount: ethereumWallets.length,
          cachedWalletCount: ethereumWallets.persistedWallets.filter(wallet => wallet.data.balanceIsCached).length,
          failedWalletCount: ethereumWallets.persistedWallets.filter(wallet => wallet.data.fetchErrorMsg).length,
        },
      });
    })();
    const baseLoad = walletForBase.load().then(() => {
      logStartupTiming({
        milestone: 'base-wallet-refresh-finished',
        startedAt: externalLoadStartedAt,
        details: {
          usedCache: !!walletForBase.data.balanceIsCached,
          error: walletForBase.data.fetchErrorMsg || undefined,
        },
      });
    });

    await Promise.all([baseLoad, ethereumLoad]);
  }

  async function ensureLegacyMiningHoldCleanup() {
    if (legacyMiningHoldCleanupPromise) {
      return await legacyMiningHoldCleanupPromise;
    }
    legacyMiningHoldCleanupPromise = (async () => {
      if (
        !walletKeys.legacyMiningHoldAddress ||
        walletKeys.legacyMiningHoldAddress === walletKeys.defaultArgonAddress
      ) {
        return;
      }
      const finalizedClient = await getFinalizedClient();
      const [balance] = await readArgonWalletBalanceValues(finalizedClient, [walletKeys.legacyMiningHoldAddress]);
      const hasLegacyValue =
        balance.availableMicrogons > 0n ||
        balance.availableMicronots > 0n ||
        balance.reservedMicrogons > 0n ||
        balance.reservedMicronots > 0n;
      if (!hasLegacyValue) {
        return;
      }
      const moveCapital = new MoveCapital(walletKeys, getTransactionTracker());
      await moveCapital.moveLegacyMiningHoldToDefault(
        {
          ...defaultWalletData,
          type: WalletType.argon,
          address: walletKeys.legacyMiningHoldAddress,
          ...balance,
          totalMicrogons: balance.availableMicrogons + balance.reservedMicrogons,
          totalMicronots: balance.availableMicronots + balance.reservedMicronots,
        },
        walletKeys,
      );
    })();

    try {
      await legacyMiningHoldCleanupPromise;
    } finally {
      legacyMiningHoldCleanupPromise = undefined;
    }
  }

  load().catch(error => {
    void handleFatalError.bind('useWallets')(error);
    isLoadedReject();
  });

  return {
    load,
    isLoaded,
    isLoadedPromise,

    argonWallets,
    ethereumWallets,
    bitcoinWallet,

    defaultArgonWallet,
    miningBotWallet,
    operationalWallet,

    ethereumFinancialPositions,
    defaultArgonSpendableMicrogons,
    defaultArgonDisplayedMicrogons,
    totalWalletMicrogons,
    totalWalletMicronots,
    miningSeatValue,
    miningBidValue,
    miningSeatMicrogons,
    miningSeatMicronots,
    miningSeatStakedMicronots,
    miningBidMicrogons,
    miningBidMicronots,

    totalMiningMicrogons,
    totalMiningMicronots,
    totalVaultingMicrogons,
    totalMiningResources,

    on<K extends keyof IWalletEvents>(event: K, cb: IWalletEvents[K]): () => void {
      const unsub = argonWallets.events.on(event, cb);
      // re-emit any load events that happened before we subscribed
      if (!argonWallets.deferredLoading.isSettled) {
        void argonWallets.deferredLoading.promise.then(() => {
          const events = argonWallets.getLoadEvents(event);
          for (const args of events) {
            // @ts-expect-error ts can't understand this pattern
            cb(...args);
          }
        });
      }
      return unsub;
    },
  };
});
