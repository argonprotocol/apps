<template>
  <div class="space-y-4 px-10 pt-4 pb-8">
    <div class="rounded-lg border border-slate-300 bg-white px-5 py-4">
      <p class="text-argon-700 text-xs font-light tracking-wide uppercase">
        {{ isAcknowledged ? 'Funding Expired' : 'Action Required' }}
      </p>
      <h2 class="mt-1 text-xl font-semibold text-slate-900">Bitcoin funding window expired.</h2>
      <p class="mt-2 text-sm text-slate-700">
        <template v-if="isAcknowledged">
          This funding request has expired. Start a new funding attempt when you're ready.
        </template>
        <template v-else>
          This lock expired before Bitcoin funding was confirmed. Review it, then start a new funding attempt when
          you're ready.
        </template>
      </p>
    </div>

    <div class="rounded-lg border border-slate-300 bg-slate-50/60 px-5 py-4 text-sm text-slate-700">
      That funding request is closed. Starting again opens a new Bitcoin lock for this vault.
    </div>

    <div>
      <button
        data-testid="LockFundingExpired.startNew()"
        @click="emit('startNew')"
        class="bg-argon-600 hover:bg-argon-700 cursor-pointer rounded-md px-6 py-2 text-lg font-bold text-white">
        Choose a New Amount
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'startNew'): void;
}>();

const isAcknowledged = Vue.computed(() => {
  return props.personalLock.status === BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged;
});
</script>
