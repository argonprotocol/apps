import { reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { StabilizerBuys } from '../lib/StabilizerBuys.ts';
import { StabilizerBuyBid } from '../lib/txs/StabilizerBuy.bid.ts';
import { StabilizerBuyPurchases } from '../lib/StabilizerBuyPurchases.ts';
import { StabilizerBuyAlerts } from '../lib/StabilizerBuyAlerts.ts';
import { getConfig } from './config.ts';
import { createEthereumClient } from './ethereum.ts';
import { getBlockWatch } from './mainchain.ts';
import { getTransactionTracker } from './transactions.ts';
import { getWalletKeys, getWalletsForEthereum } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise.ts';

let buys: StabilizerBuys;
let operations: { stabilizerBuyBid: StabilizerBuyBid };
let purchases: StabilizerBuyPurchases | undefined;
let alerts: StabilizerBuyAlerts | undefined;

export function getStabilizerBuys(): StabilizerBuys {
  if (!buys) {
    const walletKeys = getWalletKeys();
    buys = new StabilizerBuys(getBlockWatch(), walletKeys.defaultArgonAddress, getDbPromise());
    buys.data = reactive(buys.data) as StabilizerBuys['data'];
  }

  if (!purchases) {
    const walletKeys = getWalletKeys();
    const ethereumClient = createEthereumClient();
    if (ethereumClient) {
      purchases = new StabilizerBuyPurchases(buys, walletKeys, ethereumClient, getWalletsForEthereum());
      purchases.data = reactive(purchases.data) as StabilizerBuyPurchases['data'];
      void purchases.start();
    }
  }

  if (!alerts) {
    const config = getConfig();
    alerts = new StabilizerBuyAlerts(buys, getStabilizerBuyPurchases, getWalletsForEthereum(), config, getDbPromise());
    alerts.data = reactive(alerts.data) as StabilizerBuyAlerts['data'];
    alerts.start();
    watch(
      () => [config.stabilizerBuyAlert, buys.data.blockNumber],
      () => {
        void alerts?.refresh().catch(() => undefined);
      },
    );
  }

  void buys.start();
  return buys;
}

export function getStabilizerBuyPurchases(): StabilizerBuyPurchases | undefined {
  getStabilizerBuys();
  return purchases;
}

export function getStabilizerBuyOperations() {
  operations ??= { stabilizerBuyBid: new StabilizerBuyBid(getStabilizerBuys(), getTransactionTracker()) };
  return operations;
}

// Retain the destination while the page mounts; domain records remain authoritative.
export const useStabilizerBuyNavigation = defineStore('stabilizerBuyNavigation', () => {
  const admissionFrame = ref<number>();
  const buyId = ref<string>();
  const reviewBuy = ref(false);
  const noticeError = ref<string>();
  const noticeRequestId = ref(0);

  function cancelPendingNotice(): void {
    noticeRequestId.value++;
    noticeError.value = undefined;
  }

  return { admissionFrame, buyId, reviewBuy, noticeError, noticeRequestId, cancelPendingNotice };
});

export function getStabilizerBuyAlerts(): StabilizerBuyAlerts | undefined {
  getStabilizerBuys();
  return alerts;
}
