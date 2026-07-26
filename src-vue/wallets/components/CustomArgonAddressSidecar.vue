<template>
  <div class="px-5 py-5">
    <div class="mb-4 border-b border-slate-600/20 px-7 pt-6 pb-7 text-base opacity-60">
      Insert any Argon address here in the field below.
    </div>
    <div class="px-7">
      <label
        for="custom-argon-address"
        class="mb-1 block text-sm font-medium text-slate-600/80"
        :class="props.disabled ? 'opacity-30' : ''"
      >
        Address of Account
      </label>
      <input
        id="custom-argon-address"
        v-model="address"
        data-testid="WalletOverlay.customArgonAddress"
        type="text"
        :disabled="props.disabled"
        class="w-full rounded-md border border-slate-900/40 px-2 py-1.5 font-mono disabled:opacity-30"
        placeholder="Address of Account"
        @input="emitAddress"
      />
      <div v-if="addressWarning" class="mt-3 w-full rounded-md border p-2 text-sm text-yellow-600">
        {{ addressWarning }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { isValidArgonAccountAddress } from '@argonprotocol/apps-core';

const props = defineProps<{
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (event: 'updateAddress', address: string): void;
}>();

const address = ref('');
const addressWarning = computed(() => {
  const trimmedAddress = address.value.trim();
  if (!trimmedAddress || isValidArgonAccountAddress(trimmedAddress)) return '';
  return 'The address entered is not a valid Argon address.';
});

function emitAddress() {
  emit('updateAddress', address.value.trim());
}
</script>
