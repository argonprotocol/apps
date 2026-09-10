<template>
  <OverlayBase
    title="Active Seats"
    :isOpen="isOpen"
    class="ActiveSeatsOverlay w-9/12 max-w-5xl text-base"
    data-testid="ActiveSeatsOverlay"
    @close="emit('close')"
    @pressEsc="emit('close')"
  >
    <div class="px-8 py-6 text-slate-700">
      <div
        v-if="loadError"
        class="mb-4 flex items-center justify-between gap-4 rounded-md bg-red-50 px-4 py-3 text-red-800"
      >
        <span>{{ seats.length ? 'Unable to refresh active seats. Showing the last loaded results.' : loadError }}</span>
        <button type="button" class="shrink-0 font-semibold underline underline-offset-2" @click="refreshSeats">
          Try Again
        </button>
      </div>
      <TooltipProvider :delayDuration="300" :skipDelayDuration="0">
        <table class="w-full" aria-label="Your active mining seats">
          <thead class="sticky top-0 bg-white">
            <tr class="border-b border-slate-300 text-left font-bold text-slate-600">
              <th class="pb-2">Seat</th>
              <th class="pb-2 text-right">Bid Amount</th>
              <th class="pb-2 text-right">Earnings</th>
              <th class="pb-2 text-right">Return to Date</th>
              <th class="pb-2 text-right">Time Remaining</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="isLoading && seats.length === 0">
              <td colspan="5" class="py-4 text-slate-500">Loading active mining seats…</td>
            </tr>
            <tr v-else-if="!loadError && seats.length === 0">
              <td colspan="5" class="py-4 text-slate-500">You do not have any active mining seats.</td>
            </tr>
            <TooltipRoot v-for="row in seats" v-else :key="row.seat.id">
              <TooltipTrigger asChild>
                <tr class="border-b border-slate-200 last:border-b-0" tabindex="0">
                  <td class="py-3 font-bold">{{ row.seat.id }}</td>
                  <td class="py-3 text-right font-mono">
                    {{ microgonToArgonNm(row.seat.miner?.bidAmount ?? 0n).format('0,0.00') }} ARGN
                  </td>
                  <td class="py-3 text-right font-mono">
                    <template v-if="row.tooltipStats">
                      {{ microgonToArgonNm(row.earnedMicrogons).format('0,0.[00]') }} ARGN +
                      {{ micronotToArgonotNm(row.earnedMicronots).format('0,0.[00]') }} ARGNOT
                    </template>
                    <template v-else>Pending history</template>
                  </td>
                  <td class="py-3 text-right font-mono">
                    <template v-if="row.tooltipStats">{{ numeral(row.returnPercent).format('0,0.00') }}%</template>
                    <template v-else>—</template>
                  </td>
                  <td class="py-3 text-right">
                    {{
                      numeral(
                        (100 -
                          getMiningSeatProgressAtFrame(
                            row.seat.miner?.startingFrameId ?? miningFrames.currentFrameId,
                            miningFrames.currentFrameId,
                            miningFrames.getCurrentFrameProgress(),
                          )) /
                          10,
                      ).format('0.0')
                    }}
                    days
                  </td>
                </tr>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent
                  side="bottom"
                  align="center"
                  :sideOffset="-5"
                  :collisionPadding="9"
                  :style="floatingZIndex"
                  class="relative"
                >
                  <SeatTooltip
                    :seat="row.seat"
                    :frameId="miningFrames.currentFrameId"
                    isLiveFrame
                    :startingFrameId="row.seat.miner?.startingFrameId"
                    :ourBidAddresses="ourBidAddresses"
                    :hasAuction="false"
                    :isUnavailableForBids="false"
                    :tooltipStats="row.tooltipStats"
                  />
                  <TooltipArrow
                    :width="27"
                    :height="15"
                    class="z-20 -mt-px fill-white stroke-slate-800/20 stroke-[0.5px]"
                  />
                </TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
          </tbody>
        </table>
      </TooltipProvider>
    </div>
  </OverlayBase>
</template>

<script lang="ts">
import type { IMiningSeat } from '@argonprotocol/apps-core';
import type { IMiningSeatRewardTerms } from '../../interfaces/db/ICohortRecord.ts';

