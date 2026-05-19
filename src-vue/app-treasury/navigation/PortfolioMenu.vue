<!-- prettier-ignore -->
<template>
  <div ref="rootRef" class="flex flex-row items-center">
    <PortfolioDetailsMenu />
    <div class="w-px h-[30px] bg-slate-400/50"></div>
    <PortfolioCurrencyMenu />
  </div>
</template>

<script setup lang="ts">
import PortfolioDetailsMenu from './PortfolioDetailsMenu.vue';
import PortfolioCurrencyMenu from '../../app-shared/navigation/PortfolioCurrencyMenu.vue';
</script>
