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
          <span v-if="isOwnLock && isMinting" class="text-slate-400">({{ mintedPct }}% minted)</span>
        </span>
      </div>

      <div class="mt-3 text-sm font-light text-slate-500 italic">
        {{ statusMessage }}
      </div>

      <div v-if="releaseTxid" class="mt-2 text-xs">
        <a
          :href="mempool.txUrl(releaseTxid)"
          target="_blank"
          class="text-argon-600 inline-flex items-center gap-1 hover:underline">
          View bitcoin transaction
          <ArrowTopRightOnSquareIcon class="h-3 w-3" />
        </a>
      </div>

      <div class="mt-4 flex flex-row items-start gap-6">
        <div class="space-y-1.5 text-sm text-slate-600">
          <div v-if="!isPendingFunding && isOwnLock && unlockPrice > 0n">
            <Tooltip
              :asChild="true"
              content="The argon cost to unlock this bitcoin and return it to your wallet. Includes the redemption rate plus transaction fees.">
              <span class="cursor-help">
                Unlock costs
                <span class="font-semibold">
                  {{ currency.symbol }}{{ microgonToMoneyNm(unlockPrice).format('0,0.[00]') }}
                </span>
              </span>
            </Tooltip>
          </div>
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
            <div>{{ timerDetail }}</div>
          </div>
        </div>
      </div>

      <div
        v-if="isOwnLock && !isPendingFunding && !isReleased"
        class="mt-5 flex justify-end border-t border-slate-200 pt-4">
        <button
          data-testid="LockDetail.unlock()"
          @click="emit('unlock')"
          class="bg-argon-600 hover:bg-argon-700 cursor-pointer rounded-md px-6 py-2 text-lg font-bold text-white">
          Unlock Bitcoin
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getVaults } from '../../stores/vaults.ts';
import { getWalletKeys } from '../../stores/wallets.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline';
import BitcoinMempool from '../../lib/BitcoinMempool.ts';
import { ESPLORA_HOST } from '../../lib/Env.ts';
import BitcoinIcon from '../../assets/wallets/bitcoin.svg?component';
import VaultIcon from '../../assets/wallets/vault.svg?component';
import Tooltip from '../../components/Tooltip.vue';

dayjs.extend(utc);

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const vaults = getVaults();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const props = defineProps<{
  lock: IBitcoinLockRecord;
  pendingCosign?: { dueFrame?: number };
}>();

const emit = defineEmits<{
  (e: 'unlock'): void;
}>();

const isOwnLock = Vue.computed(() => props.lock.uuid != null);

const isMinting = Vue.computed(() => {
  return props.lock.status === BitcoinLockStatus.LockedAndIsMinting;
});

const isPendingCosign = Vue.computed(() => {
  return props.pendingCosign != null;
});

const isPendingFunding = Vue.computed(() => {
  return props.lock.status === BitcoinLockStatus.LockPendingFunding;
});

const isReleased = Vue.computed(() => {
  return props.lock.status === BitcoinLockStatus.Released;
});

const statusMessage = Vue.computed(() => {
  if (isReleased.value) {
    if (isOwnLock.value) {
      return 'Your bitcoin has been unlocked and returned to your wallet.';
    }
    return 'This bitcoin has been unlocked and returned to the owner.';
  }
  if (isPendingFunding.value) {
    if (isOwnLock.value) {
      return 'Awaiting your Bitcoin deposit to complete this lock.';
    }
    return 'This lock is awaiting Bitcoin funding from the owner.';
  }
  if (isPendingCosign.value) {
    return 'This lock has a pending release request. Your vault will cosign automatically.';
  }
  if (isMinting.value) {
    if (isOwnLock.value) {
      return 'Minting in progress — argons are being issued to your wallet.';
    }
    return 'Minting in progress — argons are being issued to the lock owner.';
  }
  return 'This bitcoin is locked and generating revenue on Argon.';
});

const fundingUtxoRecord = Vue.computed(() => {
  return bitcoinLocks.getAcceptedFundingRecord(props.lock);
});

const mempool = new BitcoinMempool(ESPLORA_HOST);
const releaseTxid = Vue.computed(() => fundingUtxoRecord.value?.releaseTxid);

const fundingSatoshis = Vue.computed(() => {
  return fundingUtxoRecord.value?.satoshis ?? props.lock.satoshis;
});

const formattedBtc = Vue.computed(() => {
  return numeral(currency.convertSatToBtc(fundingSatoshis.value)).format('0,0.[00000000]');
});

