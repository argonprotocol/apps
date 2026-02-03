import * as Vue from 'vue';
import { Stats } from '../lib/Stats';
import { getDbPromise } from './helpers/dbPromise';
import { Config, getConfig } from './config';
import handleFatalError from './helpers/handleFatalError.ts';
import { Currency, getCurrency } from './currency.ts';
import { getMiningFrames } from './mainchain.ts';

let stats: Vue.Reactive<Stats>;

export type { Stats };

export function getStats(): Vue.Reactive<Stats> {
  if (!stats) {
    console.log('Initializing stats');
    const dbPromise = getDbPromise();
    const config = getConfig();
    const currency = getCurrency();
    const miningFrames = getMiningFrames();
    stats = Vue.reactive(new Stats(dbPromise, config as Config, currency as Currency, miningFrames));
    stats.load().catch(handleFatalError.bind('getStats'));
  }

  return stats;
}
