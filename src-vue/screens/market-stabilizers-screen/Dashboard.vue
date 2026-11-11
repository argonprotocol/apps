<template>
  <div DashBox data-testid="MarketStabilizersScreen" class="relative isolate flex min-h-0 grow flex-col">
    <div class="relative z-10 min-h-0 grow overflow-y-auto">
      <p v-if="message" role="status" class="mt-4 px-9 text-slate-500">{{ message }}</p>
      <BlankSlate v-if="!market.hasAccess" :canActivate="market.canActivate" @create="emit('editAlert')" />

      <div v-else class="flex shrink-0 grow flex-col">
        <section class="mt-5 flex flex-row items-end gap-x-2 px-9 text-center">
          <div class="w-1/3 border-b border-slate-400/30 py-5">
            <div class="text-argon-600 inline-flex text-5xl font-bold">
              <template v-if="summary">
                <FormattedMoney :value="summary.returnSummary.investedCost" :symbol="currency.symbol" />
              </template>
              <template v-else>--</template>
            </div>
            <div>Total Invested</div>
          </div>
          <div class="w-px self-stretch bg-slate-400/30" />
          <div class="w-1/3 border-b border-slate-400/30 py-5">
            <div class="text-argon-600 inline-flex text-5xl font-bold">
              <template v-if="hasNoInvestments || summary?.returnSummary.returnAmount !== undefined">
                <FormattedMoney :value="summary?.returnSummary.returnAmount ?? 0n" :symbol="currency.symbol" />
              </template>
              <template v-else>--</template>
            </div>
            <div>Net Earnings</div>
          </div>
          <div class="w-px self-stretch bg-slate-400/30" />
          <div class="w-1/3 border-b border-slate-400/30 py-5">
            <div class="text-argon-600 text-5xl font-bold">
              <span v-if="hasNoInvestments">0%</span>
              <Returns v-else :returns="summary?.returnSummary" :showLabel="false" :hideDecimalsAt="10" />
            </div>
            <div>{{ config.returnMetric }}</div>
          </div>
        </section>

        <div class="flex grow flex-col pt-10">
          <div class="flex flex-row items-center px-9 text-slate-800/70">
            <span class="grow">Stabilizer Buys</span>
            <template v-if="opportunity">
              <button
                type="button"
                class="text-argon-600 cursor-pointer font-medium whitespace-nowrap"
                @click="emit('editAlert')"
              >
                <template v-if="hasBuyAlert">
                  Edit Buy Alert ({{ numeral(minimumAlertApy).format('0.[0]') }}% APY)
                </template>
                <template v-else>Create Buy Alert</template>
              </button>
              <div class="mx-3 w-px self-stretch bg-slate-400/50" />
            </template>
            <a
              :href="`${NetworkConfig.websiteHost}/docs/network-rules/market-stabilizers`"
              target="_blank"
              class="text-argon-600 cursor-pointer whitespace-nowrap"
            >
              View Docs
            </a>
          </div>

          <section
            v-if="!opportunity"
            class="mx-9 mt-4 flex flex-wrap items-center gap-3 rounded border border-slate-900/30 bg-white px-4 py-3"
          >
            <span v-if="hasBuyAlert" aria-hidden="true" class="relative flex size-4 shrink-0">
              <span class="watching-ring border-argon-400/60 absolute inline-flex size-full rounded-full border" />
              <span
                class="watching-ring border-argon-400/60 absolute inline-flex size-full rounded-full border"
                style="animation-delay: 0.5s"
              />
              <span class="bg-argon-400 relative inline-flex size-4 rounded-full" />
            </span>
            <p class="text-slate-600">
              <template v-if="hasBuyAlert">
                Watching for buys above {{ numeral(minimumAlertApy).format('0.[0]') }}% APY
              </template>
              <template v-else>Get notified when buying opportunities meet your minimum APY.</template>
            </p>
            <template v-if="market.availableUsdc !== undefined">
              <span aria-hidden="true" class="text-slate-400">·</span>
              <span class="font-light text-slate-500">
                {{ numeral(formatUnits(market.availableUsdc, 6)).format('0,0') }} USDC available
              </span>
            </template>
            <button
              type="button"
              class="text-argon-600 ml-auto cursor-pointer font-medium whitespace-nowrap"
              @click="emit('editAlert')"
            >
              <template v-if="hasBuyAlert">Edit</template>
              <template v-else>Create Buy Alert</template>
            </button>
          </section>

          <StabilizerBuyOpportunity
            v-else
            :isAlert="minimumAlertApy !== undefined && opportunity.apy >= minimumAlertApy"
            :opportunityApy="opportunity?.apy"
            :observedAt="opportunity?.observedAt"
            :quantityMicrogons="opportunity?.quote.quotedMicrogonsOut"
            :discountPercent="opportunity.discountPercent"
            :availableUsdc="market.availableUsdc"
            class="mt-4"
            @purchase="emit('reviewPurchase')"
          />

          <section v-if="purchaseGroups.length" class="mt-8 flex flex-col gap-y-3 px-9 pb-6">
            <header v-if="activePurchaseCount" class="text-slate-800/70">
              You have {{ activePurchaseCount }}
              {{ activePurchaseCount === 1 ? 'stabilizer buy' : 'stabilizer buys' }}...
            </header>
            <StabilizerBuyRecord
              v-for="group in activeGroups"
              :key="group.id"
              :buys="group.buys"
              :principal="group.principal"
              :rewards="group.rewards"
              :returns="group.returns"
              :purchaseDate="group.purchaseDate"
              :releasesAt="group.releasesAt"
              :biddingClosesAt="group.biddingClosesAt"
              :isBiddingOpen="group.admissionFrame !== undefined && group.admissionFrame === biddingFrame"
              :purchaseProgressById="market.purchaseProgressById"
              @purchase="emit('openPurchase', $event.id)"
              @rewards="emit('openRewards', $event.admissionFrame)"
            />
            <details v-if="completedGroups.length" class="group mt-5">
              <summary class="flex cursor-pointer list-none items-center gap-2 text-slate-400">
                Completed Purchases ({{ completedPurchaseCount }})
                <ChevronDownIcon class="size-4 transition-transform group-open:rotate-180" />
              </summary>
              <div class="mt-3 flex flex-col gap-3">
                <StabilizerBuyRecord
                  v-for="group in completedGroups"
                  :key="group.id"
                  :buys="group.buys"
                  :principal="group.principal"
                  :rewards="group.rewards"
                  :returns="group.returns"
                  :purchaseDate="group.purchaseDate"
                  :releasesAt="group.releasesAt"
                  archived
                  :purchaseProgressById="market.purchaseProgressById"
                  @purchase="emit('openPurchase', $event.id)"
                  @rewards="emit('openRewards', $event.admissionFrame)"
                />
              </div>
            </details>
          </section>
        </div>
      </div>
    </div>
    <div class="pointer-events-none absolute inset-x-0 bottom-0 z-0 px-0.5 pb-0.5">
      <!-- Crop the generated image's white margins so the street meets the bottom edge. -->
      <img
        src="/treasury-footers/market-stabilizers.png"
        class="w-full object-cover opacity-50"
        style="aspect-ratio: 5 / 1; object-position: center 66%"
        alt=""
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, toRefs } from 'vue';
import { useMarketStabilizers } from '../../stores/marketStabilizers.ts';
import { useStabilizerBuyNavigation } from '../../stores/stabilizerBuys.ts';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { ChevronDownIcon } from '@heroicons/vue/24/outline';
import { StabilizerBuyStatus } from '../../interfaces/IStabilizerBuyPurchase.ts';
import { getConfig } from '../../stores/config.ts';
import numeral from '../../lib/numeral.ts';
import Returns from '../../components/Returns.vue';
import FormattedMoney from '../../components/FormattedMoney.vue';
import { formatUnits } from 'viem';
import { getCurrency } from '../../stores/currency.ts';
import BlankSlate from './BlankSlate.vue';
import StabilizerBuyOpportunity from './components/StabilizerBuyOpportunity.vue';
import StabilizerBuyRecord from './components/StabilizerBuyRecord.vue';

