import * as Vue from 'vue';
import { getDbPromise } from './helpers/dbPromise';
import handleFatalError from './helpers/handleFatalError';
import { Bot } from '../lib/Bot';
import { Config, useConfig } from './config';
import { Installer, useInstaller } from './installer';
import { getMiningFrames } from './mainchain.ts';

let bot: Vue.Reactive<Bot>;

export type { Bot };

export function useBot(): Vue.Reactive<Bot> {
  if (!bot) {
    console.log('Initializing bot');
    const config = useConfig();
    const dbPromise = getDbPromise();
    bot = Vue.reactive(new Bot(config as Config, dbPromise));
    const installer = useInstaller();
    const miningFrames = getMiningFrames();
    bot.load(installer as Installer, miningFrames).catch(handleFatalError.bind('useBot'));
  }

  return bot;
}
