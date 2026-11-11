import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { ask as askDialog } from '@tauri-apps/plugin-dialog';
import handleFatalError from './helpers/handleFatalError.ts';
import { getConfig, type Config } from './config.ts';
import { createDeferred, MoveTo, MoveToken, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { getMyMiningSeats } from './myMiningSeats.ts';
import { getCurrency } from './currency.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { AccountSecurity } from '../lib/AccountSecurity.ts';
import { WalletAuthenticationRequiredError, WalletSecrets } from '../lib/WalletSecrets.ts';
import { EncryptionSecret } from '../lib/EncryptionSecret.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import {
  existentialDepositMicrogons,
  hasArgonWalletValue,
  getSpendableDefaultArgonMicrogons,
  getSpendableMicrogons,
  IArgonWalletType,
  WalletForArgon,
} from '../lib/WalletForArgon.ts';
import { IWallet, WalletType } from '../lib/Wallet.ts';
import { WalletsForArgon, IWalletEvents, readArgonWalletBalanceValues } from '../lib/WalletsForArgon.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getBlockWatch, getFinalizedClient, getMainchainClient, getMainchainClients } from './mainchain.ts';
import { loadEthereumChainConfig } from '../lib/EthereumClient.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { WalletForBase } from '../lib/WalletForBase.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import { getBitcoinLocks, getBitcoinTransactionOperations } from './bitcoin.ts';
import { invokeWithTimeout } from '../lib/tauriApi.ts';
import { MoveCapital } from '../lib/MoveCapital.ts';
import { MiningSetup } from '../lib/MiningSetup.ts';
import { MiningBidProxySetup } from '../lib/txs/MiningBidProxy.setup.ts';
import { BalanceTransfer, type ITransactionMoveMetadata } from '../lib/txs/Balance.transfer.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import { getTransactionTracker } from './transactions.ts';
import { WalletHistoryRecovery } from '../lib/recovery/WalletHistory.ts';
import { logStartupTiming } from '../lib/Utils.ts';

let legacyMiningHoldCleanupPromise: Promise<void> | undefined;

let accountSecurity: AccountSecurity | undefined;
export function getAccountSecurity() {
  if (!accountSecurity) {
    accountSecurity = new AccountSecurity(
      prompt =>
        new Promise<void>((resolve, reject) => {
          basicEmitter.emit('requestAccountAuthentication', { ...prompt, resolve, reject });
        }),
    );
    accountSecurity.data = Vue.shallowReactive(accountSecurity.data);
    accountSecurity = Vue.markRaw(accountSecurity);
  }
  return accountSecurity;
}

// Wallet Keys //////////////////
let walletKeys: WalletKeys | undefined;
export async function initializeWalletKeys(
  options: Parameters<typeof WalletKeys.load>[2] = {},
): Promise<Awaited<ReturnType<typeof WalletKeys.load>>> {
  if (walletKeys) return { walletKeys };
  const db = await getDbPromise();
  const loaded = await WalletKeys.load({ db, config: getConfig() as Config }, getAccountSecurity(), options);
  walletKeys = Vue.markRaw(loaded.walletKeys);
  return { ...loaded, walletKeys };
}

export function getWalletKeys(): WalletKeys {
  if (!walletKeys) throw new Error('Wallet startup has not finished.');
  return walletKeys;
}

export async function exposeMasterMnemonic(): Promise<string> {
  if (walletKeys) return walletKeys.exposeMasterMnemonic();

  const wallet = await WalletSecrets.readSavedWallet();
  const protection = await new EncryptionSecret().info();
  if (wallet.pendingKeyChange && protection && protection.method !== 'none') {
    wallet.encryptedMnemonic = wallet.pendingKeyChange.encryptedMnemonic;
  }
  return new WalletSecrets(wallet, getAccountSecurity()).getMnemonic();
}

export async function configureAccountSecurity(options: Parameters<AccountSecurity['configure']>[0]): Promise<void> {
  await getAccountSecurity().configure(options, {
    walletKeys: getWalletKeys(),
    db: await getDbPromise(),
    config: getConfig() as Config,
    ethereumWallets: walletsForEthereum,
  });
}

