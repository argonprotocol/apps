<template>
  <PopoverRoot as="div" @update:open="onOpen">
    <PopoverTrigger :asChild="true">
      <slot>
        <span class="cursor-pointer text-argon-600/50 hover:text-argon-600">view sync details</span>
      </slot>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        as="div"
        :side="popoverSide"
        align="center"
        :sideOffset="10"
        :collisionPadding="24"
        :avoidCollisions="true"
        class="group relative z-[2002] w-[560px] rounded-lg border border-gray-300 bg-white text-left text-base shadow-lg"
      >
        <PopoverPanelArrow />
        <div class="px-5 pt-4 pb-3 text-slate-700">
          <h2 class="pb-4 text-2xl font-bold">Ethereum Sync Status</h2>

          <div class="grid grid-cols-[170px_1fr] gap-x-6 gap-y-3">
            <div class="text-gray-500">Mode</div>
            <div>
              <div class="font-semibold font-mono">
                {{ formatEthereumSyncStatus(ethereumSyncState?.mode, ethereumSyncState?.lastError) }}
              </div>
              <div v-if="ethereumSyncState?.mode === 'submitting'" class="pt-1 text-xs font-medium text-amber-700">
                Execution anchor and sync period values are the latest observed snapshot while the verifier transaction is still being checked.
              </div>
            </div>

            <div class="text-gray-500">Status Updated</div>
            <div class="font-light font-mono">
              <CountupClock as="span" :time="lastUpdatedAt" v-slot="{ hours, minutes, seconds, isNull }">
                <template v-if="hours">{{ hours }}h, </template>
                <template v-if="minutes || hours">{{ minutes }}m{{ !isNull && !hours ? ', ' : '' }}</template>
                <template v-if="!isNull && !hours">{{ seconds }}s ago</template>
                <template v-else-if="isNull">-- ----</template>
              </CountupClock>
            </div>

            <div class="text-gray-500">Last Submitted Tx</div>
            <div class="font-light font-mono break-all">
              <template v-if="ethereumSyncState?.lastSubmittedTxHash">{{ ethereumSyncState.lastSubmittedTxHash }}</template>
              <template v-else>--</template>
            </div>

            <div class="text-gray-500">Finalized Slot</div>
            <div class="font-light font-mono">{{ formatBigInt(ethereumSyncState?.latestFinalizedSlot) }}</div>

            <div class="text-gray-500">Sync Period</div>
            <div class="font-light font-mono">{{ formatBigInt(ethereumSyncState?.latestSyncCommitteeUpdatePeriod) }}</div>

            <div class="text-gray-500">Anchor Block</div>
            <div class="font-light font-mono">{{ formatBigInt(ethereumSyncState?.latestExecutionAnchorBlockNumber) }}</div>

            <div class="text-gray-500">Ethereum Block</div>
            <div class="font-light font-mono">{{ formatBigInt(ethereumSyncState?.latestEthereumBlockNumber) }}</div>

            <div class="text-gray-500">Execution Anchor Gap</div>
            <div class="font-light font-mono">{{ formatBigInt(executionBlockLag) }}</div>

            <div class="text-gray-500">Gateway Nonce Gap</div>
            <div class="font-light font-mono">{{ formatBigInt(ethereumSyncState?.gatewayActivityNonceGap) }}</div>

            <div class="text-gray-500">Last Error</div>
            <div class="font-light font-mono break-words">
              <template v-if="ethereumSyncState?.lastError">{{ ethereumSyncState.lastError }}</template>
              <template v-else>--</template>
            </div>
          </div>

          <div class="mt-5 flex items-center gap-2 border-t border-dashed border-slate-300 pt-3">
            <button
              @click="refreshState"
              :disabled="isRefreshing"
              class="rounded border border-argon-600/50 px-3 py-1 text-center text-argon-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <template v-if="isRefreshing">Refreshing…</template>
              <template v-else>Refresh</template>
            </button>
          </div>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import CountupClock from '../../components/CountupClock.vue';
import PopoverPanelArrow from '../../components/PopoverPanelArrow.vue';
import { getBot } from '../../stores/bot.ts';

const props = withDefaults(
  defineProps<{
    position?: 'left' | 'right' | 'top';
  }>(),
  {
    position: 'top',
  },
);

const bot = getBot();

const isRefreshing = Vue.ref(false);

const popoverSide = Vue.computed(() => {
  if (props.position === 'left') {
    return 'left';
  }

  return props.position === 'right' ? 'right' : 'top';
});

const ethereumSyncState = Vue.computed(() => {
  return bot.state?.ethereumSync;
});

const lastUpdatedAt = Vue.computed(() => {
  const value = ethereumSyncState.value?.lastUpdatedAt;
  return value ? dayjs(value) : null;
});

const executionBlockLag = Vue.computed(() => {
  const latestExecutionAnchorBlockNumber = ethereumSyncState.value?.latestExecutionAnchorBlockNumber;
  const latestEthereumBlockNumber = ethereumSyncState.value?.latestEthereumBlockNumber;
  if (latestExecutionAnchorBlockNumber === undefined || latestEthereumBlockNumber === undefined) {
    return;
  }

  return latestEthereumBlockNumber > latestExecutionAnchorBlockNumber
    ? latestEthereumBlockNumber - latestExecutionAnchorBlockNumber
    : 0n;
});

async function onOpen(open: boolean) {
  if (!open) {
    return;
  }

  await refreshState();
}

async function refreshState() {
  isRefreshing.value = true;

  try {
    await bot.refreshState();
  } finally {
    isRefreshing.value = false;
  }
}

function formatBigInt(value?: bigint) {
  return value === undefined ? '--' : value.toString();
}

function formatEthereumSyncStatus(mode?: string, lastError?: string) {
  switch (mode) {
    case 'needsBootstrap':
      return 'Waiting for one-time sudo bootstrap';
    case 'idle':
      return 'Idle and ready to sync';
    case 'submitting':
      return 'Submitting verifier maintenance transactions';
    case 'error':
      return lastError ? `Sync error: ${lastError}` : 'Sync error';
    case 'disabled':
      return 'Disabled';
    default:
      return 'Unknown';
  }
}
</script>
