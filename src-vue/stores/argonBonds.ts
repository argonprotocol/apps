import { reactive, watch } from 'vue';
import { ArgonBonds } from '../lib/ArgonBonds.ts';
import { BondBuy } from '../lib/txs/Bond.buy.ts';
import { StakeBuy } from '../lib/txs/Stake.buy.ts';
import { BondLotRelease } from '../lib/txs/BondLot.release.ts';
import { getConfig } from './config.ts';
import { getCurrency } from './currency.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getMiningFrames } from './mainchain.ts';
import { getTransactionTracker } from './transactions.ts';
import { getWalletKeys } from './wallets.ts';

let argonBonds: ArgonBonds;
let bondLoadStarted = false;
let bondTransactionOperations: {
  bondBuy: BondBuy;
  stakeBuy: StakeBuy;
  bondLotRelease: BondLotRelease;
};

export function getArgonBonds(): ArgonBonds {
  if (!argonBonds) {
    const config = getConfig();
    argonBonds = new ArgonBonds(getDbPromise(), config, getCurrency(), getMiningFrames(), getWalletKeys());
    argonBonds.data = reactive(argonBonds.data) as ArgonBonds['data'];
    watch(
      () => (config.isLoaded ? config.upstreamOperator?.vaultId : undefined),
      () => {
        if (!argonBonds.data.isLoaded) return;
        void argonBonds.refreshBondLots();
      },
    );
  }
  if (!bondLoadStarted) {
    bondLoadStarted = true;
    void (async () => {
      let retryDelayMs = 1_000;
      while (!argonBonds.data.isLoaded) {
        try {
          await argonBonds.load();
        } catch (error) {
          console.warn('[ArgonBonds] Retrying current-state load', error);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        }
      }
    })();
  }

  return argonBonds;
}

export function getBondTransactionOperations() {
  if (!bondTransactionOperations) {
    const bonds = getArgonBonds();
    const keys = getWalletKeys();
    const tracker = getTransactionTracker();
    bondTransactionOperations = {
      bondBuy: new BondBuy(bonds, keys, tracker),
      stakeBuy: new StakeBuy(bonds, getCurrency(), keys, tracker),
      bondLotRelease: new BondLotRelease(bonds, keys, tracker),
    };
  }
  return bondTransactionOperations;
}
