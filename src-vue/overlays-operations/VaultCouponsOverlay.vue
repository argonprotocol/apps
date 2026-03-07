<template>
  <OverlayBase :isOpen="isOpen" :overflowScroll="false" @close="closeOverlay" @esc="closeOverlay" class="w-7/12">
    <template #title>
      <div class="grow text-2xl font-bold">Manage Coupons</div>
    </template>

    <div v-if="errorMessage" class="px-4 py-3 text-sm text-red-700">
      {{ errorMessage }}
    </div>
    <div v-if="coupons.length === 0" class="px-4 py-4 italic">No coupons found.</div>
    <div v-else class="max-h-72 space-y-3 overflow-y-auto px-4 py-4">
      <div v-for="coupon in coupons" :key="coupon.id" class="rounded-md border border-slate-300 px-3 py-3">
        <div class="flex flex-row items-start justify-between gap-x-4">
          <div>
            <div class="font-semibold text-slate-900">{{ coupon.label }}</div>
            <div class="text-xs text-slate-500">Max sats: {{ coupon.maxSatoshis.toString() }}</div>
            <div class="text-xs break-all text-slate-500">Public key: {{ coupon.publicKey }}</div>
            <div class="text-xs break-all text-slate-500">Private key: {{ coupon.privateKey }}</div>
            <a :href="`https://argon.network/capital-invite?key=${coupon.privateKey}&ip=`">Link</a>
          </div>
          <div class="text-xs font-semibold whitespace-nowrap" :class="statusClass(coupon.txId)">
            {{ transactionStatus(coupon.txId) }}
          </div>
        </div>
      </div>
    </div>
    <div v-if="isAddingCoupon" class="mx-4">
      <div>
        <label>Recipient Name</label>
        <input
          v-model.trim="couponLabel"
          type="text"
          class="focus:border-argon-600 mt-2 w-full rounded-md border border-slate-300 focus:ring-0" />
      </div>

      <div class="mt-3">
        <label>Max Satoshis Allowed For Free Lock</label>
        <InputNumber v-model="maxSatoshisNumber" :min="1" :max="2100000000000000" suffix=" sats" />
      </div>

      <div class="mt-2 flex flex-row gap-x-2">
        <button @click="toggleAddCoupon" class="text-argon-600 rounded border px-3 py-1">Cancel</button>
        <button
          @click="createCoupon"
          :disabled="isCreatingCoupon"
          class="border-argon-700 bg-argon-600 rounded border px-3 py-1 text-white disabled:opacity-50">
          {{ isCreatingCoupon ? 'Creating...' : 'Create' }}
        </button>
      </div>
    </div>
    <div v-else @click="toggleAddCoupon" class="text-argon-600 mx-4 cursor-pointer">+ Add Coupon</div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import InputNumber from '../components/InputNumber.vue';
import { getDbPromise } from '../stores/helpers/dbPromise.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getMyVault } from '../stores/vaults.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import type { IVaultCouponRecord } from '../lib/db/VaultCouponsTable.ts';
import { BitcoinLock, Keyring, mnemonicGenerate, u8aToHex } from '@argonprotocol/mainchain';
import { mnemonicToMiniSecret, sr25519PairFromSeed } from '@polkadot/util-crypto';

const isOpen = Vue.ref(false);
const isAddingCoupon = Vue.ref(false);
const isCreatingCoupon = Vue.ref(false);
const errorMessage = Vue.ref<string | null>(null);
const couponLabel = Vue.ref('');
const maxSatoshisNumber = Vue.ref(100_000_000);
const coupons = Vue.ref<IVaultCouponRecord[]>([]);

const myVault = getMyVault();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();

function closeOverlay() {
  isOpen.value = false;
}

function toggleAddCoupon() {
  errorMessage.value = null;
  isAddingCoupon.value = !isAddingCoupon.value;
  if (!isAddingCoupon.value) {
    couponLabel.value = '';
    maxSatoshisNumber.value = 100_000_000;
  }
}

function transactionStatus(txId: number): string {
  const txInfo = transactionTracker.data.txInfos.find(x => x.tx.id === txId);
  if (!txInfo) return 'Recorded';
  if (txInfo.tx.status === TransactionStatus.Finalized) return 'Finalized';
  if (txInfo.tx.status === TransactionStatus.Error) return 'Failed';
  if (txInfo.tx.status === TransactionStatus.TimedOutWaitingForBlock) return 'Timed Out';
  if (txInfo.tx.status === TransactionStatus.InBlock) return 'In Block';
  return 'Submitting';
}

function statusClass(txId: number): string {
  const status = transactionStatus(txId);
  if (status === 'Finalized') return 'text-green-700';
  if (status === 'Failed' || status === 'Timed Out') return 'text-red-700';
  return 'text-slate-600';
}

async function loadCoupons() {
  await transactionTracker.load();
  await myVault.load();
  const vaultId = myVault.createdVault?.vaultId;
  if (!vaultId) {
    coupons.value = [];
    return;
  }
  const db = await getDbPromise();
  coupons.value = await db.vaultCouponsTable.fetchByVaultId(vaultId);
}

async function createCoupon() {
  if (isCreatingCoupon.value) return;

  const label = couponLabel.value.trim();
  if (!label) {
    errorMessage.value = 'Enter a label for the coupon.';
    return;
  }

  const maxSatoshis = BigInt(Math.floor(maxSatoshisNumber.value));
  if (maxSatoshis <= 0n) {
    errorMessage.value = 'Max satoshis must be greater than zero.';
    return;
  }

  try {
    errorMessage.value = null;
    isCreatingCoupon.value = true;

    await myVault.load();
    const vaultId = myVault.createdVault?.vaultId;
    if (!vaultId) {
      throw new Error('No vault is available to create a coupon.');
    }

    const client = await getMainchainClient(false);
    if (!BitcoinLock.areFeeCouponsSupported(client)) {
      throw new Error('Fee coupons are not supported by the connected mainchain.');
    }

    const couponMnemonic = mnemonicGenerate();
    const couponSeed = mnemonicToMiniSecret(couponMnemonic);
    const couponKeypair = sr25519PairFromSeed(couponSeed);
    const couponProofKeypair = new Keyring({ type: 'sr25519' }).addFromSeed(couponSeed);
    const publicKey = u8aToHex(couponKeypair.publicKey);
    const privateKey = u8aToHex(couponKeypair.secretKey);
    const signer = await walletKeys.getVaultingKeypair();
    const tx = client.tx.bitcoinLocks.registerFeeCoupon(couponProofKeypair.publicKey, maxSatoshis, null);
    const txInfo = await transactionTracker.submitAndWatch({
      tx,
      signer,
      extrinsicType: ExtrinsicType.VaultRegisterCoupon,
      metadata: {
        vaultId,
        label,
        publicKey,
        maxSatoshis,
      },
    });

    const db = await getDbPromise();
    await db.vaultCouponsTable.insert({
      vaultId,
      txId: txInfo.tx.id,
      label,
      publicKey,
      privateKey,
      maxSatoshis,
    });

    await loadCoupons();
    toggleAddCoupon();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to create coupon.';
  } finally {
    isCreatingCoupon.value = false;
  }
}

basicEmitter.on('openVaultCouponsOverlay', () => {
  isOpen.value = true;
  void loadCoupons();
});

Vue.watch(isOpen, isNowOpen => {
  if (isNowOpen) {
    void loadCoupons();
  }
});
</script>
