import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm, message } from '@tauri-apps/plugin-dialog';
import { AppStartup } from '../lib/AppStartup.ts';
import Importer from '../lib/Importer.ts';
import { WalletLoadError } from '../lib/WalletKeys.ts';
import { AccountAuthenticationError } from '../lib/AccountSecurity.ts';
import { WalletRecovery } from '../lib/WalletRecovery.ts';
import { Config, getConfig } from './config.ts';
// prettier-ignore
import { initializeWalletKeys, getWalletKeys, getWalletsForArgon, getMiningBidProxySetup, useWallets } from './wallets.ts';
import { getMyVault } from './vaults.ts';
import { getMainchainClients, getMiningFrames, getMining, refreshPrunedClientFromConfig } from './mainchain.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getServerApiClient } from './server.ts';
import { isAppUpdateBlockingServerInstall } from './appUpdater.ts';
import { useRuntimeCompatibility } from './runtimeCompatibility.ts';
import { enrollUpstreamRecovery, publishOwnServer, publishOwnServerEndpoint } from './bootstrapRecovery.ts';
import handleFatalError from './helpers/handleFatalError.ts';
import { SSH } from '../lib/SSH.ts';
import Installer from '../lib/Installer.ts';
import { Bot } from '../lib/Bot.ts';
import { type EncryptionAuthentication } from '../lib/EncryptionSecret.ts';
import { getEthereumOutboundTransferTracker } from './moveToEthereum.ts';
import { restoreTransactions } from './transactionOperations.ts';
import { waitForLoad } from '@argonprotocol/mainchain';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';

export { type Installer, type Bot };

