<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    data-testid="GatewayRelayOverlay"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="w-[620px]">
    <template #title>
      <div class="grow text-2xl font-bold">Relay Pending Gateway Activities</div>
    </template>

    <div class="px-6 py-5 text-slate-700">
      <div v-if="isLoading" class="py-10 text-center text-sm font-medium text-slate-500">
        Loading pending Ethereum gateway relay work...
      </div>

      <div v-else-if="loadError" class="space-y-4">
        <div class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ loadError }}
        </div>

        <div class="flex justify-end">
          <button
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            @click="closeOverlay">
            Close
          </button>
        </div>
      </div>

      <div v-else-if="preview" class="space-y-5">
        <p class="text-sm leading-6 text-slate-500">
          This sends ready Ethereum gateway updates using your Ethereum wallet. Collect still records council approvals and collateralizes transfers separately; this step is only for the outbound Ethereum relay.
        </p>

        <div v-if="submitSuccessHash" class="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Gateway activities were relayed to Ethereum in transaction
          <span class="font-mono">{{ submitSuccessHash }}</span>.
        </div>

        <div v-if="submitError" class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ submitError }}
        </div>

        <div class="rounded-lg border border-slate-200 bg-white">
          <div class="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800">Relay summary</div>

          <dl class="divide-y divide-slate-200">
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Pays from Ethereum address</dt>
              <dd class="max-w-[320px] break-all text-right font-mono text-sm text-slate-800">
                {{ preview.signerAddress }}
              </dd>
            </div>

            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Current ETH balance</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{ formatEth(preview.ethereumBalanceWei) }} ETH
              </dd>
            </div>

            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Ready gateway activities</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{ preview.updateCount }}
              </dd>
            </div>

            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Minting authority activations</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{ preview.activationCount }}
              </dd>
            </div>

            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Included deactivations</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{ preview.deactivationCount }}
              </dd>
            </div>

            <div v-if="preview.firstQueueNonce != null" class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Queue range</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{
                  preview.firstQueueNonce === preview.lastQueueNonce
                    ? preview.firstQueueNonce.toString()
                    : `${preview.firstQueueNonce} - ${preview.lastQueueNonce}`
                }}
              </dd>
            </div>

            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Estimated network fee</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{ preview.feeEstimateWei != null ? `${formatEth(preview.feeEstimateWei)} ETH` : 'Not available' }}
              </dd>
            </div>

            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Expected repayment on Argon</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{ microgonToArgonNm(preview.expectedRepaymentMicrogons).format('0,0.[000000]') }} ARGN
              </dd>
            </div>

            <div v-if="estimatedFeeMicrogons != null" class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Fee at current repayment pricing</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{ microgonToArgonNm(estimatedFeeMicrogons).format('0,0.[000000]') }} ARGN
              </dd>
            </div>
          </dl>
        </div>

        <div
          class="rounded-md px-4 py-3 text-sm"
          :class="preview.canRelay ? 'border border-emerald-200 bg-emerald-50 text-emerald-800' : 'border border-amber-200 bg-amber-50 text-amber-800'">
          {{ previewMessage }}
        </div>

        <div class="flex justify-end gap-3 pt-1">
          <button
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            @click="closeOverlay">
            Close
          </button>
          <button
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            :disabled="isSubmitting"
            @click="loadPreview">
            Refresh
          </button>
          <button
            type="button"
            :disabled="isSubmitting || !preview.canRelay"
            class="bg-argon-button hover:bg-argon-button-hover rounded px-5 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40"
            @click="submitRelay">
            {{ isSubmitting ? 'Relaying...' : 'Relay to Ethereum' }}
          </button>
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { Hash } from 'viem';
import OverlayBase from '../../app-shared/overlays/OverlayBase.vue';
import basicEmitter from '../../emitters/basicEmitter.ts';
import type { IEthereumGatewayRelayPreview } from '../../lib/EthereumClient.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { formatEvmNativeFeeWei } from '../../lib/Utils.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getMyVault } from '../../stores/vaults.ts';

const currency = getCurrency();
const myVault = getMyVault();
const { microgonToArgonNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(false);
const isSubmitting = Vue.ref(false);
const loadError = Vue.ref('');
const submitError = Vue.ref('');
const submitSuccessHash = Vue.ref<Hash>();
const preview = Vue.ref<IEthereumGatewayRelayPreview>();

const estimatedFeeMicrogons = Vue.computed(() => {
  if (!preview.value?.feeEstimateWei || !preview.value.estimatedMicrogonsPerEth) {
    return;
  }

  return (preview.value.feeEstimateWei * preview.value.estimatedMicrogonsPerEth) / 10n ** 18n;
});

const previewMessage = Vue.computed(() => {
  if (!preview.value) {
    return '';
  }

  if (preview.value.canRelay) {
    return 'These minting-authority updates are ready to relay to Ethereum from the wallet shown above.';
  }

  if (preview.value.reason === 'paused') {
    return 'The Ethereum gateway is currently paused, so pending activities cannot be relayed right now.';
  }

  if (preview.value.reason === 'insufficientBalance') {
    const missingWei = (preview.value.feeEstimateWei ?? 0n) - preview.value.ethereumBalanceWei;
    return `This wallet needs about ${formatEth(missingWei)} more ETH to cover this relay.`;
  }

  if (preview.value.reason === 'repaymentTooLow') {
    return 'At current repayment pricing, this relay would cost more in Ethereum fees than the expected Argon repayment.';
  }

  return 'No minting-authority activations are ready to relay right now.';
});

async function loadPreview() {
  isLoading.value = true;
  loadError.value = '';
  submitError.value = '';

  try {
    preview.value = await myVault.globalCouncil.getReadyGatewayRelayPreview();
  } catch (error) {
    preview.value = undefined;
    loadError.value = error instanceof Error ? error.message : 'Unable to load pending gateway activities.';
  } finally {
    isLoading.value = false;
  }
}

async function submitRelay() {
  if (!preview.value?.canRelay) {
    return;
  }

  submitError.value = '';
  submitSuccessHash.value = undefined;
  isSubmitting.value = true;

  try {
    const receipt = await myVault.globalCouncil.relayApprovedGatewayUpdates();
    if (!receipt) {
      await loadPreview();
      submitError.value = 'No relayable gateway updates were available by the time this submission was sent.';
      return;
    }

    submitSuccessHash.value = receipt.transactionHash;
    await loadPreview();
    await Promise.all([myVault.globalCouncil.load(true), myVault.mintingAuthorities.load(true)]);
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : 'Unable to relay pending gateway activities.';
  } finally {
    isSubmitting.value = false;
  }
}

function closeOverlay() {
  isOpen.value = false;
}

function formatEth(valueWei: bigint) {
  return formatEvmNativeFeeWei(valueWei);
}

basicEmitter.on('openGatewayRelayOverlay', () => {
  isOpen.value = true;
  submitSuccessHash.value = undefined;
  void loadPreview();
});
</script>
