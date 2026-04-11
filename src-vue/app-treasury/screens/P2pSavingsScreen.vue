<!-- prettier-ignore -->
<template>
  <div class="relative h-full grow">
    <ComingSoonBanner class="absolute -top-0.5 -right-0.5 h-48 text-slate-400" />
    <div class="flex h-full flex-col items-center justify-center px-6 py-4">
      <div class="flex w-fit max-w-full flex-col pb-10">
        <div class="text-center text-5xl text-slate-700/50 font-bold whitespace-nowrap px-20">
          INFLATION-FREE CASH
        </div>

        <p class="w-0 min-w-full whitespace-normal border-t border-slate-400/50 pt-4 mt-4 text-[17px]/7 font-light">
          Argon's P2P wallet stores your funds on your local device and transacts directly with other users by sending signed "notes". It’s faster, cheaper, and more anonymous than transacting on the mainchain. We expect to integrate this feature into the Treasury app very soon.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import ComingSoonBanner from '../../assets/coming-soon-banner.svg';
</script>
