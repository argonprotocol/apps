<!-- prettier-ignore -->
<template>
  <SelectRoot v-model="selectedOption" @update:open="handleToggleOpen" @update:modelValue="handleUpdateModelValue">
    <SelectTrigger
      data-testid="input-menu-trigger"
      ref="triggerInstance"
      :class="triggerClasses"
    >
      <SelectValue class="whitespace-nowrap flex flex-row justify-between w-full font-mono text-sm">
        <span class="grow text-left">{{ selectedOption?.name|| 'Select Option...' }}</span>
        <span v-if="selectedOption?.microgons" class="text-right opacity-50 pl-5">{{ currency.symbol }}{{ microgonToMoneyNm(selectedOption.microgons).format('0,0.00') }}</span>
        <span v-if="selectedOption?.sats" class="text-right opacity-50 pl-5 pr-2">{{selectedOption.sats}} sat{{selectedOption.sats > 1n ? 's' : ''}}/vbyte</span>
      </SelectValue>
      <div class="relative size-4">
        <ChevronDownIcon v-if="!showMenu" class="size-4 text-gray-400" />
      </div>
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        class="bg-white cursor-default data-[side=bottom]:rounded-b-md data-[side=top]:rounded-t-md data-[side=bottom]:border-t-gray-400 data-[side=top]:border-b-gray-400 border border-slate-700/50 shadow-sm will-change-[opacity,transform] data-[side=top]:animate-slideDownAndFade data-[side=right]:animate-slideLeftAndFade data-[side=bottom]:animate-slideUpAndFade data-[side=left]:animate-slideRightAndFade z-[2000]"
        position="popper"
        :style="{ minWidth: menuWidth, maxHeight: 'var(--reka-select-content-available-height)' }"
        :avoidCollisions="true"
        :bodyLock="true"
        :collisionPadding="10"
        :sideOffset="-3"
        :sticky="'always'"
      >
        <SelectScrollUpButton class="absolute top-0 left-0 right-0 z-10 flex items-center justify-center h-[25px] bg-gradient-to-b from-[10px] from-white to-transparent">
          <ChevronUpIcon class="size-5 text-gray-400" />
        </SelectScrollUpButton>

        <SelectViewport class="p-[5px]">
          <SelectItem
            :data-testid="option.name"
            v-for="(option, index) in props.options"
            :key="index"
            :disabled="option.disabled"
            :class="[option.disabled ? 'opacity-50' : '']"
            :value="option"
            class="text-xs leading-none rounded-[3px] flex items-center h-[25px] pr-[10px] pl-[20px] relative select-none data-[highlighted]:outline-none data-[highlighted]:bg-argon-400 data-[highlighted]:text-white"
          >
            <SelectItemIndicator class="absolute left-0 w-[20px] inline-flex items-center justify-center">
              <CheckIcon class="size-4 text-white-400 block" />
            </SelectItemIndicator>
            <SelectItemText class="whitespace-nowrap flex flex-row justify-between w-full font-mono text-sm">
              <span class="grow text-left">{{ option.name }}</span>
              <span v-if="option.microgons" class="text-right opacity-50 pl-5">{{ currency.symbol }}{{ microgonToMoneyNm(option.microgons).format('0,0.00') }}</span>
              <span v-if="option.sats" class="text-right opacity-50 pl-5">{{option.sats}} sat{{option.sats > 1n ? 's' : ''}}/vbyte</span>
            </SelectItemText>
          </SelectItem>
        </SelectViewport>

        <SelectScrollDownButton class="absolute bottom-0 left-0 right-0 flex items-center justify-center h-[25px] bg-gradient-to-t from-[10px] from-white to-transparent">
          <ChevronDownIcon class="size-5 text-gray-400" />
        </SelectScrollDownButton>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { ChevronDownIcon, ChevronUpIcon, CheckIcon } from '@heroicons/vue/24/outline';
import { getCurrency } from '../stores/currency';
import { createNumeralHelpers } from '../lib/numeral';
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui';
const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

export type IOption = { name: string; value: string; microgons?: bigint; sats?: bigint; disabled?: boolean };

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    options: IOption[];
    disabled?: boolean;
    selectFirst?: boolean;
    class?: string;
  }>(),
  {
    disabled: false,
    selectFirst: false,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const showMenu = Vue.ref(false);
const triggerInstance = Vue.ref<any>(null);

const menuWidth = Vue.ref('auto');

const selectedOption: Vue.Ref<IOption | undefined> = Vue.ref(undefined);

const value = Vue.computed({
  get: () => props.modelValue,
  set: (value: string | undefined) => {
    if (value === undefined) {
      value = props.options[0].value;
    }
    emit('update:modelValue', value);
  },
});

const triggerClasses = Vue.computed(() => {
  const defaultClasses =
    'inline-flex w-full items-center justify-between rounded-md px-[10px] text-xs leading-none h-[30px] gap-[5px] bg-white hover:bg-stone-50 border border-slate-700/50 data-[placeholder]:text-gray-600 outline-none';
  return props.class ? `${defaultClasses} ${props.class}` : defaultClasses;
});

function handleUpdateModelValue(option: IOption) {
  selectedOption.value = option;
  if (option.value !== undefined) {
    value.value = option.value;
  }
}

function handleToggleOpen(isOpen: boolean) {
  const el = triggerInstance.value.$el as HTMLElement;
  const rect = el.getBoundingClientRect();
  menuWidth.value = `${rect.width}px`;
}

Vue.watch(
  () => [props.modelValue, props.selectFirst, props.options],
  () => {
    const foundOption = props.options.find(x => x.value === props.modelValue);
    if (foundOption) {
      selectedOption.value = foundOption;
    } else if (props.selectFirst && props.options.length > 0) {
      selectedOption.value = props.options[0];
    } else {
      selectedOption.value = undefined;
    }
  },
  { deep: true, immediate: true },
);
</script>

<style scoped>
@reference "../main.css";

ul {
  @apply flex flex-col;
}

ul li {
  @apply border-b border-gray-300;
}
</style>
