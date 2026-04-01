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
      <template v-if="notice.kind === 'mismatch' && mismatchView.phase === 'returningOnArgon'">
        Argon is finalizing your return request before the Bitcoin transfer is sent.
      </template>

      <template v-else-if="notice.kind === 'mismatch' && mismatchView.phase === 'returningOnBitcoin'">
        The return transaction is waiting for Bitcoin confirmations.
      </template>

      <template v-else-if="notice.kind === 'fundingExpiring'">
        {{ isResumedFunding ? 'Continue before the funding window expires in' : 'Funding window expires in' }}
        <CountdownClock :time="fundingWindowExpirationTime" v-slot="{ days, hours, minutes }">
          <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
          <template v-else>{{ hours }}h {{ minutes }}m</template>
        </CountdownClock>
      </template>

      <template v-else-if="notice.kind === 'mismatch' && !mismatchView.isFundingExpired">
        Funding window expires in
        <CountdownClock :time="fundingWindowExpirationTime" v-slot="{ days, hours, minutes }">
          <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
          <template v-else>{{ hours }}h {{ minutes }}m</template>
        </CountdownClock>
      </template>

      <template v-else-if="notice.kind === 'mismatch'">
        Lock expires in
        <CountdownClock :time="lockExpirationTime" v-slot="{ days, hours, minutes }">
          <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
          <template v-else>{{ hours }}h {{ minutes }}m</template>
        </CountdownClock>
      </template>

      <template v-else-if="notice.kind === 'resumeFunding'">
        {{ isResumedFunding ? 'Continue before the funding window expires in' : 'Resume before the lock expires in' }}
        <CountdownClock :time="isResumedFunding ? fundingWindowExpirationTime : lockExpirationTime" v-slot="{ days, hours, minutes }">
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
import BitcoinIcon from '../assets/wallets/bitcoin-alert.svg?component';
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
  isResumedFunding?: boolean;
}>();

const emit = defineEmits<{
  (e: 'open-lock', notice: Extract<IBitcoinAlert, { kind: 'mismatch' | 'resumeFunding' | 'fundingExpiring' }>): void;
  (e: 'open-unlock', notice: Extract<IBitcoinAlert, { kind: 'unlockNeedsAttention' | 'unlockExpiring' }>): void;
}>();

const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const mismatchView = Vue.computed(() => {
  if (props.notice.kind !== 'mismatch') {
    return {
      phase: 'none',
      error: '',
      isFundingExpired: false,
      nextCandidate: undefined,
      candidateCount: 0,
    };
  }
  return bitcoinLocks.getMismatchViewState(props.notice.lock);
});

const mismatchCandidate = Vue.computed(() => {
  if (props.notice.kind !== 'mismatch') return undefined;
  return mismatchView.value.nextCandidate;
});
const mismatchCanAct = Vue.computed(() => {
  return (
    !!mismatchView.value.nextCandidate &&
    (mismatchView.value.nextCandidate.canAccept || mismatchView.value.nextCandidate.canReturn)
  );
});
const isResumedFunding = Vue.computed(() => {
  return !!props.isResumedFunding;
});

const observedSatoshis = Vue.computed(() => {
  if (props.notice.kind !== 'mismatch') return 0n;
  return (
    mismatchCandidate.value?.observedSatoshis ??
    mismatchCandidate.value?.record.satoshis ??
    bitcoinLocks.getReceivedFundingSatoshis(props.notice.lock) ??
    0n
  );
});

const differenceSummary = Vue.computed(() => {
  if (props.notice.kind !== 'mismatch') return '';
  const diff = mismatchCandidate.value?.differenceSatoshis ?? observedSatoshis.value - props.notice.lock.satoshis;
  return formatSatsDifference(diff);
});

const guidanceText = Vue.computed(() => {
  if (props.notice.kind !== 'mismatch') return '';
  if (mismatchView.value.error) return 'Open details to resolve this Bitcoin deposit.';
  if (mismatchView.value.isFundingExpired) return 'Review how to recover this Bitcoin deposit.';
  if (!mismatchCanAct.value) {
    return 'Once Bitcoin confirmations finish, choose whether to keep this Bitcoin deposit or return it.';
  }
  return 'Choose whether to keep this Bitcoin deposit or return it.';
});

const fundingWindowExpirationTime = Vue.computed(() => {
  if (props.notice.kind === 'fundingExpiring') {
    return dayjs.utc(props.notice.expiresAt);
  }
  if (props.notice.kind !== 'mismatch') return dayjs.utc();
  return dayjs.utc(bitcoinLocks.verifyExpirationTime(props.notice.lock));
});

const expirationTime = Vue.computed(() => {
  if (props.notice.kind !== 'unlockExpiring') return dayjs.utc();
  return dayjs.utc(props.notice.expiresAt);
});

const lockExpirationTime = Vue.computed(() => {
  return dayjs.utc(bitcoinLocks.unlockDeadlineTime(props.notice.lock));
});

