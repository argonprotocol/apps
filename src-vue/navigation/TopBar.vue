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
        Management Console
        <InstanceMenu v-if="NETWORK_NAME !== 'mainnet' || instances.length > 1" :instances="instances" />
      </div>
    </div>

    <div class="flex w-1/3 justify-center pointer-events-none relative left-1.5">
      <TabSwitcher />
    </div>

    <div v-if="controller.isLoaded"
      class="flex flex-row mr-3 space-x-2 items-center justify-end w-1/3 grow pointer-events-none relative top-[1px]"
      :class="[wallets.isLoaded ? '' : 'opacity-20']"
    >
      <div :class="[controller.screenKey === ScreenKey.Mining && bot.isSyncing ? 'pointer-events-none' : 'pointer-events-auto']">
        <PortfolioMenu ref="portfolioMenuRef" />
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
import PortfolioMenu from './PortfolioMenu.vue';
import StatusMenu from './StatusMenu.vue';
import AccountMenu from './AccountMenu.vue';
import InstanceMenu from './InstanceMenu.vue';
import { useWallets } from '../stores/wallets';
import { getBot } from '../stores/bot';
import { ScreenKey } from '../interfaces/IConfig.ts';
import { useTour } from '../stores/tour';
import { appConfigDir } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import { INSTANCE_NAME, NETWORK_NAME } from '../lib/Env.ts';
import { IInstance } from './InstanceMenu.vue';
import TabSwitcher from './TabSwitcher.vue';

const controller = useController();
const wallets = useWallets();
const tour = useTour();
const bot = getBot();

const portfolioMenuRef = Vue.ref<InstanceType<typeof PortfolioMenu> | null>(null);
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
tour.registerPositionCheck('portfolioMenu', () => {
  const currencyMenuElem = portfolioMenuRef.value?.$el;
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
