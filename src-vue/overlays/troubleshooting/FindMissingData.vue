<template>
  <div ref="containerRef" class="flex min-h-[90%] flex-col gap-4 overflow-x-hidden overflow-y-auto pt-3 pr-7 pb-5 pl-4">
    <DiagnosticStep ref="step1" :run="() => checkWalletTransfers()">
      <heading>Searching for Missing Wallet Transfers</heading>
      <success v-slot="{ data }">
        <template v-if="data.isUnchanged">Your wallet is already up to date.</template>
        <template v-else>
          We were able to recover {{ data.recoveredTransfers }} missing wallet transfer{{
            data.recoveredTransfers === 1 ? '' : 's'
          }}.
        </template>
      </success>
      <failure>No wallet transfers were found.</failure>
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
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import DiagnosticStep from './components/DiagnosticStep.vue';
import success from './components/DiagnosticSuccess.vue';
import failure from './components/DiagnosticFailure.vue';
import heading from './components/DiagnosticHeading.vue';
import { getWalletBalances, getWalletKeys } from '../../stores/wallets.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getDbPromise } from '../../stores/helpers/dbPromise.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { MyVaultRecovery } from '../../lib/MyVaultRecovery.ts';
import { getMainchainClients } from '../../stores/mainchain.ts';

const walletBalances = getWalletBalances();
const walletKeys = getWalletKeys();
const myVault = getMyVault();
const dbPromise = getDbPromise();
const bitcoinLocks = getBitcoinLocks();

const containerRef = Vue.ref<HTMLElement>();

const step1 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step2 = Vue.ref<InstanceType<typeof DiagnosticStep>>();
const step3 = Vue.ref<InstanceType<typeof DiagnosticStep>>();

function scrollToBottom() {
  if (containerRef.value) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight;
  }
}

async function checkWalletTransfers() {
  const db = await dbPromise;
  await walletBalances.load();
  const transfers = await db.walletTransfersTable.fetchAll();
  const blockNumbersNeeded = new Set<number>();

  for (const wallet of walletBalances.addresses) {
    await walletBalances.lookupTransferOrClaimBlocks(wallet, blockNumbersNeeded, [0, Number.MAX_SAFE_INTEGER]);
  }
  const newBlocks = new Set<number>();
  for (const block of blockNumbersNeeded) {
    if (!transfers.find(t => t.blockNumber === block)) {
      newBlocks.add(block);
    }
  }
  for (const block of newBlocks) {
    await walletBalances.resyncBlock(block);
  }
  const isUnchanged = newBlocks.size === 0;

  return {
    isUnchanged,
    recoveredTransfers: newBlocks.size,
  };
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
    bitcoinLocksStore: bitcoinLocks,
    vaultSetupBlockNumber: myVault.metadata!.createdAtBlockHeight!,
    vault: myVault.createdVault!,
    mainchainClients: getMainchainClients(),
  });
  const newlyFound = bitcoins.filter(b => !existing.some(e => e.utxoId === b.utxoId));
  if (newlyFound.length > 0) {
    await myVault.recordPersonalBitcoins(bitcoins);
  }

  return {
    isUnchanged: newlyFound.length === 0,
    foundBitcoins: newlyFound.length,
  };
}

async function findMissingData() {
  await myVault.load();
  await Vue.nextTick();

  const steps = [step1.value, step2.value, step3.value].filter(Boolean);
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
