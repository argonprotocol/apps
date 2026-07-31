<template>
  <div
    class="relative mt-3 flex flex-row items-center rounded border border-yellow-400/70 bg-yellow-100 px-3 py-3 text-yellow-900"
  >
    <div
      class="pointer-events-none absolute -top-[14px] left-20 border-x-[14px] border-b-[14px] border-x-transparent border-b-yellow-400/70"
    />
    <div
      class="pointer-events-none absolute -top-[12px] left-20 border-x-[13px] border-b-[13px] border-x-transparent border-b-yellow-100"
    />

    <div class="flex grow flex-row items-center">
      <slot />
    </div>
    <button class="cursor-pointer font-semibold hover:underline" type="button" @click="emit('open-wallet')">
      Open Wallet
    </button>
  </div>
</template>

<script setup lang="ts">
const emit = defineEmits<{
  (event: 'open-wallet'): void;
}>();
</script>
