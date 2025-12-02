<template>
  <DialogRoot class="absolute inset-0 z-10" :open="isOpen">
    <DialogPortal>
      <DialogOverlay asChild>
        <BgOverlay @close="closeOverlay" />
      </DialogOverlay>

      <DialogContent @escapeKeyDown="closeOverlay" :aria-describedby="undefined">
        <div
          class="ConnectOverlay inner-input-shadow bg-argon-menu-bg absolute top-[40px] right-3 bottom-3 left-3 z-20 flex flex-col overflow-auto rounded-md border border-black/30 text-left transition-all focus:outline-none"
          style="
            box-shadow:
              0 -1px 2px 0 rgba(0, 0, 0, 0.1),
              inset 0 2px 0 rgba(255, 255, 255, 1);
          ">
          <TabsRoot
            class="flex h-full w-full flex-col"
            :model-value="selectedTab"
            @update:modelValue="selectedTab = $event">
            <div class="flex h-full w-full flex-col px-4">
              <h2
                class="relative flex flex-row pt-5 pb-4 pl-3 text-left text-3xl font-bold whitespace-nowrap text-[#672D73]"
                style="box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1)">
                <DialogTitle as="div" class="relative z-10 w-1/3 min-w-fit pr-10">Connect a Mining Machine</DialogTitle>
                <TabsList
                  class="relative -ml-3 flex w-1/3 min-w-fit divide-x divide-slate-400/60 rounded-lg border border-slate-400/60 text-base text-slate-400/80">
                  <TabsTrigger
                    class="hover:text-argon-700/60 data-[state=active]:text-argon-600 flex flex-1 cursor-pointer items-center justify-center rounded-tl-md px-5 leading-none outline-none select-none data-[state=active]:font-bold"
                    value="digitalOcean">
                    Digital Ocean
                  </TabsTrigger>
                  <TabsTrigger
                    data-testid="ServerConnectOverlay.selectedTab='local'"
                    class="hover:text-argon-700/60 data-[state=active]:text-argon-600 flex flex-1 cursor-pointer items-center justify-center rounded-tl-md px-5 leading-none outline-none select-none data-[state=active]:font-bold"
                    value="localComputer">
                    Local Computer
                  </TabsTrigger>
                  <TabsTrigger
                    class="hover:text-argon-700/60 data-[state=active]:text-argon-600 flex flex-1 cursor-pointer items-center justify-center rounded-tl-md px-5 leading-none outline-none select-none data-[state=active]:font-bold"
                    value="customServer">
                    Custom Server
                  </TabsTrigger>
                </TabsList>
                <div
                  @click="closeOverlay"
                  class="absolute top-[22px] right-[0px] z-10 flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/70 hover:bg-[#D6D9DF] focus:outline-none">
                  <XMarkIcon class="h-5 w-5 stroke-4 text-[#B74CBA]" />
                </div>
              </h2>

              <div MainContent class="relative flex grow flex-col">
                <TabsContent value="digitalOcean" class="mx-5 flex grow flex-col p-3">
                  <DigitalOcean ref="digitalOceanRef" @ready="updateDigitalOceanStatus" />
                </TabsContent>

                <TabsContent value="localComputer" class="grow">
                  <LocalComputer ref="localComputerRef" @ready="updateLocalComputerStatus" />
                </TabsContent>

                <TabsContent value="customServer">
                  <CustomServer ref="customServerRef" @ready="updateCustomServerStatus" />
                </TabsContent>
              </div>

              <div class="mx-4 flex flex-row justify-end space-x-4 rounded-b-lg border-t border-slate-300 py-4">
                <div v-if="serverCreationError" class="flex grow items-center rounded-md bg-red-200 p-2 pl-4">
                  <div class="flex">
                    <div class="shrink-0">
                      <ExclamationTriangleIcon class="size-5 text-red-400" aria-hidden="true" />
                    </div>
                    <div class="ml-3 text-sm font-medium text-red-800">
                      {{ serverCreationError }}
                    </div>
                  </div>
                </div>
                <button
                  @click="closeOverlay"
                  class="border-argon-button/50 cursor-pointer rounded-md border px-7 py-1 text-xl font-bold text-gray-500">
                  <span>Close</span>
                </button>
                <button
                  @click="connect"
                  :disabled="!isReadyToConnect()"
                  class="bg-argon-button rounded-md px-7 py-1 text-xl font-bold text-white"
                  :class="[isReadyToConnect() ? 'cursor-pointer' : 'cursor-default bg-[#A600D4]/50 opacity-30']">
                  <template v-if="selectedTab === 'digitalOcean'">
                    <span v-if="!isSaving">Connect Digital Ocean</span>
                    <span v-else>Connecting Digital Ocean...</span>
                  </template>
                  <template v-else-if="selectedTab === 'localComputer'">
                    <span v-if="!isSaving">Connect Local Computer</span>
                    <span v-else>Connecting Local Computer...</span>
                  </template>
                  <template v-else-if="selectedTab === 'customServer'">
                    <span v-if="!isSaving">Connect Custom Server</span>
                    <span v-else>Connecting Custom Server...</span>
                  </template>
                </button>
              </div>
            </div>
          </TabsRoot>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script lang="ts">
