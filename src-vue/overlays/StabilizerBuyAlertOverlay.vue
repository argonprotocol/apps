<template>
  <OverlayBase
    :isOpen="true"
    :title="hasAlert ? 'Edit Buy Alert' : 'Create Buy Alert'"
    class="w-240"
    @close="emit('close')"
    :disallowClose="isSaving"
  >
    <div class="space-y-5 px-10 py-5 text-base">
      <fieldset v-if="!hasAlert" class="flex flex-wrap gap-x-7 gap-y-3">
        <legend class="sr-only">Stabilizer type</legend>
        <label class="flex items-center gap-3 font-bold text-slate-600">
          <RadioButton name="stabilizerType" value="buy" checked />
          Short-term Buy Alerts
        </label>
        <label class="flex cursor-not-allowed items-center gap-3 font-bold text-slate-400">
          <RadioButton name="stabilizerType" value="pool" disabled />
          Long-term Pool Position · Coming soon
        </label>
      </fieldset>
      <h3 class="text-2xl font-bold text-slate-700">Choose When to Be Notified</h3>
      <p class="mt-2 leading-relaxed text-slate-500">
        Receive a notification when a buying opportunity meets your minimum estimated APY, then choose whether and how
        much to buy.
      </p>
      <p class="mt-3 font-light text-slate-500">Purchases and bonus bids always need your approval.</p>

      <div class="mt-7">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2 text-slate-500">
          <label class="font-bold">Alert Me to Returns Above</label>
          <span v-if="market.availableUsdc !== undefined">
            {{ numeral(formatUnits(market.availableUsdc, 6)).format('0,0') }} USDC across your Ethereum wallets
          </span>
        </div>
        <InputNumber
          v-model="minimumApy"
          :min="0"
          :max="100"
          :maxDecimals="1"
          :hideArrows="true"
          suffix="% APY"
          aria-label="Minimum return APY"
          class="px-1 py-2 text-base"
        />
        <input
          v-model.number="minimumApy"
          type="range"
          min="0"
          max="100"
          step="0.5"
          aria-label="Minimum return APY slider"
          class="accent-argon-button mt-4 w-full cursor-pointer"
        />
        <div class="mt-1 flex justify-between font-light text-slate-500">
          <span>0%</span>
          <span>100%</span>
        </div>
      </div>
      <section
        v-if="!hasAlert && termDays !== undefined"
        class="border-argon-300/60 mt-8 grid gap-5 rounded-md border px-5 py-6 text-center sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-slate-300"
      >
        <div class="px-3">
          <header class="font-bold text-gray-600/60">TERM LENGTH</header>
          <div class="text-argon-600 py-1 text-3xl font-bold">{{ termDays }} DAYS</div>
          <div class="font-light text-slate-500">Before Full Release</div>
        </div>
        <div class="px-3">
          <header class="flex items-center justify-center gap-1 font-bold text-gray-600/60">
            AVERAGE APY
            <Tooltip :asChild="true" side="top">
              <button type="button" aria-label="Historical return assumptions" class="inline-flex cursor-help">
                <InformationCircleIcon class="size-4 text-gray-400" />
              </button>
              <template #content>
                <p>
                  Modeled from historical buys, including estimated fees and bonuses. Assumes proceeds are reinvested
                  after release.
                </p>
                <p v-if="!projection" class="mt-2">
                  Estimate unavailable.
                  <button type="button" class="text-argon-600 cursor-pointer underline" @click="estimateFees()">
                    Retry estimate
                  </button>
                </p>
              </template>
            </Tooltip>
          </header>
          <div class="text-argon-600 py-1 text-3xl font-bold">
            <template v-if="projection">
              {{ numeral(projection.apy.min).formatIfElse(Math.abs(projection.apy.min) < 10, '0,0.[0]', '0,0') }}–{{
                numeral(projection.apy.max).formatIfElse(Math.abs(projection.apy.max) < 10, '0,0.[0]', '0,0')
              }}%
            </template>
            <template v-else>--</template>
          </div>
          <div class="font-light text-slate-500">Based on Past Performance</div>
        </div>
        <div class="px-3">
          <header class="font-bold text-gray-600/60">PROJECTED EARNINGS</header>
          <div class="text-argon-600 py-1 text-3xl font-bold">
            <template v-if="projection && market.availableUsdc !== undefined && market.availableUsdc > 0n">
              {{ numeral(formatUnits(projection.earnings.min, 6)).formatCurrency('₳', 1) }}–{{
                numeral(formatUnits(projection.earnings.max, 6)).formatCurrency('₳', 1)
              }}
            </template>
            <template v-else>--</template>
          </div>
          <div class="font-light text-slate-500">Modeled Over One Year</div>
        </div>
      </section>
      <p v-if="error" role="alert" class="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-red-700">
        {{ error }}
      </p>
    </div>
    <div class="mx-2 flex justify-end gap-4 border-t border-slate-300 px-2 py-4 text-base">
      <button
        v-if="hasAlert"
        type="button"
        aria-label="Remove buy alert"
        title="Remove buy alert"
        :disabled="isSaving"
        class="mr-auto flex cursor-pointer items-center justify-center rounded-md border border-slate-300 px-3 py-2 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        @click="saveAlertSettings(undefined)"
      >
        <TrashIcon class="size-5" />
      </button>
      <button
        type="button"
        class="cursor-pointer rounded-md border border-slate-300 px-10 py-2 text-slate-600 hover:bg-slate-50"
        :disabled="isSaving"
        @click="emit('close')"
      >
        Cancel
      </button>
      <button
        type="button"
        data-testid="StabilizerBuyAlertOverlay.saveAlert()"
        :disabled="isSaving"
        class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-10 py-2 font-bold text-white disabled:cursor-default disabled:opacity-40"
        @click="saveAlertSettings({ minimumApy })"
      >
        <template v-if="isSaving">Saving Alert…</template>
        <template v-else-if="hasAlert">Save Changes</template>
        <template v-else>Create Buy Alert</template>
      </button>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { NetworkConfig } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { InformationCircleIcon, TrashIcon } from '@heroicons/vue/24/outline';
