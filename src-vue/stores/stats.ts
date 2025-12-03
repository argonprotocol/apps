import * as Vue from 'vue';
import { Stats } from '../lib/Stats';
import { getDbPromise } from './helpers/dbPromise';
import { Config, useConfig } from './config';
import handleFatalError from './helpers/handleFatalError.ts';
import { Currency, useCurrency } from './currency.ts';
import { getMiningFrames } from './mainchain.ts';

let stats: Vue.Reactive<Stats>;

export type { Stats };

export function useStats(): Vue.Reactive<Stats> {
  if (!stats) {
    console.log('Initializing stats');
    const dbPromise = getDbPromise();
    const config = useConfig();
    const currency = useCurrency();
    const miningFrames = getMiningFrames();
    stats = Vue.reactive(new Stats(dbPromise, config as Config, currency as Currency, miningFrames));
    stats.load().catch(handleFatalError.bind('useStats'));
  }

  return stats;
}
