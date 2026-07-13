<!-- prettier-ignore -->
<template>
  <div
    class="bg-white/95 relative flex min-h-14 w-full flex-row items-center select-none"
    style="border-radius: 10px 10px 0 0; box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2)"
    data-tauri-drag-region
  >
    <div
      class="pointer-events-none absolute top-0 right-0 h-[calc(100%+4px)] w-2/3 rounded-tr-[10px] bg-gradient-to-r from-transparent via-[var(--bg-color)] via-55% to-[var(--bg-color)]"
    />
    <div class="absolute right-2 -bottom-px h-px w-full bg-slate-400/30" />

    <div class="flex flex-row items-center w-1/3 pointer-events-none relative top-px">
      <WindowControls />
      <div class="relative top-px text-[19px] font-bold whitespace-nowrap">
        Argon Desktop
      </div>
    </div>

    <NavigationMenuRoot
      v-if="controller.isLoaded && !controller.isImporting"
      class="relative mr-3 flex w-1/3 grow flex-row items-center justify-end pointer-events-none"
      :model-value="navigationMenuValue"
      :delay-duration="0"
      :skip-delay-duration="0"
      @update:model-value="setNavigationMenuValue"
    >
      <NavigationMenuList class="relative flex flex-row items-center space-x-2" @mouseenter="clearNavigationMenuClose">
        <div class="pointer-events-auto">
          <OperationalMenu />
        </div>
        <div
          v-if="config.isLoaded && config.hasExtensionOperations"
          :class="[controller.selectedTab === TopTab.Mining && bot.isSyncing ? 'pointer-events-none' : 'pointer-events-auto']"
        >
          <ServerMenu ref="serverMenuRef" />
        </div>
        <div :class="[controller.selectedTab === TopTab.Mining && bot.isSyncing ? 'pointer-events-none' : 'pointer-events-auto', wallets.isLoaded ? '' : 'opacity-20']">
          <div ref="currencyMenuRef" class="flex flex-row items-center">
            <PortfolioDetailsMenu />
            <div class="w-px h-[30px] bg-slate-400/50"></div>
            <PortfolioCurrencyMenu />
          </div>
        </div>
        <div class="pointer-events-auto">
          <ProfitsMenu ref="returnsMenuRef" />
        </div>
        <div :class="[controller.selectedTab === TopTab.Mining && bot.isSyncing ? 'pointer-events-none' : 'pointer-events-auto']">
          <AccountMenu ref="accountMenuRef" />
        </div>
      </NavigationMenuList>
      <NavigationMenuIndicator
        :style="navigationMenuIndicatorZIndex"
        class="pointer-events-none absolute top-full left-0 flex h-[10px] w-[var(--reka-navigation-menu-indicator-size)] translate-x-[var(--reka-navigation-menu-indicator-position)] items-end justify-center transition-[width,transform,opacity] duration-300 data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100"
      >
        <div class="relative top-[-1px] h-0 w-0 border-x-[13px] border-b-[13px] border-x-transparent border-b-gray-900/20">
          <div class="absolute top-[2px] left-[-11px] h-0 w-0 border-x-[11px] border-b-[11px] border-x-transparent border-b-argon-menu-bg" />
        </div>
      </NavigationMenuIndicator>
      <NavigationMenuViewport
        align="end"
        :style="navigationMenuViewportZIndex"
        class="pointer-events-auto absolute top-full left-[var(--reka-navigation-menu-viewport-left)] mt-[8px] h-[var(--reka-navigation-menu-viewport-height)] w-full origin-[top_center] overflow-visible rounded border border-gray-900/20 bg-argon-menu-bg shadow-lg transition-[left,_width,_height] duration-300 data-[state=closed]:animate-scaleOut data-[state=open]:animate-scaleIn sm:w-[var(--reka-navigation-menu-viewport-width)]"
        @mouseenter="clearNavigationMenuClose"
      />
    </NavigationMenuRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { TopTab } from '../interfaces/IConfig.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import WindowControls from '../tauri-controls/WindowControls.vue';
import PortfolioMenu from './PortfolioMenu.vue';
import AccountMenu from './AccountMenu.vue';
import { useWallets } from '../stores/wallets.ts';
import { getBot } from '../stores/bot.ts';
import { useTour } from '../stores/tour.ts';
import ServerMenu from './ServerMenu.vue';
import OperationalMenu from './OperationalMenu.vue';
import {
  NavigationMenuContent,
  NavigationMenuIndicator,
  NavigationMenuItem,
  NavigationMenuList,
  NavigationMenuRoot,
  NavigationMenuTrigger,
  NavigationMenuViewport,
} from 'reka-ui';
import { useFloatingZIndex } from '../overlays/helpers/OverlayZIndex.ts';
import ProfitsMenu from './ProfitsMenu.vue';
import PortfolioDetailsMenu from './PortfolioDetailsMenu.vue';
import PortfolioCurrencyMenu from './PortfolioCurrencyMenu.vue';
import { getConfig } from '../stores/config.ts';
import basicEmitter from '../emitters/basicEmitter.ts';

const controller = useCertificationController();
const wallets = useWallets();
const tour = useTour();
const config = getConfig();
const bot = getBot();
const navigationMenuViewportZIndex = useFloatingZIndex();
const navigationMenuIndicatorZIndex = useFloatingZIndex(2);

const serverMenuRef = Vue.ref<InstanceType<typeof ServerMenu> | null>(null);
const accountMenuRef = Vue.ref<InstanceType<typeof AccountMenu> | null>(null);
const currencyMenuRef = Vue.ref<InstanceType<typeof PortfolioMenu> | null>(null);
const returnsMenuRef = Vue.ref<InstanceType<typeof ProfitsMenu> | null>(null);

const navigationMenuValue = Vue.ref('');
let navigationMenuCloseTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

function onTreasuryInviteClaimed() {
  navigationMenuValue.value = '';
}

function setNavigationMenuValue(value: string) {
  clearNavigationMenuClose();

  if (value) {
    navigationMenuValue.value = value;
    return;
  }

  navigationMenuCloseTimeoutId = setTimeout(() => {
    navigationMenuValue.value = '';
    navigationMenuCloseTimeoutId = undefined;
  }, 450);
}

function clearNavigationMenuClose() {
  if (navigationMenuCloseTimeoutId) {
    clearTimeout(navigationMenuCloseTimeoutId);
  }
  navigationMenuCloseTimeoutId = undefined;
}

function openCertificationMenu() {
  clearNavigationMenuClose();
  navigationMenuValue.value = 'certification';
}

tour.registerPositionCheck('currencyMenu', () => {
  const currencyMenuElem = currencyMenuRef.value?.$el;
  const rect = currencyMenuElem?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 10;
  rect.right += 10;
  rect.top -= 10;
  rect.bottom += 7;
  return { ...rect, blur: 5 };
});

tour.registerPositionCheck('accountMenu', () => {
  const accountMenuElem = accountMenuRef.value?.$el;
  const rect = accountMenuElem?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 7;
  rect.right += 7;
  rect.top -= 7;
  rect.bottom += 7;
  return { ...rect, blur: 5 };
});

basicEmitter.on('openCertificationMenu', openCertificationMenu);

Vue.onBeforeUnmount(() => {
  basicEmitter.off('openCertificationMenu', openCertificationMenu);
});
</script>
