<!-- prettier-ignore -->
<template>
  <AlertBarRow
    v-if="props.variant === 'bar'"
    tone="warn"
    dataTestid="VaultAlert.bar">
    <template #icon>
      <div class="flex items-center gap-x-1.5 text-argon-700/70">
        <MoneyIcon
          v-if="
            notice.collectRevenue > 0n ||
            notice.authorizedTransferRewardAmount > 0n ||
            notice.pendingAuthorizedTransferRewardAmount > 0n
          "
          class="relative h-6 w-6 top-0.5 text-white/85" />
        <SigningIcon
          v-if="notice.signatureCount > 0 || hasVaultSecurityWork(notice)"
          class="h-5 w-5 text-white/85" />
      </div>
    </template>

    <div class="min-w-0 leading-tight text-white">
      <template v-if="notice.isCollectProcessing && notice.collectRevenue">
        <strong>{{ formatMoney(notice.collectRevenue) }} is being collected</strong>
      </template>

      <template v-else-if="notice.isProcessing">
        <template v-if="notice.pendingAuthorizedTransferCount > 0">
          <strong>
            <template v-if="notice.pendingAuthorizedTransferRewardAmount > 0n">
              {{ formatMoney(notice.pendingAuthorizedTransferRewardAmount) }} in crosschain authorization rewards
            </template>
            <template v-else>Crosschain transfer authorization</template>
            is processing
          </strong>
        </template>
        <template v-else-if="hasVaultSecurityWork(notice)">
          <strong>
            Vault approvals are processing
          </strong>
        </template>
        <template v-else>
          <strong>{{ notice.signatureCount }} co-signature{{ notice.signatureCount === 1 ? ' is' : 's are' }} processing.</strong>
        </template>
      </template>

      <template v-else-if="hasVaultSecurityWork(notice)">
        <strong>{{ getVaultSecurityTitle(notice) }}</strong>
        <span v-if="notice.amountAtRiskMicrogons > 0n" class="text-white/80">
          ({{ formatMoney(notice.amountAtRiskMicrogons) }} at risk)
        </span>
      </template>

      <template v-else-if="notice.collectRevenue && !notice.signatureCount">
        <strong>{{ formatMoney(notice.collectRevenue) }} is waiting to be collected</strong>
        <span class="text-white/80">
          <CountdownClock :time="collectDueDate" v-slot="{ hours, minutes, days, seconds }">
            <template v-if="hours || minutes || days || seconds > 0">
              ({{ formatMoney(notice.expiringCollectAmount) }} expires in
              <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
              <span v-else-if="hours || minutes > 1">
                <span v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
                <span v-if="hours && minutes">&nbsp;</span>
                <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
              </span>
              <span v-else-if="seconds">{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>)
            </template>
          </CountdownClock>
        </span>
      </template>

      <template v-else-if="!notice.collectRevenue && notice.signatureCount">
        <strong>
          {{ notice.signatureCount }} bitcoin transaction{{ notice.signatureCount === 1 ? '' : 's' }} require{{
            notice.signatureCount === 1 ? 's' : ''
          }}
          signing at a penalty of {{ formatMoney(notice.signaturePenalty) }}
        </strong>
        <span class="text-white/80">
          (due in
          <CountdownClock :time="cosignDueDate" v-slot="{ hours, minutes, days }">
            <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
            <template v-else>
              <span v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
              <span v-if="hours && minutes">&nbsp;</span>
              <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
            </template>
          </CountdownClock>)
        </span>
      </template>

      <template v-else>
        <strong>{{ formatMoney(notice.collectRevenue) }} is waiting to be collected</strong>
        and
        <strong>
          {{ notice.signatureCount }} bitcoin transaction{{ notice.signatureCount === 1 ? '' : 's' }} require{{
            notice.signatureCount === 1 ? 's' : ''
          }}
          signing
        </strong>
        <span class="text-white/80">
          ({{ formatMoney(notice.expiringCollectAmount) }} expires in
          <CountdownClock :time="collectDueDate" v-slot="{ hours, minutes, days, seconds }">
            <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
            <span v-else-if="hours || minutes > 1">
              <span v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
              <span v-if="hours && minutes">&nbsp;</span>
              <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
            </span>
            <span v-else-if="seconds">{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>
          </CountdownClock>
          and {{ formatMoney(notice.signaturePenalty) }} is at risk in securitization for
          <CountdownClock :time="cosignDueDate" v-slot="{ hours, minutes, days }">
            <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
            <template v-else>
              <span v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
              <span v-if="hours && minutes">&nbsp;</span>
              <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
            </template>
          </CountdownClock>)
        </span>
      </template>
    </div>

    <template #action>
      <button @click="$emit('open')">
        <template v-if="notice.isProcessing">View Progress</template>
        <template v-else-if="hasVaultSecurityWork(notice) || (notice.collectRevenue > 0n && notice.signatureCount > 0)">
          Open Details
        </template>
        <template v-else-if="notice.collectRevenue > 0n">Collect Revenue</template>
        <template v-else>Sign Bitcoin Transactions</template>
      </button>
    </template>
  </AlertBarRow>

  <AlertDetailRow
    v-else
    dataTestid="VaultAlert.card"
    :title="getCardTitle(notice)"
    :tooltipContent="getCardTooltipContent(notice)"
    sublineClass="text-slate-500"
    :buttonLabel="getButtonLabel(notice)"
    :isLast="isLast"
    @open="$emit('open')">
    <template #icon>
      <div class="flex items-center gap-x-1.5">
        <MoneyIcon
          v-if="
            notice.collectRevenue > 0n ||
            notice.authorizedTransferRewardAmount > 0n ||
            notice.pendingAuthorizedTransferRewardAmount > 0n
          "
          class="relative top-0.5 h-9 w-9 text-argon-700/70" />
        <SigningIcon
          v-if="notice.signatureCount > 0 || hasVaultSecurityWork(notice)"
          class="h-8 w-8 text-argon-700/70" />
      </div>
    </template>

    <template #subline>
      <template v-if="notice.isProcessing && notice.collectRevenue">
        Waiting for collect to finalize.
      </template>

      <template v-else-if="notice.isProcessing">
        <template v-if="notice.pendingAuthorizedTransferCount > 0">
          Waiting for crosschain authorization to finalize.
        </template>
        <template v-else-if="hasVaultSecurityWork(notice)">
          Waiting for vault approvals to finalize.
        </template>
        <template v-else>Waiting for signatures to finalize.</template>
      </template>

      <template v-else-if="hasVaultSecurityWork(notice)">
        <template
          v-if="hasAvailableAuthorizationWork(notice) && !notice.councilApprovalCount && notice.amountAtRiskMicrogons <= 0n"
        >
          {{ getAuthorizationOpportunityText(notice) }} ready on Argon.
        </template>
        <template v-if="notice.amountAtRiskMicrogons > 0n">
          {{ formatMoney(notice.amountAtRiskMicrogons) }} requires further approval.
        </template>
        <template v-else-if="!hasAvailableAuthorizationWork(notice) || notice.councilApprovalCount > 0">
          Review pending vault approvals.
        </template>
      </template>

      <template v-else-if="notice.collectRevenue && !notice.signatureCount">
        {{ formatMoney(notice.expiringCollectAmount) }} expires in
        <CountdownClock :time="collectDueDate" v-slot="{ hours, minutes, days, seconds }">
          <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
          <span v-else-if="hours || minutes > 1">
            <span v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
            <span v-if="hours && minutes">&nbsp;</span>
            <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
          </span>
          <span v-else-if="seconds">{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>
        </CountdownClock>
      </template>

      <template v-else-if="!notice.collectRevenue && notice.signatureCount">
        {{ formatMoney(notice.signaturePenalty) }} is at risk in securitization for
        <CountdownClock :time="cosignDueDate" v-slot="{ hours, minutes, days }">
          <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
          <template v-else>
            <span v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
            <span v-if="hours && minutes">&nbsp;</span>
            <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
          </template>
        </CountdownClock>
      </template>

      <template v-else>
        {{ formatMoney(notice.expiringCollectAmount) }} expires in
        <CountdownClock :time="collectDueDate" v-slot="{ hours, minutes, days, seconds }">
          <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
          <span v-else-if="hours || minutes > 1">
            <span v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
            <span v-if="hours && minutes">&nbsp;</span>
            <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
          </span>
          <span v-else-if="seconds">{{ seconds }} second{{ seconds === 1 ? '' : 's' }}</span>
        </CountdownClock>
        and {{ formatMoney(notice.signaturePenalty) }} is at risk in securitization for
        <CountdownClock :time="cosignDueDate" v-slot="{ hours, minutes, days }">
          <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
          <template v-else>
            <span v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
            <span v-if="hours && minutes">&nbsp;</span>
            <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
          </template>
        </CountdownClock>
      </template>
    </template>
  </AlertDetailRow>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import AlertBarRow from './AlertBarRow.vue';
import AlertDetailRow from './AlertDetailRow.vue';
import MoneyIcon from '../../assets/money.svg?component';
import SigningIcon from '../../assets/signing.svg?component';
import CountdownClock from '../../components/CountdownClock.vue';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import type { IVaultCollectNotice } from '../../lib/VaultCollectBuilder.ts';

dayjs.extend(utc);

const props = withDefaults(
  defineProps<{
    notice: IVaultCollectNotice;
    variant?: 'bar' | 'card';
    isLast?: boolean;
  }>(),
  {
    variant: 'card',
  },
);

defineEmits<{
  (e: 'open'): void;
}>();

const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const collectDueDate = Vue.computed(() => {
  return dayjs.utc(props.notice.nextCollectDueDate);
});

const cosignDueDate = Vue.computed(() => {
  return dayjs.utc(props.notice.nextCosignDueDate);
});

function hasVaultSecurityWork(notice: IVaultCollectNotice): boolean {
  return (
    notice.councilApprovalCount > 0 ||
    hasAvailableAuthorizationWork(notice) ||
    notice.pendingAuthorizedTransferCount > 0
  );
}

function hasAvailableAuthorizationWork(notice: IVaultCollectNotice): boolean {
  return notice.authorizedTransferCount > 0;
}

function getButtonLabel(notice: IVaultCollectNotice): string {
  if (notice.isProcessing) {
    return 'View Progress';
  }

  if (hasVaultSecurityWork(notice) || (notice.collectRevenue > 0n && notice.signatureCount > 0)) {
    return 'Open Details';
  }

  if (notice.collectRevenue > 0n) {
    return 'Collect Revenue';
  }

  return 'Sign Bitcoin Transactions';
}

function getCardTitle(notice: IVaultCollectNotice): string {
  if (notice.isCollectProcessing && notice.collectRevenue > 0n) {
    return `${formatMoney(notice.collectRevenue)} is being collected`;
  }

  if (notice.isProcessing) {
    if (notice.pendingAuthorizedTransferCount > 0) {
      return notice.pendingAuthorizedTransferRewardAmount > 0n
        ? `${formatMoney(notice.pendingAuthorizedTransferRewardAmount)} in crosschain authorization rewards is processing`
        : 'Crosschain transfer authorization is processing';
    }

    if (hasVaultSecurityWork(notice)) {
      return 'Vault approvals are processing';
    }

    return `${notice.signatureCount} co-signature${notice.signatureCount === 1 ? ' is' : 's are'} processing`;
  }

  if (hasVaultSecurityWork(notice)) {
    if (hasAvailableAuthorizationWork(notice) && !notice.councilApprovalCount && notice.amountAtRiskMicrogons <= 0n) {
      return `${getAuthorizationOpportunityText(notice)} need${notice.authorizedTransferCount === 1 ? 's' : ''} attention`;
    }

    if (notice.amountAtRiskMicrogons > 0n) {
      return `Vault approvals with ${formatMoney(notice.amountAtRiskMicrogons)} at risk`;
    }

    return 'Vault approvals need attention';
  }

  if (notice.collectRevenue > 0n && notice.signatureCount > 0) {
    return 'Vault collection and signatures need attention';
  }

  if (notice.collectRevenue > 0n) {
    return `${formatMoney(notice.collectRevenue)} is waiting to be collected`;
  }

  return `${notice.signatureCount} bitcoin transaction${notice.signatureCount === 1 ? '' : 's'} need${notice.signatureCount === 1 ? 's' : ''} signing`;
}

function getCardTooltipContent(notice: IVaultCollectNotice): string {
  if (notice.pendingAuthorizedTransferCount > 0) {
    return 'Crosschain transfer authorization is pending.';
  }

  if (hasVaultSecurityWork(notice) && notice.isProcessing) {
    return 'Vault approvals are pending.';
  }

  if (hasVaultSecurityWork(notice)) {
    if (hasAvailableAuthorizationWork(notice) && !notice.councilApprovalCount && notice.amountAtRiskMicrogons <= 0n) {
      return 'Review crosschain transfer authorization opportunities.';
    }

    if (notice.amountAtRiskMicrogons > 0n) {
      return 'Review pending vault approvals and at-risk funds.';
    }

    return 'Review pending vault actions.';
  }

  if (notice.isProcessing && notice.collectRevenue > 0n) {
    return 'Revenue collection is pending.';
  }

  if (notice.isProcessing) {
    return 'Bitcoin signatures are pending.';
  }

  if (notice.collectRevenue > 0n && notice.signatureCount > 0) {
    return 'Collect earnings and sign bitcoin transactions.';
  }

  if (notice.collectRevenue > 0n) {
    return 'Collect your vault earnings.';
  }

  return 'Sign bitcoin transactions to avoid forfeiting vault security.';
}

function formatMoney(value: bigint): string {
  return `${currency.symbol}${microgonToMoneyNm(value).formatIfElse('< 1_000', '0,0.00', '0,0')}`;
}

function getAuthorizationOpportunityText(notice: IVaultCollectNotice): string {
  const label = `${notice.authorizedTransferCount} crosschain authorization opportunit${notice.authorizedTransferCount === 1 ? 'y' : 'ies'}`;
  if (notice.authorizedTransferRewardAmount <= 0n) {
    return label;
  }

  return `${label} worth ${formatMoney(notice.authorizedTransferRewardAmount)}`;
}

function getVaultSecurityTitle(notice: IVaultCollectNotice): string {
  if (hasAvailableAuthorizationWork(notice) && !notice.councilApprovalCount && notice.amountAtRiskMicrogons <= 0n) {
    return `${getAuthorizationOpportunityText(notice)} need${notice.authorizedTransferCount === 1 ? 's' : ''} attention`;
  }

  return 'Vault approvals need attention';
}
</script>

<style scoped>
@reference "../../main.css";
</style>
