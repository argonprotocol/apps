<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="flex flex-row items-center">
    <NavigationMenuItem class="pointer-events-auto">
      <NavigationMenuTrigger
        Trigger
        class="flex h-[30px] shrink-0 cursor-pointer flex-row items-center justify-center rounded-l-md border border-r-0 border-slate-400/50 px-3.5 font-mono text-[17px] font-semibold text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
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
        <ul class="bg-argon-menu-bg w-96 rounded p-1 text-md text-gray-900 shadow-lg ring-1 ring-gray-900/20">
          <li v-if="aggregate.readiness !== 'ready'" class="flex text-sm items-center justify-between gap-6 px-3 py-2.5">
            <div v-if="aggregate.isStale" class="font-normal text-slate-500">Updating</div>
            <div v-else-if="aggregate.readiness === 'loading'" class="font-normal text-slate-500">Loading</div>
            <div v-else-if="aggregate.readiness === 'partial'" class="font-normal text-slate-500">
              Some values unavailable
            </div>
            <div v-else-if="aggregate.readiness === 'error'" class="font-normal text-slate-500">Unavailable</div>
          </li>

          <li v-if="aggregate.readiness !== 'ready'" divider class="my-1 h-px w-full bg-slate-400/30" />

          <li
            v-for="(group, groupIndex) in visibleGroups"
            :key="group.group"
            :class="[
              group.group === 'bonds' ? '' : 'px-3 py-2',
              groupIndex < visibleGroups.length - 1 ? 'border-b border-slate-400/20' : '',
            ]"
          >
            <template v-if="group.group === 'ethereum'">
              <div
                class="flex items-start justify-between gap-6"
              >
                <div>
                  <div>
                    <div class="flex items-center font-semibold text-slate-700">
                      External Ethereum Wallets
                      <button
                        type="button"
                        class="ml-1 flex cursor-pointer items-center text-slate-500 hover:text-slate-700"
                        :aria-expanded="ethereumWalletsAreExpanded"
                        aria-label="Toggle individual Ethereum wallets"
                        @click.stop="ethereumWalletsAreExpanded = !ethereumWalletsAreExpanded"
                      >
                        (<MinusIcon v-if="ethereumWalletsAreExpanded" class="size-3" /><PlusIcon
                          v-else
                          class="size-3"
                        />)
                      </button>
                    </div>
                    <div
                      v-if="group.state !== 'ready' && group.state !== 'stale'"
                      class="text-sm font-normal text-slate-500 capitalize"
                    >
                      {{ group.state }}
                    </div>
                    <div v-else-if="group.isStale" class="text-sm font-normal text-slate-500">Stale</div>
                  </div>
                </div>
                <div class="font-mono font-semibold text-slate-700">
                  {{ group.state === 'ready' || (group.state === 'stale' && group.positions.length) ? `${currency.symbol}${formatValue(group.currentValue)}` : '--' }}
                </div>
              </div>
              <div v-if="ethereumWalletsAreExpanded" class="mt-1 ml-2 border-l border-slate-300/70 pl-2">
                <div v-if="ethereumWalletRows.length === 0" class="py-1 text-sm font-normal text-slate-500">
                  No Ethereum wallets connected
                </div>
                <div
                  v-for="entry in ethereumWalletRows"
                  :key="entry.record.id"
                  class="flex items-start justify-between gap-6 py-1"
                >
                  <div class="font-normal text-slate-600">{{ getEthereumWalletDisplayName(entry.record.name) }}</div>
                  <div class="font-mono font-normal text-slate-600">
                    {{ entry.isLoaded ? `${currency.symbol}${formatValue(entry.totalValue)}` : '--' }}
                  </div>
                </div>
              </div>
            </template>
            <template v-else-if="group.group === 'liquid'">
              <div class="flex items-start justify-between gap-6">
                <div>
                  <div class="flex items-center font-semibold text-slate-700">
                    Internal App Wallet
                    <button
                      type="button"
                      class="ml-1 flex cursor-pointer items-center text-slate-500 hover:text-slate-700"
                      :aria-expanded="internalWalletIsExpanded"
                      aria-label="Toggle Internal App Wallet tokens"
                      @click.stop="internalWalletIsExpanded = !internalWalletIsExpanded"
                    >
                      (<MinusIcon v-if="internalWalletIsExpanded" class="size-3" /><PlusIcon v-else class="size-3" />)
                    </button>
                  </div>
                  <div
                    v-if="group.state !== 'ready' && group.state !== 'stale'"
                    class="text-sm font-normal text-slate-500 capitalize"
                  >
                    {{ group.state }}
                  </div>
                  <div v-else-if="group.isStale" class="text-sm font-normal text-slate-500">Stale</div>
                </div>
                <div class="font-mono font-semibold text-slate-700">
                  {{ group.state === 'ready' || (group.state === 'stale' && group.positions.length) ? `${currency.symbol}${formatValue(group.currentValue)}` : '--' }}
                </div>
              </div>
              <div v-if="internalWalletIsExpanded" class="mt-1 ml-2 border-l border-slate-300/70 pl-2">
                <div
                  v-for="token in internalWalletTokenRows"
                  :key="token.symbol"
                  class="flex items-start justify-between gap-6 py-1"
                >
                  <div class="font-normal text-slate-600">{{ token.nativeAmount }} {{ token.symbol }}</div>
                  <div class="font-mono font-normal text-slate-600">
                    {{ currency.symbol }}{{ formatValue(token.value) }}
                  </div>
                </div>
              </div>
            </template>
            <template v-else-if="group.group === 'bonds'">
              <div
                v-for="bond in bondAssetRows"
                :key="bond.asset"
                class="border-b border-slate-400/20 px-3 py-2 last:border-b-0"
              >
                <div class="flex items-start justify-between gap-6">
                  <div>
                    <div class="flex items-center font-semibold text-slate-700">
                      {{ bond.label }}
                      <button
                        type="button"
                        class="ml-1 flex cursor-pointer items-center text-slate-500 hover:text-slate-700"
                        :aria-expanded="bond.expanded.value"
                        :aria-label="`Toggle ${bond.label} details`"
                        @click.stop="bond.expanded.value = !bond.expanded.value"
                      >
                        (<MinusIcon v-if="bond.expanded.value" class="size-3" /><PlusIcon v-else class="size-3" />)
                      </button>
                    </div>
                    <div
                      v-if="group.state !== 'ready' && group.state !== 'stale'"
                      class="text-sm font-normal text-slate-500 capitalize"
                    >
                      {{ group.state }}
                    </div>
                    <div v-else-if="group.isStale" class="text-sm font-normal text-slate-500">Stale</div>
                  </div>
                  <div class="font-mono font-semibold text-slate-700">
                    {{
                      group.state === 'ready' || group.state === 'stale'
                        ? `${currency.symbol}${formatValue(bond.currentValue)}`
                        : '--'
                    }}
                  </div>
                </div>
                <div
                  v-if="bond.expanded.value"
                  class="mt-1 ml-2 border-l border-slate-300/70 py-1 pl-2 text-sm font-normal text-slate-500"
                >
                  {{ bond.count }} {{ bond.count === 1 ? bond.singularLabel : bond.pluralLabel }}
                </div>
              </div>
            </template>
            <template v-else-if="group.group === 'bitcoin'">
              <div class="flex items-start justify-between gap-6">
                <div>
                  <div class="flex items-center font-semibold text-slate-700">
                    {{ financialMenuLabels[group.group] }}
                    <button
                      type="button"
                      class="ml-1 flex cursor-pointer items-center text-slate-500 hover:text-slate-700"
                      :aria-expanded="bitcoinLocksAreExpanded"
                      aria-label="Toggle Bitcoin lock details"
                      @click.stop="bitcoinLocksAreExpanded = !bitcoinLocksAreExpanded"
                    >
                      (<MinusIcon v-if="bitcoinLocksAreExpanded" class="size-3" /><PlusIcon v-else class="size-3" />)
                    </button>
                  </div>
                  <div
                    v-if="group.state !== 'ready' && group.state !== 'stale'"
                    class="text-sm font-normal text-slate-500 capitalize"
                  >
                    {{ group.state }}
                  </div>
                  <div v-else-if="group.isStale" class="text-sm font-normal text-slate-500">Stale</div>
                </div>
                <div class="font-mono font-semibold text-slate-700">
                  {{ group.state === 'ready' || (group.state === 'stale' && group.positions.length) ? `${currency.symbol}${formatValue(group.currentValue)}` : '--' }}
                </div>
              </div>
              <div v-if="bitcoinLocksAreExpanded" class="mt-1 ml-2 border-l border-slate-300/70 pl-2">
                <div class="flex items-center justify-between gap-6 py-1">
                  <div class="font-normal text-slate-600">Locked BTC</div>
                  <div class="font-mono font-normal text-slate-600">
                    {{ currency.symbol }}{{ formatValue(bitcoinPositionBreakdown.lockedBtc) }}
                  </div>
                </div>
                <div class="flex items-center justify-between gap-6 py-1">
                  <div class="font-normal text-slate-600">Debt</div>
                  <div class="font-mono font-normal text-slate-600">
                    {{ currency.symbol }}{{ formatValue(bitcoinPositionBreakdown.debt) }}
                  </div>
                </div>
              </div>
            </template>
            <div v-else class="flex items-start justify-between gap-6">
              <div>
              <div class="font-semibold text-slate-700">{{ financialMenuLabels[group.group] }}</div>
              <div v-if="group.state !== 'ready' && group.state !== 'stale'" class="text-sm font-normal text-slate-500 capitalize">
                {{ group.state }}
              </div>
              <div v-else-if="group.isStale" class="inline-flex items-center gap-1 text-sm font-normal text-slate-500">
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
              <div v-else-if="group.group === 'mining'" class="text-sm font-normal text-slate-500">
                <div>
                  Seats {{ currency.symbol }}{{ formatValue(miningPositionBreakdown.seats) }} · Bids {{ currency.symbol
                  }}{{ formatValue(miningPositionBreakdown.bids) }}
                </div>
                <div>
                  {{ microgonToArgonNm(miningPositionBreakdown.microgons).format('0,0.[00]') }} ARGN ·
                  {{ micronotToArgonotNm(miningPositionBreakdown.micronots).format('0,0.[00]') }} ARGNOT
                </div>
              </div>
              <div v-else-if="group.group === 'vaulting'" class="text-sm font-normal text-slate-500">
                <div>
                  {{ microgonToArgonNm(vaultPositionBreakdown.securitization).format('0,0.[00]') }} ARGN securitized
                </div>
                <div v-if="vaultPositionBreakdown.committedMicronots">
                  {{ micronotToArgonotNm(vaultPositionBreakdown.committedMicronots).format('0,0.[00]') }} ARGNOT staked
                </div>
              </div>
              <div v-else-if="group.grossLiabilities" class="text-sm font-normal text-slate-500">
                Assets {{ currency.symbol }}{{ formatValue(group.grossAssets) }} · Liabilities {{ currency.symbol
                }}{{ formatValue(group.grossLiabilities) }}
              </div>
              </div>
              <div class="font-mono font-semibold text-slate-700">
                {{ group.state === 'ready' || (group.state === 'stale' && group.positions.length) ? `${currency.symbol}${formatValue(group.currentValue)}` : '--' }}
              </div>
            </div>
          </li>

          <li
            v-if="visibleGroups.length === 0 && aggregate.readiness !== 'loading'"
            class="px-3 py-4 text-center font-normal text-slate-500"
          >
            No financial positions yet
          </li>

          <li class="mt-3 border-t border-slate-400/30 px-2 pt-2 pb-1">
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
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { storeToRefs } from 'pinia';
import { NavigationMenuContent, NavigationMenuItem, NavigationMenuTrigger } from 'reka-ui';
import { InformationCircleIcon, MinusIcon, PlusIcon } from '@heroicons/vue/20/solid';
import { getCurrency } from '../stores/currency.ts';
import { getConfig } from '../stores/config.ts';
import ArgonSign from '../assets/currencies/argon.svg?component';
import DollarSign from '../assets/currencies/dollar.svg?component';
import EuroSign from '../assets/currencies/euro.svg?component';
import PoundSign from '../assets/currencies/pound.svg?component';
import RupeeSign from '../assets/currencies/rupee.svg?component';
import basicEmitter from '../emitters/basicEmitter.ts';
import Tooltip from '../components/Tooltip.vue';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getEthereumWalletDisplayName, getWalletTotalValue } from '../lib/Wallet.ts';
import { useFinancials } from '../stores/financials.ts';
import { useWallets } from '../stores/wallets.ts';
import { financialMenuLabels } from './financialMenuLabels.ts';

