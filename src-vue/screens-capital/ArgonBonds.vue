<!-- prettier-ignore -->
<template>
  <div class="flex h-full flex-col px-4 py-4 gap-4">
    <header class="flex flex-row items-center justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-800/70">Argon Bonds</h2>
        <div v-if="isLoaded && vaultTotalCapacity > 0n" class="mt-0.5 text-sm text-slate-400">
          <span class="font-medium text-slate-600">{{ currency.symbol }}{{ microgonToMoneyNm(vaultAvailableCapacity).format('0,0.00') }}</span>
          available of
          <span>{{ currency.symbol }}{{ microgonToMoneyNm(vaultTotalCapacity).format('0,0.00') }}</span>
          vault capacity
        </div>
      </div>
      <button
        v-if="hasBond"
        @click="showOverlay = true"
        class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-5 py-2 text-base font-bold text-white">
        Adjust Bonds
      </button>
    </header>

    <div v-if="!isLoaded" class="flex grow items-center justify-center text-slate-500">
      Loading…
    </div>

    <template v-else>
      <!-- Pending return banner -->
      <div
        v-if="hasPendingReturn"
        class="rounded-lg border border-amber-200 bg-amber-50 px-5 py-3 flex flex-row items-center gap-3">
        <div class="text-sm text-amber-700">
          <span class="font-semibold">{{ currency.symbol }}{{ microgonToMoneyNm(pendingReturnAmount).format('0,0.00') }}</span>
          is being returned to your wallet
          <template v-if="bondsReturnedDate">
            by
            <CountdownClock :time="bondsReturnedDate" v-slot="{ hours, minutes, seconds, days }">
              in
              <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
              <template v-else-if="hours > 0">
                <span>{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                <span v-if="minutes > 0"> {{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
              </template>
              <span v-else-if="minutes > 0">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
              <span v-else>{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>
            </CountdownClock>
          </template>
        </div>
      </div>

      <!-- Active bond stats -->
      <div v-if="hasBond" class="rounded-lg border border-slate-300/50 bg-white px-6 py-4 shadow-sm">
        <div class="flex flex-row gap-8 items-stretch">
          <div class="shrink-0">
            <div class="text-xs font-medium uppercase tracking-wide text-slate-400">Bonds Held</div>
            <div class="mt-1 text-3xl font-bold text-argon-text-primary font-mono">
              {{ currency.symbol }}{{ microgonToMoneyNm(funderState!.heldPrincipal).format('0,0.00') }}
            </div>
          </div>

          <div class="w-px bg-slate-100 self-stretch"></div>

          <div class="shrink-0">
            <div class="text-xs font-medium uppercase tracking-wide text-slate-400">Est. APY</div>
            <div class="mt-1 text-2xl font-bold text-slate-700 font-mono">
              {{ numeral(estimatedApy).formatIfElseCapped('< 100', '0,0.[00]', '0,0', 9_999) }}%
            </div>
          </div>
        </div>
      </div>

      <!-- Blank state -->
      <div
        v-else
        class="flex grow flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-argon-300/60 bg-argon-20/40">
        <div class="text-center">
          <div class="text-base font-medium text-argon-text-primary">No active bond</div>
          <div class="mt-1 text-sm text-slate-400">Buy bonds to earn treasury yield from Vault #{{ bonds.vaultId }}</div>
        </div>
        <button
          @click="showOverlay = true"
          class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-6 py-2.5 text-base font-bold text-white">
          Buy Bonds
        </button>
      </div>

      <!-- Bond history table -->
      <div v-if="frameHistory.length > 0" class="text-xs font-semibold uppercase tracking-wide text-slate-400 px-1 -mb-2">{{ showAllHistory ? 'All History' : 'Last 10 Days' }}</div>
      <div v-if="frameHistory.length > 0" class="flex flex-col overflow-hidden rounded-lg border border-slate-300/50 bg-white shadow-sm">
        <div class="grid grid-cols-3 border-b border-slate-100 px-6 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <div>Date</div>
          <div>Bonds</div>
          <div>Earnings</div>
        </div>
        <TransitionGroup tag="div" name="frame-row" class="overflow-y-auto">
          <div
            v-for="row in visibleHistory"
            :key="row.frameId"
            class="grid grid-cols-3 border-b border-slate-50 px-6 py-3 last:border-0 hover:bg-slate-50/60">
            <div class="text-sm text-slate-500" :title="`Frame #${row.frameId}`">{{ formatDate(row.date) }}</div>
            <div class="font-mono text-sm font-medium text-slate-800">
              {{ currency.symbol }}{{ microgonToMoneyNm(row.balance).format('0,0.00') }}
            </div>
            <div class="font-mono text-sm font-medium text-slate-700 flex items-center gap-2">
              <template v-if="row.frameId === miningFrames.currentFrameId">
                +{{ currency.symbol }}{{ microgonToMoneyNm(projectedFrameEarnings > 0n ? projectedFrameEarnings : row.earnings).format('0,0.00') }}
                <Tooltip :asChild="true" :content="`Projected earnings from bid pool (${Math.round(frameProgressPct)}% of mining auction complete)`">
                  <svg viewBox="0 0 36 36" class="h-5 w-5 shrink-0 -rotate-90 cursor-help">
                    <circle cx="18" cy="18" r="15" pathLength="100" fill="none" stroke-width="3" class="stroke-slate-200" />
                    <circle cx="18" cy="18" r="15" pathLength="100"
                      :stroke-dasharray="`${frameProgressPct} 100`"
                      fill="none" stroke="currentColor" stroke-width="6" class="text-argon-600" />
                  </svg>
                </Tooltip>
              </template>
              <template v-else>
                +{{ currency.symbol }}{{ microgonToMoneyNm(row.earnings).format('0,0.00') }}
              </template>
            </div>
          </div>
        </TransitionGroup>
        <div
          v-if="frameHistory.length > 10 && !showAllHistory"
          class="border-t border-slate-100 px-6 py-2 text-center">
          <button
            @click="showAllHistory = true"
            class="text-sm text-argon-600 hover:text-argon-700 cursor-pointer">
            Show more
          </button>
        </div>
      </div>
    </template>

    <AdjustBondOverlay
      v-if="showOverlay"
      :vaultId="bonds.vaultId"
      :currentAmount="funderState?.heldPrincipal ?? 0n"
      :walletBalance="walletBalance"
      :availableVaultSpace="vaultAvailableCapacity"
      @close="showOverlay = false"
      @submitted="onSubmitted"
    />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { getVaults } from '../stores/vaults.ts';
import { useWallets } from '../stores/wallets.ts';
import { getMainchainClient, getMiningFrames } from '../stores/mainchain.ts';
import { getConfig } from '../stores/config.ts';
import { NetworkConfig, TreasuryPool } from '@argonprotocol/apps-core';
import { type IFrameEarningsRow, useBonds } from '../stores/bonds.ts';
import AdjustBondOverlay from '../overlays-operations/AdjustBondOverlay.vue';
import CountdownClock from '../components/CountdownClock.vue';
import Tooltip from '../components/Tooltip.vue';
import { TICK_MILLIS } from '../lib/Env.ts';

dayjs.extend(utc);

interface IFrameRow extends IFrameEarningsRow {
  date: Date;
}

const currency = getCurrency();
const vaults = getVaults();
const wallets = useWallets();
const miningFrames = getMiningFrames();
const config = getConfig();
const bonds = useBonds();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);
const showOverlay = Vue.ref(false);
const showAllHistory = Vue.ref(false);
const funderState = Vue.computed(() => bonds.funderState);
const vaultTotalCapacity = Vue.ref(0n);
const distributableBidPool = Vue.ref(0n);
const globalActiveCapital = Vue.ref(0n);
const vaultActiveCapital = Vue.ref(0n);

const hasBond = Vue.computed(() => bonds.heldPrincipal > 0n);

const vaultAvailableCapacity = Vue.computed(() => {
  const perFrameCapacity = vaultTotalCapacity.value / 10n;
  const available = perFrameCapacity - vaultActiveCapital.value;
  return available > 0n ? available : 0n;
});

const frameHistory = Vue.computed<IFrameRow[]>(() => {
  return bonds.frameHistory
    .filter(row => row.frameId > 0)
    .map(row => {
      let date: Date;
      if (miningFrames.framesById[row.frameId]) {
        date = miningFrames.getFrameDate(row.frameId);
      } else {
        const frameDiff = miningFrames.currentFrameId - row.frameId;
        date = new Date(Date.now() - frameDiff * TICK_MILLIS);
      }
      return { ...row, date };
    });
});

const walletBalance = Vue.computed(() => wallets.liquidLockingWallet.availableMicrogons);

const hasPendingReturn = Vue.computed(() => bonds.funderState?.hasPendingReturn ?? false);

const pendingReturnAmount = Vue.computed(() => bonds.funderState?.pendingReturnAmount ?? 0n);

const bondsReturnedDate = Vue.computed(() => {
  const pendingReturnAtFrame = bonds.funderState?.pendingReturnAtFrame;
  if (pendingReturnAtFrame == null) return null;
  return dayjs.utc(miningFrames.getFrameDate(pendingReturnAtFrame));
});

const estimatedApy = bonds.estimatedApy;

const progressTick = Vue.ref(0);
const frameProgressPct = Vue.computed(() => {
  void progressTick.value; // reactive dependency on tick updates
  const ticksPerFrame = NetworkConfig.rewardTicksPerFrame;
  const elapsed = ticksPerFrame - miningFrames.getFrameRewardTicksRemaining();
  return Math.min((elapsed / ticksPerFrame) * 100, 100);
});

const currentFrameRow = Vue.computed(() => {
  return frameHistory.value.find(r => r.frameId === miningFrames.currentFrameId);
});

const projectedFrameEarnings = Vue.computed(() => {
  const row = currentFrameRow.value;
  if (!row || row.balance <= 0n) return 0n;
  return TreasuryPool.projectedFrameEarnings({
    funderBondedAmount: row.balance,
    vaultActiveCapital: vaultActiveCapital.value,
    globalActiveCapital: globalActiveCapital.value,
    distributableBidPool: distributableBidPool.value,
    earningsSharePct: row.sharingPct,
  });
});

function updateFrameProgress() {
  progressTick.value++;
}

const visibleHistory = Vue.computed(() => {
  return showAllHistory.value ? frameHistory.value : frameHistory.value.slice(0, 10);
});

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

async function onSubmitted() {
  showOverlay.value = false;
  showAllHistory.value = false;
  await bonds.refreshFrameHistory();
}

let unsubVault: (() => void) | undefined;
let unsubBidPool: (() => void) | undefined;
let unsubTick: { unsubscribe: () => void } | undefined;

Vue.onMounted(async () => {
  await config.isLoadedPromise;
  await bonds.load();

  const client = await getMainchainClient(false);

  unsubVault = await vaults.subscribeToVault(bonds.vaultId, () => {
    const vault = vaults.vaultsById[bonds.vaultId];
    if (vault) {
      vaultTotalCapacity.value = vault.securitization;
    }
  });

  unsubBidPool = await TreasuryPool.subscribeBidPool(client, bidPool => {
    distributableBidPool.value = bidPool;
  });

  const capital = await TreasuryPool.getActiveCapital(client, bonds.vaultId);
  vaultActiveCapital.value = capital.vaultActivatedCapital;
  globalActiveCapital.value = capital.totalActivatedCapital;

  isLoaded.value = true;

  unsubTick = miningFrames.onTick(() => {
    updateFrameProgress();
  });
});

Vue.onUnmounted(() => {
  unsubVault?.();
  unsubBidPool?.();
  unsubTick?.unsubscribe();
});
</script>

<style scoped>
.frame-row-enter-active {
  transition: all 0.4s ease-out;
}
.frame-row-move {
  transition: transform 0.4s ease-out;
}
.frame-row-enter-from {
  opacity: 0;
  transform: translateY(-100%);
}
</style>
