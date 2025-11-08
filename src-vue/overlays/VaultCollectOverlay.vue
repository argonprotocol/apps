<template>
  <DialogRoot class="absolute inset-0 z-10" :open="true">
    <DialogPortal>
      <AnimatePresence>
        <DialogOverlay asChild>
          <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
            <BgOverlay @close="closeOverlay" />
          </Motion>
        </DialogOverlay>

        <DialogContent asChild @escapeKeyDown="closeOverlay" :aria-describedby="undefined">
          <Motion
            :ref="draggable.setModalRef"
            @mousedown="draggable.onMouseDown($event)"
            :initial="{ opacity: 0 }"
            :animate="{ opacity: 1 }"
            :exit="{ opacity: 0 }"
            :style="{
              top: `calc(50% + ${draggable.modalPosition.y}px)`,
              left: `calc(50% + ${draggable.modalPosition.x}px)`,
              transform: 'translate(-50%, -50%)',
              cursor: draggable.isDragging ? 'grabbing' : 'default',
            }"
            class="text-md absolute z-50 w-140 overflow-scroll rounded-lg border border-black/40 bg-white px-4 pt-2 pb-4 shadow-xl focus:outline-none">
            <h2
              @mousedown="draggable.onMouseDown($event)"
              :style="{ cursor: draggable.isDragging ? 'grabbing' : 'grab' }"
              class="mb-2 flex w-full flex-row items-center space-x-4 border-b border-black/20 px-3 pt-3 pb-3 text-5xl font-bold">
              <DialogTitle class="grow text-2xl font-bold">
                {{ myVault.data.pendingCollectRevenue ? 'Collect Pending Revenue' : 'Sign Bitcoin Transactions' }}
              </DialogTitle>
              <div
                @click="closeOverlay"
                class="z-10 mr-1 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none">
                <XMarkIcon class="h-5 w-5 stroke-4 text-[#B74CBA]" />
              </div>
            </h2>

            <div box class="flex flex-col px-3 py-3">
              <span class="py-4 font-thin text-red-700" v-if="collectError">{{ collectError }}</span>
              <div :class="{ 'opacity-80': isCollecting }" class="flex flex-col gap-y-2">
                <p>
                  <span v-if="myVault.data.pendingCollectRevenue">
                    Your vault has
                    <strong>
                      {{ currency.symbol
                      }}{{
                        microgonToMoneyNm(myVault.data.pendingCollectRevenue).formatIfElse('< 1_000', '0,0.00', '0,0')
                      }}
                    </strong>
                    in uncollected revenue.
                    <CountdownClock :time="nextCollectDueDate" v-slot="{ hours, minutes, days, seconds }">
                      <template v-if="hours || minutes || days || seconds">
                        You must collect this within
                        <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}.</span>
                        <span v-else-if="hours || minutes > 0">
                          <span class="mr-2" v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                          <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
                        </span>
                        <span v-else-if="seconds">{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>
                        ; otherwise,
                        <strong>
                          {{ currency.symbol
                          }}{{
                            microgonToMoneyNm(myVault.data.expiringCollectAmount).formatIfElse(
                              '< 1_000',
                              '0,0.00',
                              '0,0',
                            )
                          }}
                        </strong>
                        will expire and be lost forever.
                      </template>
                    </CountdownClock>
                  </span>
                  <span v-if="myVault.data.pendingCosignUtxoIds.size">
                    {{ myVault.data.pendingCollectRevenue ? 'Also, you' : 'You' }} have
                    <strong>
                      {{ myVault.data.pendingCosignUtxoIds.size }} transaction{{
                        myVault.data.pendingCosignUtxoIds.size === 1 ? '' : 's'
                      }}
                    </strong>
                    that must be signed. Failure to do so within
                    <CountdownClock :time="nextCollectDueDate" v-slot="{ hours, minutes, days }">
                      <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
                      <template v-else>
                        <span class="mr-2" v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                        <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
                      </template>
                    </CountdownClock>
                    will result in your vault forfeiting
                    <strong>
                      {{ currency.symbol
                      }}{{ microgonToMoneyNm(securitization).formatIfElse('< 1_000', '0,0.00', '0,0') }}
                    </strong>
                    in securitization.
                  </span>
                </p>

                <p>
                  Click the button below to complete
                  {{
                    myVault.data.pendingCosignUtxoIds.size && myVault.data.pendingCollectRevenue
                      ? 'both tasks at the same time'
                      : 'this task'
                  }}.
                </p>

                <button
                  @click="collect"
                  :class="[isCollecting ? 'pointer-events-none opacity-80' : '']"
                  :disabled="isCollecting"
                  class="bg-argon-600 hover:bg-argon-700 mt-4 cursor-pointer rounded-md px-6 py-2 text-lg font-bold text-white">
                  <template v-if="!isCollecting">
                    <template v-if="myVault.data.pendingCollectRevenue">Collect Revenue</template>
                    <template v-if="myVault.data.pendingCollectRevenue && myVault.data.pendingCosignUtxoIds.size">
                      +
                    </template>
                    <template v-if="myVault.data.pendingCosignUtxoIds.size">Sign Transactions</template>
                  </template>
                  <template v-else>Processing...</template>
                </button>
              </div>
              <ProgressBar
                v-if="isCollecting"
                class="mt-5 w-full"
                :hasError="collectError != ''"
                :progress="collectProgress" />
            </div>
          </Motion>
        </DialogContent>
      </AnimatePresence>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import CountdownClock from '../components/CountdownClock.vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { AnimatePresence, Motion } from 'motion-v';
import BgOverlay from '../components/BgOverlay.vue';
import Draggable from './helpers/Draggable.ts';
import { useMyVault } from '../stores/vaults.ts';
import { useCurrency } from '../stores/currency.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import ProgressBar from '../components/ProgressBar.vue';

dayjs.extend(utc);

const emit = defineEmits<{
  close: [];
}>();

const draggable = Vue.reactive(new Draggable());

const isCollecting = Vue.ref(false);
const collectProgress = Vue.ref(0);
const collectError = Vue.ref('');
const myVault = useMyVault();
const currency = useCurrency();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const securitization = Vue.computed(() => {
  return myVault.createdVault?.securitization ?? 0n;
});

const nextCollectDueDate = Vue.computed(() => {
  return dayjs.utc(myVault.data.nextCollectDueDate);
});

function closeOverlay() {
  emit('close');
}

async function collect() {
  isCollecting.value = true;
  collectProgress.value = 0;
  try {
    await myVault.collect((totalComplete, inProgressPctComplete, toComplete) => {
      collectProgress.value = totalComplete + inProgressPctComplete * (1 / toComplete);
    });
    collectProgress.value = 100;
    closeOverlay();
  } catch (error) {
    console.error('Error collecting pending revenue:', error);
    collectError.value = error instanceof Error ? error.message : `${error}`;
  } finally {
    isCollecting.value = false;
  }
}
</script>
