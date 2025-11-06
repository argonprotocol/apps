import * as Vue from 'vue';
import { useConfig, type Config } from './config';
import Installer from '../lib/Installer';
import handleFatalError from './helpers/handleFatalError';
import { useWalletKeys } from './wallets.ts';

let installer: Vue.Reactive<Installer>;

export type { Installer };

export function useInstaller(): Vue.Reactive<Installer> {
  if (!installer) {
    console.log('Initializing installer');
    const config = useConfig();
    installer = Vue.reactive(new Installer(config as Config, useWalletKeys()));
    installer.load().catch(handleFatalError.bind('useInstaller'));
  }

  return installer;
}
