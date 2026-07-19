<template>
  <div class="h-full overflow-y-auto p-5 text-left">
    <div v-if="ethereumImportStep === 'choice'" class="mt-5 grid grid-cols-2 gap-3">
      <button
        data-testid="WalletOverlay.createDefaultEthereum()"
        type="button"
        class="rounded-md border border-slate-300 px-4 py-3 text-left hover:bg-slate-50"
        @click="createDefaultEthereum"
      >
        <div class="font-bold">Create Native Wallet</div>
        <div class="mt-1 text-sm text-slate-500">Use the Ethereum wallet from this app's core account.</div>
      </button>
      <button
        data-testid="WalletOverlay.connectExternalEthereum()"
        type="button"
        class="rounded-md border border-slate-300 px-4 py-3 text-left hover:bg-slate-50"
        @click="ethereumImportStep = 'external'"
      >
        <div class="font-bold">Connect External Wallet</div>
        <div class="mt-1 text-sm text-slate-500">Import by private key or mnemonic.</div>
      </button>
    </div>

    <div v-else-if="ethereumImportStep === 'external'" class="mt-5">
      <div class="mb-3 flex gap-2">
        <button
          type="button"
          class="rounded-md border px-3 py-1.5"
          :class="ethereumImportMode === 'privateKey' ? 'border-argon-500 bg-argon-50' : 'border-slate-300'"
          @click="ethereumImportMode = 'privateKey'"
        >
          Private Key
        </button>
        <button
          type="button"
          class="rounded-md border px-3 py-1.5"
          :class="ethereumImportMode === 'mnemonic' ? 'border-argon-500 bg-argon-50' : 'border-slate-300'"
          @click="ethereumImportMode = 'mnemonic'"
        >
          Mnemonic
        </button>
      </div>
      <label v-if="ethereumImportMode === 'privateKey'" class="mb-3 block">
        <span class="mb-1 block text-sm font-semibold text-slate-700">Wallet Name</span>
        <input
          v-model="ethereumWalletNameInput"
          class="focus:border-argon-500 w-full rounded-md border border-slate-300 px-3 py-2 outline-none"
          placeholder="Name this wallet"
        />
      </label>
      <textarea
        v-model="ethereumSecretInput"
        class="focus:border-argon-500 h-28 w-full resize-none rounded-md border border-slate-300 p-3 font-mono text-sm outline-none"
        :placeholder="ethereumImportMode === 'privateKey' ? 'Paste private key' : 'Paste mnemonic'"
      />
      <div v-if="ethereumImportError" class="mt-2 text-sm text-red-600">{{ ethereumImportError }}</div>
      <div class="mt-4 flex justify-end gap-2">
        <button
          v-if="startedFromChoiceStep"
          type="button"
          class="rounded-md border border-slate-300 px-4 py-2"
          @click="ethereumImportStep = 'choice'"
        >
          Back
        </button>
        <button
          type="button"
          class="bg-argon-600 rounded-md px-4 py-2 font-bold text-white disabled:opacity-50"
          :disabled="isImportingEthereum"
          @click="continueExternalImport"
        >
          {{ ethereumImportMode === 'privateKey' ? 'Import' : 'Preview Accounts' }}
        </button>
      </div>
    </div>

    <div v-else-if="ethereumImportStep === 'mnemonicAccounts'" class="mt-5">
      <div class="mb-3 flex items-center justify-between">
        <div class="font-bold">Select an account</div>
        <button
          type="button"
          class="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          :disabled="isScanningBalances"
          @click="scanMnemonicBalances"
        >
          {{ isScanningBalances ? 'Scanning...' : 'Scan Balances' }}
        </button>
      </div>
      <div class="max-h-72 overflow-y-auto rounded-md border border-slate-200">
        <button
          v-for="account in mnemonicAccounts"
          :key="account.derivationPath"
          type="button"
          class="flex w-full flex-col border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50"
          :class="selectedMnemonicPath === account.derivationPath ? 'bg-argon-50' : ''"
          @click="selectedMnemonicPath = account.derivationPath"
        >
          <span class="font-mono text-sm">{{ account.address }}</span>
          <span class="text-xs text-slate-500">
            {{ account.derivationPath }}
            <template v-if="account.balanceSummary">· {{ account.balanceSummary }}</template>
          </span>
        </button>
      </div>
      <label class="mt-4 block">
        <span class="mb-1 block text-sm font-semibold text-slate-700">Wallet Name</span>
        <input
          v-model="ethereumWalletNameInput"
          class="focus:border-argon-500 w-full rounded-md border border-slate-300 px-3 py-2 outline-none"
          placeholder="Name this wallet"
        />
      </label>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-md border border-slate-300 px-4 py-2"
          @click="ethereumImportStep = 'external'"
        >
          Back
        </button>
        <button
          type="button"
          class="bg-argon-600 rounded-md px-4 py-2 font-bold text-white disabled:opacity-50"
          :disabled="!selectedMnemonicPath || isImportingEthereum"
          @click="importSelectedMnemonicAccount"
        >
          Import Selected
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { useWallets } from '../stores/wallets.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';

