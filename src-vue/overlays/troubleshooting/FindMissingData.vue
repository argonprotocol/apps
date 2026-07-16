<template>
  <div ref="containerRef" class="flex min-h-[90%] flex-col gap-4 overflow-x-hidden overflow-y-auto pt-3 pr-7 pb-5 pl-4">
    <DiagnosticStep ref="step1" :run="() => checkWalletHistory()">
      <heading>Searching for Missing Wallet History</heading>
      <success>Your wallet history is up to date.</success>
      <failure>Unable to restore wallet history.</failure>
    </DiagnosticStep>

    <DiagnosticStep ref="step2" :run="() => checkVault()">
      <heading>Searching for Missing Vault</heading>
      <success v-slot="{ data }">
        <template v-if="data.isNotFound">No vault was found.</template>
        <template v-else-if="data.isUnchanged">Your vault is already up to date.</template>
        <template v-else>
          We were able to recover your missing vault created in block #{{ data.createdAtBlockHeight ?? 'unknown' }}.
        </template>
      </success>
      <failure>No vault was found.</failure>
    </DiagnosticStep>

    <DiagnosticStep ref="step3" :run="() => checkBitcoins()">
      <heading>Searching for Missing Bitcoins</heading>
      <success v-slot="{ data }">
        <template v-if="data.isNotFound">No bitcoins were found.</template>
        <template v-else-if="data.isUnchanged">Your bitcoins are already up to date.</template>
        <template v-else>
          We were able to recover {{ data.foundBitcoins }} missing bitcoin{{ data.foundBitcoins === 1 ? '' : 's' }}.
        </template>
      </success>
      <failure>No bitcoins were found.</failure>
    </DiagnosticStep>

    <DiagnosticStep ref="step4" :run="() => checkMintingAuthorities()">
      <heading>Searching for Missing Minting Authorities</heading>
      <success v-slot="{ data }">
        <template v-if="data.isNotFound">No Ethereum minting authorities were found for this vault operator.</template>
        <template v-else-if="data.isUnchanged">Your minting authorities are already up to date.</template>
        <template v-else>
          We were able to recover {{ data.recoveredAuthorities }} missing minting authorit{{
            data.recoveredAuthorities === 1 ? 'y' : 'ies'
          }}.
        </template>
      </success>
      <failure>Unable to recover minting authorities.</failure>
    </DiagnosticStep>

    <DiagnosticStep ref="step5" :run="() => checkFinancialHistory()">
      <heading>Restoring Investment History</heading>
      <success v-slot="{ data }">
        <template v-if="data.isUnchanged">Your investment history is already up to date.</template>
        <template v-else>Recovered {{ data.recoveredBlocks }} investment history blocks.</template>
      </success>
      <failure>Unable to restore complete investment history.</failure>
    </DiagnosticStep>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import DiagnosticStep from './components/DiagnosticStep.vue';
import success from './components/DiagnosticSuccess.vue';
import failure from './components/DiagnosticFailure.vue';
import heading from './components/DiagnosticHeading.vue';
import { getWalletHistoryRecovery, getWalletKeys, useWallets } from '../../stores/wallets.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { MyVaultRecovery } from '../../lib/recovery/MyVaultDiscovery.ts';
import { getBlockWatch, getMainchainClients, getFinalizedClient } from '../../stores/mainchain.ts';
import { useFinancials } from '../../stores/financials.ts';

const wallets = useWallets();
const walletKeys = getWalletKeys();
const myVault = getMyVault();
const bitcoinLocks = getBitcoinLocks();
const financials = useFinancials();

const containerRef = Vue.ref<HTMLElement>();

const step1 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step2 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step3 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step4 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step5 = Vue.ref<InstanceType<typeof DiagnosticStep>>();

function scrollToBottom() {
  if (containerRef.value) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight;
  }
}

