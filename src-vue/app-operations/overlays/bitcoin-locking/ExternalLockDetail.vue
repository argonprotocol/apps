<template>
  <div class="flex flex-row gap-8 px-10 pt-6 pb-8">
    <div class="relative w-28 shrink-0 pt-1">
      <VaultIcon class="w-28 opacity-50" />
      <BitcoinIcon class="absolute -top-2 -right-1 w-8 bg-white text-slate-700/70" />
    </div>

    <div class="grow">
      <div class="flex items-baseline gap-2">
        <span class="text-argon-600 font-mono text-2xl font-bold">{{ formattedBtc }} BTC</span>
        <span class="text-sm text-slate-500">
          <Tooltip :asChild="true" content="The current market value of this bitcoin based on the latest oracle price.">
            <span class="cursor-help">
              {{ currency.symbol }}{{ microgonToMoneyNm(btcMarketRate).format('0,0.[00]') }} market
            </span>
          </Tooltip>
          ·
          <span>{{ currency.symbol }}{{ microgonToMoneyNm(lock.liquidityPromised).format('0,0.[00]') }} liquidity</span>
        </span>
      </div>

      <div class="mt-3 text-sm font-light text-slate-500 italic">
        {{ statusMessage }}
      </div>

      <div class="mt-4 flex flex-row items-start gap-6">
        <div class="space-y-1.5 text-sm text-slate-600">
          <div v-if="totalFees > 0n" class="text-slate-500">
            <Tooltip :asChild="true" content="The fee charged by the vault operator for securing this bitcoin lock.">
              <span class="cursor-help">
                Vault fee: {{ currency.symbol }}{{ microgonToMoneyNm(totalFees).format('0,0.[00]') }}
              </span>
            </Tooltip>
          </div>
        </div>

        <div v-if="!isReleased" class="ml-auto flex flex-row items-center gap-2">
          <div class="relative size-12">
            <svg class="size-full -rotate-90" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
              <circle cx="18" cy="18" r="16" fill="none" class="stroke-current text-gray-200" stroke-width="3.5" />
              <circle
                cx="18"
                cy="18"
                r="16"
                fill="none"
                :class="timerColorClass"
                stroke-width="3.5"
                stroke-dasharray="100"
                :stroke-dashoffset="100 - termProgress"
                stroke-linecap="butt" />
            </svg>
            <div class="absolute start-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transform">
              <span :class="timerColorClass" class="text-center text-xs font-bold">
                {{ Math.round(termProgress) }}%
              </span>
            </div>
          </div>
          <div class="text-xs text-slate-500">
            <div class="font-semibold text-slate-600">{{ timerLabel }}</div>
            <CountdownClock
              v-if="isPendingFunding"
              :time="lockExpirationTime"
              v-slot="{ days, hours, minutes, seconds, isFinished }">
              <template v-if="isFinished">Expired</template>
              <template v-else>
                <template v-if="days > 0">{{ days }}d</template>
                <template v-else-if="hours > 0">{{ hours }}h {{ minutes }}m</template>
                <template v-else>{{ minutes }}m {{ seconds }}s</template>
                remaining
              </template>
            </CountdownClock>
            <div v-else>{{ timerDetail }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getBitcoinLocks } from '../../../stores/bitcoin.ts';
import { getConfig } from '../../../stores/config.ts';
import { getVaults } from '../../../stores/vaults.ts';
import BitcoinIcon from '../../../assets/wallets/bitcoin.svg?component';
import VaultIcon from '../../../assets/wallets/vault.svg?component';
import Tooltip from '../../../components/Tooltip.vue';
import CountdownClock from '../../../components/CountdownClock.vue';
import { IS_TREASURY_APP } from '../../../lib/Env.ts';
import type { IExternalBitcoinLock } from '../../../lib/MyVault.ts';

