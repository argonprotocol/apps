<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    :enableTopBar="true"
    class="w-7/12"
    @close="closeOverlay"
  >
    <template #title>
      <DialogTitle class="grow pl-3">{{ SOFTWARE_INFO_TITLE }}</DialogTitle>
    </template>

    <article class="px-6 py-5 text-slate-700">
      <p class="text-sm leading-6">
        Argon Desktop is open-source software made available under the MIT License. It is provided as-is, without
        warranties. You control your own keys and choose which transactions and protocol actions to make.
      </p>

      <section class="mt-5 border-t border-slate-300 pt-4">
        <h3 class="text-sm font-semibold text-slate-800">Self-Custody</h3>
        <div class="mt-2 space-y-3 text-sm leading-6">
          <p>
            Keep your device, passwords, recovery phrase, private keys, and backups safe. No one can recover them for
            you if they are lost.
          </p>
          <p>Transactions may be irreversible, so verify the details before confirming an action.</p>
        </div>
      </section>

      <section class="mt-5 border-t border-dashed border-slate-300 pt-4">
        <h3 class="text-sm font-semibold text-slate-800">Software and External Systems</h3>
        <div class="mt-2 space-y-3 text-sm leading-6">
          <p>
            Open-source software can contain bugs. The blockchains, public RPC providers, indexers, cross-chain transfer
            systems, and linked third-party services used by some features can also change or become unavailable.
          </p>
          <p>Check important information before acting, especially when moving or locking funds.</p>
        </div>
      </section>

      <section class="mt-5 border-t border-dashed border-slate-300 pt-4">
        <h3 class="text-sm font-semibold text-slate-800">Troubleshooting</h3>
        <div class="mt-2 space-y-3 text-sm leading-6">
          <p>
            As an open-source project, Argon Desktop does not have a dedicated support team. Community contributors may
            offer help through the Discord and GitHub links in the app, but support is voluntary and not guaranteed.
          </p>
          <p>
            Troubleshooting packages are created only when you choose to download one. They contain local app data and
            logs; wallet mnemonic files are excluded unless you explicitly include them.
          </p>
        </div>
      </section>

      <section class="mt-5 border-t border-dashed border-slate-300 pt-4">
        <h3 class="text-sm font-semibold text-slate-800">{{ LICENSE_TITLE }}</h3>
        <p class="mt-2 text-sm font-semibold text-slate-800">{{ copyrightNotice }}</p>

        <div class="mt-4 space-y-5">
          <div>
            <h4 class="text-sm font-semibold text-slate-800">Permission</h4>
            <p class="mt-2 text-sm leading-6">{{ permissionGrant }}</p>
          </div>
          <div>
            <h4 class="text-sm font-semibold text-slate-800">Conditions</h4>
            <p class="mt-2 text-sm leading-6">{{ licenseCondition }}</p>
          </div>
          <div>
            <h4 class="text-sm font-semibold text-slate-800">Warranty and Liability</h4>
            <p class="mt-2 text-sm leading-6">{{ warrantyAndLiability }}</p>
          </div>
        </div>
      </section>
    </article>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { DialogTitle } from 'reka-ui';
import licenseText from '../../LICENSE?raw';
import basicEmitter from '../emitters/basicEmitter.ts';
import { LICENSE_TITLE, SOFTWARE_INFO_TITLE } from '../lib/SoftwareInfo.ts';
import OverlayBase from './OverlayBase.vue';

const [, copyrightNotice, permissionGrant, licenseCondition, warrantyAndLiability] = licenseText
  .trim()
  .split(/\n\s*\n/)
  .map(paragraph => paragraph.replace(/\n/g, ' '));

const isOpen = Vue.ref(false);

basicEmitter.on('openSoftwareInfoOverlay', () => {
  isOpen.value = true;
});

function closeOverlay() {
  isOpen.value = false;
}
</script>
