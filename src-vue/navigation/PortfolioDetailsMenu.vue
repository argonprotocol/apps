<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="flex flex-row items-center">
    <NavigationMenuItem class="pointer-events-auto">
      <NavigationMenuTrigger
        Trigger
        class="flex h-[30px] min-w-[120px] shrink-0 cursor-pointer flex-row items-center justify-center rounded-l-md border border-r-0 border-slate-400/50 px-3.5 font-mono text-[17px] font-semibold text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
      >
        <ArgonSign v-if="!currency?.record?.key || currency?.record?.key === 'ARGN'" class="relative top-0 h-[13px]" />
        <DollarSign v-else-if="currency?.record?.key === 'USD'" class="h-[15px]" />
        <EuroSign v-else-if="currency?.record?.key === 'EUR'" class="h-[15px]" />
        <PoundSign v-else-if="currency?.record?.key === 'GBP'" class="h-[15px]" />
        <RupeeSign v-else-if="currency?.record?.key === 'INR'" class="h-[15px]" />
        <div v-else class="h-[18px] w-[13px]" />
        <div class="relative top-px -mr-0.5 ml-[3px]">
          {{ totalNetWorth[0] }}.<span class="opacity-50">{{ totalNetWorth[1] }}</span>
        </div>
      </NavigationMenuTrigger>

      <NavigationMenuContent class="absolute top-0 left-0 w-full data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight sm:w-auto">
        <ul class="bg-argon-menu-bg w-96 rounded p-1 text-sm text-gray-900 shadow-lg ring-1 ring-gray-900/20">
          <li class="flex items-center justify-between gap-6 px-3 py-2.5">
            <div>
              <div class="font-semibold text-slate-700">Net worth</div>
              <div v-if="aggregate.isStale" class="text-xs font-normal text-slate-500">Updating</div>
              <div v-else-if="aggregate.readiness === 'loading'" class="text-xs font-normal text-slate-500">Loading</div>
              <div v-else-if="aggregate.readiness === 'partial'" class="text-xs font-normal text-slate-500">
                Some values unavailable
              </div>
              <div v-else-if="aggregate.readiness === 'error'" class="text-xs font-normal text-slate-500">Unavailable</div>
            </div>
            <div class="font-mono text-lg font-bold text-argon-700/80">{{ currency.symbol }}{{ formattedNetWorth }}</div>
          </li>

          <li divider class="my-1 h-px w-full bg-slate-400/30" />

          <li v-for="group in visibleGroups" :key="group.group" class="flex items-center justify-between gap-6 px-3 py-2">
            <div>
              <div class="font-semibold text-slate-700">{{ financialMenuLabels[group.group] }}</div>
              <div v-if="group.state !== 'ready' && group.state !== 'stale'" class="text-xs font-normal text-slate-500 capitalize">
                {{ group.state }}
              </div>
              <div v-else-if="group.isStale" class="inline-flex items-center gap-1 text-xs font-normal text-slate-500">
                Stale
                <Tooltip
                  as-child
                  :content="group.message ?? 'This position is waiting for newer finalized account data.'"
                >
                  <span class="cursor-help text-slate-400 hover:text-slate-600">
                    <InformationCircleIcon class="size-3.5" />
                  </span>
                </Tooltip>
              </div>
              <div v-else-if="group.group === 'liquid'" class="text-xs font-normal text-slate-500">
                {{ microgonToArgonNm(liquidNativeBalances.microgons).format('0,0.[00]') }} ARGN ·
                {{ micronotToArgonotNm(liquidNativeBalances.micronots).format('0,0.[00]') }} ARGNOT
              </div>
              <div v-else-if="group.group === 'ethereum'" class="text-xs font-normal text-slate-500">
                {{ ethereumAssetLabels.length ? ethereumAssetLabels.join(' · ') : 'No assets' }}
              </div>
              <div v-else-if="group.group === 'base'" class="text-xs font-normal text-slate-500">
                {{ baseAssetLabels.join(' · ') }}
              </div>
              <div v-else-if="group.group === 'mining'" class="text-xs font-normal text-slate-500">
                <div>
                  Seats {{ currency.symbol }}{{ formatValue(miningPositionBreakdown.seats) }} · Bids {{ currency.symbol
                  }}{{ formatValue(miningPositionBreakdown.bids) }}
                </div>
                <div>
                  {{ microgonToArgonNm(miningPositionBreakdown.microgons).format('0,0.[00]') }} ARGN ·
                  {{ micronotToArgonotNm(miningPositionBreakdown.micronots).format('0,0.[00]') }} ARGNOT
                </div>
              </div>
              <div v-else-if="group.group === 'vaulting'" class="text-xs font-normal text-slate-500">
                <div>
                  {{ microgonToArgonNm(vaultPositionBreakdown.securitization).format('0,0.[00]') }} ARGN securitized
                </div>
                <div v-if="vaultPositionBreakdown.committedMicronots">
                  {{ micronotToArgonotNm(vaultPositionBreakdown.committedMicronots).format('0,0.[00]') }} ARGNOT staked
                </div>
              </div>
              <div v-else-if="group.group === 'bitcoin'" class="text-xs font-normal text-slate-500">
                Locked BTC {{ currency.symbol }}{{ formatValue(bitcoinPositionBreakdown.lockedBtc) }}
                <template v-if="bitcoinPositionBreakdown.pendingMint">
                  + pending mint {{ currency.symbol }}{{ formatValue(bitcoinPositionBreakdown.pendingMint) }}
                </template>
                − debt {{ currency.symbol }}{{ formatValue(bitcoinPositionBreakdown.debt) }}
              </div>
              <div v-else-if="group.grossLiabilities" class="text-xs font-normal text-slate-500">
                Assets {{ currency.symbol }}{{ formatValue(group.grossAssets) }} · Liabilities {{ currency.symbol
                }}{{ formatValue(group.grossLiabilities) }}
              </div>
            </div>
            <div class="font-mono font-semibold text-slate-700">
              {{ group.state === 'ready' || (group.state === 'stale' && group.positions.length) ? `${currency.symbol}${formatValue(group.currentValue)}` : '--' }}
            </div>
          </li>

          <li
            v-if="visibleGroups.length === 0 && aggregate.readiness !== 'loading'"
            class="px-3 py-4 text-center font-normal text-slate-500"
          >
            No financial positions yet
          </li>

          <li class="mt-1 border-t border-slate-400/30 px-2 pt-2 pb-1">
            <button
              type="button"
              class="w-full cursor-pointer rounded-md border border-argon-600/50 px-3 py-2 font-semibold whitespace-nowrap text-argon-600/80 hover:bg-argon-600/70 hover:text-white"
              @click="openTransactionsOverlay"
            >
              View Transaction History
            </button>
          </li>
        </ul>
      </NavigationMenuContent>
    </NavigationMenuItem>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { storeToRefs } from 'pinia';
