import * as Vue from 'vue';
import { Currency } from '../lib/Currency';
import handleFatalError from './helpers/handleFatalError';
import { getConfig, Config } from './config';
import { getMainchainClients } from './mainchain.ts';

let currency: Vue.Reactive<Currency>;

export type { Currency };

export function getCurrency(): Vue.Reactive<Currency> {
  if (!currency) {
    console.log('Initializing currency');
    const config = getConfig();
    const mainchainClients = getMainchainClients();
    currency = Vue.reactive(new Currency(mainchainClients, config as Config));
    currency.load().catch(handleFatalError.bind('useCurrency'));
  }

  return currency;
}
