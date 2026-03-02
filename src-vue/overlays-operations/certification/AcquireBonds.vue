<template>
  <div class="pl-2">
    <p class="text-md leading-7">
      Treasury Bonds are issued by the Argon Treasury and represent a claim on future network revenue. Acquiring a bond
      signals your financial commitment to the protocol and is required for full operator certification. Bonds are
      available in denominations starting at A500 and can be purchased directly through the Treasury interface. Each
      bond has a maturity date after which it can be redeemed at face value plus accrued yield.
    </p>

    <button class="bg-argon-600 mt-5 flex flex-row items-center rounded-lg px-8 py-2 font-bold text-white">
      <ArrowTopRightOnSquareIcon class="mr-2 w-5" />
      Open Documentation
    </button>
  </div>
</template>

<script setup lang="ts">
import { ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline';
</script>
