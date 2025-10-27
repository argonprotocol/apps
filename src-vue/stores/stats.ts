import * as Vue from 'vue';
import { Stats } from '../lib/Stats';
import { getDbPromise } from './helpers/dbPromise';
import { useConfig, Config } from './config';
import handleFatalError from './helpers/handleFatalError.ts';

let stats: Vue.Reactive<Stats>;

export type { Stats };

export function useStats(): Vue.Reactive<Stats> {
  if (!stats) {
    console.log('Initializing stats');
    const dbPromise = getDbPromise();
    const config = useConfig();
    stats = Vue.reactive(new Stats(dbPromise, config as Config));
    stats.load().catch(handleFatalError.bind('useStats'));
  }

  return stats;
}
