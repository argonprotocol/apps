<template>
  <img
    :src="src"
    :alt="alt"
    class="cursor-zoom-in rounded-md border border-black object-cover"
    :class="addClasses"
    @click="zoomOpen = true"
  />

  <DialogRoot :open="zoomOpen" @update:open="zoomOpen = $event">
    <DialogPortal>
      <DialogOverlay asChild class="fixed inset-0 bg-black/70 backdrop-blur-xs">
        <BgOverlay :style="{ zIndex: overlayZIndex.backdropZIndex }" @close="zoomOpen = false" />
      </DialogOverlay>
      <DialogContent
        class="fixed inset-0 flex items-center justify-center p-4 focus:outline-none"
        :style="{ pointerEvents: 'none', zIndex: overlayZIndex.contentZIndex }"
      >
        <img
          :src="src"
          :alt="alt"
          class="pointer-events-auto max-h-[90vh] max-w-[90vw] cursor-zoom-out rounded-md shadow-lg"
          @click="zoomOpen = false"
        />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { DialogRoot, DialogOverlay, DialogPortal, DialogContent } from 'reka-ui';
import BgOverlay from './BgOverlay.vue';
import { useOverlayZIndex } from '../overlays/helpers/OverlayZIndex.ts';

const props = defineProps<{
  src: string;
  alt: string;
  addClasses?: string;
}>();

const zoomOpen = ref(false);
const overlayZIndex = useOverlayZIndex(() => zoomOpen.value);
</script>
