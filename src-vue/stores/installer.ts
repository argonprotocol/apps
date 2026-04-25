import * as Vue from 'vue';
import { getConfig, type Config } from './config';
import Installer from '../lib/Installer';
import handleFatalError from './helpers/handleFatalError';
import { getWalletKeys } from './wallets.ts';
import { CloseRequestedEvent } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { refreshPrunedClientFromConfig } from './mainchain.ts';

let installer: Vue.Reactive<Installer>;

export { type Installer };

export function getInstaller(): Vue.Reactive<Installer> {
  if (!installer) {
    console.log('Initializing installer');
    const config = getConfig();
    installer = Vue.reactive(
      new Installer(config as Config, getWalletKeys(), {
        refreshPrunedClient: refreshPrunedClientFromConfig,
      }),
    );
    installer.load().catch(handleFatalError.bind('useInstaller'));
  }

  return installer;
}

export async function checkInstallerIfCloseAllowed() {
  const installer = getInstaller();
  if (!installer.isRunning || installer.isRunningInBackground) {
    return true;
  }
  return await confirm(
    'Are you sure you want to close the app? The install process will be aborted and might become corrupted.',
    {
      title: 'Confirm Exit',
      kind: 'warning',
      okLabel: 'Close',
      cancelLabel: 'Cancel',
    },
  );
}
