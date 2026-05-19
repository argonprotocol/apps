<!-- prettier-ignore -->
<template>
  <div ref="rootRef">
    <NavigationMenuItem class="pointer-events-auto">
      <NavigationMenuTrigger
        Trigger
        class="group relative flex h-[30px] w-[38px] cursor-pointer flex-row items-center justify-center rounded-md border border-slate-400/50 text-sm/6 font-semibold text-argon-600/60 hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none data-[state=open]:border-slate-400/60 data-[state=open]:bg-slate-400/10">
        <ConfigIcon class="h-5 w-5" />
        <ArrowCalloutButton
          v-if="controller.activeGuideId === OperationalStepId.BackupMnemonic && !basics.overlayIsOpen"
          class="absolute top-1/2 left-2 z-50 -translate-x-full -translate-y-1/2 group-data-[state=open]:hidden"
          label="Mouse Over"
          guidance="Open your account menu."
          direction="right"
        />
      </NavigationMenuTrigger>

      <NavigationMenuContent
        class="data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight absolute top-0 left-0 w-full sm:w-auto"
      >
          <ul class="flex min-w-66 shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900">
            <NavigationMenuLink @click="() => openAboutOverlay()" :class="menuItemClass">
              <header>About This App</header>
            </NavigationMenuLink>
            <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <NavigationMenuLink @click="() => openProfileOverlay()" :class="menuItemClass">
              <header>Personal Profile</header>
            </NavigationMenuLink>
            <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <NavigationMenuLink @click="() => openJurisdictionOverlay()" :class="menuItemClass">
              <header>Default Jurisdiction</header>
            </NavigationMenuLink>
            <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <NavigationMenuLink @click="() => openSecuritySettingsOverlay()" :class="[menuItemClass, 'relative']">
              <header>Security and Backups</header>
              <ArrowCalloutButton
                v-if="controller.activeGuideId === OperationalStepId.BackupMnemonic"
                class="absolute top-1/2 left-2 -translate-y-1/2 -translate-x-full z-50"
                guidance="Open the overlay."
                direction="right"
              />
            </NavigationMenuLink>
            <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <NavigationMenuLink @click="() => openPortfolioPanel()" :class="menuItemClass">
              <header>Portfolio Details</header>
            </NavigationMenuLink>
            <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <NavigationMenuLink :class="menuItemClass" @click="() => checkForUpdates()">
              <header>Check for Updates</header>
            </NavigationMenuLink>
            <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <NavigationMenuLink @click="() => openImportAccountOverlay()" :class="menuItemClass">
              <header>Import Account</header>
            </NavigationMenuLink>
            <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <li>
              <NavigationMenuSub
                :model-value="walletsMenuValue"
                orientation="vertical"
                class="relative"
                @mouseenter="clearWalletsMenuClose"
                @mouseleave="scheduleWalletsMenuClose"
                @update:model-value="setWalletsMenuValue"
              >
                <NavigationMenuList class="flex flex-col">
                  <NavigationMenuItem value="wallets">
                    <NavigationMenuTrigger
                      :class="submenuTriggerClass"
                    >
                      <ChevronLeftIcon class="absolute top-1/2 left-0.5 h-5 w-5 -translate-y-1/2 text-gray-400" />
                      <header>In-App Wallets</header>
                    </NavigationMenuTrigger>
                    <NavigationMenuContent class="absolute top-0 left-0 w-full sm:w-auto">
                      <ul class="min-w-50 bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
                        <NavigationMenuLink :class="menuItemClass" @click="openWallet(WalletType.miningHold)">
                          <header>Argon Mining Wallet</header>
                        </NavigationMenuLink>
                        <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
                        <NavigationMenuLink :class="menuItemClass" @click="openWallet(WalletType.vaulting)">
                          <header>Argon Vaulting Wallet</header>
                        </NavigationMenuLink>
                        <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
                        <NavigationMenuLink :class="menuItemClass" @click="openWallet(WalletType.ethereum)">
                          <header>Ethereum Wallet</header>
                        </NavigationMenuLink>
                      </ul>
                    </NavigationMenuContent>
                  </NavigationMenuItem>
                </NavigationMenuList>
                <NavigationMenuViewport
                  align="start"
                  class="pointer-events-auto absolute top-[var(--reka-navigation-menu-viewport-top)] right-full mr-1 h-[var(--reka-navigation-menu-viewport-height)] w-[var(--reka-navigation-menu-viewport-width)] overflow-visible"
                />
              </NavigationMenuSub>
            </li>
            <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
            <li>
              <NavigationMenuSub
                :model-value="resourcesMenuValue"
                orientation="vertical"
                class="relative"
                @mouseenter="clearResourcesMenuClose"
                @mouseleave="scheduleResourcesMenuClose"
                @update:model-value="setResourcesMenuValue"
              >
                <NavigationMenuList class="flex flex-col">
                  <NavigationMenuItem value="resources">
                    <NavigationMenuTrigger
                      :class="submenuTriggerClass"
                    >
                      <ChevronLeftIcon class="absolute top-1/2 left-0.5 h-5 w-5 -translate-y-1/2 text-gray-400" />
                      <header>Helpful Resources</header>
                    </NavigationMenuTrigger>
                    <NavigationMenuContent class="absolute top-0 left-0 w-full sm:w-auto">
                      <ul class="min-w-56 bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
                        <NavigationMenuLink :class="menuItemClass" @click="() => openTroubleshooting()">
                          <header>Troubleshooting</header>
                        </NavigationMenuLink>
                        <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
                        <NavigationMenuLink :class="menuItemClass" @click="() => void openLink('https://argon.network/docs')">
                          <header>Documentation</header>
                        </NavigationMenuLink>
                        <NavigationMenuLink :class="menuItemClass" @click="() => void openLink('https://argon.network/faq')">
                          <header>Frequently Asked Questions</header>
                        </NavigationMenuLink>
                        <NavigationMenuLink
                          :class="[menuItemClass, tour.isDisabled ? 'pointer-events-none opacity-30' : '']"
                          @click="() => !tour.isDisabled && takeTheTour()"
                        >
                          <header>Take the Welcome Tour</header>
                        </NavigationMenuLink>
                        <li divider class="my-1 h-[1px] w-full bg-slate-400/30" />
                        <NavigationMenuLink :class="menuItemClass" @click="() => void openLink('https://discord.gg/xDwwDgCYr9')">
                          <header>Discord User Community</header>
                        </NavigationMenuLink>
                        <NavigationMenuLink
                          :class="menuItemClass"
                          @click="() => void openLink('https://github.com/argonprotocol/apps/issues')">
                          <header>GitHub Developer Community</header>
                        </NavigationMenuLink>
                      </ul>
                    </NavigationMenuContent>
                  </NavigationMenuItem>
                </NavigationMenuList>
                <NavigationMenuViewport
                  align="start"
                  class="pointer-events-auto absolute top-[var(--reka-navigation-menu-viewport-top)] right-full mr-1 h-[var(--reka-navigation-menu-viewport-height)] w-[var(--reka-navigation-menu-viewport-width)] overflow-visible"
                />
              </NavigationMenuSub>
            </li>
          </ul>
        </NavigationMenuContent>
    </NavigationMenuItem>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  NavigationMenuItem,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuLink,
  NavigationMenuSub,
  NavigationMenuList,
  NavigationMenuViewport,
} from 'reka-ui';
import ConfigIcon from '../../assets/config.svg?component';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { ChevronLeftIcon } from '@heroicons/vue/24/outline';
import { useTour } from '../../stores/tour.ts';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { OperationalStepId, useOperationsController } from '../stores/controller.ts';
import { useBasics } from '../../stores/basics.ts';
import { WalletType } from '../../lib/Wallet.ts';

