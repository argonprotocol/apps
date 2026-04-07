<!-- prettier-ignore -->
<template>
  <p class="text-md text-slate-500 px-3">Feature Coming Soon.</p>
</template>

<script setup lang="ts">
const emit = defineEmits(['close', 'goTo']);

function closeOverlay() {
  emit('close');
}

function goBack() {
  emit('goTo', 'overview');
}
</script>