const rootRef = Vue.ref<HTMLElement>();

defineExpose({
  $el: rootRef,
});

const currency = getCurrency();
const config = getConfig();
const financials = useFinancials();
const wallets = useWallets();
const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);
const ethereumWalletsAreExpanded = Vue.ref(false);
const internalWalletIsExpanded = Vue.ref(false);
const argonBondsAreExpanded = Vue.ref(false);
const argonotStakesAreExpanded = Vue.ref(false);
const bitcoinLocksAreExpanded = Vue.ref(false);
const {
  financialPositionAggregate: aggregate,
  liquidLockedRecords,
  liquidNativeBalances,
  bondSummariesByAsset,
} = storeToRefs(financials);
const bondAssetRows = Vue.computed(() => {
  const bondPositions = aggregate.value.groupSummaries.bonds.positions.filter(position => position.kind === 'bond');
  const positions = bondPositions.filter(position => position.lifecycle !== 'completed');

  return [
    {
      asset: 'ARGN',
      label: 'Argon Bonds',
      singularLabel: 'bond',
      pluralLabel: 'bonds',
      currentValue: bondSummariesByAsset.value.ARGN.currentValue,
      count: positions.filter(position => position.nativeAsset === 'ARGN').length,
      expanded: argonBondsAreExpanded,
    },
    {
      asset: 'ARGNOT',
      label: 'Argonot Stakes',
      singularLabel: 'stake',
      pluralLabel: 'stakes',
      currentValue: bondSummariesByAsset.value.ARGNOT.currentValue,
      count: positions.filter(position => position.nativeAsset === 'ARGNOT').length,
      expanded: argonotStakesAreExpanded,
    },
  ];
});