const market = useMarketStabilizers();
const { data, summary, dates, returns, biddingFrame, opportunity } = toRefs(market);
const hasNoInvestments = computed(
  () => summary.value?.state === 'ready' && summary.value.returnSummary.availability === 'not-applicable',
);
const buys = computed(() => data.value.buys);
const frameRewards = computed(() => data.value.frameRewards);
const minimumAlertApy = computed(() => market.config.stabilizerBuyAlert?.minimumApy);
const navigation = useStabilizerBuyNavigation();
const message = computed(() => navigation.noticeError ?? market.alertError ?? data.value.error);

const emit = defineEmits<{
  reviewPurchase: [];
  editAlert: [];
  openPurchase: [buyId: string];
  openRewards: [admissionFrame: number];
}>();

const config = getConfig();
const currency = getCurrency();
const hasBuyAlert = computed(() => minimumAlertApy.value !== undefined);
const purchaseGroups = computed(() => {
  const ids = new Set<number | string>(frameRewards.value.map(rewards => rewards.admissionFrame));
  for (const buy of buys.value) ids.add(buy.admissionFrame ?? buy.id);

  const groups = [...ids].map(id => {
    const groupBuys = buys.value.filter(buy => (buy.admissionFrame ?? buy.id) === id);
    const rewards = frameRewards.value.find(rewards => rewards.admissionFrame === id);
    const admissionFrame = groupBuys[0]?.admissionFrame ?? rewards?.admissionFrame;

    let isComplete = groupBuys.length > 0 && groupBuys.every(buy => buy.status === StabilizerBuyStatus.Complete);
    if (rewards) {
      if (rewards.awardedReward === undefined) isComplete = false;
      else if (rewards.awardedReward > rewards.paidReward) isComplete = false;
    }

    let purchaseDate = groupBuys[0]?.createdAt;
    let releasesAt: Date | undefined;
    let biddingClosesAt: Date | undefined;
    let groupReturn = returns.value.byPurchase[String(id)];
    if (admissionFrame !== undefined) {
      purchaseDate = dates.value.admission[admissionFrame];
      releasesAt = dates.value.releases[admissionFrame];
      biddingClosesAt = dates.value.closes[admissionFrame];
      groupReturn = returns.value.byFrame[admissionFrame];
    }

    return {
      id,
      buys: groupBuys,
      rewards,
      admissionFrame,
      isComplete,
      principal: groupBuys.reduce((sum, buy) => sum + (buy.principal ?? 0n), 0n),
      purchaseDate,
      releasesAt,
      biddingClosesAt,
      returns: groupReturn,
    };
  });

  return groups.sort((a, b) => {
    if (biddingFrame.value !== undefined) {
      if (a.admissionFrame === biddingFrame.value) return -1;
      if (b.admissionFrame === biddingFrame.value) return 1;
    }

    const aCreatedAt = a.buys[0]?.createdAt ?? a.rewards!.createdAt;
    const bCreatedAt = b.buys[0]?.createdAt ?? b.rewards!.createdAt;
    return bCreatedAt.getTime() - aCreatedAt.getTime();
  });
});
const activeGroups = computed(() => purchaseGroups.value.filter(group => !group.isComplete));
const activePurchaseCount = computed(() => activeGroups.value.reduce((count, group) => count + group.buys.length, 0));
const completedGroups = computed(() => purchaseGroups.value.filter(group => group.isComplete));
const completedPurchaseCount = computed(() =>
  completedGroups.value.reduce((count, group) => count + group.buys.length, 0),
);
</script>

<style scoped>
@media (prefers-reduced-motion: no-preference) {
  .watching-ring {
    animation: watching-ring 5s cubic-bezier(0, 0, 0.2, 1) infinite;
  }
}

@keyframes watching-ring {
  0% {
    transform: scale(1);
    opacity: 0.6;
  }
  40%,
  100% {
    transform: scale(2);
    opacity: 0;
  }
}
</style>
