<template>
  <OverlayBase :isOpen="isOpen" title="Create Stabilizer" @close="emit('close')" />
</template>

<script setup lang="ts">
import OverlayBase from './OverlayBase.vue';

defineProps<{ isOpen: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>
