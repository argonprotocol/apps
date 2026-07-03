<!-- prettier-ignore -->
<template>
  <div ref="rootRef">
    <NavigationMenuItem class="pointer-events-auto">
      <NavigationMenuTrigger
        Trigger
        class="font-light inline-block text-md border border-slate-600/30 rounded-l-md text-slate-800/80 px-3 ml-2 h-[30px] focus:outline-none relative -top-[0.5px]"
        :class="[isOpen ? 'border-slate-400/60 bg-slate-400/10' : 'border-slate-400/50']"
      >
        <template v-if="networkName !== 'mainnet'">{{ networkName }}:</template>{{ INSTANCE_NAME?.slice(0, 10) }}<template v-if="INSTANCE_NAME.length > 10">...</template>
      </NavigationMenuTrigger>

      <NavigationMenuContent
        class="data-[motion=from-start]:animate-enterFromLeft data-[motion=from-end]:animate-enterFromRight data-[motion=to-start]:animate-exitToLeft data-[motion=to-end]:animate-exitToRight absolute top-0 left-0 w-full sm:w-auto"
      >
        <div class="min-w-40 bg-argon-menu-bg flex shrink flex-col rounded p-1 text-sm/6 font-semibold text-gray-900 shadow-lg ring-1 ring-gray-900/20">
          <template v-for="instance in props.instances" :key="instance.name">
            <NavigationMenuLink @click="() => openInstance(instance)" class="flex flex-row py-2 items-center">
              <div ItemWrapper>{{ instance.name }}</div>
              <span v-if="instance.isSelected">
                <CheckIcon class="size-5" aria-hidden="true" />
              </span>
            </NavigationMenuLink>
            <div divider class="my-1 h-[1px] w-full bg-slate-400/30" />
          </template>
        </div>
      </NavigationMenuContent>
    </NavigationMenuItem>
  </div>
</template>

<script lang="ts">
export interface IInstance {
  name: string;
  isSelected: boolean;
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import { NavigationMenuItem, NavigationMenuTrigger, NavigationMenuContent, NavigationMenuLink } from 'reka-ui';
import { INSTANCE_NAME, NETWORK_NAME } from '../lib/Env.ts';
import { invokeWithTimeout } from '../lib/tauriApi.ts';
import { CheckIcon } from '@heroicons/vue/20/solid';

const isOpen = Vue.ref(false);
const rootRef = Vue.ref<HTMLElement>();

const props = defineProps<{
  instances: IInstance[];
}>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

const networkName = NETWORK_NAME.replace('dev-docker', 'docknet');

async function openInstance(instance: IInstance) {
  await invokeWithTimeout('load_instance', { name: instance.name }, 10000);
  isOpen.value = false;
}
</script>

<style scoped>
@reference "../main.css";

[data-reka-collection-item] {
  @apply focus:bg-argon-menu-hover cursor-pointer px-3 focus:!text-indigo-600 focus:outline-none;

  &[data-disabled] {
    opacity: 0.3;
    pointer-events: none;
  }
  [ItemWrapper] {
    @apply grow text-left font-bold whitespace-nowrap text-gray-900;
  }
}

[divider]:last-child {
  display: none;
}
</style>
