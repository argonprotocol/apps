<template>
  <PopoverRoot :open="props.open">
    <PopoverAnchor asChild><slot /></PopoverAnchor>
    <PopoverPortal>
      <PopoverContent
        class="flex"
        :side="props.side ?? 'right'"
        :align="props.side === 'top' ? 'end' : 'center'"
        :sideOffset="12"
        :avoidCollisions="false"
        :style="floatingZIndex"
        @openAutoFocus.prevent
        @closeAutoFocus.prevent
        @interactOutside.prevent
        @escapeKeyDown="emit('close')"
      >
        <ArrowCalloutButton
          :autoOpenGuidance="props.open && props.autoOpenGuidance"
          :label="props.label"
          :guidance="props.guidance"
          :guidanceAlign="props.guidanceAlign"
          :position="props.guidancePosition"
          :showArrow="props.side !== 'top'"
          :direction="props.side === 'left' ? 'right' : 'left'"
        >
          <template v-if="$slots.guidanceActions" #guidanceActions><slot name="guidanceActions" /></template>
        </ArrowCalloutButton>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';
import { computed } from 'vue';
import { provideOverlayContentZIndex, useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';

const props = defineProps<{
  open: boolean;
  autoOpenGuidance?: boolean;
  guidance: string;
  guidanceAlign?: 'center' | 'end';
  label?: string;
  side?: 'right' | 'left' | 'top';
  guidancePosition?: 'top' | 'bottom' | 'right';
}>();
const emit = defineEmits<{ (event: 'close'): void }>();
const floatingZIndex = useFloatingZIndex();
provideOverlayContentZIndex(computed(() => floatingZIndex.value.zIndex));
</script>
