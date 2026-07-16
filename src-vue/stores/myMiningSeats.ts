import * as Vue from 'vue';
import { MyMiningSeats } from '../lib/MyMiningSeats';
import { getDbPromise } from './helpers/dbPromise';
import { Config, getConfig } from './config';
import handleFatalError from './helpers/handleFatalError.ts';
import { Currency, getCurrency } from './currency.ts';
import { getMiningFrames } from './mainchain.ts';

let myMiningSeats: Vue.Reactive<MyMiningSeats>;

export { type MyMiningSeats };

export function getMyMiningSeats(): Vue.Reactive<MyMiningSeats> {
  if (!myMiningSeats) {
    console.log('Initializing my mining seats');
    const dbPromise = getDbPromise();
    const config = getConfig();
    const currency = getCurrency();
    const miningFrames = getMiningFrames();
    myMiningSeats = Vue.reactive(new MyMiningSeats(dbPromise, config as Config, currency, miningFrames));
  }
  if (!myMiningSeats.isLoaded) {
    void myMiningSeats.load().catch(handleFatalError.bind('getMyMiningSeats'));
  }

  return myMiningSeats;
}