export const useStartupStore = defineStore('startup', () => {
  const isWalletReady = Vue.ref(false);
  const isLoading = Vue.ref(false);
  const isImporting = Vue.ref(false);
  const errorMessage = Vue.ref('');
  const startup = Vue.shallowRef<Vue.Reactive<AppStartup>>();
  const installer = Vue.shallowRef<Vue.Reactive<Installer>>();
  const bot = Vue.shallowRef<Vue.Reactive<Bot>>();
  let initialization: Promise<void> | undefined;
  let needsReload = false;

  function initialize(authentication?: EncryptionAuthentication): Promise<void> {
    const compatibility = useRuntimeCompatibility();
    compatibility.start();
    if (compatibility.shouldShowCompatibilityScreen) return Promise.resolve();
    if (needsReload) {
      window.location.reload();
      return Promise.resolve();
    }
    if (initialization) return initialization;
    initialization = initializeApplication(authentication);
    return initialization;
  }

  async function importFromMnemonic(mnemonic: string): Promise<boolean> {
    const walletKeys = getWalletKeys();
    if (await walletKeys.matchesMnemonic(mnemonic)) return false;

    const config = getConfig();
    const dbPromise = getDbPromise();
    const wallets = useWallets();
    await wallets.isLoadedPromise;

    let hasAccountActivity = wallets.hasFunds === true || config.walletAccountsHadPreviousLife;
    if (!hasAccountActivity) {
      const db = await dbPromise;
      const [transactions, transfers] = await Promise.all([
        db.transactionsTable.fetchAll(),
        db.walletTransfersTable.fetchAll(),
      ]);
      hasAccountActivity = transactions.length > 0 || transfers.length > 0;
    }
    if (!hasAccountActivity) {
      await wallets.externalBalancesReady;
      if (wallets.hasFunds === undefined) {
        throw new Error('Could not check your existing account balances. Reload the app before replacing it.');
      }
      hasAccountActivity = wallets.hasFunds;
    }
    if (hasAccountActivity) {
      const hasConfirmedBackup = await confirm(
        'You have an existing account with account activity. If you replace it with the imported mnemonic, you will lose access and could permanently lose funds if its recovery mnemonic is not backed up. Please confirm you wish to proceed.',
        { title: 'Replace Account', kind: 'warning', okLabel: 'Backed up — Import Account', cancelLabel: 'Cancel' },
      );
      if (!hasConfirmedBackup) return false;
    }

    isImporting.value = true;
    const importer = new Importer(config as Config, walletKeys, dbPromise);
    try {
      return await importer.importFromMnemonic(mnemonic, { removeMnemonicFiles: hasAccountActivity });
    } finally {
      isImporting.value = false;
    }
  }

  async function initializeApplication(authentication?: EncryptionAuthentication): Promise<void> {
    isLoading.value = true;
    errorMessage.value = '';
    try {
      let config: Vue.Reactive<Config>;
      let defaultArgonWallet: IWalletRecord | undefined;
      try {
        if (await Importer.finishPendingImport()) {
          // Discard pre-import table caches before constructing any account services.
          window.location.reload();
          return;
        }
        config = getConfig();
        await config.load();
        const db = await getDbPromise();
        defaultArgonWallet = await db.walletsTable.getDefaultArgon();
      } catch (error) {
        // Discard partially initialized database/config state on the next retry.
        needsReload = true;
        throw error;
      }
      if (useRuntimeCompatibility().shouldShowCompatibilityScreen) return;
      const loaded = await initializeWalletKeys({
        authentication,
        defaultArgonWallet,
      });
      const walletKeys = loaded.walletKeys;

      const clients = getMainchainClients();
      const appStartup = Vue.reactive(new AppStartup(config as Config, walletKeys, clients));
      startup.value = appStartup;
      void appStartup.isReadyPromise.catch(() => undefined);
      SSH.setConfig(config as Config, walletKeys);

      const serverInstaller = Vue.reactive(
        new Installer(config as Config, walletKeys, {
          refreshPrunedClient: refreshPrunedClientFromConfig,
          isAppUpdateBlockingInstall: isAppUpdateBlockingServerInstall,
          publishOwnServer,
          publishOwnServerEndpoint,
          ensureMiningBidProxy: () => getMiningBidProxySetup().ensure(),
        }),
      );
      installer.value = serverInstaller;
      const serverBot = Vue.reactive(new Bot(config as Config, getDbPromise(), getServerApiClient()));
      bot.value = serverBot;
      isWalletReady.value = true;
      void waitForLoad().then(restoreTransactions);
      void appStartup.isReadyPromise
        .then(() => getEthereumOutboundTransferTracker())
        .catch(error => console.error('[Startup] Unable to start outbound Ethereum transfer tracking', error));
      await appStartup.initialize();

      void getCurrentWindow().onCloseRequested(async event => {
        if (!(await checkInstallerIfCloseAllowed())) {
          event.preventDefault();
          return;
        }
        if (!config.isLoaded) return;
        await config.save().catch(error => console.warn('Failed to save config on close', error));
      });

      let history = Promise.resolve();
      if (appStartup.needsWalletHistoryRecovery) {
        appStartup.isRecoveringHistory = true;
        appStartup.historyLoadPct = 0;
        try {
          // Only a missing own-server connection is a prerequisite for installer/bot startup.
          await appStartup.recoverOwnServerConnection();
          const recovery = new WalletRecovery(
            getMyVault(),
            walletKeys,
            getWalletsForArgon(),
            clients,
            getMiningFrames(),
          );
          history = appStartup.recoverPreviousWalletHistory(recovery);
        } catch (error) {
          history = Promise.reject(error);
        }
      }
      history = history
        .catch(error => {
          console.error('Unable to recover previous wallet history', error);
          void message(
            'Argon Desktop could not finish restoring this account history. The app will continue; use Find Missing Data in Troubleshooting to retry.',
            { title: 'Account Recovery Incomplete', kind: 'warning' },
          );
        })
        .finally(() => {
          appStartup.isRecoveringHistory = false;
        });

      const installation = serverInstaller.load().then(() => {
        if (!config.upstreamOperator?.encryptedBootstrapRecovery) return;
        void enrollUpstreamRecovery().catch(error =>
          console.warn('Unable to enroll upstream endpoint recovery during startup', error),
        );
      });
      void serverBot
        .load(serverInstaller as Installer, getMining(), getMiningFrames())
        .catch(handleFatalError.bind('getBot'));
      const completed = await Promise.allSettled([history.then(() => appStartup.recordLaunch()), installation]);
      const failure = completed.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));
      if (isWalletReady.value) needsReload = true;
      if (startupError instanceof WalletLoadError) errorMessage.value = startupError.message;
      else if (startupError instanceof AccountAuthenticationError)
        errorMessage.value = 'Your account is still locked. Try again to unlock it.';
      else errorMessage.value = 'Your account could not be opened. Please try again.';
      if (isWalletReady.value) void handleFatalError.call('appStartup', startupError);
      else console.error('[Startup] Unable to open account', startupError);
      throw startupError;
    } finally {
      if (authentication) delete authentication.passcode;
      isLoading.value = false;
      if (!isWalletReady.value) initialization = undefined;
    }
  }

  return {
    isWalletReady,
    isLoading,
    isImporting,
    errorMessage,
    startup,
    installer,
    bot,
    initialize,
    importFromMnemonic,
  };
});

export function getAppStartup(): Vue.Reactive<AppStartup> {
  const startup = useStartupStore().startup;
  if (!startup) throw new Error('App startup has not initialized.');
  return startup;
}

export function getInstaller(): Vue.Reactive<Installer> {
  const installer = useStartupStore().installer;
  if (!installer) throw new Error('Installer startup has not initialized.');
  return installer;
}

export function getBot(): Vue.Reactive<Bot> {
  const bot = useStartupStore().bot;
  if (!bot) throw new Error('Bot startup has not initialized.');
  return bot;
}

export async function recoverPreviousWalletHistory(): Promise<void> {
  const startup = getAppStartup();
  if (!startup.needsWalletHistoryRecovery) return;
  startup.isRecoveringHistory = true;
  startup.historyLoadPct = 0;
  try {
    await startup.recoverOwnServerConnection();
    const recovery = new WalletRecovery(
      getMyVault(),
      getWalletKeys(),
      getWalletsForArgon(),
      getMainchainClients(),
      getMiningFrames(),
    );
    await startup.recoverPreviousWalletHistory(recovery);
  } finally {
    startup.isRecoveringHistory = false;
  }
}

export async function checkInstallerIfCloseAllowed() {
  const installer = getInstaller();
  if (!installer.isRunning || installer.isRunningInBackground) return true;
  return confirm(
    'Are you sure you want to close the app? The install process will be aborted and might become corrupted.',
    { title: 'Confirm Exit', kind: 'warning', okLabel: 'Close', cancelLabel: 'Cancel' },
  );
}
