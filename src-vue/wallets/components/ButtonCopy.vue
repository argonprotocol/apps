<template>
  <CopyToClipboard
    NotDraggable
    :content="props.address"
    class="relative z-10 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-sm/6 font-semibold hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
  >
    <CopyIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-500/60" />
    <template #copying>
      <div class="flex h-full w-full items-center justify-center rounded-md bg-[#f1f3f7]">
        <CheckIcon class="pointer-events-none h-5 w-5 stroke-2 text-green-600" />
      </div>
    </template>
  </CopyToClipboard>
</template>

<script setup lang="ts">
import { CheckIcon } from '@heroicons/vue/24/outline';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import CopyIcon from '../../assets/copy.svg';

const props = defineProps<{
  address: string;
}>();
</script>
