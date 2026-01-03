<template>
  <div class="flex flex-col">
    <p class="text-md text-slate-500">
      All your data in this app can be entirely recreated from a single account recovery file. Click the button below to
      download. And keep it safe! It contains your account's private key, so don't share it with anyone.
    </p>

    <ul class="mt-4 flex w-full flex-row items-center space-x-2 text-center font-bold">
      <li
        @click="importAccount"
        class="pointer-events-none flex w-1/2 cursor-pointer flex-col items-center rounded-md py-6 opacity-30 hover:bg-slate-100">
        <RecoveryFileIcon class="mb-2 inline-block h-14 w-14" />
        Import from Recovery File
      </li>
      <li
        @click="goTo('import-from-mnemonic')"
        class="flex w-1/2 cursor-pointer flex-col items-center rounded-md py-6 hover:bg-slate-100">
        <MnemonicsIcon class="mb-2 inline-block h-14 w-14" />
        Import from Mnemonic
      </li>
    </ul>
  </div>
</template>
<script setup lang="ts">
import RecoveryFileIcon from '../../assets/recovery-file.svg?component';
import MnemonicsIcon from '../../assets/mnemonics.svg?component';
import { open as openFileOverlay } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { useController } from '../../stores/controller.ts';

const emit = defineEmits(['close', 'goTo']);

const controller = useController();

function goTo(screen: 'overview' | 'import-from-mnemonic') {
  emit('goTo', screen);
}

async function importAccount() {
  const filePath = await openFileOverlay({
    multiple: false,
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
  });
  if (!filePath || Array.isArray(filePath)) return; // cancelled or multi-select

  const dataRaw = await readTextFile(filePath);
  emit('close');
  await controller.importFromFile(dataRaw);
}
</script>
