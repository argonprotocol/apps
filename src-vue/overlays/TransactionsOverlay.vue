<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" class="w-8/12" overflowScroll>
    <template #title>
      <div class="grow text-2xl font-bold">Transactions</div>
    </template>

    <div class="flex min-h-0 flex-col px-5 pb-5">
      <div v-if="isLoading" class="flex min-h-56 items-center justify-center text-sm font-semibold text-slate-500">
        Loading transactions...
      </div>

      <div v-else-if="!activities.length" class="flex min-h-56 items-center justify-center text-sm text-slate-500">
        Your wallet has no activity yet.
      </div>

      <div v-else class="min-h-0 max-h-[calc(100vh-10rem)] overflow-y-auto rounded-md border border-slate-300/80">
        <table class="w-full table-fixed text-left">
          <thead class="sticky top-0 z-10 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
            <tr>
              <th class="w-[30%] px-4 py-3">Activity</th>
              <th class="w-[20%] px-4 py-3 text-right">Amount</th>
              <th class="w-[18%] px-4 py-3">Status</th>
              <th class="w-[18%] px-4 py-3">Block</th>
              <th class="w-[14%] px-4 py-3">Source</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200/80 bg-white">
            <tr v-for="activity in activities" :key="activity.id" class="align-top hover:bg-slate-50">
              <td class="px-4 py-3">
                <div class="truncate text-sm font-bold text-slate-800">{{ activityTitle(activity) }}</div>
                <div v-if="activity.otherParty" class="mt-0.5 truncate text-xs text-slate-500">
                  {{ activity.amount && activity.amount < 0n ? 'To' : 'From' }} {{ activity.otherParty }}
                </div>
                <div v-else-if="activity.events.length" class="mt-0.5 truncate text-xs text-slate-500">
                  {{ eventSummary(activity) }}
                </div>
                <div v-else-if="activity.transaction" class="mt-0.5 truncate text-xs text-slate-500">
                  {{ activity.transaction.extrinsicType }}
                </div>
              </td>
              <td class="px-4 py-3 text-right">
                <div class="whitespace-nowrap text-sm font-bold" :class="amountClass(activity)">
                  {{ amountLabel(activity) }}
                </div>
                <div v-if="ledgerBalanceLabel(activity)" class="mt-0.5 whitespace-nowrap text-xs text-slate-500">
                  {{ ledgerBalanceLabel(activity) }}
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="text-sm font-semibold text-slate-700">{{ statusLabel(activity) }}</div>
                <div class="mt-0.5 text-xs text-slate-500">{{ dateLabel(activity) }}</div>
              </td>
              <td class="px-4 py-3">
                <div class="text-sm font-semibold text-slate-700">{{ blockLabel(activity) }}</div>
                <div v-if="activity.extrinsicIndex !== null" class="mt-0.5 text-xs text-slate-500">
                  Extrinsic {{ activity.extrinsicIndex }}
                </div>
              </td>
              <td class="px-4 py-3">
                <span class="inline-flex rounded border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600">
                  {{ sourceLabel(activity) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import { bigIntAbs } from '@argonprotocol/apps-core';
import OverlayBase from './OverlayBase.vue';
import { getCurrency } from '../stores/currency.ts';
import { getDbPromise } from '../stores/helpers/dbPromise.ts';
import { getWalletKeys, useWallets } from '../stores/wallets.ts';
import { useBasics } from '../stores/basics.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { IWalletActivityRecord, WalletActivity } from '../lib/WalletActivity.ts';
import basicEmitter from '../emitters/basicEmitter.ts';

dayjs.extend(utc);
dayjs.extend(relativeTime);

const currency = getCurrency();
const walletKeys = getWalletKeys();
const wallets = useWallets();
const basics = useBasics();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(true);
const activities = Vue.ref<IWalletActivityRecord[]>([]);
let unsubscribe: (() => void) | undefined;

async function loadActivity(): Promise<void> {
  isLoading.value = true;
  const db = await getDbPromise();
  activities.value = await new WalletActivity(db).fetchByWalletAddress(walletKeys.defaultArgonAddress);
  isLoading.value = false;
}

function closeOverlay(): void {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

async function openOverlay(): Promise<void> {
  isOpen.value = true;
  basics.overlayIsOpen = true;
  await loadActivity();
}

function activityTitle(activity: IWalletActivityRecord): string {
  switch (activity.activityType) {
    case 'transfer':
      return activity.amount && activity.amount < 0n ? 'Sent' : 'Received';
    case 'tokenGateway':
      return activity.amount && activity.amount < 0n ? 'Bridged Out' : 'Bridged In';
    case 'faucet':
      return 'Faucet';
    case 'vaultRevenue':
      return 'Vault Revenue';
    case 'fee':
      return 'Transaction Fee';
    case 'submittedTransaction':
      return 'Submitted Transaction';
    case 'balanceChange':
      return 'Balance Change';
    default:
      return 'Wallet Activity';
  }
}

function amountLabel(activity: IWalletActivityRecord): string {
  if (activity.amount !== undefined && activity.currency) {
    return formatTokenAmount(activity.amount, activity.currency);
  }

  const parts: string[] = [];
  if (activity.microgonChange !== undefined && activity.microgonChange !== 0n) {
    parts.push(formatTokenAmount(activity.microgonChange, 'argon'));
  }
  if (activity.micronotChange !== undefined && activity.micronotChange !== 0n) {
    parts.push(formatTokenAmount(activity.micronotChange, 'argonot'));
  }
  return parts.join(' / ') || 'Details';
}

function formatTokenAmount(amount: bigint, token: 'argon' | 'argonot'): string {
  const prefix = amount > 0n ? '+' : amount < 0n ? '-' : '';
  if (token === 'argon') {
    return `${prefix}${microgonToArgonNm(bigIntAbs(amount)).format('0,0.[000000]')} ARGN`;
  }
  return `${prefix}${micronotToArgonotNm(bigIntAbs(amount)).format('0,0.[000000]')} ARGNOT`;
}

function ledgerBalanceLabel(activity: IWalletActivityRecord): string {
  if (!activity.ledger) return '';
  const microgons = microgonToArgonNm(activity.ledger.availableMicrogons).format('0,0.[00]');
  const micronots = micronotToArgonotNm(activity.ledger.availableMicronots).format('0,0.[00]');
  return `${microgons} ARGN / ${micronots} ARGNOT`;
}

function amountClass(activity: IWalletActivityRecord): string {
  const amount = activity.amount ?? activity.microgonChange ?? activity.micronotChange;
  if (amount === undefined) return 'text-slate-600';
  if (amount > 0n) return 'text-emerald-700';
  if (amount < 0n) return 'text-rose-700';
  return 'text-slate-600';
}

function statusLabel(activity: IWalletActivityRecord): string {
  if (activity.transaction) {
    return activity.transaction.status;
  }
  return activity.isFinalized ? 'Finalized' : 'Pending';
}

function blockLabel(activity: IWalletActivityRecord): string {
  if (activity.blockNumber === undefined) {
    return 'Pending';
  }
  return activity.blockNumber.toLocaleString();
}

function sourceLabel(activity: IWalletActivityRecord): string {
  switch (activity.source) {
    case 'walletTransfer':
      return 'Transfer';
    case 'walletLedger':
      return 'Ledger';
    case 'submittedTransaction':
      return 'Local';
  }
}

function dateLabel(activity: IWalletActivityRecord): string {
  const date = activity.transfer?.createdAt ?? activity.ledger?.createdAt ?? activity.transaction?.submittedAtTime;
  if (!date) return '';
  return dayjs.utc(date).local().fromNow();
}

function eventSummary(activity: IWalletActivityRecord): string {
  return activity.events.map(event => `${event.pallet}.${event.method}`).join(', ');
}

Vue.onMounted(async () => {
  basicEmitter.on('openTransactionsOverlay', openOverlay);
  unsubscribe = wallets.on('balance-change', async (_entry, walletType) => {
    if (isOpen.value && walletType === 'defaultArgon') {
      await loadActivity();
    }
  });
});

Vue.onBeforeUnmount(() => {
  basicEmitter.off('openTransactionsOverlay', openOverlay);
  unsubscribe?.();
});
</script>
