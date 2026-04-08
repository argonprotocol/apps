<template>
  <div
    class="relative flex min-h-14 w-full flex-row items-center border-b-[1px] border-slate-400/40 bg-white/95 select-none"
    style="border-radius: 10px 10px 0 0; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15)"
    data-tauri-drag-region>
    <div
      class="pointer-events-none absolute top-0 right-0 h-[calc(100%+4px)] w-2/3 rounded-tr-[10px] bg-gradient-to-r from-transparent via-[var(--bg-color)] via-55% to-[var(--bg-color)]"></div>
    <div class="absolute right-2 -bottom-px h-px w-full bg-slate-400/30" />
    <div class="pointer-events-none relative top-px flex w-1/2 flex-row items-center">
      <WindowControls />
      <div class="text-[19px] font-bold whitespace-nowrap">
        {{ APP_NAME }}
        <InstanceMenu v-if="NETWORK_NAME !== 'mainnet' || instances.length > 1" :instances="instances" />
      </div>
    </div>

    <div
      v-if="controller.isLoaded && !controller.isImporting"
      class="pointer-events-none relative top-[1px] mr-3 flex w-1/2 grow flex-row items-center justify-end space-x-2"
      :class="[wallets.isLoaded ? '' : 'opacity-20']">
      <div
        v-if="config.upstreamOperator"
        class="text-argon-600/70 flex h-[30px] cursor-pointer flex-row items-center rounded-md border border-slate-400/50 px-3 font-semibold hover:border-slate-400/50 hover:bg-slate-400/10 focus:outline-none">
        <div class="bg-argon-600 mr-2 h-3 w-3 rounded-full"></div>
        <div>Connected to {{ toPossessive(config.upstreamOperator.name) }} Vault</div>
      </div>
      <div class="pointer-events-auto relative">
        <AccountMenu ref="accountMenuRef" />
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import AccountMenu from './AccountMenu.vue';
import { useTreasuryController } from '../../stores/treasuryController.ts';
import { useWallets } from '../../stores/wallets.ts';
import { getConfig, NETWORK_NAME } from '../../stores/config.ts';
import { APP_NAME, INSTANCE_NAME } from '../../lib/Env.ts';
import WindowControls from '../../tauri-controls/WindowControls.vue';
import InstanceMenu from '../../app-shared/navigation/InstanceMenu.vue';
import { IInstance } from '../../app-shared/navigation/InstanceMenu.vue';
import * as Vue from 'vue';
import { appConfigDir } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';

const config = getConfig();
const wallets = useWallets();
const controller = useTreasuryController();

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

function toPossessive(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';

  return trimmed.endsWith('s') ? `${trimmed}'` : `${trimmed}'s`;
}

Vue.onMounted(async () => {
  await fetchInstances();
});
</script>
