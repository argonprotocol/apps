<!-- prettier-ignore -->
<template>
  <div class="h-full pt-2 w-screen flex flex-row overflow-hidden cursor-default gap-y-2">
    <div @click="">Operational Bonds</div>
    <div>Bitcoin Locks</div>
  </div>
</template>

<script setup lang="ts">
import '../lib/Env.ts'; // load env first
import * as Vue from 'vue';
import { waitForLoad } from '@argonprotocol/mainchain';

Vue.onBeforeMount(async () => {
  await waitForLoad();
});

Vue.onErrorCaptured((error, instance) => {
  console.error(instance?.$options.name, error);
  return false;
});
</script>
