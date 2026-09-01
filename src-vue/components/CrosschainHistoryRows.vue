<template>
  <div v-if="records.length">
    <details v-for="record in records" :key="record.id" class="group border-b border-slate-200 last:border-b-0">
      <summary class="flex cursor-pointer list-none items-center gap-x-4 px-4 py-3 hover:bg-slate-50">
        <div class="min-w-0 grow">
          <div class="flex items-center gap-x-2">
            <span class="font-semibold text-slate-800">{{ title(record) }}</span>
            <CrosschainIdentityLabel v-if="sourceIdentity(record)" :identity="sourceIdentity(record)!" compact />
          </div>
          <div class="mt-0.5 text-sm text-slate-500">
            Finalized · Argon block {{ record.blockNumber.toLocaleString() }} · {{ formatDate(record.blockTime) }}
          </div>
        </div>
        <div v-if="record.details.kind === 'transferAuthorization'" class="shrink-0 text-right">
          <div class="font-mono font-semibold text-slate-700">
            {{ formatTokenAmount(record.details.amount, record.details.moveToken) }}
          </div>
          <div class="mt-0.5 text-xs text-slate-500">
            {{ formatTokenAmount(record.details.tip, record.details.moveToken) }} tip
          </div>
        </div>
        <div class="text-slate-400 transition-transform group-open:rotate-90">›</div>
      </summary>

      <div class="border-t border-dashed border-slate-200 bg-slate-50/70 px-10 py-4">
        <dl
          v-if="record.details.kind === 'transferAuthorization'"
          class="grid grid-cols-[120px_minmax(0,1fr)_120px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm"
        >
          <dt>Sender</dt>
          <dd>
            <CrosschainIdentityLabel v-if="sourceIdentity(record)" :identity="sourceIdentity(record)!" />
            <CopyableArgonAddress :address="record.details.sourceAccount" />
          </dd>
          <dt>Recipient</dt>
          <dd class="inline-flex max-w-full items-center gap-x-1.5">
            <span :title="record.details.destinationAccount" class="font-mono select-all">
              {{ abbreviateAddress(record.details.destinationAccount, 10) }}
            </span>
            <CopyToClipboard
              :content="record.details.destinationAccount"
              class="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
              title="Copy full Ethereum address"
            >
              <CopyIcon class="h-3.5 w-3.5" />
              <template #copying><CheckIcon class="h-3.5 w-3.5 text-green-600" /></template>
            </CopyToClipboard>
          </dd>
          <dt>Collateral supplied by</dt>
          <dd :title="`Signing key ${record.details.authoritySigningKey}`">
            <CrosschainIdentityLabel v-if="authorityIdentity(record)" :identity="authorityIdentity(record)!" />
            <CopyableArgonAddress v-else :address="record.details.authorityOwnerAccount ?? record.accountId" />
            <span class="text-slate-500">
              · {{ formatArgon(record.details.microgonCollateral) }} ARGN +
              {{ formatArgonot(record.details.micronotCollateral) }} ARGNOT
            </span>
          </dd>
        </dl>

        <CrosschainActivityDetails
          v-else-if="record.details.kind === 'councilApproval'"
          :queueNonce="record.details.queueNonce"
          :targetKind="record.details.targetKind"
          :targetValue="record.details.targetValue"
          :authorityOwnerAccount="record.details.authorityOwnerAccount"
          :authorityOwnerIdentity="ownerIdentity(record)"
          :councilChange="record.details.councilChange"
          wide
        />

        <dl v-else class="grid grid-cols-[120px_minmax(0,1fr)_120px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt>Minting Authority</dt>
          <dd :title="`Signing key ${record.details.authoritySigningKey}`">
            <CrosschainIdentityLabel v-if="recordIdentity(record)" :identity="recordIdentity(record)!" />
            <CopyableArgonAddress v-else :address="record.accountId" />
          </dd>
          <template v-if="record.details.queueNonce !== undefined">
            <dt>Queue order</dt>
            <dd>#{{ record.details.queueNonce }}</dd>
          </template>
        </dl>

        <button
          v-if="record.extrinsicIndex !== undefined"
          type="button"
          class="text-argon-600 hover:text-argon-700 mt-3 inline-flex items-center gap-x-1 text-sm underline decoration-transparent underline-offset-2 hover:decoration-current"
          @click="openTransaction(record)"
        >
          Argon transaction
          <ArrowTopRightOnSquareIcon class="h-4 w-4" />
        </button>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT, MoveToken } from '@argonprotocol/apps-core';
