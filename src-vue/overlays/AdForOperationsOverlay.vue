<template>
  <div v-if="config.hasExtensionOperations" class="space-y-3 pr-10 pl-5">
    <p>This is your home base for mining and vaulting on the Argon network. No prior crypto experience required.</p>
    <p>
      <strong class="font-bold">Mining</strong>
      helps secure the Argon network by maintaining consensus and minting new Argons when needed. You earn block rewards
      by helping keep things running smoothly.
    </p>
    <p>
      <strong class="font-bold">Vaulting</strong>
      locks Bitcoin into stabilization contracts that keeps Argon's price steady. You earn revenue from mining revenue
      based on the percentage of Argons you're helping stabilize.
    </p>
  </div>
</template>
<script setup lang="ts">
import { getConfig } from '../stores/config.ts';

const config = getConfig();
</script>