import { NavigationMenuContent, NavigationMenuItem, NavigationMenuTrigger } from 'reka-ui';
import { InformationCircleIcon } from '@heroicons/vue/20/solid';
import { getCurrency } from '../stores/currency.ts';
import ArgonSign from '../assets/currencies/argon.svg?component';
import DollarSign from '../assets/currencies/dollar.svg?component';
import EuroSign from '../assets/currencies/euro.svg?component';
import PoundSign from '../assets/currencies/pound.svg?component';
import RupeeSign from '../assets/currencies/rupee.svg?component';
import basicEmitter from '../emitters/basicEmitter.ts';
import Tooltip from '../components/Tooltip.vue';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { useFinancials } from '../stores/financials.ts';
import { useWallets } from '../stores/wallets.ts';
import { financialMenuLabels } from './financialMenuLabels.ts';

const rootRef = Vue.ref<HTMLElement>();

defineExpose({
  $el: rootRef,
});

const currency = getCurrency();
const financials = useFinancials();
const wallets = useWallets();
const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm, otherTokenNm } = createNumeralHelpers(currency);
const { financialPositionAggregate: aggregate, liquidLockedRecords, liquidNativeBalances } = storeToRefs(financials);

const visibleGroups = Vue.computed(() => {
  return aggregate.value.groups.filter(group => {
    if (group.state === 'loading') return false;
    if (group.group === 'ethereum') return !!wallets.ethereumWallet.address;
    if (group.group === 'base') return group.positions.some(position => position.lifecycle !== 'unavailable');
    return group.state !== 'ready' || group.grossAssets !== 0n || group.grossLiabilities !== 0n;
  });
});
const ethereumAssetLabels = Vue.computed(() => {
  const labels: string[] = [];
  const microgons = wallets.ethereumWallet.availableMicrogons + wallets.ethereumWallet.reservedMicrogons;
  const micronots = wallets.ethereumWallet.availableMicronots + wallets.ethereumWallet.reservedMicronots;

  if (microgons > 0n) labels.push(`${microgonToArgonNm(microgons).format('0,0.[00]')} ARGN`);
  if (micronots > 0n) labels.push(`${micronotToArgonotNm(micronots).format('0,0.[00]')} ARGNOT`);

  for (const token of wallets.ethereumWallet.otherTokens) {
    if (token.value <= 0n) continue;
    labels.push(`${otherTokenNm(token).format('0,0.[000000]')} ${token.symbol}`);
  }

  return labels;
});
const baseAssetLabels = Vue.computed(() => {
  return wallets.baseWallet.otherTokens
    .filter(token => token.value > 0n)
    .map(token => `${otherTokenNm(token).format('0,0.[000000]')} ${token.symbol}`);
});
const miningPositionBreakdown = Vue.computed(() => {
  const mining = aggregate.value.groupSummaries.mining;

  return mining.positions.reduce(
    (total, position) => {
      if (position.kind === 'mining-cohort') {
        total.seats += position.currentValue ?? 0n;
      } else if (position.kind === 'mining-bid') {
        total.bids += position.currentValue ?? 0n;
      } else if (position.kind === 'mining-balance') {
        if (position.asset === 'ARGN') total.microgons += position.amount;
        else total.micronots += position.amount;
      } else if (position.kind === 'mining-argonot' && position.lifecycle !== 'completed') {
        total.micronots += position.micronots;
      }
      return total;
    },
    { seats: 0n, bids: 0n, microgons: 0n, micronots: 0n },
  );
});
const vaultPositionBreakdown = Vue.computed(() => {
  return aggregate.value.groupSummaries.vaulting.positions.reduce(
    (total, position) => {
      if (position.kind === 'vault') total.securitization += position.securitization;
      if (position.kind === 'vault-balance') total.committedMicronots += position.amount;
      return total;
    },
    { securitization: 0n, committedMicronots: 0n },
  );
});
const bitcoinPositionBreakdown = Vue.computed(() => {
  return liquidLockedRecords.value.reduce(
    (total, lock) => {
      total.lockedBtc += lock.valueOfBtc;
      total.pendingMint += lock.pendingLiquidity;
      total.debt += lock.unlockAmount;
      return total;
    },
    { lockedBtc: 0n, pendingMint: 0n, debt: 0n },
  );
});
const formattedNetWorth = Vue.computed(() => {
  if (!currency.isLoaded || aggregate.value.netWorth === undefined) return '--';
  return formatValue(aggregate.value.netWorth);
});
const totalNetWorth = Vue.computed(() => {
  if (formattedNetWorth.value === '--') return ['--', '--'];
  return formattedNetWorth.value.split('.');
});

function formatValue(value: bigint): string {
  return microgonToMoneyNm(value).format('0,0.00');
}

function openTransactionsOverlay(): void {
  basicEmitter.emit('openTransactionsOverlay');
}
</script>