import { ArrowTopRightOnSquareIcon, CheckIcon } from '@heroicons/vue/24/outline';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import CopyIcon from '../assets/copy.svg';
import CrosschainActivityDetails from './CrosschainActivityDetails.vue';
import CrosschainIdentityLabel from './CrosschainIdentityLabel.vue';
import CopyableArgonAddress from './CopyableArgonAddress.vue';
import CopyToClipboard from './CopyToClipboard.vue';
import type { ICrosschainSourceIdentity } from '../lib/CrosschainTransferView.ts';
import type { ICrosschainHistoryRecord } from '../lib/CrosschainHistory.ts';
import { abbreviateAddress } from '../lib/Utils.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';

const props = defineProps<{
  records: ICrosschainHistoryRecord[];
  knownIdentities: Map<string, ICrosschainSourceIdentity>;
}>();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(getCurrency());

function title(record: ICrosschainHistoryRecord) {
  if (record.details.kind === 'transferAuthorization') return `Authorized ${record.details.moveToken} to Ethereum`;
  if (record.details.kind === 'councilApproval') {
    if (record.details.targetKind === 'mintingAuthorityActivation') return 'Signed minting authority activation';
    if (record.details.targetKind === 'mintingAuthorityDeactivation') return 'Signed minting authority deactivation';
    return 'Signed global issuance council rotation';
  }
  return 'Registered minting authority';
}

function sourceIdentity(record: ICrosschainHistoryRecord) {
  if (record.details.kind !== 'transferAuthorization') return;
  return props.knownIdentities.get(record.details.sourceAccount);
}

function ownerIdentity(record: ICrosschainHistoryRecord) {
  if (record.details.kind !== 'councilApproval' || !record.details.authorityOwnerAccount) return;
  return props.knownIdentities.get(record.details.authorityOwnerAccount);
}

function authorityIdentity(record: ICrosschainHistoryRecord) {
  if (record.details.kind !== 'transferAuthorization') return;
  return props.knownIdentities.get(record.details.authorityOwnerAccount ?? record.accountId);
}

function recordIdentity(record: ICrosschainHistoryRecord) {
  return props.knownIdentities.get(record.accountId);
}

function openTransaction(record: ICrosschainHistoryRecord) {
  if (record.extrinsicIndex === undefined) return;
  void tauriOpenUrl(`https://argon.statescan.io/#/extrinsics/${record.blockNumber}-${record.extrinsicIndex}`);
}

function formatTokenAmount(amount: bigint, moveToken: MoveToken.ARGN | MoveToken.ARGNOT) {
  return moveToken === MoveToken.ARGNOT ? `${formatArgonot(amount)} ARGNOT` : `${formatArgon(amount)} ARGN`;
}

function formatArgon(amount: bigint) {
  if (amount > 0n && amount < BigInt(MICROGONS_PER_ARGON) / 100n) return '<0.01';
  return microgonToArgonNm(amount).format('0,0.[00]');
}

function formatArgonot(amount: bigint) {
  if (amount > 0n && amount < BigInt(MICRONOTS_PER_ARGONOT) / 100n) return '<0.01';
  return micronotToArgonotNm(amount).format('0,0.[00]');
}

function formatDate(date: Date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
