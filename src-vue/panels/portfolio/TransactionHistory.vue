<template>
  <div class="flex flex-row items-center justify-center pb-[20%] text-center">
    <table class="m-5 mt-10 h-full w-full table-auto">
      <thead class="text-argon-600 sticky border-b border-slate-200 font-bold tracking-wide uppercase">
        <tr>
          <th class="p-2 text-left">Date</th>
          <th class="p-2 text-left">Transfer</th>
          <th class="p-2 text-left">Amount</th>
          <th class="p-2 text-left">Block #</th>
          <th class="p-2 text-right">Details</th>
        </tr>
      </thead>
      <tbody class="font-mono">
        <tr v-for="(tx, i) in transactions" :key="tx.id" :class="[i % 2 === 0 ? 'bg-argon-100/20' : '']">
          <td class="p-2 text-left text-slate-500">{{ dayjs.utc(tx.createdAt).local().fromNow() }}</td>
          <td class="p-2 text-left">{{ getTransferInfo(tx) }}</td>
          <td class="p-2 text-left">
            {{ microgonToMoneyNm(bigIntAbs(tx.amount)).format('0,0.[00]') }}
            {{ tx.currency === 'argon' ? 'ARGN' : 'ARGNOT' }}
          </td>
          <td class="p-2 text-left">
            {{ numeral(tx.blockNumber).format('0,0') }}
          </td>
          <td class="relative p-2 text-right">
            <a @click="openTx(tx)" class="!text-argon-600 hover:text-argon-800 cursor-pointer">track</a>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { getDbPromise } from '../../stores/helpers/dbPromise.ts';
import * as Vue from 'vue';
import { capitalize } from 'vue';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { IWalletTransferRecord } from '../../lib/db/WalletTransfersTable.ts';
import { getWalletBalances, getWalletKeys } from '../../stores/wallets.ts';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { bigIntAbs } from '@argonprotocol/apps-core';

dayjs.extend(utc);

const keys = getWalletKeys();
const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

function getTransferInfo(tx: IWalletTransferRecord): string {
  const wallet = capitalize(tx.walletName);
  let destination = '...';
  if (tx.otherParty) {
    destination = formatAddress(tx.otherParty);
  } else {
    if (tx.transferType === 'tokenGateway') {
      destination = 'Ethereum';
    } else if (tx.transferType === 'transfer') {
      destination = 'Transfer';
    } else if (tx.transferType === 'faucet') {
      destination = 'Testnet Faucet';
    }
  }
  if (tx.amount < 0n) {
    if (tx.transferType === 'tokenGateway') {
      destination = `Ethereum (${destination})`;
    }
    return `${wallet} -> ${destination}`;
  }
  return `${destination} -> ${wallet}`;
}

function formatAddress(address: string): string {
  if (keys.miningHoldAddress === address) {
    return 'Mining';
  } else if (keys.miningBotAddress === address) {
    return 'MiningBot';
  } else if (keys.vaultingAddress === address) {
    return 'Vaulting';
  }

  if (address.startsWith('0x')) {
    address = address.slice(2);
    address = address.replace(/^0+/, '');
    address = '0x' + address;
  }

  return address.slice(0, 6) + '...' + address.slice(-4);
}

function openTx(tx: IWalletTransferRecord) {
  let url = `https://argon.statescan.io/#/extrinsics/${tx.blockNumber}-${tx.extrinsicIndex}`;
  if (tx.tokenGatewayCommitmentHash) {
    url = `https://explorer.hyperbridge.network/messages/${tx.tokenGatewayCommitmentHash}`;
  }
  tauriOpenUrl(url);
}

async function loadTransactionHistory(): Promise<void> {
  const db = await getDbPromise();

  const allTransfers = await db.walletTransfersTable.fetchAll();
  const allBlockExtrinsics: { [key: string]: number } = {};
  for (const tx of allTransfers) {
    const key = `${tx.blockNumber}-${tx.extrinsicIndex}`;
    allBlockExtrinsics[key] ??= 0;
    allBlockExtrinsics[key] += 1;
  }
  transactions.value = allTransfers.filter(x => {
    if (x.amount < 0n && allBlockExtrinsics[`${x.blockNumber}-${x.extrinsicIndex}`] > 1) {
      return false;
    }
    return true;
  });
}

const transactions = Vue.ref<IWalletTransferRecord[]>([]);
Vue.onMounted(async () => {
  await loadTransactionHistory();
  const balances = getWalletBalances();
  balances.events.on('transfer-in', async () => {
    await loadTransactionHistory();
  });
});
</script>
