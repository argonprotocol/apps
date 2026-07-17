<!-- prettier-ignore -->
<template>
  <div DashBox class="flex flex-col h-full">
    <div class="flex flex-col items-center grow justify-center">
      <section class="flex flex-col items-center">
        <div style="text-shadow: 1px 1px 0 white">
          <div class="text-5xl leading-tight font-bold text-center text-argon-text-primary">
            Earn Argons and Argonots
            <div>By Running Your Own Mining Node</div>
          </div>
          <p class="text-base text-justify w-[780px] !mx-auto mt-10 text-argon-text-primary">
            Argon is fully decentralized and democratic. Anyone can participate in the mining and rewards of the system, and
            a special auction process serves as gatekeeper. Auctions are held every 24 hours, and the winners are given the keys
            for ten days before the cycle repeats itself. The best thing is, special mining hardware provides no advantage.
            Argon is optimized for cheap virtual cloud machines, which makes getting involved easy and cost-effective.
            Click a button below to get started.
          </p>
        </div>
        <div class="flex flex-row items-center text-2xl mt-10 w-full justify-center gap-x-6">
          <a
            target="_blank"
            href="https://argon.network/docs/mining-operations"
            class="flex flex-row items-center cursor-pointer bg-white/10 hover:bg-argon-600/10 border border-argon-800/30 inner-button-shadow font-bold! !text-argon-600 visited:!text-argon-600 hover:!text-argon-600 no-underline hover:no-underline [text-shadow:1px_1px_0_rgba(255,255,255,0.5)] px-12 py-2 rounded-md"
          >
            Learn How Mining Works
            <ArrowTopRightOnSquareIcon class="w-5 ml-2" />
          </a>
          <button
            @click="startSettingUpMiner"
            class="flex flex-row cursor-pointer items-center gap-x-2 bg-argon-500 hover:bg-argon-600 border border-argon-700 inner-button-shadow font-bold text-white px-12 py-2 rounded-md"
          >
            <span class="relative">
              Set Up Your Mining Operation
              <ArrowCalloutButton
                v-if="[OperationalStepId.FirstMiningSeat, OperationalStepId.MoreMiningSeats].includes(controller.activeGuideId as any)"
                class="absolute top-1/2 -left-2 -translate-y-1/2 -translate-x-full z-50"
                guidance="Click to begin setting up your mining."
                direction="right"
              />
            </span>
            <ChevronDoubleRightIcon class="size-5 relative top-px" />
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script lang="ts">
const isLoaded = Vue.ref(false);
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import { useMiningStats } from '../../stores/miningStats.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { ChevronDoubleRightIcon, ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline';
import BlankSlateBlocks from '../network-screen/BlankSlateBlocks.vue';
import { MiningSetupStatus } from '../../interfaces/IConfig.ts';
import { OperationalStepId, useCertificationController } from '../../stores/certificationController.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';

const controller = useCertificationController();
const miningStats = useMiningStats();
const currency = getCurrency();
const config = getConfig();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

function startSettingUpMiner() {
  config.miningSetupStatus = MiningSetupStatus.Checklist;
}

Vue.onMounted(async () => {
  Promise.all([miningStats.update()]).then(() => {
    isLoaded.value = true;
  });
});
</script>
