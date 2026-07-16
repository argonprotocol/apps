import { reactive, watch } from 'vue';
import { ArgonBonds } from '../lib/ArgonBonds.ts';
import { getConfig } from './config.ts';
import { getCurrency } from './currency.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import { getMiningFrames } from './mainchain.ts';
import { getTransactionTracker } from './transactions.ts';
import { getWalletKeys } from './wallets.ts';

let argonBonds: ArgonBonds;

export function getArgonBonds(): ArgonBonds {
  if (!argonBonds) {
    const config = getConfig();
    argonBonds = new ArgonBonds(
      getDbPromise(),
      config,
      getCurrency(),
      getMiningFrames(),
      getWalletKeys(),
      getTransactionTracker(),
    );
    argonBonds.data = reactive(argonBonds.data) as ArgonBonds['data'];
    watch(
      () => (config.isLoaded ? config.upstreamOperator?.vaultId : undefined),
      () => {
        if (!argonBonds.data.isLoaded) return;
        void argonBonds.refreshBondLots();
      },
    );
  }

  return argonBonds;
}
