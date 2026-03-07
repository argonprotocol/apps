<!-- prettier-ignore -->
<template>
  <ul class="flex flex-col px-3">
    <li
      @click="goTo('mnemonics')"
      class="group flex flex-row items-center cursor-pointer hover:text-argon-600 hover:bg-gradient-to-r hover:from-transparent hover:to-argon-menu-hover/70 rounded-md py-4"
    >
      <span class="relative flex flex-row items-center">
        <PasswordIcon class="w-5 h-5 mr-2 opacity-70 group-hover:text-argon-600" />
        View Account Recovery Mnemonic
        <ArrowCalloutButton
          v-if="controller.activeGuideId === OperationalStepId.BackupMnemonic"
          class="absolute top-1/2 -right-4 -translate-y-1/2 translate-x-full z-50"
          guidance="This opens your secret passphrase."
        />
      </span>
    </li>
    <li class="h-[1px] border-t border-slate-300 border-dashed my-4" />
    <li
      @click="goTo('ssh')"
      class="group flex flex-row items-center cursor-pointer hover:text-argon-600 hover:bg-gradient-to-r hover:from-transparent hover:to-argon-menu-hover/70 rounded-md py-4"
    >
      <TerminalIcon class="w-5 h-5 mr-2 opacity-70 group-hover:text-argon-600" />
      Connect to Mining Machine
    </li>
    <li class="h-[1px] border-t border-slate-300 border-dashed my-4" />
    <li
      @click="goTo('encrypt')"
      class="group flex flex-row items-center cursor-pointer hover:text-argon-600 hover:bg-gradient-to-r hover:from-transparent hover:to-argon-menu-hover/70 rounded-md py-4"
    >
      <EncryptionFileIcon class="w-5 h-5 mr-2 opacity-70 group-hover:text-argon-600" />
      Set Encryption Passphrase
    </li>
    <li class="h-[1px] border-t border-slate-300 border-dashed my-4" />
    <li
      @click="goTo('export')"
      class="group flex flex-row items-center cursor-pointer hover:text-argon-600 hover:bg-gradient-to-r hover:from-transparent hover:to-argon-menu-hover/70 rounded-md py-4"
    >
      <ExportIcon class="w-5 h-5 mr-2 opacity-70 group-hover:text-argon-600" />
      Export Account Backup File
    </li>
  </ul>
</template>

<script setup lang="ts">
import EncryptionFileIcon from '../../assets/encryption-file.svg?component';
import PasswordIcon from '../../assets/password.svg?component';
import TerminalIcon from '../../assets/terminal.svg?component';
import ExportIcon from '../../assets/export.svg?component';
import { OperationalStepId, OperationsTab, useOperationsController } from '../../stores/operationsController.ts';
import ArrowCalloutButton from '../../components/ArrowCalloutButton.vue';

const controller = useOperationsController();

const emit = defineEmits(['close', 'goTo']);

function goTo(screen: 'encrypt' | 'mnemonics' | 'ssh' | 'export') {
  emit('goTo', screen);
}
</script>