const wallets = useWallets();
const props = defineProps<{
  initialStep: 'choice' | 'external';
}>();
const emit = defineEmits<{
  complete: [walletRecord: IWalletRecord];
}>();

const ethereumImportStep = Vue.ref<'choice' | 'external' | 'mnemonicAccounts'>();
const ethereumImportMode = Vue.ref<'privateKey' | 'mnemonic'>('privateKey');
const ethereumSecretInput = Vue.ref('');
const ethereumWalletNameInput = Vue.ref('');
const ethereumImportError = Vue.ref('');
const isImportingEthereum = Vue.ref(false);
const isScanningBalances = Vue.ref(false);
const mnemonicAccounts = Vue.ref<{ address: string; derivationPath: string; balanceSummary?: string }[]>([]);
const selectedMnemonicPath = Vue.ref('');
const startedFromChoiceStep = Vue.ref(false);

function openEthereumImport(step: 'choice' | 'external') {
  const hasDefaultEthereumWallet = wallets.walletRecords.some(wallet => wallet.role === 'defaultEthereum');
  const initialStep = step === 'choice' && hasDefaultEthereumWallet ? 'external' : step;

  startedFromChoiceStep.value = initialStep === 'choice';
  ethereumImportStep.value = initialStep;
  ethereumImportMode.value = 'privateKey';
  ethereumWalletNameInput.value = '';
  ethereumImportError.value = '';
}

function resetEthereumImport() {
  ethereumImportStep.value = undefined;
  ethereumSecretInput.value = '';
  ethereumWalletNameInput.value = '';
  ethereumImportError.value = '';
  mnemonicAccounts.value = [];
  selectedMnemonicPath.value = '';
  startedFromChoiceStep.value = false;
}

async function createDefaultEthereum() {
  const walletRecord = await wallets.createDefaultEthereumWallet();
  resetEthereumImport();
  emit('complete', walletRecord);
}

async function continueExternalImport() {
  ethereumImportError.value = '';
  const walletName = ethereumWalletNameInput.value.trim();
  if (ethereumImportMode.value === 'privateKey' && !walletName) {
    ethereumImportError.value = 'Enter a wallet name.';
    return;
  }
  isImportingEthereum.value = true;
  try {
    if (ethereumImportMode.value === 'privateKey') {
      const walletRecord = await wallets.importExternalEthereumPrivateKey({
        name: walletName,
        privateKey: ethereumSecretInput.value.trim(),
      });
      resetEthereumImport();
      emit('complete', walletRecord);
      return;
    }
    mnemonicAccounts.value = await wallets.previewExternalEthereumMnemonic(ethereumSecretInput.value.trim());
    selectedMnemonicPath.value = mnemonicAccounts.value[0]?.derivationPath ?? '';
    ethereumImportStep.value = 'mnemonicAccounts';
  } catch (error) {
    ethereumImportError.value = error instanceof Error ? error.message : 'Unable to import Ethereum wallet.';
  } finally {
    isImportingEthereum.value = false;
  }
}

async function scanMnemonicBalances() {
  isScanningBalances.value = true;
  try {
    const balances = await wallets.scanEthereumWalletBalances(mnemonicAccounts.value.map(account => account.address));
    mnemonicAccounts.value = mnemonicAccounts.value.map(account => {
      const balance = balances.find(x => x.address === account.address)?.wallet;
      if (!balance) return account;
      return {
        ...account,
        balanceSummary:
          [
            balance.availableMicrogons ? `${balance.availableMicrogons.toLocaleString()} microgons` : '',
            balance.availableMicronots ? `${balance.availableMicronots.toLocaleString()} micronots` : '',
          ]
            .filter(Boolean)
            .join(', ') || 'No tracked balance',
      };
    });
  } finally {
    isScanningBalances.value = false;
  }
}

async function importSelectedMnemonicAccount() {
  const account = mnemonicAccounts.value.find(x => x.derivationPath === selectedMnemonicPath.value);
  if (!account) return;
  const walletName = ethereumWalletNameInput.value.trim();
  if (!walletName) {
    ethereumImportError.value = 'Enter a wallet name.';
    return;
  }
  isImportingEthereum.value = true;
  try {
    const walletRecord = await wallets.importExternalEthereumMnemonic({
      name: walletName,
      mnemonic: ethereumSecretInput.value.trim(),
      address: account.address,
      derivationPath: account.derivationPath,
    });
    resetEthereumImport();
    emit('complete', walletRecord);
  } catch (error) {
    ethereumImportError.value = error instanceof Error ? error.message : 'Unable to import Ethereum wallet.';
  } finally {
    isImportingEthereum.value = false;
  }
}

Vue.watch(() => props.initialStep, openEthereumImport, { immediate: true });
</script>
