import * as Vue from 'vue';
import { getDbPromise } from './helpers/dbPromise';
import handleFatalError from './helpers/handleFatalError';
import { Bot } from '../lib/Bot';
import { Config, getConfig } from './config';
import { Installer, getInstaller } from './installer';
import { getMiningFrames } from './mainchain.ts';

let bot: Vue.Reactive<Bot>;

export type { Bot };

export function getBot(): Vue.Reactive<Bot> {
  if (!bot) {
    console.log('Initializing bot');
    const config = getConfig();
    const dbPromise = getDbPromise();
    bot = Vue.reactive(new Bot(config as Config, dbPromise));
    const installer = getInstaller();
    const miningFrames = getMiningFrames();
    bot.load(installer as Installer, miningFrames).catch(handleFatalError.bind('useBot'));
  }

  return bot;
}