import {
  IConfigServerCreation,
  IConfigServerCreationCustomServer,
  IConfigServerCreationDigitalOcean,
  IConfigServerCreationLocalComputer,
} from '../interfaces/IConfig';

export interface IServerConnectChildExposed {
  connect: () => Promise<
    IConfigServerCreationDigitalOcean | IConfigServerCreationLocalComputer | IConfigServerCreationCustomServer
  >;
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import basicEmitter from '../emitters/basicEmitter';
import { useConfig, Config } from '../stores/config';
import BgOverlay from '../components/BgOverlay.vue';
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from 'reka-ui';
import DigitalOcean from './server-connect/DigitalOcean.vue';
import LocalComputer from './server-connect/LocalComputer.vue';
import CustomServer from './server-connect/CustomServer.vue';
import { MiningMachine } from '../lib/MiningMachine.ts';
import { useWalletKeys } from '../stores/wallets.ts';

const config = useConfig();
const walletKeys = useWalletKeys();

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);
const isSaving = Vue.ref(false);

const selectedTab = Vue.ref('digitalOcean');
const serverCreationError = Vue.ref('');

const digitalOceanRef = Vue.ref<InstanceType<typeof DigitalOcean>>();
const localComputerRef = Vue.ref<InstanceType<typeof LocalComputer>>();
const customServerRef = Vue.ref<InstanceType<typeof CustomServer>>();

const isDigitalOceanReady = Vue.ref(false);
const isLocalComputerReady = Vue.ref(false);
const isCustomServerReady = Vue.ref(false);

basicEmitter.on('openServerConnectOverlay', async () => {
  isOpen.value = true;
  isLoaded.value = true;
  serverCreationError.value = '';

  if (config.serverCreation?.localComputer) {
    selectedTab.value = 'localComputer';
  } else if (config.serverCreation?.customServer) {
    selectedTab.value = 'customServer';
  }
});

const closeOverlay = () => {
  isOpen.value = false;
  isLoaded.value = false;
};

function updateDigitalOceanStatus(isReady: boolean) {
  isDigitalOceanReady.value = isReady;
}

function updateLocalComputerStatus(isReady: boolean) {
  isLocalComputerReady.value = isReady;
}

function updateCustomServerStatus(isReady: boolean) {
  isCustomServerReady.value = isReady;
  serverCreationError.value = '';
}

function isReadyToConnect() {
  if (selectedTab.value === 'digitalOcean' && !isDigitalOceanReady.value) return false;
  if (selectedTab.value === 'localComputer' && !isLocalComputerReady.value) return false;
  if (selectedTab.value === 'customServer' && !isCustomServerReady.value) return false;
  return !isSaving.value;
}

async function connect() {
  isSaving.value = true;
  serverCreationError.value = '';

  try {
    config.serverCreation = await extractServerCreation();
    config.resetField('installDetails');

    if (config.serverCreation.customServer?.hasRunningBot) {
      config.serverDetails = await MiningMachine.setup(config as Config, walletKeys);
      config.hasReadMiningInstructions = true;
      config.isMinerInstalled = true;
      config.isMinerReadyToInstall = true;
      config.isMinerInstalling = true;
      config.isMiningMachineCreated = true;
      config.isPreparingMinerSetup = true;
    }

    await config.save();
  } catch (error: any) {
    serverCreationError.value = error.message;
    throw error;
  } finally {
    isSaving.value = false;
  }

  closeOverlay();
}

async function extractServerCreation(): Promise<IConfigServerCreation> {
  if (selectedTab.value === 'digitalOcean') {
    return { digitalOcean: (await digitalOceanRef.value?.connect()) as IConfigServerCreationDigitalOcean };
  }
  if (selectedTab.value === 'localComputer') {
    return { localComputer: (await localComputerRef.value?.connect()) as IConfigServerCreationLocalComputer };
  }
  return { customServer: (await customServerRef.value?.connect()) as IConfigServerCreationCustomServer };
}

Vue.watch(selectedTab, () => {
  serverCreationError.value = '';
});
</script>

<style scoped>
@reference "../main.css";

.ConnectOverlay {
  h2 {
    position: relative;
    &:before {
      @apply from-argon-menu-bg bg-gradient-to-r to-transparent;
      content: '';
      display: block;
      width: 30px;
      position: absolute;
      z-index: 1;
      left: -5px;
      top: 0;
      bottom: -5px;
    }
    &:after {
      @apply from-argon-menu-bg bg-gradient-to-l to-transparent;
      content: '';
      display: block;
      width: 30px;
      position: absolute;
      z-index: 1;
      right: -5px;
      top: 0;
      bottom: -5px;
    }
  }
}
</style>
