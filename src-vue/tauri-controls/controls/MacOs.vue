<script setup lang="ts">
import { twMerge } from 'tailwind-merge';
import { ref } from 'vue';
import Button from '../components/Button.vue';
import Icons from '../components/Icons.vue';
import { closeWindow, fullscreenWindow, maximizeWindow, minimizeWindow, isWindowFullscreen } from '../utils/os';

const winBtns = ref(null);
const isMouseOver = ref(false);
const isAltKeyPressed = ref(false); // Option Key

function handleExpandWindow(event: MouseEvent) {
  isAltKeyPressed.value = event.altKey;
  isMouseOver.value = false;
  if (isAltKeyPressed.value) {
    isAltKeyPressed.value = false;
    maximizeWindow();
  } else {
    fullscreenWindow();
  }
}

function handleMouseOver(event: MouseEvent) {
  isMouseOver.value = true;
  isAltKeyPressed.value = event.altKey;
}

function handleMouseLeave() {
  isMouseOver.value = false;
}

function handleKeyPress(event: KeyboardEvent) {
  isAltKeyPressed.value = event.altKey;
}

function handleKeyUp(event: KeyboardEvent) {
  isAltKeyPressed.value = event.altKey;
}
</script>

<template>
  <div
    ref="winBtns"
    @mouseover="handleMouseOver"
    @mouseleave="handleMouseLeave"
    @keypress="handleKeyPress"
    @keyup="handleKeyUp"
    tabindex="0"
    :class="
      twMerge(
        'space-x-2 text-black active:text-black dark:text-black',
        isWindowFullscreen ? 'px-2' : 'px-3',
        $attrs.class as string,
      )
    "
  >
    <Button
      v-if="!isWindowFullscreen"
      @click="closeWindow"
      class="aspect-square h-3 w-3 content-center items-center justify-center self-center rounded-full border border-black/[.12] bg-[#ff544d] text-center text-black/60 hover:bg-[#ff544d] active:bg-[#bf403a] active:text-black/60 dark:border-none"
    >
      <Icons icon="closeMac" v-if="isMouseOver" />
    </Button>
    <Button
      v-if="!isWindowFullscreen"
      @click="minimizeWindow"
      class="aspect-square h-3 w-3 content-center items-center justify-center self-center rounded-full border border-black/[.12] bg-[#ffbd2e] text-center text-black/60 hover:bg-[#ffbd2e] active:bg-[#bf9122] active:text-black/60 dark:border-none"
    >
      <Icons icon="minMac" v-if="isMouseOver" />
    </Button>
    <Button
      v-if="!isWindowFullscreen"
      @click="handleExpandWindow"
      class="aspect-square h-3 w-3 content-center items-center justify-center self-center rounded-full border border-black/[.12] bg-[#28c93f] text-center text-black/60 hover:bg-[#28c93f] active:bg-[#1e9930] active:text-black/60 dark:border-none"
    >
      <template v-if="isMouseOver">
        <Icons icon="plusMac" v-if="isAltKeyPressed" />
        <Icons icon="fullMac" v-else />
      </template>
    </Button>
  </div>
</template>
