<template>
  <div class="mx-5 p-3">
    <DialogDescription class="mt-4 pr-10 font-light opacity-80">
      Argon Investor Console allows you to use any Ubuntu 24+ server as a server to run the Argon Blockchain and Bidding
      Bot. You'll need to setup the SSH access credentials correctly, but once that's done, we'll setup everything else
      (required software, security patches, etc). The minimum requirements are shown below.
    </DialogDescription>

    <div Warning>
      <strong>WARNING:</strong>
      This option is experimental and minimally tested. There are an infinite number of server combinations, and as
      such, we cannot guarantee all possibilities will work. Proceed at your own risk.
    </div>

    <header class="mt-10 font-bold">Minimum Requirements</header>
    <div class="mt-1 mb-3 w-10/12 font-light opacity-80">
      This table lists the most basic server requirements to run an Argon miner.
    </div>

    <table class="my-5 w-full font-light opacity-80">
      <tbody>
        <tr>
          <td class="w-2/12 border-t border-b border-slate-400/40 py-2 pr-4">Operating System</td>
          <td class="w-4/12 border-t border-b border-slate-400/40 py-2 pl-4 font-sans font-bold">Ubuntu 24.04+</td>
          <td class="w-10"><div class="w-10"></div></td>
          <td class="w-2/12 border-t border-b border-slate-400/40 py-2 pr-4">Memory</td>
          <td class="w-4/12 border-t border-b border-slate-400/40 py-2 pl-4 font-sans font-bold">8GB+ RAM</td>
        </tr>
        <tr>
          <td class="border-b border-slate-400/40 py-2 pr-4">Compute Cores</td>
          <td class="border-b border-slate-400/40 py-2 pl-4 font-sans font-bold">4+ vCPUs</td>
          <td></td>
          <td class="border-b border-slate-400/40 py-2 pr-4">Hard Drive</td>
          <td class="border-b border-slate-400/40 py-2 pl-4 font-sans font-bold">100GB or more</td>
        </tr>
        <tr>
          <td class="border-b border-slate-400/40 py-2 pr-4">Internet</td>
          <td class="border-b border-slate-400/40 py-2 pl-4 font-sans font-bold">Public</td>
          <td></td>
          <td class="border-b border-slate-400/40 py-2 pr-4">Uptime</td>
          <td class="border-b border-slate-400/40 py-2 pl-4 font-sans font-bold">Always On</td>
        </tr>
        <tr>
          <td class="border-b border-slate-400/40 py-2 pr-4">Public Ports</td>
          <td class="border-b border-slate-400/40 py-2 pl-4 font-sans font-bold">{{ publicPorts.join(', ') }}</td>
          <td></td>
          <td class="border-b border-slate-400/40 py-2 pr-4">Ports Exposed to You</td>
          <td class="border-b border-slate-400/40 py-2 pl-4 font-sans font-bold">{{ privatePorts.join(', ') }}</td>
        </tr>
      </tbody>
    </table>

    <header class="mt-7 font-bold">SSH Security</header>
    <div class="w-10/12">
      <p class="mt-1 mb-3 font-light opacity-80">
        You'll need to add Argon Investor's SSH public key to your server's authorized keys. Log-in to your server and
        run the command shown below.
      </p>
    </div>
    <CopyToClipboard
      ref="copyToClipboard"
      :content="addSshPublicKey"
      class="relative mb-3 w-full"
      @click="highlightCopiedContent">
      <textarea
        type="text"
        :value="addSshPublicKey"
        class="pointer-events-none h-full w-full rounded-md border border-slate-300 bg-white py-4 pr-8 pl-4"
        readonly />
      <div
        class="pointer-events-auto absolute top-1 right-8 bottom-1 w-10 bg-gradient-to-r from-transparent to-white"></div>
      <div class="absolute top-1/2 right-4 -translate-y-1/2 cursor-pointer">
        <CopyIcon class="h-4 w-4 opacity-80" />
      </div>
      <template #copied>
        <div class="pointer-events-none h-full w-full rounded-md border border-slate-300 bg-white py-4 pr-8 pl-4">
          <span class="inline-block h-full w-full bg-blue-200" style="word-break: break-word">
            {{ addSshPublicKey }}
          </span>
        </div>
        <div
          class="pointer-events-none absolute top-1/2 right-4 flex -translate-y-1/2 flex-row items-center bg-white pl-2">
          <div
            class="pointer-events-auto absolute top-0 bottom-0 -left-8 w-8 bg-gradient-to-r from-transparent to-white"></div>
          <span class="font-bold text-blue-800/60">Copied</span>
          <CopyIcon class="ml-3 h-4 w-4 text-blue-600" />
        </div>
      </template>
    </CopyToClipboard>

    <header class="mt-7 font-bold">Server Details</header>
    <div>
      <p class="mt-1 mb-3 font-light opacity-80">
        You'll need to input your server's IP address and SSH user below. The default SSH user for Ubuntu servers is
        usually
        <code>ubuntu</code>
        or
        <code>root</code>
        .
      </p>
    </div>

    <div class="flex flex-row">
      <div class="wrapper mr-2 flex w-1/5 flex-row items-center justify-center">
        <input
          type="text"
          v-model="sshUser"
          placeholder="SSH User"
          class="w-full rounded-md border border-slate-300 bg-white px-4 py-3" />
        <span class="pl-2 font-bold text-slate-500/60">@</span>
      </div>
      <div class="wrapper mr-4 flex grow flex-col">
        <input
          type="text"
          v-model="ipAddressAndMaybePort"
          placeholder="Your Server's IP Address"
          class="w-full rounded-md border border-slate-300 bg-white px-4 py-3" />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)'; // 0-255
