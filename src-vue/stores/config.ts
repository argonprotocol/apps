import * as Vue from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NETWORK_NAME } from '../lib/Env.ts';
import { Config } from '../lib/Config.ts';
import { getDbPromise } from './helpers/dbPromise';
import handleFatalError from './helpers/handleFatalError';
import { SSH } from '../lib/SSH';
import { getMyVault } from './vaults.ts';
import { getWalletBalances, getWalletKeys } from './wallets.ts';
import { WalletRecovery } from '../lib/WalletRecovery.ts';
import { getMainchainClients, getMiningFrames } from './mainchain.ts';

let config: Vue.Reactive<Config>;

export { NETWORK_NAME };
export type { Config };

export function getConfig(): Vue.Reactive<Config> {
  if (!config) {
    console.log('Initializing config');
    const dbPromise = getDbPromise();
    const walletKeys = getWalletKeys();
    config = Vue.reactive(
      new Config(dbPromise, walletKeys, async onProgress => {
        const myVault = getMyVault();
        const clients = getMainchainClients();
        const walletBalances = getWalletBalances();
        const miningFrames = getMiningFrames();
        const walletRecover = new WalletRecovery(myVault, walletKeys, walletBalances, clients, miningFrames);
        return await walletRecover.findHistory(onProgress);
      }),
    );
    config
      .load()
      .then(() => {
        // Ensure any unsaved changes are saved when the window is closed
        console.info('Config loaded');
        void getCurrentWindow().onCloseRequested(async () => {
          await config.save();
        });
      })
      .catch(handleFatalError.bind('useConfig'));
    SSH.setConfig(config as Config);
  }

  return config;
}