const mintedPct = Vue.computed(() => {
  return bitcoinLocks.getMintPercent(props.lock);
});

const totalFees = Vue.computed(() => {
  const ratchet = props.lock.ratchets?.[0];
  if (ratchet) {
    return (ratchet.securityFee ?? 0n) + (ratchet.txFee ?? 0n);
  }
  // External locks: read security fees directly from chain data
  return props.lock.lockDetails?.securityFees ?? 0n;
});

const timerLabel = Vue.computed(() => {
  if (isPendingFunding.value) return 'Funding Window';
  if (isPendingCosign.value) return 'Cosign Deadline';
  return 'Term Progress';
});

const timerDetail = Vue.computed(() => {
  if (isPendingFunding.value) {
    const now = dayjs.utc();
    const exp = lockExpirationTime.value;
    const diff = exp.diff(now, 'minute');
    if (diff <= 0) return 'Expired';
    if (diff < 60) return `${diff}m remaining`;
    const hours = Math.floor(diff / 60);
    const mins = diff % 60;
    if (hours < 24) return `${hours}h ${mins}m remaining`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h remaining`;
  }
  if (isPendingCosign.value) {
    if (props.pendingCosign?.dueFrame) {
      return `Due frame #${props.pendingCosign.dueFrame}`;
    }
    return 'Cosign required';
  }
  return `Expires ${lockExpirationTime.value.format('MMM D, YYYY')}`;
});

const timerColorClass = Vue.computed(() => {
  if (termProgress.value > 90) return 'stroke-current text-amber-500';
  if (isPendingCosign.value) return 'stroke-current text-amber-500';
  return 'stroke-current text-argon-600';
});

const lockTermProgress = Vue.computed(() => {
  const created = props.lock.lockDetails?.createdAtHeight ?? 0;
  const expires = props.lock.lockDetails?.vaultClaimHeight ?? 0;
  const current = bitcoinLocks.data.oracleBitcoinBlockHeight;
  if (expires <= created) return 100;
  const elapsed = Math.max(current - created, 0);
  const total = expires - created;
  return Math.min((elapsed / total) * 100, 100);
});

const fundingWindowProgress = Vue.computed(() => {
  try {
    const expTime = bitcoinLocks.verifyExpirationTime(props.lock);
    if (expTime <= Date.now()) return 100;
    const created = props.lock.lockDetails?.createdAtHeight ?? 0;
    const current = bitcoinLocks.data.oracleBitcoinBlockHeight;
    const windowBlocks = bitcoinLocks.config?.pendingConfirmationExpirationBlocks;
    if (!windowBlocks) return 0;
    const elapsed = Math.max(current - created, 0);
    return Math.min((elapsed / windowBlocks) * 100, 100);
  } catch {
    return 0;
  }
});

const termProgress = Vue.computed(() => {
  if (isPendingFunding.value) return fundingWindowProgress.value;
  return lockTermProgress.value;
});

const btcMarketRate = Vue.ref(0n);
const unlockPrice = Vue.ref(0n);
const lockExpirationTime = Vue.ref(dayjs.utc());

async function loadPrices() {
  btcMarketRate.value = await vaults.getMarketRateInMicrogons(fundingSatoshis.value).catch(() => 0n);

  if (!bitcoinLocks.isLockedStatus(props.lock)) {
    unlockPrice.value = 0n;
    return;
  }

  const liquidLockingAddress = getWalletKeys().liquidLockingAddress;
  const unlockFee = await bitcoinLocks
    .estimatedReleaseArgonTxFee({ lock: props.lock, liquidLockingAddress })
    .catch(() => 0n);

  unlockPrice.value = (await vaults.getRedemptionRate(props.lock).catch(() => 0n)) + unlockFee;
}

Vue.onMounted(() => {
  if (isPendingFunding.value) {
    try {
      const fundingExpMillis = bitcoinLocks.verifyExpirationTime(props.lock);
      lockExpirationTime.value = dayjs.utc(fundingExpMillis);
    } catch {
      lockExpirationTime.value = dayjs.utc();
    }
  } else {
    const expirationMillis = bitcoinLocks.unlockDeadlineTime(props.lock);
    lockExpirationTime.value = dayjs.utc(expirationMillis);
  }
  void loadPrices();
});

Vue.watch(
  () => props.lock,
  () => void loadPrices(),
  { deep: true },
);
</script>
