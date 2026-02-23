<!-- prettier-ignore -->
<template>
  <div class="flex flex-col px-3">
    <p class="text-md text-slate-600">
      {{ introText }}
    </p>

    <div v-if="!isActive" class="mt-6 flex flex-row items-center justify-end gap-3">
      <button
        class="bg-argon-600 hover:bg-argon-700 text-white text-sm font-bold px-4 py-2 rounded-md cursor-pointer disabled:opacity-50"
        v-if="!isActive"
        :disabled="isLoading"
        @click="activateAccess"
      >
        Activate SSH Access
      </button>
    </div>

    <div v-if="errorMessage" class="mt-3 text-sm font-semibold text-red-600">
      {{ errorMessage }}
    </div>

    <div v-if="isActive && privateKey" class="mt-4">
      <div class="text-xs text-slate-500 mb-2">Paste this entire block into your terminal.</div>
      <CopyCommandBlock v-if="command" :content="command" />
      <div class="flex flex-row justify-end">
        <button
          class="bg-slate-200 hover:bg-slate-300 text-slate-900 text-sm font-bold px-4 py-2 rounded-md cursor-pointer disabled:opacity-50"
          :disabled="isLoading"
          @click="deactivateAccess"
        >
          Deactivate
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import CopyCommandBlock from '../../components/CopyCommandBlock.vue';
import { getConfig } from '../../stores/config.ts';
import { platformType } from '../../tauri-controls/utils/os.ts';
import { invokeWithTimeout } from '../../lib/tauriApi.ts';

type SshAccessStatus = {
  active: boolean;
  publicKey?: string | null;
  privateKey?: string | null;
};

const config = getConfig();
const isLoading = Vue.ref(false);
const errorMessage = Vue.ref('');
const status = Vue.ref<SshAccessStatus>({ active: false });
const isWindows = platformType === 'windows';

const isActive = Vue.computed(() => !!status.value.active);
const privateKey = Vue.computed(() => status.value.privateKey ?? '');
const introText = Vue.computed(() =>
  isActive.value
    ? 'Run the command below to connect to your mining machine. The key will remain valid until you deactivate it.'
    : 'Activate SSH access to connect to your mining machine.',
);

const command = Vue.computed(() => {
  if (!privateKey.value) return '';
  return isWindows ? windowsCommand.value : macLinuxCommand.value;
});

const macLinuxCommand = Vue.computed(() => {
  if (!privateKey.value) return '';
  const { host, port, username } = getServerDetails();
  return [
    'tmp=$(mktemp)',
    'chmod 600 "$tmp"',
    'trap \'rm -f "$tmp"\' EXIT',
    'cat <<\'EOF\' > "$tmp"',
    privateKey.value.trim(),
    'EOF',
    `ssh -i "$tmp" -p ${port} ${username}@${host}`,
  ].join('\n');
});

const windowsCommand = Vue.computed(() => {
  if (!privateKey.value) return '';
  const { host, port, username } = getServerDetails();
  const path = '$env:USERPROFILE\\argon-ssh.pem';
  return [
    `$path = "${path}"`,
    "@'",
    privateKey.value.trim(),
    "'@ | Set-Content -Path $path -NoNewline",
    `ssh -i $path -p ${port} ${username}@${host}`,
    'Remove-Item -Force $path',
  ].join('\n');
});

function getServerDetails() {
  const details = config.serverDetails;
  const host = details.ipAddress;
  const port = details.port ?? 22;
  const username = details.sshUser;
  const address = `${host}:${port}`;
  return { host, port, username, address };
}

async function refreshStatus() {
  status.value = await invokeWithTimeout<SshAccessStatus>('ssh_access_status', {}, 15e3);
}

async function activateAccess() {
  errorMessage.value = '';
  await config.isLoadedPromise;
  const { host, port, username, address } = getServerDetails();
  if (!host || !username) {
    errorMessage.value = 'Missing SSH server details.';
    return;
  }
  isLoading.value = true;
  try {
    status.value = await invokeWithTimeout<SshAccessStatus>(
      'ssh_access_activate',
      {
        address,
        host,
        port,
        username,
      },
      30e3,
    );
  } catch (err) {
    errorMessage.value = String(err);
  } finally {
    isLoading.value = false;
  }
}

async function deactivateAccess() {
  errorMessage.value = '';
  await config.isLoadedPromise;
  const { host, port, username, address } = getServerDetails();
  if (!host || !username) {
    errorMessage.value = 'Missing SSH server details.';
    return;
  }
  isLoading.value = true;
  try {
    status.value = await invokeWithTimeout<SshAccessStatus>(
      'ssh_access_deactivate',
      {
        address,
        host,
        port,
        username,
      },
      30e3,
    );
  } catch (err) {
    errorMessage.value = String(err);
  } finally {
    isLoading.value = false;
  }
}

Vue.onMounted(() => {
  void (async () => {
    await refreshStatus();
    if (!isActive.value) {
      await activateAccess();
    }
  })();
});
</script>
