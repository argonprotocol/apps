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
import { IWallet, defaultWalletData } from '../lib/Wallet.ts';
import { WalletsForArgon, IWalletEvents, readArgonWalletBalanceValues } from '../lib/WalletsForArgon.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getBlockWatch, getFinalizedClient } from './mainchain.ts';
import { getMyVault } from './vaults.ts';
import { loadEthereumChainConfig } from '../lib/EthereumClient.ts';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { WalletForBase } from '../lib/WalletForBase.ts';
import { invokeWithTimeout } from '../lib/tauriApi.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { MoveCapital } from '../lib/MoveCapital.ts';
import { getTransactionTracker } from './transactions.ts';
import { WalletHistoryRecovery } from '../lib/recovery/WalletHistory.ts';
import { logStartupTiming } from '../lib/Utils.ts';

const DEFAULT_ETHEREUM_HD_PATH = "m/44'/60'/0'/0'/0'";
const EXTERNAL_ETHEREUM_HD_PREFIX = "m/44'/60'/0'/0";
let legacyMiningHoldCleanupPromise: Promise<void> | undefined;

let walletKeys: WalletKeys;
export function getWalletKeys() {
  walletKeys ??= new WalletKeys(SECURITY, async () => {
    const walletsForArgon = getWalletsForArgon();
    await walletsForArgon.load();
    return walletsForArgon.didWalletHavePreviousLife();
  });
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

let walletHistoryRecoveryInstance: WalletHistoryRecovery | undefined;
export function getWalletHistoryRecovery() {
  if (walletHistoryRecoveryInstance) return walletHistoryRecoveryInstance;

  const dbPromise = getDbPromise();
  const wallets = getWalletsForArgon();
  const keys = getWalletKeys();
  const legacyMiningHoldWallet = new WalletForArgon(keys.legacyMiningHoldAddress, 'miningBot', dbPromise);
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

  const walletsForArgon = getWalletsForArgon();
  let walletHistoryRecovery: WalletHistoryRecovery | undefined;
  const ethereumWalletLoaders = new Map<number, WalletForEthereum>();
  const walletForBase = new WalletForBase(walletKeys.defaultEthereumAddress, financialCache);
  const walletRecords = Vue.ref<IWalletRecord[]>([]);
  const activeEthereumWalletRecordId = Vue.ref<number>();

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

  const defaultArgonWallet = Vue.reactive<IWallet>({ ...defaultWalletData, address: walletKeys.defaultArgonAddress });
  const miningBotWallet = Vue.reactive<IWallet>({ ...defaultWalletData, address: walletKeys.miningBotAddress });
  const operationalWallet = Vue.reactive<IWallet>({ ...defaultWalletData, address: walletKeys.operationalAddress });

  const emptyEthereumWallet = Vue.reactive<IWallet>({ ...defaultWalletData });
  const activeEthereumWallet = Vue.computed(() => {
    if (!activeEthereumWalletRecordId.value) return;
    return ethereumWalletLoaders.get(activeEthereumWalletRecordId.value);
  });
  const ethereumWallet = Vue.computed(() => {
    return activeEthereumWallet.value?.data ?? emptyEthereumWallet;
  });
  const baseWallet = Vue.reactive<IWallet>(walletForBase.data);
  walletForBase.data = baseWallet;
  const ethereumFinancialPositions = Vue.computed(() => {
    return activeEthereumWallet.value?.createFinancialPositions(currency) ?? [];
  });
  const baseFinancialPositions = Vue.computed(() => walletForBase.createFinancialPositions(currency));

  const liquidLockingWallet = Vue.computed(() => {
    return defaultArgonWallet;
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

  const totalVaultingResources = Vue.computed(() => {
    return (
      defaultArgonWallet.availableMicrogons +
      defaultArgonWallet.reservedMicrogons +
      currency.convertMicronotTo(defaultArgonWallet.availableMicronots, UnitOfMeasurement.Microgon) +
      currency.convertMicronotTo(defaultArgonWallet.reservedMicronots, UnitOfMeasurement.Microgon)
    );
  });

  const totalOperationalResources = Vue.computed(() => {
    return totalMiningResources.value + totalVaultingResources.value;
  });

  const totalWalletMicrogons = Vue.ref(0n);
  const totalWalletMicronots = Vue.ref(0n);

  const walletMapping = {
    defaultArgon: defaultArgonWallet,
    miningBot: miningBotWallet,
    operational: operationalWallet,
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
  const unsubscribeBalanceChanges = walletsForArgon.events.on('balance-change', (entry, type) => {
    const wallet = walletMapping[type];
    if (!wallet) return;
    Object.assign(wallet, entry);
    wallet.totalMicrogons = wallet.availableMicrogons + wallet.reservedMicrogons;
    wallet.totalMicronots = wallet.availableMicronots + wallet.reservedMicronots;

    totalWalletMicrogons.value = 0n;
    totalWalletMicronots.value = 0n;
    for (const currentWallet of Object.values(walletMapping)) {
      totalWalletMicrogons.value += currentWallet.totalMicrogons;
      totalWalletMicronots.value += currentWallet.totalMicronots;
    }
  });
  const unsubscribeHistoryGap = walletsForArgon.events.on('history:gap', gap => {
    walletHistoryRecovery?.markLiveGap(gap);
    queueWalletHistoryRecovery({ blockNumber: gap.toBlock });
  });
  const unsubscribeFinalizedSync = walletsForArgon.events.on('sync:finalized', block => {
    walletHistoryRecovery?.advanceLiveCoverage(block.blockNumber);
  });

  Vue.onScopeDispose(() => {
    unsubscribeBalanceChanges();
    unsubscribeHistoryGap();
    unsubscribeFinalizedSync();
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
        const walletRecordsReadyAt = performance.now();

        walletHistoryRecovery ??= getWalletHistoryRecovery();

        await walletsForArgon.load();
        const argonBalancesReadyAt = performance.now();

        queueWalletHistoryRecovery({
          blockNumber: walletsForArgon.finalizedBlock?.blockNumber ?? getBlockWatch().finalizedBlockHeader.blockNumber,
          onlyIfIncomplete: true,
        });
        await ensureLegacyMiningHoldCleanup().catch(error => {
          console.warn('Legacy mining hold cleanup failed', error);
        });
        const legacyCleanupReadyAt = performance.now();

        totalWalletMicrogons.value = walletsForArgon.totalWalletMicrogons;
        totalWalletMicronots.value = walletsForArgon.totalWalletMicronots;
        for (const [walletType, wallet] of Object.entries(walletMapping)) {
          const key = walletType as keyof typeof walletMapping;
          const walletEntry = walletsForArgon[`${key}Wallet`];
          if (!walletEntry) continue;
          Object.assign(wallet, walletEntry.latestBalanceChange);
          wallet.totalMicrogons = walletEntry.totalMicrogons;
          wallet.totalMicronots = walletEntry.totalMicronots;
        }
        await currency.isLoadedPromise;
        isLoadedResolve();
        isLoaded.value = true;
        logStartupTiming({
          milestone: 'native-wallets-ready',
          startedAt: loadStartedAt,
          details: {
            attempt,
            configMs: Math.round(configReadyAt - loadStartedAt),
            walletRecordsMs: Math.round(walletRecordsReadyAt - configReadyAt),
            argonBalancesMs: Math.round(argonBalancesReadyAt - walletRecordsReadyAt),
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
      walletsForArgon.configureDefaultArgonWallet(record.address);
    } else {
      walletKeys.configureDefaultArgonWallet({
        address: defaultArgon.address,
        keyReference: defaultArgon.keyReference ?? '//vaulting',
      });
      walletsForArgon.configureDefaultArgonWallet(defaultArgon.address);
    }

    walletRecords.value = await db.walletsTable.fetchAll();
    const currentDefaultArgon = await db.walletsTable.getDefaultArgon();
    if (currentDefaultArgon) {
      defaultArgonWallet.address = currentDefaultArgon.address;
    }
  }

  async function seedLegacyDefaultEthereumIfNeeded() {
    if (walletRecords.value.some(record => record.walletType === 'ethereum')) return;
    if (!walletKeys.defaultEthereumAddress) return;

    const legacyWallet = new WalletForEthereum(walletKeys.defaultEthereumAddress, financialCache);
    await legacyWallet.load().catch(error => {
      console.warn('Unable to inspect legacy default Ethereum wallet during wallet seeding', error);
    });
    if (
      legacyWallet.data.availableMicrogons > 0n ||
      legacyWallet.data.availableMicronots > 0n ||
      legacyWallet.data.otherTokens.some(token => token.value > 0n)
    ) {
      const db = await getDbPromise();
      const record = await db.walletsTable.createDefaultEthereum({
        address: walletKeys.defaultEthereumAddress,
        derivationPath: DEFAULT_ETHEREUM_HD_PATH,
      });
      walletRecords.value.push(record);
      legacyWallet.data = Vue.reactive<IWallet>(legacyWallet.data);
      ethereumWalletLoaders.set(record.id, legacyWallet);
      return legacyWallet;
    }
  }

  async function loadExternalWallets(): Promise<void> {
    const externalLoadStartedAt = performance.now();
    const ethereumLoad = (async () => {
      const seededWallet = await seedLegacyDefaultEthereumIfNeeded();
      const wallet = ensureActiveEthereumWallet();
      if (wallet !== seededWallet) await wallet?.load();
      logStartupTiming({
        milestone: 'ethereum-wallet-refresh-finished',
        startedAt: externalLoadStartedAt,
        details: {
          hasWallet: !!wallet,
          usedCache: !!wallet?.data.balanceIsCached,
          error: wallet?.data.fetchErrorMsg || undefined,
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

  function ensureActiveEthereumWallet(preferredRecordId = activeEthereumWalletRecordId.value) {
    const ethereumWallets = walletRecords.value.filter(record => record.walletType === 'ethereum');
    const preferredEthereum = preferredRecordId
      ? ethereumWallets.find(record => record.id === preferredRecordId)
      : undefined;
    const defaultEthereum = ethereumWallets.find(record => record.role === 'defaultEthereum');
    const activeEthereum = preferredEthereum ?? defaultEthereum ?? ethereumWallets[0];
    activeEthereumWalletRecordId.value = activeEthereum?.id;
    walletKeys.configureEthereumWallet(activeEthereum);
    return activeEthereum ? ensureEthereumWalletLoader(activeEthereum) : undefined;
  }

  async function refreshWalletRecords() {
    const db = await getDbPromise();
    walletRecords.value = await db.walletsTable.fetchAll();
    ensureActiveEthereumWallet();
  }

  async function selectEthereumWalletRecord(recordId: number) {
    const selectedWallet = ensureActiveEthereumWallet(recordId);
    await selectedWallet?.load();
  }

  async function createDefaultEthereumWallet() {
    const db = await getDbPromise();
    const record = await db.walletsTable.createDefaultEthereum({
      address: walletKeys.defaultEthereumAddress,
      derivationPath: DEFAULT_ETHEREUM_HD_PATH,
    });
    await refreshWalletRecords();
    return record;
  }

  async function previewExternalEthereumMnemonic(mnemonic: string, count = 10) {
    const hdPaths = Array.from({ length: count }, (_, index) => `${EXTERNAL_ETHEREUM_HD_PREFIX}/${index}`);
    const addresses = await invokeWithTimeout<string[]>(
      'derive_external_ethereum_addresses',
      { mnemonic, hdPaths },
      60e3,
    );
    return hdPaths.map((derivationPath, index) => ({
      derivationPath,
      address: addresses[index],
    }));
  }

  async function importExternalEthereumPrivateKey(args: { name: string; privateKey: string }) {
    const [address, encryptedSecret] = await Promise.all([
      invokeWithTimeout<string>(
        'derive_external_ethereum_address_from_private_key',
        { privateKey: args.privateKey },
        60e3,
      ),
      invokeWithTimeout<string>('encrypt_wallet_secret', { secret: args.privateKey }, 60e3),
    ]);
    const db = await getDbPromise();
    const record = await db.walletsTable.importExternalEthereum({
      name: args.name,
      address,
      secretKind: 'privateKey',
      encryptedSecret,
    });
    await refreshWalletRecords();
    return record;
  }

  async function importExternalEthereumMnemonic(args: {
    name: string;
    mnemonic: string;
    address: string;
    derivationPath: string;
  }) {
    const encryptedSecret = await invokeWithTimeout<string>('encrypt_wallet_secret', { secret: args.mnemonic }, 60e3);
    const db = await getDbPromise();
    const record = await db.walletsTable.importExternalEthereum({
      name: args.name,
      address: args.address,
      derivationPath: args.derivationPath,
      secretKind: 'mnemonic',
      encryptedSecret,
    });
    await refreshWalletRecords();
    return record;
  }

  async function scanEthereumWalletBalances(addresses: string[]) {
    return await Promise.all(
      addresses.map(async address => {
        const wallet = new WalletForEthereum(address);
        await wallet.load().catch(() => undefined);
        return {
          address,
          wallet: wallet.data,
        };
      }),
    );
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
      const moveCapital = new MoveCapital(walletKeys, getTransactionTracker(), getMyVault());
      await moveCapital.moveLegacyMiningHoldToDefault(
        {
          ...defaultWalletData,
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

  async function updateWalletRecordSortOrder(records: Pick<IWalletRecord, 'id' | 'sortOrder'>[]) {
    const db = await getDbPromise();
    await db.walletsTable.updateSortOrder(records);
    await refreshWalletRecords();
  }

  async function disconnectEthereumWalletRecord(recordId: number) {
    const record = walletRecords.value.find(wallet => wallet.id === recordId && wallet.walletType === 'ethereum');
    if (!record) throw new Error('Ethereum wallet not found.');

    const loader = ensureEthereumWalletLoader(record);
    if (record.role === 'defaultEthereum') {
      await loader.load({ force: true });
      if (loader.data.fetchErrorMsg) {
        throw new Error('Unable to verify that the Default Ethereum wallet is empty. Please try again.');
      }
      const hasTokens =
        loader.data.availableMicrogons > 0n ||
        loader.data.reservedMicrogons > 0n ||
        loader.data.availableMicronots > 0n ||
        loader.data.reservedMicronots > 0n ||
        loader.data.otherTokens.some(token => token.value > 0n);
      if (hasTokens) throw new Error('The Default Ethereum wallet must be empty before it can be disconnected.');
    }

    const db = await getDbPromise();
    await db.financialCacheTable.deleteExternalWalletBalance('ethereum', record.address);
    await db.walletsTable.deleteEthereumWallet(recordId);
    loader.dispose();
    ethereumWalletLoaders.delete(recordId);
    await refreshWalletRecords();
  }

  function getEthereumWalletRecord(recordId: number): IWallet {
    const record = walletRecords.value.find(wallet => wallet.id === recordId && wallet.walletType === 'ethereum');
    if (!record) {
      throw new Error(`Ethereum wallet record not found: ${recordId}`);
    }
    return ensureEthereumWalletLoader(record).data;
  }

  function ensureEthereumWalletLoader(record: IWalletRecord) {
    const existingWallet = ethereumWalletLoaders.get(record.id);
    if (existingWallet?.address.toLowerCase() === record.address.toLowerCase()) {
      return existingWallet;
    }

    const wallet = new WalletForEthereum(record.address, financialCache);
    wallet.data = Vue.reactive<IWallet>(wallet.data);
    ethereumWalletLoaders.set(record.id, wallet);
    return wallet;
  }

  load().catch(error => {
    void handleFatalError.bind('useWallets')(error);
    isLoadedReject();
  });

  return {
    isLoaded,
    isLoadedPromise,

    load,
    walletRecords,
    activeEthereumWalletRecordId,
    refreshWalletRecords,
    selectEthereumWalletRecord,
    getEthereumWalletRecord,
    createDefaultEthereumWallet,
    previewExternalEthereumMnemonic,
    importExternalEthereumPrivateKey,
    importExternalEthereumMnemonic,
    scanEthereumWalletBalances,
    updateWalletRecordSortOrder,
    disconnectEthereumWalletRecord,

    defaultArgonWallet,
    miningBotWallet,
    operationalWallet,
    ethereumWallet,
    baseWallet,
    ethereumFinancialPositions,
    baseFinancialPositions,
    liquidLockingWallet,

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
    totalVaultingResources,
    totalOperationalResources,

    on<K extends keyof IWalletEvents>(event: K, cb: IWalletEvents[K]): () => void {
      const unsub = walletsForArgon.events.on(event, cb);
      // re-emit any load events that happened before we subscribed
      if (!walletsForArgon.deferredLoading.isSettled) {
        void walletsForArgon.deferredLoading.promise.then(() => {
          const events = walletsForArgon.getLoadEvents(event);
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
