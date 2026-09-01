<template>
  <span class="inline-flex max-w-full items-center gap-x-1.5">
    <span
      v-if="identity.kind !== 'upstream'"
      :class="
        compact
          ? 'max-w-48 truncate rounded bg-slate-200/70 px-2 py-0.5 text-xs font-medium text-slate-600'
          : 'font-medium'
      "
    >
      {{ identity.name }}
    </span>
    <span v-if="upstreamName" :class="compact ? 'max-w-48 truncate text-xs text-slate-500' : 'text-xs text-slate-500'">
      (Upstream: {{ upstreamName }})
    </span>
  </span>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { ICrosschainSourceIdentity } from '../lib/CrosschainTransferView.ts';

const props = defineProps<{
  identity: ICrosschainSourceIdentity;
  compact?: boolean;
}>();

const upstreamName = Vue.computed(() => {
  return props.identity.kind === 'upstream' ? props.identity.name : props.identity.upstreamName;
});
</script>
