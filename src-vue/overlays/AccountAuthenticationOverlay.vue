<template>
  <OverlayBase
    :isOpen="!!request"
    :title="request?.reason"
    :showCloseIcon="false"
    :hasHeaderBorder="false"
    class="w-11/12 max-w-sm"
    @close="cancel"
    @pressEsc="cancel"
  >
    <template #title>
      <span class="flex min-w-0 items-center gap-2 text-lg font-semibold text-slate-800">
        <LockClosedIcon class="text-argon-600 size-5 shrink-0" aria-hidden="true" />
        <span class="min-w-0 break-words first-letter:uppercase">{{ request?.reason }}</span>
      </span>
    </template>
    <form class="px-4 pb-4" @submit.prevent="confirm">
      <template v-if="request?.method === 'passcode'">
        <p class="mb-4 text-sm text-slate-600">Enter your app passcode to continue.</p>
        <label :for="inputId" class="mb-2 block text-sm font-semibold text-slate-700">App passcode</label>
        <input
          :id="inputId"
          v-model="passcode"
          type="password"
          autocomplete="current-password"
          autofocus
          :disabled="isVerifying"
          class="focus:border-argon-500 w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 focus:outline-none"
        />
      </template>
      <p v-else class="text-sm text-slate-600">Use your device authentication to continue.</p>
      <p v-if="errorMessage" class="mt-3 text-sm text-red-600" role="alert">{{ errorMessage }}</p>
      <footer class="mt-5 flex justify-end gap-2">
        <button
          v-if="request?.canCancel !== false"
          type="button"
          :disabled="isVerifying"
          class="cursor-pointer rounded-md border border-slate-300 px-4 py-1 font-bold text-slate-600 hover:bg-slate-50"
          @click="cancel"
        >
          Cancel
        </button>
        <button
          type="submit"
          :disabled="isVerifying || (request?.method === 'passcode' && !passcode)"
          class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-4 py-1 font-bold text-white disabled:cursor-default disabled:opacity-50"
        >
          {{ isVerifying ? 'Unlocking…' : 'Confirm' }}
        </button>
      </footer>
    </form>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { LockClosedIcon } from '@heroicons/vue/24/outline';
import OverlayBase from './OverlayBase.vue';
import basicEmitter, { type IAccountAuthenticationRequest } from '../emitters/basicEmitter.ts';

const request = Vue.shallowRef<IAccountAuthenticationRequest>();
const passcode = Vue.ref('');
const errorMessage = Vue.ref('');
const isVerifying = Vue.ref(false);
const inputId = Vue.useId();

function open(next: IAccountAuthenticationRequest) {
  if (request.value) {
    console.info('[SecurityAccess]', { event: 'prompt-rejected', accessId: next.accessId, method: next.method });
    next.reject(new Error('Another Account Security confirmation is already open. Please retry.'));
    return;
  }
  passcode.value = '';
  errorMessage.value = '';
  request.value = next;
  console.info('[SecurityAccess]', { event: 'prompt-opened', accessId: next.accessId, method: next.method });
  if (next.method === 'system') void confirm();
}

function cancel() {
  if (request.value?.canCancel === false || isVerifying.value) return;
  dismiss();
}

function dismiss() {
  const current = request.value;
  if (current)
    console.info('[SecurityAccess]', { event: 'prompt-canceled', accessId: current.accessId, method: current.method });
  request.value = undefined;
  passcode.value = '';
  current?.reject(new Error('Account Security confirmation canceled.'));
}

async function confirm() {
  const current = request.value;
  if (!current || isVerifying.value) return;
  if (current.method === 'passcode' && !passcode.value) return;
  isVerifying.value = true;
  errorMessage.value = '';
  try {
    await current.verify(passcode.value);
    if (request.value !== current) return;
    request.value = undefined;
    current.resolve();
  } catch (error) {
    if (request.value === current) errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    passcode.value = '';
    isVerifying.value = false;
  }
}

basicEmitter.on('requestAccountAuthentication', open);
basicEmitter.on('closeAllOverlays', cancel);
Vue.onBeforeUnmount(() => {
  basicEmitter.off('requestAccountAuthentication', open);
  basicEmitter.off('closeAllOverlays', cancel);
  dismiss();
});
</script>
