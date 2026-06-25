<template>
  <PopoverArrow as-child>
    <div class="pointer-events-none h-[15px] w-[30px] rotate-180 overflow-hidden">
      <div class="relative top-[5px] left-[5px] h-[20px] w-[20px] rotate-45 bg-white ring-1 ring-gray-900/20"></div>
    </div>
  </PopoverArrow>
</template>

<script setup lang="ts">
import { PopoverArrow } from 'reka-ui';
</script>
