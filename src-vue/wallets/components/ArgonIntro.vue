<template>
  <p>
    These are your unencumbered tokens, ready
    <template v-if="walletType === WalletType.defaultArgon">to use for mining,</template>
    <template v-else>for Argonot Bonds, Liquid Locking,</template>
    or whatever else you want to do with them.
  </p>
</template>

<script setup lang="ts">
import { WalletType } from '../../lib/Wallet.ts';

const props = defineProps<{
  walletType: WalletType;
}>();
</script>