interface IActiveMiningSeatRow {
  seat: IMiningSeat;
  earnedMicrogons: bigint;
  earnedMicronots: bigint;
  returnPercent: number;
  tooltipStats: IMiningSeatRewardTerms | null;
}
</script>
<script setup lang="ts">
import * as Vue from 'vue';
import { NetworkConfig } from '@argonprotocol/apps-core';
import OverlayBase from '../OverlayBase.vue';
import { calculatePositionReturn } from '../../lib/financials/index.ts';
import { createMiningCohortFinancialPosition } from '../../lib/financials/MyMiningSeats.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import SeatTooltip from '../../screens/mining-screen/components/SeatTooltip.vue';
import { getMiningSeatProgressAtFrame } from '../../screens/mining-screen/miningSeatProgress.ts';
import { getMining, getMiningFrames } from '../../stores/mainchain.ts';
import { getMyMiningSeats } from '../../stores/myMiningSeats.ts';
import { useWallets } from '../../stores/wallets.ts';
import { useTopOverlayFloatingZIndex } from '../helpers/OverlayZIndex.ts';

const props = defineProps<{ isOpen: boolean }>();

const emit = defineEmits<{
  (event: 'close'): void;
}>();

const currency = getCurrency();
const mining = getMining();
const miningFrames = getMiningFrames();
const myMiningSeats = getMyMiningSeats();
const wallets = useWallets();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);
const ourBidAddresses = new Set<string>();
const floatingZIndex = useTopOverlayFloatingZIndex();
const seats = Vue.ref<IActiveMiningSeatRow[]>([]);
const isLoading = Vue.ref(false);
const loadError = Vue.ref<string>();
let refreshRequestId = 0;

async function refreshSeats() {
  const requestId = ++refreshRequestId;
  isLoading.value = true;
  loadError.value = undefined;
  try {
    await myMiningSeats.isLoadedPromise;
    const slots = await mining.fetchCurrentMiningSeats(wallets.miningBotWallet.address);
    const cohortsByFrameId = new Map(myMiningSeats.miningCohorts.map(cohort => [cohort.id, cohort]));

    const refreshedSeats = slots.flatMap(slot =>
      slot.seats.flatMap<IActiveMiningSeatRow>(seat => {
        if (!seat.miner?.isOurs) return [];

        const cohort = cohortsByFrameId.get(seat.miner.startingFrameId);
        if (!cohort) {
          return [{ seat, earnedMicrogons: 0n, earnedMicronots: 0n, returnPercent: 0, tooltipStats: null }];
        }

        const seatCount = BigInt(cohort.seatCountWon);
        const position = createMiningCohortFinancialPosition({
          cohort,
          latestFrameId: myMiningSeats.latestFrameId,
          liveArgonotRateMicrogons: myMiningSeats.currency.microgonsPer.ARGNOT,
          frameDates: new Map([
            [cohort.id, miningFrames.getFrameDate(cohort.id)],
            [
              cohort.id + NetworkConfig.framesPerCohort,
              miningFrames.getFrameDate(cohort.id + NetworkConfig.framesPerCohort),
            ],
          ]),
        });
        return [
          {
            seat,
            earnedMicrogons:
              (cohort.microgonsMinedTotal + cohort.microgonsMintedTotal + cohort.microgonFeesCollectedTotal) /
              seatCount,
            earnedMicronots: cohort.micronotsMinedTotal / seatCount,
            returnPercent: calculatePositionReturn([position]).percent ?? 0,
            tooltipStats: cohort,
          },
        ];
      }),
    );
    if (requestId === refreshRequestId) seats.value = refreshedSeats;
  } catch (error) {
    console.error('[Active Seats Overlay] Unable to load active seats', error);
    if (requestId === refreshRequestId) loadError.value = 'Active seats are temporarily unavailable.';
  } finally {
    if (requestId === refreshRequestId) isLoading.value = false;
  }
}

function refreshOpenSeats() {
  if (props.isOpen) void refreshSeats();
}

Vue.watch(
  () => props.isOpen,
  isOpen => {
    if (isOpen) void refreshSeats();
  },
  { immediate: true },
);

Vue.watch(() => myMiningSeats.financialRevision, refreshOpenSeats);
</script>
