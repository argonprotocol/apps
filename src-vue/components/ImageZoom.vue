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
      <DialogOverlay asChild class="fixed inset-0 z-100 bg-black/70 backdrop-blur-sm">
        <Motion asChild :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }">
          <BgOverlay @close="zoomOpen = false" />
        </Motion>
      </DialogOverlay>
      <DialogContent
        class="fixed inset-0 z-[110] flex items-center justify-center p-4 focus:outline-none"
        style="pointer-events: none"
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
import { Motion } from 'motion-v';
import BgOverlay from './BgOverlay.vue';

const props = defineProps<{
  src: string;
  alt: string;
  addClasses?: string;
}>();

const zoomOpen = ref(false);
</script>
