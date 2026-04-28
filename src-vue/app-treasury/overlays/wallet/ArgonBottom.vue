<template>
  <div class="py-4">
    <p v-if="props.isSyncMode" class="text-argon-600/80 mt-5 text-center font-light">
      Click the Move arrow to transfer tokens {{ props.direction }} the
      <br />
      Ethereum Network.
      <a href="https://argon.network/" target="_blank" class="text-argon-600 underline">Learn more</a>
      .
    </p>
    <p v-else class="mt-5 text-center font-light">
      Click the transfer icon above (
      <PortalIcon class="relative -top-px inline-block w-4" />
      ) to move
      <br />
      tokens between Argon and Ethereum.
    </p>
  </div>
</template>

<script setup lang="ts">
import PortalIcon from '../../../assets/portal.svg';

const props = withDefaults(
  defineProps<{
    isSyncMode?: boolean;
    direction: 'from' | 'to';
  }>(),
  {
    isSyncMode: false,
  },
);
</script>
