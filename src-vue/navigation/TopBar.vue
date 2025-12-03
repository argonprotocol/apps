<!-- prettier-ignore -->
<template>
  <div
    class="bg-white/95 min-h-14 w-full flex flex-row items-center select-none"
    style="border-radius: 10px 10px 0 0; box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2)"
    data-tauri-drag-region
  >
    <div class="flex flex-row items-center w-1/3 pointer-events-none relative top-px">
      <WindowControls />
      <div class="text-[19px] font-bold whitespace-nowrap">
        <span class="hidden xl:inline">Argon</span> Investor Console
        <InstanceMenu v-if="NETWORK_NAME !== 'mainnet' || instances.length > 1" :instances="instances" />
      </div>
    </div>

    <div class="flex w-1/3 justify-center pointer-events-none">
      <ul
        ref="toggleRef"
        class="TOGGLE flex flex-row fit-content bg-[#E9EBF1] border border-[#b8b9bd] rounded text-center text-slate-600 pointer-events-auto"
      >
        <li
          class="border-r border-slate-400"
          @click="controller.setScreenKey(ScreenKey.Mining)"
          :class="{ selected: controller.screenKey === ScreenKey.Mining }"
        >
          <span class="relative px-2 text-center">
            <div :class="{ invisible: controller.screenKey === ScreenKey.Mining }">Mining</div>
            <div v-if="controller.screenKey === ScreenKey.Mining" class="absolute top-0 left-0 w-full h-full font-bold">Mining</div>
          </span>
        </li>
        <li @click="controller.setScreenKey(ScreenKey.Vaulting)" :class="{ selected: controller.screenKey === ScreenKey.Vaulting }">
          <span class="relative px-1 text-center">
            <div :class="{ invisible: controller.screenKey === ScreenKey.Vaulting }">Vaulting</div>
            <div v-if="controller.screenKey === ScreenKey.Vaulting" class="absolute top-0 left-0 w-full h-full font-bold">
              Vaulting
            </div>
          </span>
        </li>
      </ul>
    </div>

    <div v-if="controller.isLoaded"
      class="flex flex-row mr-3 space-x-2 items-center justify-end w-1/3 grow pointer-events-none relative top-[1px]"
      :class="[wallets.isLoaded ? '' : 'opacity-20']"
    >
      <div :class="[controller.screenKey === ScreenKey.Mining && bot.isSyncing ? 'pointer-events-none' : 'pointer-events-auto']">
        <StatusMenu />
      </div>
      <div :class="[controller.screenKey === ScreenKey.Mining && bot.isSyncing ? 'pointer-events-none' : 'pointer-events-auto']">
        <FinancialsMenu ref="financialsMenuRef" />
      </div>
      <div :class="[controller.screenKey === ScreenKey.Mining && bot.isSyncing ? 'pointer-events-none' : 'pointer-events-auto']">
        <AccountMenu ref="accountMenuRef" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useController } from '../stores/controller';
import WindowControls from '../tauri-controls/WindowControls.vue';
import FinancialsMenu from './FinancialsMenu.vue';
import StatusMenu from './StatusMenu.vue';
import AccountMenu from './AccountMenu.vue';
import InstanceMenu from './InstanceMenu.vue';
import { useWallets } from '../stores/wallets';
import { useBot } from '../stores/bot';
import { ScreenKey } from '../interfaces/IConfig.ts';
import { ITourPos, useTour } from '../stores/tour';
import { appConfigDir } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import { INSTANCE_NAME, NETWORK_NAME } from '../lib/Env.ts';
import { IInstance } from './InstanceMenu.vue';

const controller = useController();
const wallets = useWallets();
const tour = useTour();
const bot = useBot();

const toggleRef = Vue.ref<HTMLElement | null>(null);

const financialsMenuRef = Vue.ref<InstanceType<typeof FinancialsMenu> | null>(null);
const accountMenuRef = Vue.ref<InstanceType<typeof AccountMenu> | null>(null);

const instances = Vue.ref<IInstance[]>([]);

async function fetchInstances() {
  const configDir = await appConfigDir();

  const entries = await readDir(`${configDir}/${NETWORK_NAME}`);
  instances.value = entries
    .filter(entry => entry.isDirectory)
    .map(entry => ({
      name: entry.name,
      isSelected: entry.name === INSTANCE_NAME,
    }));
}

tour.registerPositionCheck('miningTab', (): ITourPos => {
  const rect = toggleRef.value?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 20;
  rect.right += 20;
  rect.top -= 10;
  rect.bottom += 10;
  return rect;
});

tour.registerPositionCheck('vaultingTab', () => {
  const rect = toggleRef.value?.getBoundingClientRect().toJSON() || { left: 0, right: 0, top: 0, bottom: 0 };
  rect.left -= 20;
  rect.right += 20;
  rect.top -= 10;
  rect.bottom += 10;
  return rect;
});

tour.registerPositionCheck('currencyMenu', () => {
  const currencyMenuElem = financialsMenuRef.value?.$el;
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

Vue.onMounted(async () => {
  await fetchInstances();
});
</script>

<style scoped>
@reference "../main.css";

ul.TOGGLE {
  position: relative;
  box-shadow: inset 1px 1px 2px rgba(0, 0, 0, 0.2);
  white-space: nowrap;
  &[disabled='true'] {
    pointer-events: none;
  }
  &[isRunning='true'] li {
    opacity: 0.5 !important;
  }
  li {
    z-index: 1;
    cursor: pointer;
    padding: 4px 30px;
    transition: opacity 0.3s ease;
    position: relative;
    span {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
      z-index: 2;
    }
  }
  li.selected {
    color: #99009d;
  }
  li.selected:after {
    content: '';
    width: calc(100% + 2px);
    height: calc(100% + 2px);
    position: absolute;
    top: -1px;
    left: -1px;
    background: white;
    border-radius: 5px;
    border: 1px solid #979797;
    box-shadow: 0 1px rgba(0, 0, 0, 0.1);
    cursor: default;
    transition: left 0.3s ease;
    z-index: 1;
  }
  li:not(.selected) {
    opacity: 0.3;
  }
  li:last-child.selected:after {
    left: -1px;
  }
}
</style>
