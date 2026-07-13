import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { ask as askDialog } from '@tauri-apps/plugin-dialog';
import handleFatalError from './helpers/handleFatalError.ts';
import { getConfig } from './config.ts';
import { createDeferred, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { getStats } from './stats.ts';
import { getCurrency } from './currency.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { SECURITY } from '../lib/Env.ts';
import { getSpendableDefaultArgonMicrogons, IArgonWalletType } from '../lib/WalletForArgon.ts';
import { IWallet, defaultWalletData } from '../lib/Wallet.ts';
import { IWalletEvents, WalletsForArgon, readArgonWalletBalanceValues } from '../lib/WalletsForArgon.ts';
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
    const myVault = getMyVault();
    walletsForArgon = new WalletsForArgon(getWalletKeys(), getDbPromise(), getBlockWatch(), myVault);
  }
  return walletsForArgon;
}

export const useWallets = defineStore('wallets', () => {
  const stats = getStats();
  const currency = getCurrency();
  const config = getConfig();
  const walletKeys = getWalletKeys();

  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const walletsForArgon = getWalletsForArgon();
  let walletForEthereum: WalletForEthereum | undefined;
  const walletForBase = new WalletForBase(walletKeys.ethereumAddress);
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

  const ethereumWallet = Vue.reactive<IWallet>({ ...defaultWalletData });
  const baseWallet = Vue.reactive<IWallet>(walletForBase.data);
  walletForBase.data = baseWallet;

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
    return stats.myMiningSeats.microgonsToBeMined;
  });

  const miningSeatMicronots = Vue.computed(() => {
    return stats.myMiningSeats.micronotsToBeMined;
  });

  const miningSeatStakedMicronots = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.seats.micronots;
    }
    return stats.myMiningSeats.micronotsStakedTotal;
  });

  const miningSeatValue = Vue.computed(() => {
    const micronots = miningSeatMicronots.value + miningSeatStakedMicronots.value;
    return miningSeatMicrogons.value + currency.convertMicronotTo(micronots, UnitOfMeasurement.Microgon);
  });

  const miningBidMicrogons = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.bids.microgons;
    }
    return stats.myMiningBids.microgonsBidTotal;
  });

  const miningBidMicronots = Vue.computed(() => {
    const previousHistory = previousHistoryValue.value;
    if (previousHistory) {
      return previousHistory.bids.micronots;
    }
    return stats.myMiningBids.micronotsStakedTotal;
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

  //////////////////////////////////////////////////////////////////////////////
  walletsForArgon.events.on('balance-change', (entry, type) => {
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

  async function load() {
    for (let i = 0; i < 2; i++) {
      const attempt = i + 1;
      const attemptStartedAt = Date.now();
      try {
        await config.isLoadedPromise;
        await ensureWalletRecordsLoaded();
        await ensureActiveEthereumWallet();

        const loadPromises: Promise<unknown>[] = [walletsForArgon.load(), walletForBase.load()];
        if (walletForEthereum) {
          loadPromises.push(walletForEthereum.load());
        }
        await Promise.all(loadPromises);
        await ensureLegacyMiningHoldCleanup().catch(error => {
          console.warn('Legacy mining hold cleanup failed', error);
        });

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
        await Promise.all([stats.isLoadedPromise, currency.isLoadedPromise]);
        isLoadedResolve();
        isLoaded.value = true;
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

    await seedLegacyDefaultEthereumIfNeeded();
    walletRecords.value = await db.walletsTable.fetchAll();
    const currentDefaultArgon = await db.walletsTable.getDefaultArgon();
    if (currentDefaultArgon) {
      defaultArgonWallet.address = currentDefaultArgon.address;
    }
  }

  async function seedLegacyDefaultEthereumIfNeeded() {
    const db = await getDbPromise();
    const existingEthereumWallets = await db.walletsTable.fetchEthereumWallets();
    if (existingEthereumWallets.length) return;
    if (!walletKeys.ethereumAddress) return;

    const legacyWallet = new WalletForEthereum(walletKeys.ethereumAddress);
    await legacyWallet.load().catch(error => {
      console.warn('Unable to inspect legacy default Ethereum wallet during wallet seeding', error);
    });
    if (
      legacyWallet.data.availableMicrogons > 0n ||
      legacyWallet.data.availableMicronots > 0n ||
      legacyWallet.data.otherTokens.some(token => token.value > 0n)
    ) {
      await db.walletsTable.createDefaultEthereum({
        address: walletKeys.ethereumAddress,
        derivationPath: DEFAULT_ETHEREUM_HD_PATH,
      });
    }
  }

  async function ensureActiveEthereumWallet(preferredRecordId = activeEthereumWalletRecordId.value) {
    const db = await getDbPromise();
    const defaultEthereum = await db.walletsTable.getDefaultEthereum();
    const ethereumWallets = await db.walletsTable.fetchEthereumWallets();
    const preferredEthereum = preferredRecordId
      ? ethereumWallets.find(record => record.id === preferredRecordId)
      : undefined;
    const activeEthereum = preferredEthereum ?? defaultEthereum ?? ethereumWallets[0];
    activeEthereumWalletRecordId.value = activeEthereum?.id;
    walletKeys.configureEthereumWallet(activeEthereum);
    walletForEthereum = activeEthereum ? new WalletForEthereum(activeEthereum.address) : undefined;
    Object.assign(ethereumWallet, walletForEthereum?.data ?? { ...defaultWalletData });
    if (walletForEthereum) {
      walletForEthereum.data = ethereumWallet;
    }
  }

  async function refreshWalletRecords() {
    const db = await getDbPromise();
    walletRecords.value = await db.walletsTable.fetchAll();
    await ensureActiveEthereumWallet();
  }

  async function selectEthereumWalletRecord(recordId: number) {
    await ensureActiveEthereumWallet(recordId);
    await walletForEthereum?.load();
  }

  async function createDefaultEthereumWallet() {
    const db = await getDbPromise();
    await db.walletsTable.createDefaultEthereum({
      address: walletKeys.ethereumAddress,
      derivationPath: DEFAULT_ETHEREUM_HD_PATH,
    });
    await refreshWalletRecords();
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
    await db.walletsTable.importExternalEthereum({
      name: args.name,
      address,
      secretKind: 'privateKey',
      encryptedSecret,
    });
    await refreshWalletRecords();
  }

  async function importExternalEthereumMnemonic(args: {
    name: string;
    mnemonic: string;
    address: string;
    derivationPath: string;
  }) {
    const encryptedSecret = await invokeWithTimeout<string>('encrypt_wallet_secret', { secret: args.mnemonic }, 60e3);
    const db = await getDbPromise();
    await db.walletsTable.importExternalEthereum({
      name: args.name,
      address: args.address,
      derivationPath: args.derivationPath,
      secretKind: 'mnemonic',
      encryptedSecret,
    });
    await refreshWalletRecords();
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

  load().catch(error => {
    void handleFatalError.bind('useWallets')(error);
    isLoadedReject();
  });

  return {
    isLoaded,
    isLoadedPromise,

    load,
    walletRecords,
    refreshWalletRecords,
    selectEthereumWalletRecord,
    createDefaultEthereumWallet,
    previewExternalEthereumMnemonic,
    importExternalEthereumPrivateKey,
    importExternalEthereumMnemonic,
    scanEthereumWalletBalances,
    updateWalletRecordSortOrder,

    defaultArgonWallet,
    miningBotWallet,
    operationalWallet,
    ethereumWallet,
    baseWallet,
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
