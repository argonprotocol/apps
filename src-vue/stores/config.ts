import * as Vue from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NETWORK_NAME } from '../lib/Env.ts';
import { Config } from '../lib/Config.ts';
import { getDbPromise } from './helpers/dbPromise';
import handleFatalError from './helpers/handleFatalError';
import { SSH } from '../lib/SSH';
import { useMyVault } from './vaults.ts';
import { useWalletBalances, useWalletKeys } from './wallets.ts';
import { WalletRecovery } from '../lib/WalletRecovery.ts';
import { getMainchainClients } from './mainchain.ts';

let config: Vue.Reactive<Config>;

export { NETWORK_NAME };
export type { Config };

export function useConfig(): Vue.Reactive<Config> {
  if (!config) {
    console.log('Initializing config');
    const dbPromise = getDbPromise();
    config = Vue.reactive(
      new Config(dbPromise, useWalletKeys(), async onProgress => {
        const myVault = useMyVault();
        const clients = getMainchainClients();
        const walletKeys = useWalletKeys();
        const walletBalances = useWalletBalances();
        const walletRecover = new WalletRecovery(myVault, walletKeys, walletBalances, clients);
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
