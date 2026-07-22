<!-- prettier-ignore -->
<template>
  <div ref="rootRef">
    <NavigationMenuItem class="pointer-events-auto">
      <NavigationMenuTrigger
        Trigger
        class="flex h-[30px] cursor-pointer flex-row items-center justify-center rounded-md border border-slate-400/50 px-3.5 font-mono text-[17px] font-semibold text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
      >
        <div class="relative top-px -mr-0.5 ml-[3px] whitespace-nowrap">
          <template v-if="aggregate.accountReturn.percent === undefined">0.00% RTD</template>
          <template v-else>{{ formatPercent(aggregate.accountReturn.percent) }} RTD</template>
        </div>
      </NavigationMenuTrigger>

      <NavigationMenuContent
        class="absolute top-0 left-0 w-full text-slate-700/50 data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight sm:w-auto"
      >
        <ul class="bg-argon-menu-bg min-w-72 rounded p-1 text-sm text-gray-900 shadow-lg ring-1 ring-gray-900/20">
          <li class="flex items-center justify-between gap-6 px-3 py-2.5">
            <div>
              <div class="font-semibold text-slate-700">Return on Capital</div>
              <div class="text-xs font-normal text-slate-500">
                <template v-if="aggregate.accountReturn.availability === 'not-applicable'">No positions yet</template>
                <template v-else-if="aggregate.accountReturn.availability === 'unavailable'">Not available yet</template>
                <span v-else-if="aggregate.accountReturn.availability === 'partial'" class="inline-flex items-center gap-1">
                  Partial
                  <Tooltip
                    as-child
                    content="This percentage includes only positions with known cost basis and history."
                  >
                    <span class="cursor-help text-slate-400 hover:text-slate-600">
                      <InformationCircleIcon class="size-3.5" />
                    </span>
                  </Tooltip>
                </span>
                <span v-else class="inline-flex items-center gap-1">
                  Return to date
                  <Tooltip
                    as-child
                    content="A capital-weighted measure of returns on capital deployed to network assets. Undeployed wallet balances are excluded."
                  >
                    <span class="cursor-help text-slate-400 hover:text-slate-600">
                      <InformationCircleIcon class="size-3.5" />
                    </span>
                  </Tooltip>
                </span>
              </div>
            </div>
            <div class="font-mono text-lg font-bold text-argon-700/80">
              {{ formatPercent(aggregate.accountReturn.percent) }}
            </div>
          </li>

          <li divider class="my-1 h-px w-full bg-slate-400/30" />

          <li v-for="group in returnRows" :key="group.key" class="px-3 py-2">
            <div class="flex items-start justify-between gap-6">
              <div>
                <div class="font-semibold text-slate-700">
                  {{ group.label }}
                </div>
                <div
                  v-if="group.isStale || group.returnSummary.availability !== 'available'"
                  class="text-xs font-normal text-slate-500"
                >
                  <span v-if="group.isStale" class="inline-flex items-center gap-1">
                    Stale
                    <Tooltip
                      as-child
                      :content="group.message ?? 'This position is waiting for newer finalized account data.'"
                    >
                      <span class="cursor-help text-slate-400 hover:text-slate-600">
                        <InformationCircleIcon class="size-3.5" />
                      </span>
                    </Tooltip>
                  </span>
                  <span
                    v-else-if="group.returnSummary.availability === 'partial'"
                    class="inline-flex items-center gap-1"
                  >
                    Partial
                    <Tooltip
                      as-child
                      content="This percentage includes only positions with known cost basis and history."
                    >
                      <span class="cursor-help text-slate-400 hover:text-slate-600">
                        <InformationCircleIcon class="size-3.5" />
                      </span>
                    </Tooltip>
                  </span>
                  <template v-else>Return unavailable</template>
                </div>
              </div>
              <div class="font-mono font-semibold text-slate-700">
                {{ formatPercent(group.returnSummary.percent) }}
              </div>
            </div>
          </li>

          <li v-if="returnRows.length === 0" class="px-3 py-4 text-center font-normal text-slate-500">
            No investment returns yet
          </li>

          <li
            v-if="historyRecovery.state === 'error'"
            class="mt-1 border-t border-slate-400/30 px-3 py-2 text-xs"
          >
            <button class="font-semibold text-argon-600 hover:text-argon-700" type="button" @click="financials.restoreFinancialHistory()">
              History incomplete · Retry
            </button>
          </li>
          <li
            v-else-if="
              historyRecovery.state === 'checking' ||
              historyRecovery.state === 'restoring' ||
              historyRecovery.state === 'waiting'
            "
            class="mt-1 border-t border-slate-400/30 px-3 py-2 text-xs font-normal text-slate-500"
          >
            History catching up
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
import numeral from '../lib/numeral.ts';
import Tooltip from '../components/Tooltip.vue';
import { useFinancials } from '../stores/financials.ts';
import { getConfig } from '../stores/config.ts';
import { bondAssetMenuItems, financialMenuLabels } from './financialMenuLabels.ts';

const rootRef = Vue.ref<HTMLElement>();

defineExpose({
  $el: rootRef,
});

const financials = useFinancials();
const config = getConfig();
const { financialPositionAggregate: aggregate, historyRecovery, bondSummariesByAsset } = storeToRefs(financials);
const returnRows = Vue.computed(() => {
  if (!config.isLoaded) return [];

  return aggregate.value.groups.flatMap(group => {
    if (group.returnSummary.investmentPositionCount === 0) return [];
    if ((group.group === 'mining' || group.group === 'vaulting') && !config.hasExtensionOperations) return [];
    if (group.group === 'ethereum' && !config.hasActivatedStableSwaps) return [];
    if (!['mining', 'vaulting', 'ethereum'].includes(group.group) && !config.hasExtensionTreasury) return [];

    if (group.group === 'bonds') {
      return bondAssetMenuItems.flatMap(({ asset, label }) => {
        const returnSummary = bondSummariesByAsset.value[asset].returnSummary;
        if (!returnSummary.investmentPositionCount) return [];
        return [{ ...group, key: `bonds-${asset}`, label: `${label} Bonds`, returnSummary }];
      });
    }

    const label = group.group === 'ethereum' ? 'Stable swaps' : financialMenuLabels[group.group];
    return [{ ...group, key: group.group, label }];
  });
});

function formatPercent(percent?: number): string {
  if (percent === undefined) return '--';
  return `${numeral(percent).format('0,0.00')}%`;
}
</script>
