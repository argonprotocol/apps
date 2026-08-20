<template>
  <div class="flex min-h-0 grow flex-col">
    <h2
      :style="{ cursor: props.isDragging ? 'grabbing' : 'grab' }"
      class="z-20 mx-2 flex shrink-0 items-center pt-3 pr-2 pb-2 pl-1 text-2xl font-bold text-slate-800/70 select-none"
      @mousedown="emit('dragStart', $event)"
    >
      <div class="flex min-w-0 grow items-center gap-x-2.5 pl-1.5">
        <span class="min-w-0 grow truncate text-left text-xl font-bold text-slate-800/70">Connect Ethereum Wallet</span>
        <button
          type="button"
          class="relative z-10 flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-md border border-slate-400/60 hover:border-slate-500/60 hover:bg-[#f1f3f7] focus:outline-none"
          @click="emit('close')"
        >
          <XMarkIcon class="pointer-events-none h-5 w-5 stroke-2 text-slate-500/60" />
        </button>
      </div>
    </h2>

    <div class="min-h-0 grow overflow-y-auto border-t border-slate-300 px-5 text-left">
      <div v-if="ethereumImportStep === 'external'" class="mt-5">
        <fieldset class="mb-3">
          <legend class="mb-2 text-sm font-semibold text-slate-700">Import method</legend>
          <div class="grid grid-cols-2 gap-2">
            <label
              class="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2"
              :class="ethereumImportMode === 'privateKey' ? 'border-argon-500 bg-argon-50' : 'border-slate-300'"
            >
              <input
                v-model="ethereumImportMode"
                type="radio"
                value="privateKey"
                name="ethereum-import-mode"
                class="accent-argon-600 mt-1 size-4"
              />
              <span class="flex flex-col">
                <span class="font-bold">Private key</span>
                <span class="text-sm text-slate-600">(i.e., MetaMask)</span>
              </span>
            </label>
            <label
              class="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2"
              :class="ethereumImportMode === 'mnemonic' ? 'border-argon-500 bg-argon-50' : 'border-slate-300'"
            >
              <input
                v-model="ethereumImportMode"
                type="radio"
                value="mnemonic"
                name="ethereum-import-mode"
                class="accent-argon-600 mt-1 size-4"
              />
              <span class="flex flex-col">
                <span class="font-bold">Mnemonic</span>
                <span class="text-sm text-slate-600">(i.e., Uniswap)</span>
              </span>
            </label>
          </div>
        </fieldset>
        <a
          v-if="ethereumImportMode === 'privateKey'"
          :href="`${NetworkConfig.websiteHost}/docs/bridgeless-transfers/connect-metamask-wallet`"
          target="_blank"
          rel="noopener noreferrer"
          class="text-argon-600 hover:text-argon-700 mb-3 inline-block text-sm"
        >
          How to export your private key from MetaMask ↗
        </a>
        <a
          v-else
          :href="`${NetworkConfig.websiteHost}/docs/bridgeless-transfers/connect-uniswap-wallet`"
          target="_blank"
          rel="noopener noreferrer"
          class="text-argon-600 hover:text-argon-700 mb-3 inline-block text-sm"
        >
          How to export your mnemonic from Uniswap ↗
        </a>
        <textarea
          v-model="ethereumSecretInput"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          class="focus:border-argon-500 h-28 w-full resize-none rounded-md border border-slate-300 p-3 font-mono text-sm outline-none"
          :placeholder="ethereumImportMode === 'privateKey' ? 'Paste private key' : 'Paste mnemonic'"
        />
        <div class="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Keep this private. Anyone with this {{ ethereumImportMode === 'privateKey' ? 'key' : 'mnemonic' }} can control
          your wallet.
        </div>
        <label v-if="ethereumImportMode === 'privateKey'" class="mb-3 block">
          <span class="mt-4 mb-1 block text-sm font-semibold text-slate-700">Wallet Name</span>
          <input
            v-model="ethereumWalletNameInput"
            maxlength="18"
            class="focus:border-argon-500 w-full rounded-md border border-slate-300 px-3 py-2 outline-none"
            placeholder="Name this wallet"
          />
        </label>
        <div v-if="ethereumImportError" class="mt-2 text-sm text-red-600">{{ ethereumImportError }}</div>
        <div class="mt-4 flex justify-end gap-2 pb-4">
          <button
            type="button"
            class="bg-argon-600 cursor-pointer rounded-md px-4 py-2 font-bold text-white disabled:opacity-50"
            :disabled="isImportingEthereum"
            @click="continueExternalImport"
          >
            {{ ethereumImportMode === 'privateKey' ? 'Import Wallet' : 'Load Wallets From Mnemonic' }}
          </button>
        </div>
      </div>

      <div v-else-if="ethereumImportStep === 'mnemonicAccounts'" class="mt-5">
        <div class="mb-3 flex items-center justify-between">
          <div>
            <div class="text-sm text-slate-500">Choose the wallet you want to import.</div>
          </div>
          <div v-if="isScanningBalances" class="flex items-center gap-2 text-sm text-slate-500">
            <span class="border-t-argon-600 size-3 animate-spin rounded-full border-2 border-slate-300" />
            Scanning balances
          </div>
        </div>
        <div class="max-h-80 overflow-y-auto rounded-lg border border-slate-200">
          <button
            v-for="(account, index) in mnemonicAccounts"
            :key="account.derivationPath"
            type="button"
            class="flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left transition last:border-b-0"
            :class="[
              selectedMnemonicPath === account.derivationPath ? 'bg-argon-50' : 'hover:bg-slate-50',
              account.wallet && !hasTrackedBalance(account.wallet) ? 'opacity-45' : '',
            ]"
            @click="selectedMnemonicPath = account.derivationPath"
          >
            <span
              class="flex size-5 shrink-0 items-center justify-center rounded-full border"
              :class="
                selectedMnemonicPath === account.derivationPath
                  ? 'border-argon-600 bg-argon-600'
                  : 'border-slate-300 bg-white'
              "
            >
              <span v-if="selectedMnemonicPath === account.derivationPath" class="size-2 rounded-full bg-white" />
            </span>
            <Unicon
              v-if="account.wallet && hasTrackedBalance(account.wallet)"
              :address="account.address"
              :size="40"
              class="shrink-0"
            />
            <div v-else class="size-10 shrink-0" aria-hidden="true" />
            <span class="min-w-0 grow">
              <span class="block font-semibold text-slate-800">Account {{ index + 1 }}</span>
              <span class="block font-mono text-sm text-slate-500">
                {{ abbreviateEthereumAddress(account.address) }}
              </span>
            </span>
            <span class="shrink-0 text-right text-sm font-semibold text-slate-600">
              <template v-if="account.wallet?.fetchErrorMsg">Unavailable</template>
              <template v-else-if="account.wallet">
                <span class="block">{{ formatArgn(account.wallet.availableMicrogons) }} ARGN</span>
                <span class="block">{{ formatArgnot(account.wallet.availableMicronots) }} ARGNOT</span>
              </template>
              <template v-else-if="isScanningBalances">—</template>
            </span>
          </button>
        </div>
        <label class="mt-4 block">
          <span class="mb-1 block text-sm font-semibold text-slate-700">Wallet Name</span>
          <input
            v-model="ethereumWalletNameInput"
            maxlength="18"
            class="focus:border-argon-500 w-full rounded-md border border-slate-300 px-3 py-2 outline-none"
            placeholder="Name this wallet"
          />
        </label>
        <div v-if="ethereumImportError" class="mt-2 text-sm text-red-600">{{ ethereumImportError }}</div>
        <div class="mt-4 flex justify-end gap-2 pb-4">
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
            Import Wallet
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import Unicon from '../../components/Unicon.vue';
import type { IWalletRecord } from '../../lib/db/WalletsTable.ts';
import type { IWallet } from '../../lib/Wallet.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useWallets } from '../../stores/wallets.ts';
import type { IWalletSetupStep } from '../walletOverlayState.ts';

