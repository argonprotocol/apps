<template>
  <OverlayBase :isOpen="isOpen" :overflowScroll="false" @close="closeOverlay" @esc="closeOverlay" class="w-7/12">
    <template #title>
      <div class="grow text-2xl font-bold">Manage Member Invites</div>
    </template>

    <div v-if="!config.isServerInstalled" class="my-16 text-center text-slate-700/50">
      You must wait for your
      <br />
      <a @click="openServerOverlay" class="cursor-pointer">server to finish installing</a>
      .
    </div>
    <div v-else-if="!config.hasProfileName" class="my-16 text-center text-slate-700/50">
      You must
      <a @click="updateProfileOverlay" class="cursor-pointer">set your profile name</a>
      before
      <br />
      creating invites.
    </div>
    <template v-else>
      <div v-if="errorMessage" class="px-4 py-3 text-sm text-red-700">
        {{ errorMessage }}
      </div>
      <div v-if="invites.length === 0" class="px-4 py-4 italic">No invites found.</div>
      <div v-else class="max-h-72 space-y-3 overflow-y-auto px-4 py-4">
        <div v-for="invite in invites" :key="invite.id" class="rounded-md border-b border-slate-300 px-3 py-3">
          <div class="flex flex-row items-start justify-between gap-x-4 text-slate-800">
            <div>
              {{ invite.name }} has {{ currency.symbol
              }}{{ satoshiToMoneyNm(invite.couponMaxSatoshis).format('0,0.00') }} in free BTC locking
            </div>
            <div class="break-all">
              <CountdownClock :time="dayjs.utc(invite.couponExpiresAt)">
                <template #default="{ days, hours, minutes, seconds, isFinished }">
                  <template v-if="isFinished">expired</template>
                  <template v-else>expires in {{ days }}d {{ hours }}h {{ minutes }}m {{ seconds }}s</template>
                </template>
              </CountdownClock>
            </div>
            <div>{{ extractStatus(invite) }}</div>
            <CopyToClipboard
              :content="`${NetworkConfig.get().websiteHost}/capital-invite/${invite.inviteCode}`"
              class="cursor-pointer">
              <button type="button">Copy Link</button>
              <template #copied>
                <button type="button">Copy Link</button>
              </template>
            </CopyToClipboard>
          </div>
        </div>
      </div>
      <div v-if="isAddingCoupon" class="mx-4">
        <div>
          <label>Recipient Name</label>
          <input
            v-model.trim="inviteName"
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
      <div v-else @click="toggleAddCoupon" class="text-argon-600 mx-4 cursor-pointer">+ Add Invite</div>
    </template>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import InputNumber from '../components/InputNumber.vue';
import CopyToClipboard from '../components/CopyToClipboard.vue';
import { getMainchainClient, getMiningFrames } from '../stores/mainchain.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getMyVault } from '../stores/vaults.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { BitcoinLock, Keyring, mnemonicGenerate, u8aToHex } from '@argonprotocol/mainchain';
import { mnemonicToMiniSecret, sr25519PairFromSeed } from '@polkadot/util-crypto';
import { getConfig } from '../stores/config.ts';
import { SERVER_ENV_VARS, TICK_MILLIS } from '../lib/Env.ts';
import { JsonExt } from '@argonprotocol/apps-core';
import { VaultInvites } from '../lib/VaultInvites.ts';
import dayjs, { Dayjs } from 'dayjs';
import CountdownClock from '../components/CountdownClock.vue';
import type { ICapitalInvite } from '@argonprotocol/apps-router';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { NetworkConfig } from '@argonprotocol/apps-core';

const config = getConfig();
const myVault = getMyVault();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();
const miningFrames = getMiningFrames();
const currency = getCurrency();

const { satoshiToMoneyNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isAddingCoupon = Vue.ref(false);
const isCreatingCoupon = Vue.ref(false);
const errorMessage = Vue.ref<string | null>(null);
const inviteName = Vue.ref('');
const maxSatoshisNumber = Vue.ref(100_000_000);
const invites = Vue.ref<ICapitalInvite[]>([]);

const ipAddress = Vue.computed(() => {
  return config.serverDetails.ipAddress;
});

function closeOverlay() {
  isOpen.value = false;
}

function toggleAddCoupon() {
  errorMessage.value = null;
  isAddingCoupon.value = !isAddingCoupon.value;
  if (!isAddingCoupon.value) {
    inviteName.value = '';
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

function extractStatus(invite: any): 'converted' | 'pending' | 'expired' | 'clicked' {
  if (invite.registeredAppAt) {
    return 'converted';
  } else if (invite.lastClickedAt) {
    return 'clicked';
  } else if (invite.couponExpiresAt && invite.couponExpiresAt < new Date()) {
    return 'expired';
  } else {
    return 'pending';
  }
}

function updateProfileOverlay() {
  basicEmitter.emit('openProfileOverlay');
}

function openServerOverlay() {
  basicEmitter.emit('openServerOverlay');
}

async function loadInvites() {
  errorMessage.value = null;
  await transactionTracker.load();
  await myVault.load();
  const vaultId = myVault.createdVault?.vaultId;
  if (!vaultId) {
    invites.value = [];
    return;
  }

  try {
    const response = await fetch(`http://${ipAddress.value}:${SERVER_ENV_VARS.ROUTER_PORT}/capital-users/invites`);
    if (!response.ok) {
      invites.value = [];
      errorMessage.value = 'Unable to load invites right now. Please try again.';
      return;
    }

    const rawBody = await response.text();
    invites.value = JsonExt.parse<ICapitalInvite[]>(rawBody);
  } catch {
    invites.value = [];
    errorMessage.value = 'Unable to load invites right now. Please try again.';
  }
}

async function createCoupon() {
  if (isCreatingCoupon.value) return;

  const name = inviteName.value.trim();
  if (!name) {
    errorMessage.value = 'Enter a name for the coupon.';
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
    const couponPublicKey = u8aToHex(couponKeypair.publicKey);
    const couponPrivateKey = u8aToHex(couponKeypair.secretKey);
    const signer = await walletKeys.getVaultingKeypair();
    const tx = client.tx.bitcoinLocks.registerFeeCoupon(couponProofKeypair.publicKey, maxSatoshis, null);
    const txInfo = await transactionTracker.submitAndWatch({
      tx,
      signer,
      extrinsicType: ExtrinsicType.VaultRegisterCoupon,
      metadata: {
        vaultId,
        name,
        couponPublicKey,
        couponMaxSatoshis: maxSatoshis,
      },
    });

    const couponExpirationFrame = myVault.data.currentFrameId + 1;
    const expirationFrameEndTick = miningFrames.getTickEnd(couponExpirationFrame);
    if (!expirationFrameEndTick) {
      throw new Error(`Unable to calculate expiration tick for frame ${couponExpirationFrame}.`);
    }

    const inviteCode = VaultInvites.encodeInviteCode(ipAddress.value, SERVER_ENV_VARS.ROUTER_PORT, couponPrivateKey);
    await submitCapitalUser({
      name,
      inviteCode,
      vaultId,
      couponTxId: txInfo.tx.id,
      couponPublicKey,
      couponPrivateKey,
      couponMaxSatoshis: maxSatoshis,
      couponExpirationFrame,
      couponExpiresAt: new Date(expirationFrameEndTick * TICK_MILLIS).toISOString(),
    });

    await loadInvites();
    toggleAddCoupon();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to create coupon.';
  } finally {
    isCreatingCoupon.value = false;
  }
}

async function submitCapitalUser(payload: {
  name: string;
  inviteCode: string;
  vaultId: number;
  couponTxId: number;
  couponPublicKey: string;
  couponPrivateKey: string;
  couponMaxSatoshis: bigint;
  couponExpirationFrame: number;
  couponExpiresAt: string;
}) {
  const response = await fetch(`http://${ipAddress.value}:${SERVER_ENV_VARS.ROUTER_PORT}/capital-users/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JsonExt.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Unable to submit capital user payload (${response.status}).`);
  }
}

basicEmitter.on('openVaultInvitesOverlay', () => {
  isOpen.value = true;
  void loadInvites();
});
</script>