const title = Vue.computed(() => {
  if (props.notice.kind === 'resumeFunding') return `${amountLabel.value} Bitcoin deposit returned`;
  if (props.notice.kind === 'fundingExpiring') {
    return isResumedFunding.value
      ? `${amountLabel.value} Bitcoin deposit returned`
      : `${amountLabel.value} Bitcoin funding window expiring`;
  }
  if (props.notice.kind === 'unlockNeedsAttention') return `${amountLabel.value} Bitcoin unlock needs attention`;
  if (props.notice.kind === 'unlockExpiring') return `${amountLabel.value} Bitcoin lock nearing expiration`;
  if (mismatchView.value.phase === 'returningOnArgon' || mismatchView.value.phase === 'returningOnBitcoin') {
    return `${amountLabel.value} Returning Mismatch Bitcoin Deposit`;
  }
  if (mismatchView.value.error) return `${amountLabel.value} Bitcoin funding needs attention`;
  if (mismatchView.value.isFundingExpired) return `${amountLabel.value} Bitcoin funding recovery needed`;
  if (!mismatchCanAct.value) return `${amountLabel.value} Bitcoin funding mismatch detected`;
  return `${amountLabel.value} Bitcoin funding mismatch`;
});

const ctaLabel = Vue.computed(() => {
  if (props.notice.kind === 'resumeFunding') return isResumedFunding.value ? 'Open Details' : 'Resume Funding';
  if (props.notice.kind === 'fundingExpiring') return 'Open Details';
  if (props.notice.kind === 'unlockNeedsAttention') return 'Open Details';
  if (props.notice.kind === 'unlockExpiring') return 'Unlock Bitcoin';
  if (mismatchView.value.phase === 'returningOnArgon' || mismatchView.value.phase === 'returningOnBitcoin') {
    return 'View Status';
  }
  return mismatchView.value.isFundingExpired || mismatchCanAct.value ? 'Review Options' : 'Open Details';
});

const expectedBtcLabel = Vue.computed(() => {
  if (props.notice.kind !== 'mismatch') return '0';
  return formatCompactBtc(props.notice.lock.satoshis);
});

const receivedBtcLabel = Vue.computed(() => {
  if (props.notice.kind !== 'mismatch') return '0';
  return formatCompactBtc(observedSatoshis.value);
});

const amountLabel = Vue.computed(() => {
  return `${currency.symbol}${microgonToMoneyNm(props.notice.amountMicrogons).formatIfElse('< 1_000', '0,0.00', '0,0')}`;
});

const tooltipContent = Vue.computed(() => {
  if (props.notice.kind === 'resumeFunding') {
    return isResumedFunding.value
      ? 'Your mismatched Bitcoin deposit was returned. Continue funding this lock before the window expires.'
      : 'Your mismatched Bitcoin deposit was returned. Resume funding when you are ready.';
  }

  if (props.notice.kind === 'fundingExpiring') {
    return isResumedFunding.value
      ? 'Your mismatched Bitcoin deposit was returned. Continue funding this lock before the window expires.'
      : 'Complete this Bitcoin funding before the remaining window expires.';
  }

  if (props.notice.kind === 'unlockNeedsAttention') {
    return `Open details to retry this unlock step. Technical details: ${props.notice.error}`;
  }

  if (props.notice.kind === 'unlockExpiring') {
    return `Your ${formatCompactBtc(props.notice.lock.satoshis)} BTC lock is nearing expiration. Start unlocking before the deadline.`;
  }

  if (mismatchView.value.phase === 'returningOnArgon') {
    return 'Argon is finalizing your return request before the Bitcoin transfer is sent.';
  }

  if (mismatchView.value.phase === 'returningOnBitcoin') {
    return 'The return transaction is waiting for Bitcoin confirmations.';
  }

  const details = [`Expected ${expectedBtcLabel.value} BTC. Received ${receivedBtcLabel.value} BTC.`];

  if (differenceSummary.value) {
    details.push(`${differenceSummary.value}.`);
  }

  details.push(guidanceText.value.endsWith('.') ? guidanceText.value : `${guidanceText.value}.`);

  if (mismatchView.value.error) {
    details.push(mismatchView.value.error);
  }

  return details.join(' ');
});

const sublineClass = Vue.computed(() => {
  if (props.notice.kind === 'unlockNeedsAttention' || mismatchView.value.error) {
    return 'text-red-700';
  }

  if (
    props.notice.kind === 'unlockExpiring' ||
    props.notice.kind === 'fundingExpiring' ||
    mismatchView.value.isFundingExpired
  ) {
    return 'text-amber-700';
  }

  return 'text-slate-500';
});

function openNotice() {
  if (props.isPreview) return;
  if (
    props.notice.kind === 'mismatch' ||
    props.notice.kind === 'resumeFunding' ||
    props.notice.kind === 'fundingExpiring'
  ) {
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

function formatSatsDifference(satoshis: bigint): string {
  const absoluteSatoshis = satoshis < 0n ? -satoshis : satoshis;
  const formatted = absoluteSatoshis.toLocaleString('en-US');
  if (satoshis > 0n) return `Over by ${formatted} sats`;
  if (satoshis < 0n) return `Short by ${formatted} sats`;
  return 'Matches your requested amount';
}
</script>

<style scoped>
@reference "../main.css";
</style>