const props = defineProps<{
  initialStep?: IWalletSetupStep;
  isDragging: boolean;
}>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'close'): void;
  (event: 'complete', walletRecord: IWalletRecord): void;
}>();

const wallets = useWallets();
const currency = getCurrency();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);
const ethereumImportStep = Vue.ref<'external' | 'mnemonicAccounts'>();
const ethereumImportMode = Vue.ref<'privateKey' | 'mnemonic'>('privateKey');
const ethereumSecretInput = Vue.ref('');
const ethereumWalletNameInput = Vue.ref('');
const ethereumImportError = Vue.ref('');
const isImportingEthereum = Vue.ref(false);
const isScanningBalances = Vue.ref(false);
const mnemonicAccounts = Vue.ref<{ address: string; derivationPath: string; wallet?: IWallet }[]>([]);
const selectedMnemonicPath = Vue.ref('');

function openEthereumImport() {
  ethereumImportStep.value = 'external';
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
}

function normalizeEthereumMnemonic(value: string) {
  return value
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .join(' ');
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
    const mnemonic = normalizeEthereumMnemonic(ethereumSecretInput.value);
    const wordCount = mnemonic ? mnemonic.split(' ').length : 0;
    if (wordCount !== 12 && wordCount !== 24) {
      ethereumImportError.value = `Enter exactly 12 or 24 mnemonic words. You entered ${wordCount}.`;
      return;
    }
    ethereumSecretInput.value = mnemonic;
    mnemonicAccounts.value = await wallets.previewExternalEthereumMnemonic(mnemonic);
    selectedMnemonicPath.value = mnemonicAccounts.value[0]?.derivationPath ?? '';
    ethereumImportStep.value = 'mnemonicAccounts';
    await scanMnemonicBalances();
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
      const wallet = balances.find(x => x.address === account.address)?.wallet;
      return wallet ? { ...account, wallet } : account;
    });
  } finally {
    isScanningBalances.value = false;
  }
}

function abbreviateEthereumAddress(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function hasTrackedBalance(wallet: IWallet) {
  return wallet.availableMicrogons > 0n || wallet.availableMicronots > 0n;
}

function formatArgn(microgons: bigint) {
  return microgonToArgonNm(microgons).format('0,0.[000]');
}

function formatArgnot(micronots: bigint) {
  return micronotToArgonotNm(micronots).format('0,0.[000]');
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
