<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="true" @close="emit('close')" @pressEsc="emit('close')" class="w-5/12">
    <template #title>
      <div class="grow text-2xl font-bold">Buy Bonds</div>
    </template>

    <div class="px-6 py-5">
      <BuyBondsForm
        :vaultId="props.vaultId"
        :walletBalance="props.walletBalance"
        :availableVaultSpace="props.availableVaultSpace"
        @close="emit('close')"
        @submitted="emit('submitted')"
      />
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import BuyBondsForm from './BuyBondsForm.vue';
import OverlayBase from './OverlayBase.vue';

const props = defineProps<{
  vaultId: number;
  walletBalance: bigint;
  availableVaultSpace: bigint;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'submitted'): void;
}>();
</script>
