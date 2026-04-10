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
            <CountdownClock
              v-if="isPendingFunding || isPendingCosign"
              :time="isPendingCosign ? cosignDueTime : lockExpirationTime"
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
import numeral, { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getBitcoinLocks } from '../../../stores/bitcoin.ts';
import { getConfig } from '../../../stores/config.ts';
import { getMiningFrames } from '../../../stores/mainchain.ts';
import { getVaults } from '../../../stores/vaults.ts';
import { getWalletKeys } from '../../../stores/wallets.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../../lib/db/BitcoinLocksTable.ts';
import { ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline';
import BitcoinMempool from '../../../lib/BitcoinMempool.ts';
import { ESPLORA_HOST, IS_TREASURY_APP } from '../../../lib/Env.ts';
import BitcoinIcon from '../../../assets/wallets/bitcoin.svg?component';
import VaultIcon from '../../../assets/wallets/vault.svg?component';
import Tooltip from '../../../components/Tooltip.vue';
import CountdownClock from '../../../components/CountdownClock.vue';
import type { IExternalBitcoinLock } from '../../../lib/MyVault.ts';

dayjs.extend(utc);

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const miningFrames = getMiningFrames();
const vaults = getVaults();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const props = defineProps<{
  lock: IBitcoinLockRecord | IExternalBitcoinLock;
  pendingCosign?: { dueFrame?: number };
  isReleased?: boolean;
}>();

const emit = defineEmits<{
  (e: 'unlock'): void;
}>();

const localLock = Vue.computed(() => ('uuid' in props.lock ? props.lock : undefined));

const externalLock = Vue.computed(() => ('uuid' in props.lock ? undefined : props.lock));

const isOwnLock = Vue.computed(() => !!localLock.value?.uuid);

const isMinting = Vue.computed(() => {
  return localLock.value?.status === BitcoinLockStatus.LockedAndIsMinting;
});

const isPendingCosign = Vue.computed(() => {
  return props.pendingCosign != null;
});

const isPendingFunding = Vue.computed(() => {
  return localLock.value?.status === BitcoinLockStatus.LockPendingFunding || externalLock.value?.isPending;
});

const isReleased = Vue.computed(() => {
  if (localLock.value) {
    return localLock.value.status === BitcoinLockStatus.Released;
  }

  return !!props.isReleased;
});

const vaultLabel = Vue.computed(() => {
  const upstreamOperator = config.upstreamOperator;
  if (IS_TREASURY_APP && upstreamOperator) {
    const name = upstreamOperator.name.trim();
    if (name) return `${name}'s vault`;
    return 'The vault';
  }

  return 'Your vault';
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
    return `This lock has a pending release request. ${vaultLabel.value} will cosign automatically.`;
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
  if (!localLock.value) return undefined;
  return bitcoinLocks.getAcceptedFundingRecord(localLock.value);
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
  if (!localLock.value) return 0;
  return bitcoinLocks.getMintPercent(localLock.value);
});

const totalFees = Vue.computed(() => {
  const ratchet = localLock.value?.ratchets?.[0];
  if (ratchet) {
    return (ratchet.securityFee ?? 0n) + (ratchet.txFee ?? 0n);
  }
  return props.lock.lockDetails?.securityFees ?? 0n;
});

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
  if (localLock.value) {
    return `Expires ${lockExpirationTime.value.format('MMM D, YYYY')}`;
  }
  return 'Lock term in progress';
});

const timerColorClass = Vue.computed(() => {
  if (termProgress.value > 90) return 'stroke-current text-amber-500';
  if (isPendingCosign.value) return 'stroke-current text-amber-500';
  return 'stroke-current text-argon-600';
});

const termProgress = Vue.computed(() => {
  if (isPendingFunding.value) return bitcoinLocks.getFundingWindowProgress(props.lock);

  if (isPendingCosign.value) {
    if (localLock.value) {
      return bitcoinLocks.getRequestReleaseByVaultProgress(localLock.value, miningFrames);
    }

    return bitcoinLocks.getCosignDeadlineProgress(props.pendingCosign?.dueFrame, miningFrames);
  }

  return bitcoinLocks.getLockTermProgress(props.lock);
});

const cosignDueTime = Vue.computed(() => {
  const dueFrame = props.pendingCosign?.dueFrame;
  if (!dueFrame) return dayjs.utc();
  return dayjs.utc(miningFrames.getFrameDate(dueFrame).getTime());
});

const lockExpirationTime = Vue.computed(() => {
  if (isPendingFunding.value) {
    try {
      return dayjs.utc(bitcoinLocks.verifyExpirationTime(props.lock));
    } catch {
      return dayjs.utc();
    }
  }

  if (!localLock.value) return dayjs.utc();

  const expirationMillis = bitcoinLocks.unlockDeadlineTime(localLock.value);
  return dayjs.utc(expirationMillis);
});

const btcMarketRate = Vue.ref(0n);
const unlockPrice = Vue.ref(0n);

async function loadPrices() {
  btcMarketRate.value = await vaults.getMarketRateInMicrogons(fundingSatoshis.value).catch(() => 0n);

  if (!localLock.value || !bitcoinLocks.isLockedStatus(localLock.value)) {
    unlockPrice.value = 0n;
    return;
  }

  const liquidLockingAddress = getWalletKeys().liquidLockingAddress;
  const unlockFee = await bitcoinLocks
    .estimatedReleaseArgonTxFee({ lock: localLock.value, liquidLockingAddress })
    .catch(() => 0n);

  unlockPrice.value = (await vaults.getRedemptionRate(localLock.value).catch(() => 0n)) + unlockFee;
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
