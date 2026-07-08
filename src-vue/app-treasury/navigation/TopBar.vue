<template>
  <div
    class="relative flex min-h-14 w-full flex-row items-center border-b-[1px] border-slate-400/40 bg-white/95 select-none"
    style="border-radius: 10px 10px 0 0; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15)"
    data-tauri-drag-region
  >
    <div
      class="pointer-events-none absolute top-0 right-0 h-[calc(100%+4px)] w-2/3 rounded-tr-[10px] bg-gradient-to-r from-transparent via-[var(--bg-color)] via-55% to-[var(--bg-color)]"
    />
    <div class="absolute right-2 -bottom-px h-px w-full bg-slate-400/30" />

    <div class="pointer-events-none relative top-px flex grow flex-row items-center">
      <WindowControls />
      <div class="relative top-px text-[19px] font-bold whitespace-nowrap">
        {{ APP_NAME }}
      </div>
      <InstanceMenu
        v-if="(NETWORK_NAME !== 'mainnet' || instances.length > 1) && controller.isLoaded && !controller.isImporting"
        :instances="instances"
      />

      <NavigationMenuRoot
        v-if="controller.isLoaded && !controller.isImporting"
        class="pointer-events-none relative mr-3 flex grow flex-row items-center justify-end"
        :class="[wallets.isLoaded ? '' : 'opacity-20']"
        :model-value="navigationMenuValue"
        :delay-duration="0"
        :skip-delay-duration="0"
        @update:model-value="setNavigationMenuValue"
      >
        <NavigationMenuList
          class="relative top-px flex flex-row items-center space-x-2"
          @mouseenter="clearNavigationMenuClose"
        >
          <!--<div-->
          <!--  @click="openVaultsOverlay"-->
          <!--  class="group pointer-events-auto flex h-[30px] cursor-pointer flex-row items-center justify-center rounded-md border border-slate-400/50 px-3 font-semibold hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none"-->
          <!--&gt;-->
          <!--  <GiftIcon class="text-argon-600/70 -mt-0.5 mr-2 h-4 w-4" />-->
          <!--  <div class="group-hover:text-argon-600 text-slate-900/70">A Free Gift from Josh!</div>-->
          <!--</div>-->
          <div
            v-if="config.upstreamOperator"
            @click="openVaultsOverlay"
            class="group pointer-events-auto flex h-[30px] cursor-pointer flex-row items-center rounded-md border border-slate-400/50 px-3 font-semibold hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none"
          >
            <div
              :class="config.upstreamOperator ? 'bg-argon-600' : 'bg-slate-400/50'"
              class="mr-2 h-3 w-3 rounded-full"
            />
            <div v-if="config.upstreamOperator" class="text-argon-600/70">
              Connected to {{ upstreamOperatorName }} Vault
            </div>
            <div v-else class="group-hover:text-argon-600 text-slate-900/70">Connect a Vault</div>
          </div>
          <div class="pointer-events-auto">
            <PortfolioMenu ref="currencyMenuRef" />
          </div>
          <div class="pointer-events-auto">
            <ProfitsMenu ref="returnsMenuRef" />
          </div>
          <div class="pointer-events-auto">
            <AccountMenu ref="accountMenuRef" />
          </div>
        </NavigationMenuList>
        <NavigationMenuIndicator
          :style="navigationMenuIndicatorZIndex"
          class="pointer-events-none absolute top-full left-0 flex h-[10px] w-[var(--reka-navigation-menu-indicator-size)] translate-x-[var(--reka-navigation-menu-indicator-position)] items-end justify-center transition-[width,transform,opacity] duration-300 data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100"
        >
          <div
            class="relative top-[-1px] h-0 w-0 border-x-[13px] border-b-[13px] border-x-transparent border-b-gray-900/20"
          >
            <div
              class="border-b-argon-menu-bg absolute top-[2px] left-[-11px] h-0 w-0 border-x-[11px] border-b-[11px] border-x-transparent"
            />
          </div>
        </NavigationMenuIndicator>
        <NavigationMenuViewport
          align="end"
          :style="navigationMenuViewportZIndex"
          class="bg-argon-menu-bg data-[state=closed]:animate-scaleOut data-[state=open]:animate-scaleIn pointer-events-auto absolute top-full left-[var(--reka-navigation-menu-viewport-left)] mt-[8px] h-[var(--reka-navigation-menu-viewport-height)] w-full origin-[top_center] overflow-visible rounded border border-gray-900/20 shadow-lg transition-[left,_width,_height] duration-300 sm:w-[var(--reka-navigation-menu-viewport-width)]"
          @mouseenter="clearNavigationMenuClose"
        />
      </NavigationMenuRoot>
    </div>
  </div>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import { NavigationMenuRoot, NavigationMenuList, NavigationMenuViewport, NavigationMenuIndicator } from 'reka-ui';
import { useTreasuryController } from '../../stores/treasuryController.ts';
import { useWallets } from '../../stores/wallets.ts';
import { getConfig, NETWORK_NAME } from '../../stores/config.ts';
import { APP_NAME, INSTANCE_NAME } from '../../lib/Env.ts';
import WindowControls from '../../tauri-controls/WindowControls.vue';
import InstanceMenu from '../../navigation/InstanceMenu.vue';
import { IInstance } from '../../navigation/InstanceMenu.vue';
import { appConfigDir } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import basicEmitter from '../../emitters/basicEmitter.ts';
import PortfolioMenu from './PortfolioMenu.vue';
import ProfitsMenu from '../../navigation/ProfitsMenu.vue';
import AccountMenu from './AccountMenu.vue';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';

const config = getConfig();
const wallets = useWallets();
const controller = useTreasuryController();
const navigationMenuViewportZIndex = useFloatingZIndex();
const navigationMenuIndicatorZIndex = useFloatingZIndex(2);

const navigationMenuValue = Vue.ref('');
let navigationMenuCloseTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

const instances = Vue.ref<IInstance[]>([]);

const upstreamOperatorName = Vue.computed(() => {
  const upstreamOperator = config.upstreamOperator;
  if (!upstreamOperator) return '';
  if (!upstreamOperator.name) return 'Unnamed';
  return toPossessive(upstreamOperator.name);
});

async function fetchInstances() {
  try {
    const configDir = await appConfigDir();
    const entries = await readDir(`${configDir}/${NETWORK_NAME}`);
    instances.value = entries
      .filter(entry => entry.isDirectory)
      .map(entry => ({
        name: entry.name,
        isSelected: entry.name === INSTANCE_NAME,
      }));
  } catch {
    instances.value = [
      {
        name: INSTANCE_NAME,
        isSelected: true,
      },
    ];
  }
}

function toPossessive(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';

  return trimmed.endsWith('s') ? `${trimmed}'` : `${trimmed}'s`;
}

function openVaultsOverlay() {
  if (config.upstreamOperator?.vaultId) {
  } else {
    basicEmitter.emit('openVaultsOverlay');
  }
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

Vue.onMounted(async () => {
  await fetchInstances();
});
</script>
