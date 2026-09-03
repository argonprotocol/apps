<!-- prettier-ignore -->
<template>
  <AlertDetailRow
    :dataTestid="`BitcoinAlert.${notice.kind}`"
    :title="title"
    :tooltipContent="tooltipContent"
    :sublineClass="sublineClass"
    :buttonLabel="ctaLabel"
    :isLast="isLast"
    @open="openNotice">
    <template #icon>
      <div class="mt-1">
        <AlertIcon
          v-if="notice.kind === 'unlockNeedsAttention'"
          class="h-8 w-8 text-red-600/80" />
        <ExclamationTriangleIcon
          v-else-if="notice.kind === 'unlockExpiring'"
          class="h-8 w-8 text-amber-500/90" />
        <BitcoinIcon
          v-else
          class="h-8 w-8 text-argon-700/70" />
      </div>
    </template>

    <template #subline>
      <template v-if="notice.kind === 'fundingExpiring'">
        Funding window expires in
        <CountdownClock :time="fundingWindowExpirationTime" v-slot="{ days, hours, minutes }">
          <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
          <template v-else>{{ hours }}h {{ minutes }}m</template>
        </CountdownClock>
      </template>

      <template v-else-if="notice.kind === 'unlockNeedsAttention'">
        Retry before the lock expires in
        <CountdownClock :time="lockExpirationTime" v-slot="{ days, hours, minutes }">
          <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
          <template v-else>{{ hours }}h {{ minutes }}m</template>
        </CountdownClock>
      </template>

      <template v-else>
        Lock expires in
        <CountdownClock :time="expirationTime" v-slot="{ days, hours, minutes }">
          <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
          <template v-else>{{ hours }}h {{ minutes }}m</template>
        </CountdownClock>
      </template>
    </template>
  </AlertDetailRow>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid';
import AlertDetailRow from './AlertDetailRow.vue';
import BitcoinIcon from '../assets/wallets/bitcoin.svg?component';
import AlertIcon from '../assets/alert.svg?component';
import CountdownClock from '../components/CountdownClock.vue';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import { getBitcoinLocks } from '../stores/bitcoin.ts';
import { getCurrency } from '../stores/currency.ts';
import type { IBitcoinAlert } from '../lib/Alerts.ts';

dayjs.extend(utc);

const props = defineProps<{
  notice: IBitcoinAlert;
  isPreview?: boolean;
  isLast?: boolean;
}>();

const emit = defineEmits<{
  (e: 'open-lock', notice: Extract<IBitcoinAlert, { kind: 'fundingExpiring' }>): void;
  (e: 'open-unlock', notice: Extract<IBitcoinAlert, { kind: 'unlockNeedsAttention' | 'unlockExpiring' }>): void;
}>();

const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const fundingWindowExpirationTime = Vue.computed(() => {
  return props.notice.kind === 'fundingExpiring' ? dayjs.utc(props.notice.expiresAt) : dayjs.utc();
});

const expirationTime = Vue.computed(() => {
  if (props.notice.kind !== 'unlockExpiring') return dayjs.utc();
  return dayjs.utc(props.notice.expiresAt);
});

const lockExpirationTime = Vue.computed(() => {
  return dayjs.utc(bitcoinLocks.unlockDeadlineTime(props.notice.lock));
});

const title = Vue.computed(() => {
  if (props.notice.kind === 'fundingExpiring') return `${amountLabel.value} Bitcoin funding window expiring`;
  if (props.notice.kind === 'unlockNeedsAttention') return `${amountLabel.value} Bitcoin unlock needs attention`;
  return `${amountLabel.value} Bitcoin lock nearing expiration`;
});

const ctaLabel = Vue.computed(() => {
  if (props.notice.kind === 'fundingExpiring') return 'Open Details';
  if (props.notice.kind === 'unlockNeedsAttention') return 'Open Details';
  return 'Unlock Bitcoin';
});

const amountLabel = Vue.computed(() => {
  return `${currency.symbol}${microgonToMoneyNm(props.notice.amountMicrogons).formatIfElse('< 1_000', '0,0.00', '0,0')}`;
});

const tooltipContent = Vue.computed(() => {
  if (props.notice.kind === 'fundingExpiring') {
    return 'Complete this Bitcoin funding before the remaining window expires.';
  }

  if (props.notice.kind === 'unlockNeedsAttention') {
    return `Open details to retry this unlock step. Technical details: ${props.notice.error}`;
  }

  const satoshis = props.notice.lock.fundedSatoshis || props.notice.lock.securitizedSatoshis;
  return `Your ${formatCompactBtc(satoshis)} BTC lock is nearing expiration. Start unlocking before the deadline.`;
});

const sublineClass = Vue.computed(() => {
  if (props.notice.kind === 'unlockNeedsAttention') return 'text-red-700';

  if (props.notice.kind === 'unlockExpiring' || props.notice.kind === 'fundingExpiring') {
    return 'text-amber-700';
  }

  return 'text-slate-500';
});

function openNotice() {
  if (props.isPreview) return;
  if (props.notice.kind === 'fundingExpiring') {
    emit('open-lock', props.notice);
    return;
  }
  emit('open-unlock', props.notice);
}

function formatCompactBtc(satoshis: bigint): string {
  const btc = currency.convertSatToBtc(satoshis);
  const absBtc = Math.abs(btc);
  const format = absBtc >= 0.1 ? '0,0.[000]' : absBtc >= 0.001 ? '0,0.[000000]' : '0,0.[00000000]';
  return numeral(btc).format(format);
}
</script>
