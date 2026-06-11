<!-- prettier-ignore -->
<template>
  <div ref="rootRef">
    <NavigationMenuRoot
      class="pointer-events-none relative mr-3 flex flex-row items-center"
      :class="[wallets.isLoaded ? '' : 'opacity-20']"
      :model-value="navigationMenuValue"
      :delay-duration="0"
      :skip-delay-duration="0"
      @update:model-value="setNavigationMenuValue"
    >
      <NavigationMenuList class="relative flex flex-row items-center space-x-2" @mouseenter="clearNavigationMenuClose">
        <NavigationMenuItem class="pointer-events-auto">
          <NavigationMenuTrigger
            Trigger
            class="font-light inline-block text-md border border-slate-600/30 rounded-md text-slate-800/80 px-3 ml-2 h-[30px] focus:outline-none relative -top-[0.5px]"
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
      </NavigationMenuList>
      <NavigationMenuIndicator
        class="pointer-events-none absolute top-full left-0 z-[2001] flex h-[10px] w-[var(--reka-navigation-menu-indicator-size)] translate-x-[var(--reka-navigation-menu-indicator-position)] items-end justify-center transition-[width,transform,opacity] duration-300 data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100"
      >
        <div class="relative top-[-1px] h-0 w-0 border-x-[13px] border-b-[13px] border-x-transparent border-b-gray-900/20">
          <div class="absolute top-[2px] left-[-11px] h-0 w-0 border-x-[11px] border-b-[11px] border-x-transparent border-b-argon-menu-bg" />
        </div>
      </NavigationMenuIndicator>
      <NavigationMenuViewport
        align="end"
        class="pointer-events-auto absolute top-full right-[var(--reka-navigation-menu-viewport-left)] z-[2000] mt-[8px] h-[var(--reka-navigation-menu-viewport-height)] w-full origin-[top_center] overflow-visible rounded border border-gray-900/20 bg-argon-menu-bg shadow-lg transition-[left,_width,_height] duration-300 data-[state=closed]:animate-scaleOut data-[state=open]:animate-scaleIn sm:w-[var(--reka-navigation-menu-viewport-width)]"
        @mouseenter="clearNavigationMenuClose"
      />
    </NavigationMenuRoot>
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
import {
  NavigationMenuItem,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuLink,
  NavigationMenuRoot,
  NavigationMenuList,
  NavigationMenuViewport,
  NavigationMenuIndicator,
} from 'reka-ui';
import { INSTANCE_NAME, NETWORK_NAME } from '../../lib/Env.ts';
import { invokeWithTimeout } from '../../lib/tauriApi.ts';
import { CheckIcon } from '@heroicons/vue/20/solid';
import { useWallets } from '../../stores/wallets.ts';

const wallets = useWallets();

const isOpen = Vue.ref(false);
const rootRef = Vue.ref<HTMLElement>();

const navigationMenuValue = Vue.ref('');
let navigationMenuCloseTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

const props = defineProps<{
  instances: IInstance[];
}>();

// Expose the root element to parent components
defineExpose({
  $el: rootRef,
});

const networkName = NETWORK_NAME.replace('dev-docker', 'docknet');

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

async function openInstance(instance: IInstance) {
  await invokeWithTimeout('load_instance', { name: instance.name }, 10000);
  isOpen.value = false;
}
</script>

<style scoped>
@reference "../../main.css";

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