dayjs.extend(utc);

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const vaults = getVaults();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const props = defineProps<{
  lock: IExternalBitcoinLock;
  isReleased: boolean;
  pendingCosign?: { dueFrame?: number };
}>();

const isPendingFunding = Vue.computed(() => props.lock.isPending);
const isPendingCosign = Vue.computed(() => props.pendingCosign != null);
const isReleased = Vue.computed(() => props.isReleased);

const vaultLabel = Vue.computed(() => {
  const upstreamOperator = config.upstreamOperator;
  if (IS_TREASURY_APP && upstreamOperator) {
    const name = upstreamOperator.name;
    if (name) return `${name}'s vault`;
    return 'The vault';
  }

  return 'Your vault';
});

const statusMessage = Vue.computed(() => {
  if (isReleased.value) {
    return 'This bitcoin has been unlocked and returned to the owner.';
  }
  if (isPendingFunding.value) {
    return 'This lock is awaiting Bitcoin funding from the owner.';
  }
  if (isPendingCosign.value) {
    return `This lock has a pending release request. ${vaultLabel.value} will cosign automatically.`;
  }
  return 'This bitcoin is locked and generating revenue on Argon.';
});

const formattedBtc = Vue.computed(() => {
  return numeral(currency.convertSatToBtc(props.lock.satoshis)).format('0,0.[00000000]');
});

const totalFees = Vue.computed(() => props.lock.lockDetails.securityFees ?? 0n);

const timerLabel = Vue.computed(() => {
  if (isPendingFunding.value) return 'Funding Window';
  if (isPendingCosign.value) return 'Cosign Deadline';
  return 'Term Progress';
});

const timerDetail = Vue.computed(() => {
  if (isPendingCosign.value) {
    if (props.pendingCosign?.dueFrame) {
      return `Due frame #${props.pendingCosign.dueFrame}`;
    }
    return 'Cosign required';
  }
  return 'Lock term in progress';
});

const timerColorClass = Vue.computed(() => {
  if (termProgress.value > 90) return 'stroke-current text-amber-500';
  if (isPendingCosign.value) return 'stroke-current text-amber-500';
  return 'stroke-current text-argon-600';
});

const fundingWindowProgress = Vue.computed(() => {
  try {
    const expTime = bitcoinLocks.verifyExpirationTime(props.lock);
    if (expTime <= Date.now()) return 100;
    const created = props.lock.lockDetails.createdAtHeight ?? 0;
    const current = bitcoinLocks.data.oracleBitcoinBlockHeight;
    const windowBlocks = bitcoinLocks.config?.pendingConfirmationExpirationBlocks;
    if (!windowBlocks) return 0;
    const elapsed = Math.max(current - created, 0);
    return Math.min((elapsed / windowBlocks) * 100, 100);
  } catch {
    return 0;
  }
});

const lockTermProgress = Vue.computed(() => {
  const created = props.lock.lockDetails.createdAtHeight ?? 0;
  const expires = props.lock.lockDetails.vaultClaimHeight ?? 0;
  const current = bitcoinLocks.data.oracleBitcoinBlockHeight;
  if (expires <= created) return 100;
  const elapsed = Math.max(current - created, 0);
  const total = expires - created;
  return Math.min((elapsed / total) * 100, 100);
});

const termProgress = Vue.computed(() => {
  if (isPendingFunding.value) return fundingWindowProgress.value;
  return lockTermProgress.value;
});

const btcMarketRate = Vue.ref(0n);
const lockExpirationTime = Vue.computed(() => {
  try {
    return dayjs.utc(bitcoinLocks.verifyExpirationTime(props.lock));
  } catch {
    return dayjs.utc();
  }
});

async function loadPrices() {
  btcMarketRate.value = await vaults.getMarketRateInMicrogons(props.lock.satoshis).catch(() => 0n);
}

Vue.onMounted(() => {
  void loadPrices();
});

Vue.watch(
  () => props.lock,
  () => void loadPrices(),
  { deep: true },
);
</script>
