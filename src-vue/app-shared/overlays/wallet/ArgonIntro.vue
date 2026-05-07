<template>
  <p>
    These are your unencumbered tokens, ready
    <template v-if="walletType === WalletType.vaulting">to attach to your new vault,</template>
    <template v-else-if="walletType === WalletType.miningHold">to use for mining,</template>
    <template v-else>for Argon Bonds, Liquid Locking,</template>
    or whatever else you want to do with them.
  </p>
</template>

<script setup lang="ts">
import { WalletType } from '../../../lib/Wallet.ts';

const props = defineProps<{
  walletType: WalletType;
}>();
</script>
