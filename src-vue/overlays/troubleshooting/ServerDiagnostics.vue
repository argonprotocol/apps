<template>
  <div
    ref="containerRef"
    class="flex min-h-[90%] w-200 flex-col gap-4 overflow-x-hidden overflow-y-auto pt-3 pr-7 pb-5 pl-4">
    <DiagnosticStep ref="step1" :run="() => diagnostics.isConnected()">
      <heading>Checking SSH connection to mining machine</heading>
      <success>A successful connection was made to the server located at {{ config.serverDetails.ipAddress }}</success>
      <failure>
        Failed to connect to {{ config.serverDetails.ipAddress }}. Your internet connection might be down or the mining
        machine might be offline.
      </failure>
    </DiagnosticStep>

    <DiagnosticStep ref="step2" :run="() => diagnostics.accountAddressMatches()">
      <heading>Checking Argon Account Identifier Match</heading>
      <success>
        Your app database and the mining machine are correctly using the same wallet address of
        {{ config.miningAccountAddress }}.
      </success>
      <failure>
        Your app database and the mining machine are using different wallet addresses. Somehow you connected a server
        that is not compatible with the account associated with this app.
      </failure>
    </DiagnosticStep>

    <DiagnosticStep ref="step3" :run="() => diagnostics.lastInstallCompletedSuccessfully()">
      <heading>Checking Success of Last Install/Upgrade</heading>
      <success v-slot="{ data }">
        All steps of the last install/upgrade completed successfully.
        <ul class="mt-2 grid grid-cols-2 gap-2">
          <li
            v-for="[key, status] in data.steps"
            :key="key"
            class="font-md cursor-text pr-10 font-light whitespace-nowrap text-slate-800/50 select-auto">
            {{ key }} = {{ status }}
          </li>
        </ul>
      </success>
      <failure>One or more steps of the last install/upgrade did not complete successfully.</failure>
    </DiagnosticStep>

    <DiagnosticStep ref="step4" :run="() => diagnostics.remoteServerFilesAreUpToDate()">
      <heading>Checking Remote Server Files Are Up-to-Date</heading>
      <success v-slot="{ data }">
        The remote server files are up-to-date and installed in their correct locations:
        <ul class="mt-2 grid grid-cols-3 gap-2">
          <li
            v-for="file in data.files"
            :key="file"
            class="font-md cursor-text pr-10 font-light text-slate-800/50 select-auto">
            {{ file }}
          </li>
        </ul>
      </success>
      <failure>
        The remote files on your server are out of date with the files expected by your current version of Commmander.
      </failure>
    </DiagnosticStep>

    <DiagnosticStep ref="step5" :run="() => diagnostics.remoteConfigFilesAreUpToDate()">
      <heading>Checking Remote Config Files Are Correct</heading>
      <success v-slot="{ data }">
        The remote server files are up-to-date and installed in their correct locations:
        <ul class="mt-2 grid grid-cols-3 gap-2">
          <li
            v-for="file in data.files"
            :key="file"
            class="font-md cursor-text pr-10 font-light text-slate-800/50 select-auto">
            {{ file }}
          </li>
        </ul>
      </success>
      <failure>
        The remote config files on your server are out of date with what is expected by your current version of
        Commmander.
      </failure>
    </DiagnosticStep>

    <DiagnosticStep ref="step6" :run="() => diagnostics.healthOfBitcoinNode()">
      <heading>Checking Health of Bitcoin Node</heading>
      <success v-slot="{ data }">
        Your bitcoin node appears to be working correctly.
        <ul class="mt-2 flex flex-col gap-2">
          <li
            v-for="[key, value] in Object.entries(data.info)"
            :key="key"
            class="font-md cursor-text overflow-hidden pr-10 font-light text-ellipsis whitespace-nowrap text-slate-800/50 select-auto">
            {{ key }}: {{ value }}
          </li>
        </ul>
      </success>
      <failure v-slot="{ error }">Your bitcoin node is not working correctly: {{ error?.message }}</failure>
    </DiagnosticStep>

    <DiagnosticStep ref="step7" :run="() => diagnostics.healthOfArgonNode()">
      <heading>Checking Health of Argon Node</heading>
      <success v-slot="{ data }">
        Your argon node appears to be working correctly.
        <ul class="mt-2 flex flex-col gap-2">
          <li
            v-for="[key, value] in Object.entries(data.info)"
            :key="key"
            class="font-md cursor-text overflow-hidden pr-10 font-light text-ellipsis whitespace-nowrap text-slate-800/50 select-auto">
            {{ key }}: {{ value }}
          </li>
        </ul>
      </success>
      <failure v-slot="{ error }">Your argon node seems to be having trouble: {{ error?.message }}</failure>
    </DiagnosticStep>

    <div v-if="isAllSuccess" class="mt-5 border-t border-gray-300 pt-5 text-xl font-bold text-green-600 uppercase">
      Your Mining Server Appears to Be Working Correctly!
    </div>

    <!-- <section>
      <header>Mining Bot Is Working</header>
    </section>

    <section>
      <header>Mining Data Is Correct</header>
    </section> -->
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { Diagnostics } from '../../lib/Diagnostics';
import { useConfig, Config } from '../../stores/config';
import DiagnosticStep from './components/DiagnosticStep.vue';
import success from './components/DiagnosticSuccess.vue';
import failure from './components/DiagnosticFailure.vue';
import heading from './components/DiagnosticHeading.vue';

const config = useConfig();
const diagnostics = new Diagnostics(config as Config);

const containerRef = Vue.ref<HTMLElement>();
const isAllSuccess = Vue.ref(false);

const step1 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step2 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step3 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step4 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step5 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step6 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step7 = Vue.ref<InstanceType<typeof DiagnosticStep>>();

function scrollToBottom() {
  if (containerRef.value) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight;
  }
}

async function runDiagnostics() {
  await diagnostics.load();
  await Vue.nextTick();

  const steps = [step1.value, step2.value, step3.value, step4.value, step5.value, step6.value, step7.value].filter(
    Boolean,
  );
  let hasFailure = false;

  for (const step of steps) {
    if (step && typeof step.run === 'function') {
      const wasSuccess = await step.run();
      await Vue.nextTick();
      scrollToBottom();
      if (!wasSuccess) {
        hasFailure = true;
        break;
      }
    }
  }

  isAllSuccess.value = !hasFailure;
}

Vue.onMounted(async () => {
  runDiagnostics().catch(e => {
    console.error(e);
  });
});
</script>

<style scoped>
.dots-pattern {
  background-image: radial-gradient(circle, currentColor 2px, transparent 2px);
  background-size: 8px 8px;
  background-repeat: repeat-x;
  background-position: center;
  min-height: 1em;
}
</style>