let moveCapital: Vue.Raw<MoveCapital> | undefined;
export function getMoveCapital() {
  if (!moveCapital) {
    const security = getAccountSecurity();
    moveCapital = new MoveCapital(getWalletKeys(), getTransactionTracker(), security.authenticate.bind(security));
    moveCapital.data = Vue.shallowReactive(moveCapital.data);
    moveCapital = Vue.markRaw(moveCapital);
    void moveCapital.load().catch(error => {
      console.warn('[MoveCapital] Unable to restore pending transfers', error);
    });
  }
  return moveCapital;
}

let miningBidProxySetup: MiningBidProxySetup | undefined;
export function getMiningBidProxySetup() {
  miningBidProxySetup ??= new MiningBidProxySetup(getWalletKeys(), getTransactionTracker());
  return miningBidProxySetup;
}

let miningSetup: MiningSetup | undefined;
export function getMiningSetup() {
  if (!miningSetup) {
    const transactionTracker = getTransactionTracker();
    miningSetup = new MiningSetup(getWalletKeys(), transactionTracker, getMiningBidProxySetup(), getConfig() as Config);
    void miningSetup.load().catch(error => {
      console.warn('[MiningSetup] Unable to restore mining setup', error);
    });
  }
  return miningSetup;
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
  const security = getAccountSecurity();
  walletsForEthereum ??= new WalletsForEthereum(
    getWalletKeys(),
    getDbPromise(),
    getDbPromise().then(db => db.financialCacheTable),
    security.request.bind(security),
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
  const externalBalancesReady = Vue.shallowRef(Promise.resolve());

  let walletHistoryRecovery: WalletHistoryRecovery | undefined;
  let walletLoad: Promise<void> | undefined;

  const argonWallets = Vue.markRaw(getWalletsForArgon());
  const bitcoinWallet = getWalletForBitcoin();
  const walletForBase = new WalletForBase(walletKeys.coreEthereumAddress, financialCache);
  walletForBase.data = Vue.reactive(walletForBase.data);
  const ethereumWallets = getWalletsForEthereum();

  const hasFunds = Vue.computed(() => {
    const wallets = [
      ...argonWallets.wallets,
      ethereumWallets.coreWallet,
      ...ethereumWallets.persistedWallets,
      walletForBase,
      bitcoinWallet,
    ];
    if (
      wallets.some(
        wallet => hasArgonWalletValue(wallet.data) || wallet.data.otherTokens.some(token => token.value > 0n),
      )
    )
      return true;
    if (wallets.some(wallet => wallet.data.fetchErrorMsg)) return undefined;
    return false;
  });

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
      miningBidMicrogons.value
    );
  });

  const totalMiningMicronots = Vue.computed(() => {
    return (
      defaultArgonWallet.availableMicronots +
      defaultArgonWallet.reservedMicronots +
      miningBotWallet.availableMicronots +
      miningBotWallet.reservedMicronots
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

  function load(): Promise<void> {
    if (walletLoad) return walletLoad;

    // Keep a declined load rejected so later callers cannot reopen its dialog.
    walletLoad = loadNativeWallets().then(() => {
      walletLoad = undefined;
    });
    return walletLoad;
  }

  async function loadNativeWallets(): Promise<void> {
    const loadStartedAt = performance.now();
    for (let attempt = 1; ; attempt++) {
      const attemptStartedAt = Date.now();
      try {
        await config.isLoadedPromise;
        const configReadyAt = performance.now();

        await ensureWalletRecordsLoaded();
        const walletIdentitiesReadyAt = performance.now();

        walletHistoryRecovery ??= getWalletHistoryRecovery();

        if (attempt > 1) {
          const clients = getMainchainClients();
          await clients.setArchiveClient(clients.archiveUrl);
        }

        await argonWallets.load();
        const argonBalancesReadyAt = performance.now();

        queueWalletHistoryRecovery({
          blockNumber: argonWallets.finalizedBlock?.blockNumber ?? getBlockWatch().finalizedBlockHeader.blockNumber,
          onlyIfIncomplete: true,
        });
        if (walletKeys.canSign) {
          await ensureLegacyMiningHoldCleanup().catch(error => {
            console.warn('Legacy mining hold cleanup failed', error);
          });
        }
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
        externalBalancesReady.value = loadExternalWallets();
        void externalBalancesReady.value.catch(error => {
          console.error('Unable to load external wallet balances', error);
        });
        return;
      } catch (error) {
        console.error(`[useWallets] Load attempt ${attempt} failed after ${Date.now() - attemptStartedAt}ms`, error);
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
      const fallbackVaultingAddress = walletKeys.legacyVaultingAddress?.trim();
      const keyReference = fallbackVaultingAddress ? '//vaulting' : '//default';
      const address = fallbackVaultingAddress || walletKeys.defaultArgonAddress;
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

  async function ensureLegacyMiningHoldCleanup(): Promise<void> {
    if (legacyMiningHoldCleanupPromise) return await legacyMiningHoldCleanupPromise;

    legacyMiningHoldCleanupPromise = (async () => {
      const legacyAddress = walletKeys.legacyMiningHoldAddress;
      if (!legacyAddress || legacyAddress === walletKeys.defaultArgonAddress) return;

      const transactionTracker = getTransactionTracker();
      const isLegacyCleanup = (txInfo: TransactionInfo<ITransactionMoveMetadata>) => {
        const metadata = txInfo.tx.metadataJson;
        return (
          metadata?.workflow === 'legacyMiningHoldCleanup' ||
          (txInfo.tx.accountAddress === legacyAddress &&
            metadata?.moveTo === MoveTo.External &&
            metadata.externalAddress === walletKeys.defaultArgonAddress)
        );
      };
      const transfer = new BalanceTransfer(walletKeys, transactionTracker, {
        ownsTransfer: isLegacyCleanup,
      });
      await transfer.load();
      const pending = transfer.getPendingTransfer(isLegacyCleanup);
      if (pending) return;

      const finalizedClient = await getFinalizedClient();
      const [balance] = await readArgonWalletBalanceValues(finalizedClient, [legacyAddress]);
      const requestedMicrogons = getSpendableMicrogons(balance.availableMicrogons, existentialDepositMicrogons);
      const assetsToMove = {
        [MoveToken.ARGN]: requestedMicrogons || undefined,
        [MoveToken.ARGNOT]: balance.availableMicronots || undefined,
      };
      if (!assetsToMove[MoveToken.ARGN] && !assetsToMove[MoveToken.ARGNOT]) return;

      const client = await getMainchainClient(false);
      const fee = await transfer.estimateFee({
        moveFrom: 'MiningHold',
        moveTo: MoveTo.DefaultArgon,
        assetsToMove,
        workflow: 'legacyMiningHoldCleanup',
        client,
      });
      if (fee > balance.availableMicrogons) {
        throw new Error('The retired mining wallet does not have enough ARGN to return its remaining balance.');
      }

      const microgons = requestedMicrogons > fee ? requestedMicrogons - fee : 0n;
      if (!microgons && !assetsToMove[MoveToken.ARGNOT]) return;

      try {
        await transfer.submit({
          moveFrom: 'MiningHold',
          moveTo: MoveTo.DefaultArgon,
          assetsToMove: {
            [MoveToken.ARGN]: microgons || undefined,
            [MoveToken.ARGNOT]: assetsToMove[MoveToken.ARGNOT],
          },
          workflow: 'legacyMiningHoldCleanup',
          txSigner: await walletKeys.getArgonSigner('//holding'),
          client,
        });
      } catch (error) {
        if (!(error instanceof WalletAuthenticationRequiredError)) throw error;
      }
    })();

    try {
      await legacyMiningHoldCleanupPromise;
    } finally {
      legacyMiningHoldCleanupPromise = undefined;
    }
  }

  load().catch(error => {
    void handleFatalError.bind('useWallets')(error);
    isLoadedReject(error);
  });

  return {
    load,
    isLoaded,
    isLoadedPromise,
    externalBalancesReady,
    hasFunds,

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
