<!-- prettier-ignore -->
<template>
  <AlertBarRow
    v-if="variant === 'bar'"
    tone="warn"
    dataTestid="VaultAlert.bar">
    <template #icon>
      <div class="flex items-center gap-x-1.5 text-argon-700/70">
        <MoneyIcon
          v-if="showMoneyIcon"
          class="relative h-6 w-6 top-0.5 text-white/85" />
        <SigningIcon
          v-if="showSigningIcon"
          class="h-5 w-5 text-white/85" />
      </div>
    </template>

    <div class="min-w-0 leading-tight text-white">
      <template v-if="notice.isProcessing && notice.collectRevenue">
        <strong>{{ formatMoney(notice.collectRevenue) }} is being collected</strong>
      </template>

      <template v-else-if="notice.isProcessing">
        <strong>{{ notice.signatureCount }} co-signature{{ notice.signatureCount === 1 ? '' : 's' }} are processing.</strong>
      </template>

      <template v-else-if="notice.collectRevenue && !notice.signatureCount">
        <strong>{{ formatMoney(notice.collectRevenue) }} is waiting to be collected</strong>
        <span class="text-white/80">
          <CountdownClock :time="dueDate" v-slot="{ hours, minutes, days, seconds }">
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
          (expires in
          <CountdownClock :time="dueDate" v-slot="{ hours, minutes, days }">
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
          ({{ formatMoney(notice.expiringCollectAmount) }} expires and
          {{ formatMoney(notice.signaturePenalty) }} is at risk in securitization.)
        </span>
      </template>
    </div>

    <template #action>
      <button @click="$emit('open')">
        {{ buttonLabel }}
      </button>
    </template>
  </AlertBarRow>

  <AlertDetailRow
    v-else
    dataTestid="VaultAlert.card"
    :title="cardTitle"
    :tooltipContent="cardTooltipContent"
    :sublineClass="cardSublineClass"
    :buttonLabel="buttonLabel"
    :isLast="isLast"
    @open="$emit('open')">
    <template #icon>
      <div class="flex items-center gap-x-1.5">
        <MoneyIcon
          v-if="showMoneyIcon"
          class="relative top-0.5 h-9 w-9 text-argon-700/70" />
        <SigningIcon
          v-if="showSigningIcon"
          class="h-8 w-8 text-argon-700/70" />
      </div>
    </template>

    <template #subline>
      <template v-if="notice.isProcessing && notice.collectRevenue">
        Waiting for your collection transaction to finalize.
      </template>

      <template v-else-if="notice.isProcessing">
        Waiting for your signatures to finalize.
      </template>

      <template v-else-if="notice.collectRevenue && !notice.signatureCount">
        {{ formatMoney(notice.expiringCollectAmount) }} expires in
        <CountdownClock :time="dueDate" v-slot="{ hours, minutes, days, seconds }">
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
        {{ formatMoney(notice.signaturePenalty) }} is at risk in
        <CountdownClock :time="dueDate" v-slot="{ hours, minutes, days }">
          <span v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</span>
          <template v-else>
            <span v-if="hours">{{ hours }} hour{{ hours === 1 ? '' : 's' }}</span>
            <span v-if="hours && minutes">&nbsp;</span>
            <span v-if="minutes">{{ minutes }} minute{{ minutes === 1 ? '' : 's' }}</span>
          </template>
        </CountdownClock>
      </template>

      <template v-else>
        {{ formatMoney(notice.expiringCollectAmount) }} expires and {{ formatMoney(notice.signaturePenalty) }} is at risk in
        <CountdownClock :time="dueDate" v-slot="{ hours, minutes, days }">
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
import type { IVaultAlert } from '../../lib/Alerts.ts';

dayjs.extend(utc);

const props = defineProps<{
  notice: IVaultAlert;
  variant?: 'bar' | 'card';
  isLast?: boolean;
}>();

defineEmits<{
  (e: 'open'): void;
}>();

const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const dueDate = Vue.computed(() => {
  return dayjs.utc(props.notice.nextDueDate);
});

const variant = Vue.computed(() => props.variant ?? 'card');

const showMoneyIcon = Vue.computed(() => {
  return props.notice.collectRevenue > 0n;
});

const showSigningIcon = Vue.computed(() => {
  if (props.notice.isProcessing) {
    return props.notice.collectRevenue <= 0n && props.notice.signatureCount > 0;
  }

  return props.notice.signatureCount > 0;
});

const buttonLabel = Vue.computed(() => {
  if (props.notice.isProcessing) {
    return 'View Progress';
  }

  if (props.notice.collectRevenue && props.notice.signatureCount) {
    return 'Open Vault Actions';
  }

  if (props.notice.collectRevenue) {
    return 'Collect Revenue';
  }

  return 'Sign Bitcoin Transactions';
});

const cardTitle = Vue.computed(() => {
  if (props.notice.isProcessing && props.notice.collectRevenue) {
    return `${formatMoney(props.notice.collectRevenue)} is being collected`;
  }

  if (props.notice.isProcessing) {
    return `${props.notice.signatureCount} co-signature${props.notice.signatureCount === 1 ? '' : 's'} are processing`;
  }

  if (props.notice.collectRevenue && props.notice.signatureCount) {
    return 'Vault collection and signatures need attention';
  }

  if (props.notice.collectRevenue) {
    return `${formatMoney(props.notice.collectRevenue)} is waiting to be collected`;
  }

  return `${props.notice.signatureCount} bitcoin transaction${props.notice.signatureCount === 1 ? '' : 's'} need${props.notice.signatureCount === 1 ? 's' : ''} signing`;
});

const cardTooltipContent = Vue.computed(() => {
  if (props.notice.isProcessing && props.notice.collectRevenue) {
    return 'Waiting for your revenue collection to finalize.';
  }

  if (props.notice.isProcessing) {
    return 'Your required bitcoin signatures have been submitted and are waiting to finalize.';
  }

  if (props.notice.collectRevenue && props.notice.signatureCount) {
    return "Click to co-sign pending bitcoin unlock requests and collect your vault's earnings.";
  }

  if (props.notice.collectRevenue) {
    return "Click to collect your vault's earnings.";
  }

  return "Sign these bitcoin transactions to avoid forfeiting your vault's security.";
});

const cardSublineClass = Vue.computed(() => {
  return 'text-slate-500';
});

function formatMoney(value: bigint): string {
  return `${currency.symbol}${microgonToMoneyNm(value).formatIfElse('< 1_000', '0,0.00', '0,0')}`;
}
</script>

<style scoped>
@reference "../../main.css";
</style>
