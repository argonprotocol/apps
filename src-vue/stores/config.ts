import * as Vue from 'vue';
import { NETWORK_NAME } from '../lib/Env.ts';
import { Config } from '../lib/Config.ts';
import { getDbPromise } from './helpers/dbPromise';

type GlobalConfigState = typeof globalThis & {
  __argonConfig?: Vue.Reactive<Config>;
};

const globalConfigState = globalThis as GlobalConfigState;

// Preserve the singleton Config instance across Vite HMR reloads so dev hot updates
// do not trip Config's ensureOnlyOneInstance guard.
let config: Vue.Reactive<Config> | undefined = globalConfigState.__argonConfig ?? import.meta.hot?.data.config;
globalConfigState.__argonConfig = config;

if (import.meta.hot) {
  import.meta.hot.dispose(data => {
    data.config = config;
    globalConfigState.__argonConfig = config;
  });
}

export { NETWORK_NAME };
export { type Config };

export function getConfig(): Vue.Reactive<Config> {
  if (!config) {
    console.log('Initializing config');
    config = globalConfigState.__argonConfig = Vue.reactive(new Config(getDbPromise()));
  }

  return config;
}