import { formatUnits, getAddress } from 'viem';
import { useMarketStabilizers } from '../stores/marketStabilizers.ts';
import { getStabilizerBuyPurchases } from '../stores/stabilizerBuys.ts';
import { projectHistoricalStabilizerBuys } from '../lib/financials/StabilizerBuys.ts';
import type { StabilizerBuyPurchases } from '../lib/StabilizerBuyPurchases.ts';
import type { IConfig } from '../interfaces/IConfig.ts';
import OverlayBase from './OverlayBase.vue';
import InputNumber from '../components/InputNumber.vue';
import RadioButton from '../components/RadioButton.vue';
import Tooltip from '../components/Tooltip.vue';
import numeral from '../lib/numeral.ts';

const emit = defineEmits<{ close: [] }>();
const market = useMarketStabilizers();
const hasAlert = computed(() => market.config.stabilizerBuyAlert !== undefined);
const termDays = computed(() => market.data.market?.purchaseHoldFrames);

const minimumApy = ref(market.config.stabilizerBuyAlert?.minimumApy ?? 0);
const isSaving = ref(false);
const error = ref<string>();

const history = market.history;
let estimateRevision = 0;
onScopeDispose(() => {
  estimateRevision++;
});
const fees = ref<Awaited<ReturnType<StabilizerBuyPurchases['estimateHistoricalFees']>>>();
const projection = computed(() => {
  if (!market.data.market || !fees.value) return;
  return projectHistoricalStabilizerBuys({
    history,
    fees: fees.value,
    market: market.data.market,
    availableUsdc: market.availableUsdc ?? 0n,
  });
});

watch(
  [
    () => hasAlert.value,
    () => market.data.market?.approvedPool?.poolId,
    () => market.wallets[0]?.address,
    () => NetworkConfig.get().ethereumNetwork.stabilizerBuyQuoterAddress,
    () => market.data.market?.prices?.tick,
  ],
  () => {
    fees.value = undefined;
    void estimateFees();
  },
  { immediate: true },
);

async function estimateFees() {
  const revision = ++estimateRevision;
  if (hasAlert.value) return;

  const purchases = getStabilizerBuyPurchases();
  const sourceAddress = market.wallets[0]?.address;
  const quoterAddress = NetworkConfig.get().ethereumNetwork.stabilizerBuyQuoterAddress;
  if (!purchases || !sourceAddress || !quoterAddress || !market.data.market?.approvedPool) return;

  const buyCount = history.days.reduce((sum, day) => sum + day.buyCount, 0);
  if (!buyCount) return;
  const averageUsdc = history.days
    .reduce((sum, day) => sum.plus(day.usdcSpent), BigNumber(0))
    .times(1e6)
    .div(buyCount);
  try {
    const estimate = await purchases.estimateHistoricalFees({
      sourceAddress,
      quoterAddress: getAddress(quoterAddress),
      maxUsdcIn: BigInt(averageUsdc.integerValue(BigNumber.ROUND_CEIL).toFixed(0)),
    });
    if (revision === estimateRevision) fees.value = estimate;
  } catch (cause) {
    console.warn('Unable to estimate historical Stabilizer Buy fees', cause);
  }
}

async function saveAlertSettings(settings: IConfig['stabilizerBuyAlert']) {
  if (isSaving.value) return;

  isSaving.value = true;
  error.value = undefined;
  try {
    await market.config.saveStabilizerBuyAlert(settings);
    emit('close');
  } catch (cause) {
    error.value = 'Unable to save your buy alert. Please try again.';
    console.warn('Unable to save the Stabilizer Buy alert', cause);
  } finally {
    isSaving.value = false;
  }
}
</script>