async function checkWalletHistory() {
  await wallets.isLoadedPromise;
  const walletHistoryRecovery = getWalletHistoryRecovery();
  await walletHistoryRecovery.prepare();
  await walletHistoryRecovery.recoverNow(getBlockWatch().finalizedBlockHeader.blockNumber, true);
}

async function checkVault() {
  await myVault.load();
  await bitcoinLocks.load();
  // Check if vault already exists
  const vaultExists = !!myVault.createdVault;
  const clients = getMainchainClients();
  const data = {
    isUnchanged: true,
    isNotFound: false,
    createdAtBlockHeight: myVault.metadata?.createdAtBlockHeight,
  };
  if (!vaultExists) {
    const foundVault = await MyVaultRecovery.findOperatorVault(clients, bitcoinLocks.bitcoinNetwork, walletKeys);
    if (foundVault) {
      await myVault.recordVault(foundVault);
      data.isUnchanged = false;
      data.createdAtBlockHeight = foundVault.createBlockNumber;
    } else {
      data.isNotFound = true;
    }
  }

  return data;
}

async function checkBitcoins() {
  await bitcoinLocks.load();
  if (!myVault.createdVault) {
    return {
      isNotFound: true,
    };
  }
  const table = await bitcoinLocks.getTable();
  const existing = await table.fetchAll();
  const bitcoins = await MyVaultRecovery.recoverPersonalBitcoin({
    bitcoinLocks: bitcoinLocks,
    vaultSetupBlockNumber: myVault.metadata!.createdAtBlockHeight!,
    vault: myVault.createdVault!,
    mainchainClients: getMainchainClients(),
  });
  const newlyFound = bitcoins.filter(b => !existing.some(e => e.utxoId === b.utxoId));

  return {
    isUnchanged: newlyFound.length === 0,
    isNotFound: bitcoins.length === 0,
    foundBitcoins: newlyFound.length,
  };
}

async function checkMintingAuthorities() {
  await myVault.load();
  const recoveredAuthorityCountOnLoad = myVault.mintingAuthorities.recoveredAuthorityCountOnLoad;
  if (recoveredAuthorityCountOnLoad > 0) {
    return {
      isUnchanged: false,
      isNotFound: false,
      recoveredAuthorities: recoveredAuthorityCountOnLoad,
    };
  }

  const previousAuthorityKeys = new Set(
    myVault.mintingAuthorities.data.authorities.map(authority => {
      return `${authority.authorityIndex ?? 'missing'}:${authority.signer.toLowerCase()}`;
    }),
  );
  const finalizedClient = await getFinalizedClient();
  const restoredAuthorities = await myVault.mintingAuthorities.restoreSignerIndexes(finalizedClient);

  await myVault.mintingAuthorities.refresh(finalizedClient);

  const recoveredAuthorities = restoredAuthorities.filter(authority => {
    return !previousAuthorityKeys.has(`${authority.authorityIndex ?? 'missing'}:${authority.signer.toLowerCase()}`);
  }).length;

  return {
    isUnchanged: recoveredAuthorities === 0,
    isNotFound: restoredAuthorities.length === 0,
    recoveredAuthorities,
  };
}

async function checkFinancialHistory() {
  await financials.restoreFinancialHistory(true);
  if (financials.historyRecovery.state === 'error') {
    throw new Error(financials.historyRecovery.message ?? 'Unable to restore investment history');
  }

  return {
    isUnchanged: financials.historyRecovery.recoveredBlockCount === 0,
    recoveredBlocks: financials.historyRecovery.recoveredBlockCount,
  };
}

async function findMissingData() {
  await myVault.load();
  await Vue.nextTick();

  const steps = [step1.value, step2.value, step3.value, step4.value, step5.value].filter(Boolean);
  for (const step of steps) {
    if (step && typeof step.run === 'function') {
      await step.run();
      await Vue.nextTick();
      scrollToBottom();
    }
  }
}

Vue.onMounted(async () => {
  findMissingData().catch(e => {
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
