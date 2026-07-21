import * as Vue from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NETWORK_NAME } from '../lib/Env.ts';
import { Config } from '../lib/Config.ts';
import { getDbPromise } from './helpers/dbPromise';
import handleFatalError from './helpers/handleFatalError';
import { SSH } from '../lib/SSH';
import { getMyVault } from './vaults.ts';
import { getWalletsForArgon, getWalletKeys } from './wallets.ts';
import { WalletRecovery } from '../lib/WalletRecovery.ts';
import { getMainchainClients, getMiningFrames } from './mainchain.ts';

type GlobalConfigState = typeof globalThis & {
  __argonConfig?: Vue.Reactive<Config>;
};

const globalConfigState = globalThis as GlobalConfigState;

// Preserve the singleton Config instance across Vite HMR reloads so dev hot updates
// do not trip Config's ensureOnlyOneInstance guard.
let config: Vue.Reactive<Config> | undefined = globalConfigState.__argonConfig ?? import.meta.hot?.data.config;
globalConfigState.__argonConfig = config;

if (import.meta.hot) {
  import.meta.hot.dispose(data => {
    data.config = config;
    globalConfigState.__argonConfig = config;
  });
}

export { NETWORK_NAME };
export { type Config };

export async function recordPostWelcomeLaunch(loadedConfig: Config): Promise<void> {
  if (loadedConfig.showWelcomeOverlay) return;

  loadedConfig.postWelcomeLaunchCount += 1;
  await loadedConfig.save();
}

export function getConfig(): Vue.Reactive<Config> {
  if (!config) {
    console.log('Initializing config');
    const dbPromise = getDbPromise();
    const walletKeys = getWalletKeys();
    config = globalConfigState.__argonConfig = Vue.reactive(
      new Config(dbPromise, walletKeys, async onProgress => {
        const myVault = getMyVault();
        const clients = getMainchainClients();
        const walletsForArgon = getWalletsForArgon();
        const miningFrames = getMiningFrames();
        const walletRecover = new WalletRecovery(myVault, walletKeys, walletsForArgon, clients, miningFrames);
        return await walletRecover.findHistory(onProgress);
      }),
    );
    config
      .load()
      .then(async () => {
        await recordPostWelcomeLaunch(config as Config);

        // Ensure any unsaved changes are saved when the window is closed
        console.info('Config loaded');
        void getCurrentWindow().onCloseRequested(async () => {
          if (!config?.isLoaded) {
            return;
          }

          await config.save().catch(error => {
            console.warn('Failed to save config on close', error);
          });
        });
      })
      .catch(handleFatalError.bind('useConfig'));
  }

  // Config survives Vite HMR, but SSH's static state may not. Reconnect them whenever
  // a consumer retrieves the retained singleton.
  SSH.setConfig(config as Config);

  return config;
}
