<template>
  <div class="BondRecord Component flex flex-col">
    <section ActiveRecord :class="isActionHovered ? '' : 'hover:bg-slate-50'">
      <BondIcon MainIcon />
      <div ContentWrapper>
        <div FirstRow>
          <span class="font-semibold">
            {{ numeral(bondLot.bonds).format('0,0') }}
            {{ bondLot.programType === 'Argonot' ? 'Argonot Bonds' : 'Argon Bonds' }}
          </span>
          <span class="font-light">
            bought
            {{ dayjs.utc(miningFrames.getFrameDate(bondLot.createdFrame)).local().format('M/D/YYYY [at] h:mm a') }}
          </span>
          <div v-if="isReleasing" class="text-sm text-amber-700">
            Releasing
            <span class="font-semibold">
              <template v-if="bondLot.programType === 'Argonot'">
                {{ micronotToArgonotNm(bondLot.returningBondMicrogons).format('0,0.00') }} ARGNOT
              </template>
              <template v-else>
                {{ currency.symbol }}{{ microgonToMoneyNm(bondLot.returningBondMicrogons).format('0,0.00') }}
              </template>
            </span>
            <CountdownClock
              :time="dayjs.utc(miningFrames.getFrameDate(bondLot.releaseFrame!))"
              v-slot="{ hours, minutes, seconds, days }"
            >
              in
              <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
              <template v-else-if="hours > 0">
                <span>{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                <span v-if="minutes > 0">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
              </template>
              <span v-else-if="minutes > 0">{{ minutes }}m, {{ seconds }}s</span>
              <span v-else>{{ seconds }}s</span>
            </CountdownClock>
          </div>
          <div
            v-else
            class="text-md flex grow flex-row items-center justify-end gap-x-2 text-right"
            @mouseenter="isActionHovered = true"
            @mouseleave="isActionHovered = false"
          >
            <button
              @click.stop="emit('liquidate', bondLot)"
              :disabled="isReleasing"
              class="border-argon-600 hover:bg-argon-500/20 text-argon-600 cursor-pointer rounded-md border bg-white px-5 hover:shadow-lg"
            >
              {{ isReleasing ? 'Liquidating...' : 'Liquidate' }}
            </button>
          </div>
        </div>
        <div SecondRow>
          <span>
            <template v-if="position?.investedCost !== undefined">
              {{ currency.symbol }}{{ microgonToMoneyNm(position.investedCost).format('0,0.00') }} principal basis
            </template>
            <template v-else>Principal basis unavailable</template>
          </span>
          <div class="flex grow flex-row items-stretch justify-center">
            <span class="h-full w-px bg-slate-400/50"></span>
          </div>
          <span>
            {{ currency.symbol }}{{ microgonToMoneyNm(bondLot.lifetimeEarnings).format('0,0.00') }}
            in distributions
          </span>
          <div class="flex grow flex-row items-stretch justify-center">
            <span class="h-full w-px bg-slate-400/50"></span>
          </div>
          <span>
            <template v-if="returnPercent === undefined">--</template>
            <template v-else>{{ numeral(returnPercent).format('0,0.00') }}%</template>
            return
          </span>
          <template v-if="vaultLabel">
            <div class="flex grow flex-row items-stretch justify-center">
              <span class="h-full w-px bg-slate-400/50"></span>
            </div>
            <span>{{ vaultLabel }}</span>
          </template>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import BondIcon from '../../../assets/bond.svg?component';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import CountdownClock from '../../../components/CountdownClock.vue';
import { BondLot } from '@argonprotocol/apps-core';
import { getMiningFrames } from '../../../stores/mainchain.ts';
import { getVaults } from '../../../stores/vaults.ts';
import type { IBondFinancialPosition } from '../../../interfaces/IFinancialPosition.ts';

dayjs.extend(utc);

const currency = getCurrency();
const miningFrames = getMiningFrames();
const vaults = getVaults();

const { microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    bondLot: BondLot;
    isReleasing?: boolean;
    position?: IBondFinancialPosition;
    returnPercent?: number;
  }>(),
  {
    isReleasing: false,
  },
);

const emit = defineEmits<{
  liquidate: [bondLot: BondLot];
}>();

const isActionHovered = Vue.ref(false);
const vaultLabel = Vue.computed(() => {
  if (props.bondLot.programType === 'Argonot') return;

  const vaultId = props.bondLot.vaultId;
  if (vaultId == null) {
    return 'Vault Bond';
  }

  const vault = vaults.vaultsById[vaultId];
  const name = vault?.name?.trim();
  return name ? `${name} Vault` : `Vault #${vaultId}`;
});
</script>

<style>
@reference "../../../main.css";

.BondRecord.Component {
  section[PendingRecord] {
    @apply flex cursor-pointer flex-row items-center gap-2.5 rounded border-[1.5px] border-dashed border-slate-900/30 bg-white px-3.5 py-2 hover:bg-slate-50/50;
    [MainIcon] {
      @apply opacity-50;
    }
  }

  section[ActiveRecord] {
    @apply flex cursor-pointer flex-row items-center gap-2.5 rounded border border-slate-900/30 bg-white px-3.5 py-2 shadow hover:bg-slate-50;
  }

  [ContentWrapper] {
    @apply grow pl-2;

    button[PrimaryButton] {
      @apply bg-argon-600 border-argon-800 text-md hover:bg-argon-700 cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap text-white hover:shadow-lg;
    }

    button[SecondaryButton] {
      @apply border-argon-800/50 text-md text-argon-600 hover:bg-argon-700 cursor-pointer rounded-md border px-4 py-0.5 font-semibold whitespace-nowrap hover:text-white hover:shadow-lg;
    }

    [FirstRow] {
      @apply flex flex-row items-center gap-1 pt-3 pb-2 text-lg text-slate-800;
      header {
        @apply relative top-1 grow text-lg font-bold;
      }
    }

    [SecondRow] {
      @apply flex flex-row items-stretch border-t border-slate-400/30 pt-3 pb-3 whitespace-nowrap text-slate-500;
    }
  }

  [MainIcon] {
    @apply w-20 text-slate-400;
  }
  /* relative top-px mr-7 inline-block w-18 -rotate-24 opacity-60 */

  .fade-in-out {
    animation: fadeInOut 1s ease-in-out infinite;
  }

  .fade-in-out:hover {
    animation: none;
  }

  .bitcoin-spin {
    animation: bitcoinSpin 2s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }
}

@keyframes fadeInOut {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 0.85;
  }
}

@keyframes bitcoinSpin {
  0% {
    rotate: 0deg;
  }
  90% {
    rotate: 360deg;
  }
  100% {
    rotate: 360deg;
  }
}
</style>
