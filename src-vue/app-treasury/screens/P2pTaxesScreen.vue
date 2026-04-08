<!-- prettier-ignore -->
<template>
  <div class="relative h-full grow">
    <ComingSoonBanner class="absolute -top-0.5 -right-0.5 h-48 text-slate-400" />
    <div class="flex h-full flex-col items-center justify-center px-6 py-4">
      <div class="flex w-fit max-w-full flex-col pb-10">
        <div class="text-center text-5xl text-slate-700/50 font-bold whitespace-nowrap">
          ARGON’S P2P TAX REVENUE
        </div>

        <p class="w-0 min-w-full whitespace-normal border-t border-slate-400/50 pt-4 mt-4 text-[17px]/7 font-light">
          The Localchain has no transaction cost, but you pay a small "tax" in each transaction that is yours to keep.
          Since there's no governmental body in Argon, taxes are yours to use for mining network blocks. Once taxes
          are redeemed for network votes, they're burned from the mainchain, exerting a steady downward pressure on the
          Argons in existence.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import ComingSoonBanner from '../../assets/coming-soon-banner.svg';
</script>
