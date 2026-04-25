import * as Vue from 'vue';
import { getDbPromise } from './helpers/dbPromise';
import handleFatalError from './helpers/handleFatalError';
import { Bot } from '../lib/Bot';
import { Config, getConfig } from './config';
import { Installer, getInstaller } from './installer';
import { getMining, getMiningFrames } from './mainchain.ts';
import { getServerApiClient } from './server.ts';

let bot: Vue.Reactive<Bot>;

export { type Bot };

export function getBot(): Vue.Reactive<Bot> {
  if (!bot) {
    console.log('Initializing bot');
    const config = getConfig();
    const dbPromise = getDbPromise();
    const serverApiClient = getServerApiClient();

    bot = Vue.reactive(new Bot(config as Config, dbPromise, serverApiClient));

    const installer = getInstaller();
    const mining = getMining();
    const miningFrames = getMiningFrames();

    bot.load(installer as Installer, mining, miningFrames).catch(handleFatalError.bind('getBot'));
  }

  return bot;
}
