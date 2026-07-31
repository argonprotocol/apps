<template>
  <div class="flex flex-col items-center px-10 py-8 text-center">
    <SuccessIcon class="text-argon-600 h-20 w-20" />

    <h1 class="mt-5 text-2xl font-bold">Your Purchase Is Complete</h1>
    <p class="mt-2 text-lg text-slate-700">
      You now own
      <strong>{{ numeral(amount).format('0,0') }} {{ amount === 1 ? singularLabel : pluralLabel }}</strong>
      .
    </p>

    <section class="mt-7 w-full rounded-md border border-slate-300 bg-slate-50 px-8 py-6">
      <h2 class="text-argon-600 text-xl font-bold">Collect Argons Daily</h2>
      <p class="mt-2 leading-relaxed font-light text-slate-700">
        Your {{ pluralLabel }} earn daily ARGN distributions from {{ distributionSource }}. Distributions will be
        deposited into your Internal App Wallet.
      </p>
    </section>

    <div class="mt-7 flex w-full justify-end border-t border-slate-200 pt-4">
      <button
        type="button"
        class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-6 py-2 font-semibold text-white"
        @click="emit('close')"
      >
        Done
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import numeral from '../lib/numeral.ts';
import SuccessIcon from '../assets/success.svg?component';

defineProps<{
  amount: number;
  singularLabel: string;
  pluralLabel: string;
  distributionSource: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();
</script>
