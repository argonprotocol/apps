<template>
  <dl
    class="grid gap-x-4 gap-y-2 text-sm"
    :class="wide ? 'grid-cols-[120px_minmax(0,1fr)_120px_minmax(0,1fr)]' : 'grid-cols-[120px_minmax(0,1fr)]'"
  >
    <dt>Queue order</dt>
    <dd>#{{ queueNonce }}</dd>

    <template v-if="approvalProgress">
      <dt>Council approval</dt>
      <dd>
        {{ approvalProgress.signatureCount }} of {{ approvalProgress.memberCount }} signers ·
        {{ approvalWeightPercent }}% approval weight
      </dd>
    </template>

    <template v-if="awaitingArgonConfirmation">
      <dt>Argon confirmation</dt>
      <dd v-if="ethereumBlocksUntilArgonConfirmation !== undefined">
        {{ ethereumBlocksUntilArgonConfirmation }} Ethereum
        {{ ethereumBlocksUntilArgonConfirmation === 1n ? 'block' : 'blocks' }} away
      </dd>
      <dd v-else>In progress</dd>
    </template>

    <template v-if="targetKind === 'globalIssuanceCouncilRotation'">
      <dt>Proposed council</dt>
      <dd v-if="councilChange" :title="`Council hash ${targetValue}`">
        {{ councilChange.vaultCount }} vaults
        <span class="text-slate-500">
          ({{ councilChange.newVaultCount }} new · {{ councilChange.leavingVaultCount }} leaving)
        </span>
      </dd>
      <dd v-else :title="`Council hash ${targetValue}`">Details unavailable</dd>

      <dt>Proposed rate</dt>
      <dd v-if="councilChange">
        {{ microgonToArgonNm(councilChange.epochMicrogonsPerArgonot).format('0,0.[00]') }} ARGN per ARGNOT
      </dd>
      <dd v-else>Details unavailable</dd>
    </template>

    <template v-else>
      <dt>Minting Authority</dt>
      <dd :title="`Signing key ${targetValue}`" class="flex min-w-0 items-center gap-x-2">
        <CrosschainIdentityLabel v-if="authorityOwnerIdentity" :identity="authorityOwnerIdentity" />
        <CopyableArgonAddress v-if="authorityOwnerAccount" :address="authorityOwnerAccount" />
        <span v-if="!authorityOwnerIdentity && !authorityOwnerAccount">Owner unavailable</span>
      </dd>
    </template>
  </dl>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import CopyableArgonAddress from './CopyableArgonAddress.vue';
import CrosschainIdentityLabel from './CrosschainIdentityLabel.vue';
import type { ICrosschainSourceIdentity } from '../lib/CrosschainTransferView.ts';
import type { IGlobalCouncilApproval, IGlobalCouncilChange, IGlobalCouncilQueueItem } from '../lib/GlobalCouncil.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';

const props = defineProps<{
  queueNonce: bigint;
  targetKind: IGlobalCouncilApproval['targetKind'];
  targetValue: string;
  authorityOwnerAccount?: string;
  authorityOwnerIdentity?: ICrosschainSourceIdentity;
  approvalProgress?: IGlobalCouncilQueueItem['approvalProgress'];
  awaitingArgonConfirmation?: boolean;
  ethereumBlocksUntilArgonConfirmation?: bigint;
  councilChange?: IGlobalCouncilChange;
  wide?: boolean;
}>();

const { microgonToArgonNm } = createNumeralHelpers(getCurrency());

const approvalWeightPercent = Vue.computed(() => {
  if (!props.approvalProgress?.totalWeight) return 0;
  return Number((props.approvalProgress.approvedWeight * 1_000n) / props.approvalProgress.totalWeight) / 10;
});
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