const tour = useTour();
const basics = useBasics();
const controller = useOperationsController();

const rootRef = Vue.ref<HTMLElement>();
const walletsMenuValue = Vue.ref('');
const resourcesMenuValue = Vue.ref('');
let walletsMenuCloseTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;
let resourcesMenuCloseTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

const menuItemClass =
  'block cursor-pointer rounded px-4 py-2 text-right hover:bg-argon-menu-hover focus:bg-argon-menu-hover focus:outline-none';
const submenuTriggerClass =
  'relative block w-full cursor-pointer rounded px-4 py-2 pl-10 text-right hover:bg-argon-menu-hover focus:bg-argon-menu-hover focus:outline-none data-[state=open]:bg-argon-menu-hover';

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

function openLink(url: string) {
  void tauriOpenUrl(url);
}

function checkForUpdates() {
  basicEmitter.emit('openCheckForAppUpdatesOverlay');
}

function openSecuritySettingsOverlay() {
  basicEmitter.emit('openSecuritySettingsOverlay');
}

function openAboutOverlay() {
  basicEmitter.emit('openAboutOverlay');
}

function openJurisdictionOverlay() {
  basicEmitter.emit('openJurisdictionOverlay');
}

function openImportAccountOverlay() {
  basicEmitter.emit('openImportAccountOverlay');
}

function openTroubleshooting() {
  basicEmitter.emit('openTroubleshootingOverlay', { screen: 'overview' });
}

function openProfileOverlay(): void {
  basicEmitter.emit('openProfileOverlay');
}

function openPortfolioPanel(): void {
  basicEmitter.emit('openPortfolioPanel', PortfolioTab.Overview);
}

function takeTheTour() {
  tour.start();
}

function openWallet(walletType: WalletType) {
  basicEmitter.emit('openWalletOverlay', { walletType: walletType as any });
}

function setWalletsMenuValue(value: string) {
  clearWalletsMenuClose();
  if (value) {
    closeResourcesMenu();
  }
  walletsMenuValue.value = value;
}

function setResourcesMenuValue(value: string) {
  clearResourcesMenuClose();
  if (value) {
    closeWalletsMenu();
  }
  resourcesMenuValue.value = value;
}

function clearWalletsMenuClose() {
  if (walletsMenuCloseTimeoutId) {
    clearTimeout(walletsMenuCloseTimeoutId);
  }
  walletsMenuCloseTimeoutId = undefined;
}

function scheduleWalletsMenuClose() {
  clearWalletsMenuClose();
  walletsMenuCloseTimeoutId = setTimeout(() => {
    closeWalletsMenu();
  }, 450);
}

function closeWalletsMenu() {
  walletsMenuValue.value = '';
  walletsMenuCloseTimeoutId = undefined;
}

function clearResourcesMenuClose() {
  if (resourcesMenuCloseTimeoutId) {
    clearTimeout(resourcesMenuCloseTimeoutId);
  }
  resourcesMenuCloseTimeoutId = undefined;
}

function scheduleResourcesMenuClose() {
  clearResourcesMenuClose();
  resourcesMenuCloseTimeoutId = setTimeout(() => {
    closeResourcesMenu();
  }, 450);
}

function closeResourcesMenu() {
  resourcesMenuValue.value = '';
  resourcesMenuCloseTimeoutId = undefined;
}
</script>

<style scoped>
@reference "../../main.css";

[data-reka-collection-item] {
  @apply cursor-pointer focus:outline-none;

  &[data-disabled] {
    opacity: 0.3;
    pointer-events: none;
  }
  header {
    @apply text-right font-bold whitespace-nowrap text-gray-900;
  }
  p {
    @apply text-right font-light whitespace-nowrap text-gray-700;
    line-height: 1.4em;
  }
}
</style>
