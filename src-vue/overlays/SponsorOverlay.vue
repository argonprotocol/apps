<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" :overflowScroll="false" @close="closeOverlay" @pressEsc="closeOverlay" class="w-7/12">
    <template #title>
      <div class="text-2xl font-bold grow">Sponsor Details</div>
    </template>
    <div class="px-6 py-4 text-base font-medium text-gray-700">
      <div v-if="!isLoaded" class="text-center">
        Loading
      </div>
      <div v-else>
        <p class="font-light leading-6">
          You must be invited by an operator of the network to use Argon's advanced features like Treasury and
          Operations.
        </p>

        <ul class="my-5 grid grid-cols-[130px_1fr] border-y border-slate-300/70">
          <li class="contents">
            <span class="border-b border-slate-200 py-3 text-gray-500">Name</span>
            <span class="border-b border-slate-200 py-3">{{ config.upstreamOperator?.name || '--' }}</span>
          </li>
          <li class="contents">
            <span class="border-b border-slate-200 py-3 text-gray-500">Account ID</span>
            <span class="selectable-text border-b border-slate-200 py-3 break-all">
              {{ config.upstreamOperator?.accountId || '--' }}
            </span>
          </li>
          <li class="contents">
            <span class="border-b border-slate-200 py-3 text-gray-500">Server</span>
            <span class="selectable-text border-b border-slate-200 py-3">
              {{ config.bootstrapDetails?.routerHost || '--' }}
            </span>
          </li>
          <li class="contents">
            <span class="py-3 text-gray-500">Connection</span>
            <span class="py-3">{{ config.bootstrapDetails?.type || '--' }}</span>
          </li>
        </ul>

        <p class="font-light leading-6 text-gray-600">
          Your sponsor provided you the access code to upgrade to Treasury services. They never receive your wallet
          keys or other private details.
        </p>
      </div>

    </div>
  </OverlayBase>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from './OverlayBase.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { getConfig } from '../stores/config.ts';

const config = getConfig();

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);

function closeOverlay() {
  isOpen.value = false;
}

basicEmitter.on('openSponsorOverlay', () => {
  isOpen.value = true;
});

Vue.onMounted(async () => {
  await config.load();
  isLoaded.value = true;
});
</script>
