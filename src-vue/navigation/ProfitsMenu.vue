<!-- prettier-ignore -->
<template>
  <div ref="rootRef">
    <NavigationMenuItem class="pointer-events-auto">
      <NavigationMenuTrigger
        Trigger
        class="flex h-[30px] cursor-pointer flex-row items-center justify-center rounded-md border border-slate-400/50 px-3.5 font-mono text-[17px] font-semibold text-argon-600/70 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10"
      >
        <div class="relative top-px -mr-0.5 ml-[3px] whitespace-nowrap">
          <template v-if="aggregate.accountReturn.percent === undefined">Returns</template>
          <template v-else>{{ formatPercent(aggregate.accountReturn.percent) }} RTD</template>
        </div>
      </NavigationMenuTrigger>

      <NavigationMenuContent
        class="absolute top-0 left-0 w-full text-slate-700/50 data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight sm:w-auto"
      >
        <ul class="bg-argon-menu-bg min-w-72 rounded p-1 text-sm text-gray-900 shadow-lg ring-1 ring-gray-900/20">
          <li class="flex items-center justify-between gap-6 px-3 py-2.5">
            <div>
              <div class="font-semibold text-slate-700">Account return</div>
              <div class="text-xs font-normal text-slate-500">
                <template v-if="aggregate.accountReturn.availability === 'not-applicable'">No positions yet</template>
                <template v-else-if="aggregate.accountReturn.availability === 'unavailable'">Not available yet</template>
                <template v-else-if="aggregate.accountReturn.availability === 'partial'">Partial</template>
                <template v-else>Return to date</template>
              </div>
            </div>
            <div class="font-mono text-lg font-bold text-argon-700/80">
              {{ formatPercent(aggregate.accountReturn.percent) }}
            </div>
          </li>

          <li divider class="my-1 h-px w-full bg-slate-400/30" />

          <li v-for="group in returnGroups" :key="group.group" class="flex items-center justify-between gap-6 px-3 py-2">
            <div>
              <div class="font-semibold text-slate-700">{{ financialMenuLabels[group.group] }}</div>
              <div
                v-if="group.isStale || group.returnSummary.availability !== 'available'"
                class="text-xs font-normal text-slate-500"
              >
                <template v-if="group.isStale">Stale</template>
                <template v-else-if="group.returnSummary.availability === 'partial'">Partial</template>
                <template v-else>Return unavailable</template>
              </div>
            </div>
            <div class="font-mono font-semibold text-slate-700">
              {{ formatPercent(group.returnSummary.percent) }}
            </div>
          </li>

          <li v-if="returnGroups.length === 0" class="px-3 py-4 text-center font-normal text-slate-500">
            No investment returns yet
          </li>

          <li
            v-if="
              historyRecovery.state === 'checking' ||
              historyRecovery.state === 'restoring' ||
              historyRecovery.state === 'waiting'
            "
            class="mt-1 border-t border-slate-400/30 px-3 py-2 text-xs font-normal text-slate-500"
          >
            History catching up
          </li>
          <li v-else-if="historyRecovery.state === 'error'" class="mt-1 border-t border-slate-400/30 px-3 py-2 text-xs">
            <button class="font-semibold text-argon-600 hover:text-argon-700" type="button" @click="financials.restoreFinancialHistory()">
              History incomplete · Retry
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
import numeral from '../lib/numeral.ts';
import { useFinancials } from '../stores/financials.ts';
import { financialMenuLabels } from './financialMenuLabels.ts';

const rootRef = Vue.ref<HTMLElement>();

defineExpose({
  $el: rootRef,
});

const financials = useFinancials();
const { financialPositionAggregate: aggregate, historyRecovery } = storeToRefs(financials);
const returnGroups = Vue.computed(() => {
  return aggregate.value.groups.filter(group => group.returnSummary.availability !== 'not-applicable');
});
function formatPercent(percent?: number): string {
  if (percent === undefined) return '--';
  return `${numeral(percent).format('0,0.[00]')}%`;
}
</script>
