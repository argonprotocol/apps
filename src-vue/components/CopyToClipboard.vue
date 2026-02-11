<!-- prettier-ignore -->
<template>
  <div :data-testid="triggerTestId" ref="$el" class="relative" @click="copyContent">
    <slot></slot>
    <div
      v-if="isCopied || hasNotCopied"
      class="absolute top-0 left-0 w-full h-full transition-all duration-1000"
      :class="[isFading ? 'opacity-0 -translate-y-20' : 'opacity-100', hasNotCopied ? 'invisible' : 'visible']"
    >
      <slot name="copied"></slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';

const props = defineProps<{
  content: string;
  dataTestid?: string;
}>();

const triggerTestId = Vue.computed(() => {
  const target = props.dataTestid ?? 'CopyToClipboard';
  return `${target}.copyContent()`;
});
const hasNotCopied = Vue.ref(true);
const isCopied = Vue.ref(false);
const isFading = Vue.ref(false);
const $el = Vue.ref<typeof HTMLElement>();

defineExpose({
  $el,
});

let highlightAndCopyTimeout1: ReturnType<typeof setTimeout> | undefined = undefined;
let highlightAndCopyTimeout2: ReturnType<typeof setTimeout> | undefined = undefined;
let highlightAndCopyTimeout3: ReturnType<typeof setTimeout> | undefined = undefined;

function copyContent(event: MouseEvent) {
  event?.stopImmediatePropagation();
  void navigator.clipboard.writeText(props.content).catch(() => {
    // Ignore clipboard failures; the UI feedback still confirms the click action.
  });

  clearTimeout(highlightAndCopyTimeout1);
  clearTimeout(highlightAndCopyTimeout2);
  clearTimeout(highlightAndCopyTimeout3);
  hasNotCopied.value = false;
  isCopied.value = false;

  setTimeout(() => {
    isCopied.value = true;
    isFading.value = false;

    clearTimeout(highlightAndCopyTimeout1);
    clearTimeout(highlightAndCopyTimeout2);

    highlightAndCopyTimeout1 = setTimeout(() => {
      isFading.value = true;
      highlightAndCopyTimeout2 = setTimeout(() => {
        isCopied.value = false;
        isFading.value = false;
      }, 1000);
    }, 200);
  }, 0);
}
</script>
