import * as Vue from 'vue';
import { getConfig, type Config } from './config';
import Installer from '../lib/Installer';
import handleFatalError from './helpers/handleFatalError';
import { getWalletKeys } from './wallets.ts';

let installer: Vue.Reactive<Installer>;

export type { Installer };

export function getInstaller(): Vue.Reactive<Installer> {
  if (!installer) {
    console.log('Initializing installer');
    const config = getConfig();
    installer = Vue.reactive(new Installer(config as Config, getWalletKeys()));
    installer.load().catch(handleFatalError.bind('useInstaller'));
  }

  return installer;
}
