<template>
  <div>
    <label :for="inputId" :class="label ? 'mb-2 block text-sm font-semibold text-slate-700' : 'sr-only'">
      {{ label ?? 'Passcode' }}
    </label>
    <input
      :id="inputId"
      v-model="passcode"
      :disabled="disabled"
      type="password"
      autocomplete="new-password"
      :minlength="AccountSecurity.minimumPasscodeLength"
      :aria-describedby="`${inputId}-help`"
      :placeholder="placeholder"
      class="focus:border-argon-500 w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none"
    />
    <p :id="`${inputId}-help`" class="mt-2 text-sm text-slate-500">
      Use a unique passphrase with at least {{ AccountSecurity.minimumPasscodeLength }} characters, such as several
      unrelated words. It is case-sensitive. Spaces and symbols are allowed, but no symbol is required.
    </p>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { AccountSecurity } from '../lib/AccountSecurity.ts';

withDefaults(defineProps<{ label?: string; placeholder?: string; disabled?: boolean }>(), {
  placeholder: 'Enter a new passcode',
  disabled: false,
});

const passcode = defineModel<string>({ required: true });
const inputId = Vue.useId();
</script>