const visibleGroups = Vue.computed(() => {
  return aggregate.value.groups.filter(group => {
    if (group.state === 'loading') return false;
    if (group.group === 'base') return false;
    if (group.group === 'liquid') return true;
    if (group.group === 'ethereum') return true;
    if (config.hasExtensionTreasury && (group.group === 'bonds' || group.group === 'bitcoin')) return true;
    return group.state !== 'ready' || group.grossAssets !== 0n || group.grossLiabilities !== 0n;
  });
});
const ethereumWalletRows = Vue.computed(() => {
  return wallets.ethereumWallets.map(({ record, wallet }) => ({
    record,
    wallet,
    totalValue: getWalletTotalValue(wallet, currency),
    isLoaded: !!wallet.balanceUpdatedAt,
  }));
});
const internalWalletTokenRows = Vue.computed(() => [
  {
    symbol: 'ARGN',
    nativeAmount: microgonToArgonNm(liquidNativeBalances.value.microgons).format('0,0.[00]'),
    value: liquidNativeBalances.value.microgons,
  },
  {
    symbol: 'ARGNOT',
    nativeAmount: micronotToArgonotNm(liquidNativeBalances.value.micronots).format('0,0.[00]'),
    value: currency.convertMicronotTo(liquidNativeBalances.value.micronots, UnitOfMeasurement.Microgon),
  },
]);
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