const IPV4_REGEX = new RegExp(`^(${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET})(?::(\\d{1,5}))?$`);

function isValidIPv4WithOptionalPort(s: string, allowPortZero = false): boolean {
  try {
    const m = IPV4_REGEX.exec(s);
    if (!m) return false;

    const portStr = m[2];
    if (!portStr) return true; // no port — IP is valid

    // validate numeric range (1..65535) or (0..65535 when allowPortZero)
    const port = Number(portStr);
    if (!Number.isFinite(port)) return false;
    if (allowPortZero) return port >= 0 && port <= 65535;
    return port >= 1 && port <= 65535;
  } catch (e) {
    console.error('Error validating IP address', e);
    return false;
  }
}
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import CopyIcon from '../../assets/copy.svg?component';
import { DialogDescription } from 'reka-ui';
import { getConfig } from '../../stores/config';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import { useTextareaAutosize } from '@vueuse/core';
import { SSH } from '../../lib/SSH';
import { IServerConnectChildExposed } from '../ServerConnectOverlay.vue';
import { IConfigServerCreationCustomServer, ServerType } from '../../interfaces/IConfig';
import { SERVER_ENV_VARS } from '../../lib/Env.ts';
import { getWalletKeys } from '../../stores/wallets.ts';

const emit = defineEmits(['ready']);

const walletKeys = getWalletKeys();
const config = getConfig();
const { textarea } = useTextareaAutosize();

const sshPublicKey = Vue.computed(() => walletKeys.sshPublicKey);
const copyToClipboard = Vue.ref<typeof CopyToClipboard>();
const publicPorts = Vue.computed<number[]>(() => {
  return Object.entries(SERVER_ENV_VARS)
    .filter(([name]) => name.endsWith('P2P_PORT'))
    .map(([, port]) => parseInt(port, 10))
    .sort((a, b) => a - b);
});

const privatePorts = Vue.computed<number[]>(() => {
  return Object.entries(SERVER_ENV_VARS)
    .filter(([name]) => name.endsWith('_PORT') && !name.endsWith('P2P_PORT'))
    .map(([, port]) => parseInt(port, 10))
    .concat([22])
    .sort((a, b) => a - b);
});

const sshUser = Vue.ref(config.serverCreation?.customServer?.sshUser ?? '');
const ipAddressAndMaybePort = Vue.ref(config.serverCreation?.customServer?.ipAddress ?? '');
if (config.serverCreation?.customServer?.port && config.serverCreation?.customServer?.port !== 22) {
  ipAddressAndMaybePort.value = `${ipAddressAndMaybePort.value}:${config.serverCreation?.customServer?.port}`;
}

Vue.watch(
  [sshUser, ipAddressAndMaybePort],
  ([user, ip]) => {
    const isReady = !!user && isValidIPv4WithOptionalPort(ip);
    emit('ready', isReady);
  },
  { immediate: true },
);

const addSshPublicKey = Vue.computed(() => {
  const key = walletKeys.sshPublicKey.trim();
  return `echo "${key}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
});

async function connect(): Promise<IConfigServerCreationCustomServer> {
  if (!isValidIPv4WithOptionalPort(ipAddressAndMaybePort.value)) {
    throw new Error('The IP Address cannot be left blank');
  } else if (!sshUser.value) {
    throw new Error('The SSH User cannot be left blank');
  }

  const [ipAddress, maybePort] = ipAddressAndMaybePort.value.split(':');
  const port = maybePort ? parseInt(maybePort.trim(), 10) : 22;
  const serverCreation: IConfigServerCreationCustomServer = {
    port,
    sshUser: sshUser.value,
    ipAddress: ipAddress,
  };
  const newServerDetails = {
    type: ServerType.CustomServer,
    ...serverCreation,
    workDir: '~',
  };

  const serverMeta = await (async () => {
    try {
      return await SSH.tryConnection(newServerDetails);
    } catch {
      throw new Error('A SSH connection could not be established to your server.');
    }
  })();

  if (serverMeta.walletAddress && serverMeta.walletAddress !== walletKeys.miningAddress) {
    throw new Error('The server has a different wallet address than your mining account.');
  }

  if (serverMeta.biddingRules) {
    config.biddingRules = serverMeta.biddingRules;
    config.saveBiddingRules();
    serverCreation.hasRunningBot = true;
  }

  return serverCreation;
}

function highlightCopiedContent() {
  const wrapperElem = copyToClipboard.value?.$el;
  if (!wrapperElem) return;

  const inputElem = wrapperElem.querySelector('textarea') as HTMLInputElement;
  inputElem.select();
}

defineExpose<IServerConnectChildExposed>({ connect });
</script>

<style scoped>
@reference "../../main.css";

div[Warning] {
  @apply mt-4 rounded-md border border-yellow-700/20 bg-yellow-50/50 px-5 py-4;
  strong {
    @apply text-red-500;
  }
}
</style>
