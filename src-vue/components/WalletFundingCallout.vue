<template>
  <div
    class="relative mt-3 flex flex-row items-center rounded border border-yellow-400/70 bg-yellow-100 px-3 py-3 text-yellow-900"
  >
    <div
      v-if="showArrow"
      class="pointer-events-none absolute -top-[14px] border-x-[14px] border-b-[14px] border-x-transparent border-b-yellow-400/70"
      :style="{ [arrowSide]: `${arrowOffset}px` }"
    />
    <div
      v-if="showArrow"
      class="pointer-events-none absolute -top-[12px] border-x-[13px] border-b-[13px] border-x-transparent border-b-yellow-100"
      :style="{ [arrowSide]: `${arrowOffset + 1}px` }"
    />

    <div class="flex grow flex-row items-center">
      <slot />
    </div>
    <template v-if="showAction">
      <slot name="action">
        <button class="cursor-pointer font-semibold hover:underline" type="button" @click="emit('open-wallet')">
          Open Wallet
        </button>
      </slot>
    </template>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{ arrowOffset?: number; arrowSide?: 'left' | 'right'; showAction?: boolean; showArrow?: boolean }>(),
  {
    arrowOffset: 80,
    arrowSide: 'left',
    showAction: true,
    showArrow: true,
  },
);

const emit = defineEmits<{
  (event: 'open-wallet'): void;
}>();
</script>
