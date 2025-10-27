import * as Vue from 'vue';
import { getDbPromise } from './helpers/dbPromise';
import handleFatalError from './helpers/handleFatalError';
import { Bot } from '../lib/Bot';
import { useConfig, Config } from './config';
import { useInstaller, Installer } from './installer';

let bot: Vue.Reactive<Bot>;

export type { Bot };

export function useBot(): Vue.Reactive<Bot> {
  if (!bot) {
    console.log('Initializing bot');
    const config = useConfig();
    const installer = useInstaller();
    const dbPromise = getDbPromise();
    bot = Vue.reactive(new Bot(config as Config, dbPromise));
    bot.load(installer as Installer).catch(handleFatalError.bind('useBot'));
  }

  return bot;
}
