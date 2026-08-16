<template>
  <dl
    class="grid gap-x-4 gap-y-2 text-sm"
    :class="wide ? 'grid-cols-[110px_minmax(0,1fr)_110px_minmax(0,1fr)]' : 'grid-cols-[110px_minmax(0,1fr)]'"
  >
    <dt>Sender</dt>
    <dd>
      <div v-if="sourceIdentity" class="font-medium">{{ formatCrosschainSourceIdentity(sourceIdentity) }}</div>
      <CopyableArgonAddress :address="sourceAccount" />
    </dd>

    <dt>Lifetime sent to Ethereum</dt>
    <dd v-if="sourceTotals">
      {{ formatArgon(sourceTotals.microgonsOut) }} ARGN + {{ formatArgonot(sourceTotals.micronotsOut) }} ARGNOT across
      {{ sourceTotals.transferOutCount }} transfer{{ sourceTotals.transferOutCount === 1 ? '' : 's' }}
    </dd>
    <dd v-else>Unavailable</dd>

    <dt>Recipient</dt>
    <dd>
      <div class="inline-flex max-w-full items-center gap-x-1.5">
        <span :title="recipient" class="font-mono select-all">{{ abbreviateAddress(recipient, 10) }}</span>
        <CopyToClipboard
          :content="recipient"
          class="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
          title="Copy full Ethereum address"
        >
          <CopyIcon class="h-3.5 w-3.5" />
          <template #copying><CheckIcon class="h-3.5 w-3.5 text-green-600" /></template>
        </CopyToClipboard>
      </div>
      <div v-if="recipientSeen !== undefined" class="mt-0.5 text-xs text-slate-500">
        {{ recipientSeen ? 'Used by this sender before' : 'New Ethereum address for this sender' }}
      </div>
      <div v-else class="mt-0.5 text-xs text-slate-500">Recipient history is still syncing</div>
    </dd>

    <template v-if="progress">
      <dt>Progress</dt>
      <dd>{{ progress }}</dd>
    </template>
  </dl>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT } from '@argonprotocol/apps-core';
import { CheckIcon } from '@heroicons/vue/24/outline';
import CopyIcon from '../assets/copy.svg';
import CopyableArgonAddress from './CopyableArgonAddress.vue';
import CopyToClipboard from './CopyToClipboard.vue';
import { formatCrosschainSourceIdentity, type ICrosschainSourceIdentity } from '../lib/CrosschainTransferView.ts';
import type {
  ICrosschainSourceTransferTotals,
  IMintingAuthorityAuthorization,
  IMintingAuthorityBackedTransfer,
} from '../lib/MintingAuthorities.ts';
import { abbreviateAddress } from '../lib/Utils.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';

const props = defineProps<{
  transfer: IMintingAuthorityAuthorization | IMintingAuthorityBackedTransfer;
  sourceIdentity?: ICrosschainSourceIdentity;
  sourceTotals?: ICrosschainSourceTransferTotals;
  recipientSeen?: boolean;
  progress?: string;
  wide?: boolean;
}>();

const currency = getCurrency();
const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const sourceAccount = Vue.computed(() => {
  return props.transfer.sourceAccount;
});
const recipient = Vue.computed(() => {
  return 'finalizeRequest' in props.transfer
    ? props.transfer.finalizeRequest.recipient
    : props.transfer.destinationAccount;
});
function formatArgon(value: bigint) {
  if (value > 0n && value < BigInt(MICROGONS_PER_ARGON) / 100n) return '<0.01';
  return microgonToArgonNm(value).format('0,0.[00]');
}

function formatArgonot(value: bigint) {
  if (value > 0n && value < BigInt(MICRONOTS_PER_ARGONOT) / 100n) return '<0.01';
  return micronotToArgonotNm(value).format('0,0.[00]');
}
</script>

<style scoped>
@reference "../main.css";

dt {
  @apply text-slate-500;
}

dd {
  @apply min-w-0 break-words text-slate-700;
}
</style>
