<template>
  <article
    class="rounded border border-slate-900/30 bg-white shadow"
    :class="{
      'bg-slate-50 shadow-none': archived,
      'cursor-pointer hover:bg-slate-50': rewards || buys.length === 1,
    }"
    @click="openDetails"
  >
    <div class="flex items-center gap-2.5 px-3.5 py-2">
      <div class="flex w-16 shrink-0 justify-center"><EthereumNetworkLogo class="w-10 text-slate-400" /></div>
      <div class="min-w-0 grow pl-2">
        <div class="flex flex-wrap items-center justify-between gap-3 pt-3 pb-4">
          <div class="flex min-w-0 grow flex-wrap items-baseline gap-2">
            <header class="text-lg font-bold text-slate-800">
              <template v-if="principal > 0n">
                {{ numeral(formatUnits(principal, 6)).format('0,0.[00]') }} ARGN
              </template>
              <template v-else-if="pendingBuy?.ethereumGatewayActivity">
                {{ numeral(formatUnits(pendingBuy.ethereumGatewayActivity.amount, 6)).format('0,0.[00]') }} ARGN
              </template>
              <template v-else-if="pendingBuy?.ethereumQuote">
                ~{{ numeral(formatUnits(pendingBuy.ethereumQuote.quotedMicrogonsOut, 6)).format('0,0.[00]') }} ARGN
              </template>
              <template v-else-if="buys[0]?.status === StabilizerBuyStatus.Failed">Purchase Failed</template>
              <template v-else>Purchase in Progress</template>
            </header>
            <div class="flex flex-wrap items-center gap-2 font-light text-slate-500">
              <span aria-hidden="true">·</span>
              <span>Ethereum</span>
              <template v-if="purchaseDate">
                <span aria-hidden="true">·</span>
                <span>{{ dayjs(purchaseDate).format('M/D/YYYY') }}</span>
              </template>
            </div>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-3">
            <CountdownClock
              v-if="isBiddingOpen && biddingClosesAt"
              :time="dayjs.utc(biddingClosesAt)"
              v-slot="{ days, hours, minutes, seconds, isFinished }"
            >
              <div class="flex items-center gap-2 text-slate-500">
                <template v-if="isFinished">Bidding Closed</template>
                <template v-else>
                  Closes in
                  <span class="font-mono font-semibold tabular-nums">
                    <span v-if="days">{{ days }}d</span>
                    {{ numeral(hours).format('00') }}:{{ numeral(minutes).format('00') }}:{{
                      numeral(seconds).format('00')
                    }}
                  </span>
                </template>
              </div>
            </CountdownClock>
            <span v-else-if="releasesAt" class="font-light text-slate-500">
              <template v-if="archived">Released</template>
              <template v-else>Releases</template>
              {{ dayjs(releasesAt).format('M/D/YYYY') }}
            </span>
            <button
              v-if="rewards"
              type="button"
              class="border-argon-800 text-argon-600 hover:bg-argon-700 cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap hover:text-white"
              :class="{ 'bg-argon-600 text-white': isBiddingOpen }"
              @click.prevent.stop="emit('rewards', rewards)"
            >
              <template v-if="isBiddingOpen">Adjust {{ rewards.latestBid }}% Bid &raquo;</template>
              <template v-else>View Details</template>
            </button>
            <button
              v-else-if="buys.length === 1"
              type="button"
              class="border-argon-800/50 text-argon-600 hover:bg-argon-700 cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap hover:text-white"
              @click.prevent.stop="emit('purchase', buys[0])"
            >
              <template v-if="pendingBuy">View Progress</template>
              <template v-else>View Details</template>
            </button>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3 border-t border-slate-400/30 pt-4 pb-4 text-slate-500">
          <span v-if="returns && !pendingBuy">
            {{ microgonToMoneyNm(returns.investedCost).formatCurrency(currency.symbol) }}
            invested
          </span>
          <span v-else-if="spentUsdc !== undefined">
            {{ numeral(formatUnits(spentUsdc, 6)).format('0,0.00') }} USDC spent
          </span>
          <span v-else-if="pendingBuy?.ethereumQuote">
            Up to {{ numeral(formatUnits(pendingBuy.ethereumQuote.request.maxUsdcIn, 6)).format('0,0.00') }} USDC
          </span>
          <span v-else>Cost unavailable</span>
          <span v-if="!pendingBuy && returns?.returnAmount !== undefined" class="text-center">
            {{ microgonToMoneyNm(returns.returnAmount).formatCurrency(currency.symbol) }}
            net earnings
          </span>
          <span v-else-if="pendingBuy" class="col-span-2 text-right">
            <template v-if="pendingProgress?.currentStepDetail">{{ pendingProgress.currentStepDetail }}</template>
            <PurchaseStatus v-else :status="pendingBuy.status" />
          </span>
          <span v-else />
          <span v-if="!pendingBuy && returns?.apy !== undefined" class="text-right">
            <Returns :returns="returns" metric="APY" :hideDecimalsAt="10" />
          </span>
        </div>
        <ProgressBar
          v-if="pendingProgress"
          :progress="pendingProgress.overallProgressPct"
          :showLabel="false"
          class="mb-3 h-4"
        />
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatUnits } from 'viem';
import dayjs from 'dayjs';
import {
  StabilizerBuyStatus,
  type IStabilizerBuyRecord,
  type IStabilizerBuyFrameRewards,
} from '../../../interfaces/IStabilizerBuyPurchase.ts';
import type { IFinancialReturnSummary } from '../../../interfaces/IFinancialPosition.ts';
import type { ICrosschainTransferProgress } from '../../../lib/CrosschainTransferProgress.ts';
import EthereumNetworkLogo from '../../../assets/networks/ethereum.svg?component';
import CountdownClock from '../../../components/CountdownClock.vue';
import ProgressBar from '../../../components/ProgressBar.vue';
import PurchaseStatus from './PurchaseStatus.vue';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import Returns from '../../../components/Returns.vue';
import { getCurrency } from '../../../stores/currency.ts';

const props = withDefaults(
  defineProps<{
    buys: IStabilizerBuyRecord[];
    principal: bigint;
    rewards?: IStabilizerBuyFrameRewards;
    returns?: IFinancialReturnSummary;
    purchaseDate?: Date;
    releasesAt?: Date;
    biddingClosesAt?: Date;
    isBiddingOpen?: boolean;
    purchaseProgressById?: Record<string, ICrosschainTransferProgress>;
    archived?: boolean;
  }>(),
  { purchaseProgressById: () => ({}) },
);

const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const pendingBuy = computed(() =>
  props.buys.find(
    buy =>
      buy.admissionFrame === undefined &&
      buy.status !== StabilizerBuyStatus.Complete &&
      buy.status !== StabilizerBuyStatus.Failed,
  ),
);
const pendingProgress = computed(() => {
  if (pendingBuy.value) return props.purchaseProgressById[pendingBuy.value.id];
});

const spentUsdc = computed(() => {
  if (!props.buys.length) return;

  let spent = 0n;
  for (const buy of props.buys) {
    const purchase = buy.ethereumGatewayActivity?.purchase ?? buy.argonPurchaseEvent?.purchase;
    if (!purchase) return;
    spent += purchase.usdcSpent;
  }
  return spent;
});

const emit = defineEmits<{ purchase: [buy: IStabilizerBuyRecord]; rewards: [rewards: IStabilizerBuyFrameRewards] }>();

function openDetails(): void {
  if (props.rewards) emit('rewards', props.rewards);
  else if (props.buys.length === 1) emit('purchase', props.buys[0]);
}
</script>
