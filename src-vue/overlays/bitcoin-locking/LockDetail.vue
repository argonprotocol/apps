<template>
  <div class="flex flex-row gap-8 px-10 pt-6 pb-8">
    <div class="relative w-28 shrink-0 pt-1">
      <VaultIcon class="w-28 opacity-50" />
      <BitcoinIcon class="absolute -top-2 -right-1 w-8 bg-white text-slate-700/70" />
    </div>

    <div class="grow">
      <div class="flex items-baseline gap-2">
        <span class="text-argon-600 font-mono text-2xl font-bold">{{ formattedBtc }} BTC</span>
        <span v-if="isOwnLock && isReleased" class="text-sm text-slate-500">
          <span>
            {{ currency.symbol
            }}{{ microgonToMoneyNm(localLock!.securitizationCoverageMicrogons ?? 0n).format('0,0.[00]') }} security
            coverage
          </span>
          ·
          <Tooltip :asChild="true" content="The Argons returned to unlock and release this bitcoin.">
            <span class="cursor-help">
              {{
                localLock?.releaseRedemptionMicrogons === undefined
                  ? 'release cost unavailable'
                  : `${currency.symbol}${microgonToMoneyNm(localLock.releaseRedemptionMicrogons).format('0,0.[00]')} release cost`
              }}
            </span>
          </Tooltip>
          ·
          <span class="font-medium text-slate-700">
            <template v-if="settledPerformance">
              {{ currency.symbol }}{{ microgonToMoneyNm(settledPerformance.profit).format('0,0.[00]') }} profit ({{
                numeral(settledPerformance.percent).format('0,0.[00]')
              }}%)
            </template>
            <template v-else-if="isReturnLoading">return loading...</template>
            <template v-else>return unavailable</template>
          </span>
        </span>
        <span v-else class="text-sm text-slate-500">
          <Tooltip :asChild="true" content="The current market value of this bitcoin based on the latest oracle price.">
            <span class="cursor-help">
              {{ currency.symbol }}{{ satToMoneyNm(fundingSatoshis).format('0,0.[00]') }} current market
            </span>
          </Tooltip>
          <template v-if="!('uuid' in lock)">
            ·
            <span>
              {{ currency.symbol }}{{ microgonToMoneyNm(lock.securitizationCoverageMicrogons).format('0,0.[00]') }}
              security coverage
            </span>
          </template>
        </span>
      </div>

      <div class="mt-3 text-sm font-light text-slate-500 italic">
        {{ statusMessage }}
      </div>

      <div v-if="releaseTxid" class="mt-2 text-xs">
        <a
          :href="mempool.txUrl(releaseTxid)"
          target="_blank"
          class="text-argon-600 inline-flex items-center gap-1 hover:underline"
        >
          View bitcoin transaction
          <ArrowTopRightOnSquareIcon class="h-3 w-3" />
        </a>
      </div>

      <div v-if="isOwnLock && isReleased" class="mt-4 flex items-stretch border-t border-slate-200 pt-3 text-sm">
        <div v-if="localSummary?.pendingLiquidity" class="w-32 shrink-0 text-center">
          <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Pending</div>
          <div class="mt-0.5 font-medium text-slate-700">
            {{ currency.symbol }}{{ microgonToMoneyNm(localSummary.pendingLiquidity).format('0,0.[00]') }}
          </div>
        </div>
        <div
          class="min-w-0 grow px-3 text-center"
          :class="{ 'border-l border-slate-200': localSummary?.pendingLiquidity }"
        >
          <Tooltip :asChild="true" content="The fee charged by the vault operator for securing this bitcoin lock.">
            <div class="cursor-help">
              <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Vault fees</div>
              <div class="mt-0.5 font-medium text-slate-700">
                {{ currency.symbol }}{{ microgonToMoneyNm(vaultFees).format('0,0.[00]') }}
              </div>
            </div>
          </Tooltip>
        </div>
        <div class="min-w-0 grow border-l border-slate-200 px-3 text-center">
          <Tooltip
            :asChild="true"
            content="The Bitcoin network fee deducted from the bitcoin returned to your wallet, valued at its release price."
          >
            <div class="cursor-help">
              <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">BTC unlock fee</div>
              <div class="mt-0.5 font-medium text-slate-700">
                {{
                  bitcoinUnlockCost === undefined
                    ? 'Unavailable'
                    : `${currency.symbol}${microgonToMoneyNm(bitcoinUnlockCost).format('0,0.[00]')}`
                }}
              </div>
            </div>
          </Tooltip>
        </div>
        <div class="min-w-0 grow border-l border-slate-200 px-3 text-center">
          <Tooltip
            :asChild="true"
            content="Argon transaction fees paid to initialize, ratchet, and release this bitcoin lock."
          >
            <div class="cursor-help">
              <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Argon transaction fees</div>
              <div class="mt-0.5 font-medium text-slate-700">
                {{
                  argonTransactionCost === undefined
                    ? 'Unavailable'
                    : `${currency.symbol}${microgonToMoneyNm(argonTransactionCost).format('0,0.[00]')}`
                }}
              </div>
            </div>
          </Tooltip>
        </div>
      </div>

      <div v-else class="mt-4 flex flex-row items-start gap-6">
        <div class="space-y-1.5 text-sm text-slate-600">
          <div v-if="!isPendingFunding && isOwnLock && localLock?.securitizationCoverageMicrogons !== undefined">
            <Tooltip :asChild="true" content="The current Argon security coverage for this bitcoin.">
              <span class="cursor-help">
                Security coverage
                <span class="font-semibold">
                  {{ currency.symbol
                  }}{{ microgonToMoneyNm(localLock.securitizationCoverageMicrogons).format('0,0.[00]') }}
                </span>
              </span>
            </Tooltip>
          </div>
          <div v-if="vaultFees > 0n" class="text-slate-500">
            <Tooltip :asChild="true" content="The fee charged by the vault operator for securing this bitcoin lock.">
              <span class="cursor-help">
                Vault fees
                <span class="font-semibold">
                  {{ currency.symbol }}{{ microgonToMoneyNm(vaultFees).format('0,0.[00]') }}
                </span>
              </span>
            </Tooltip>
          </div>
          <div v-if="transactionFees > 0n" class="text-slate-500">
            <Tooltip :asChild="true" content="Argon transaction fees paid to initialize and ratchet this bitcoin lock.">
              <span class="cursor-help">
                Argon transaction fees
                <span class="font-semibold">
                  {{ currency.symbol }}{{ microgonToMoneyNm(transactionFees).format('0,0.[000000]') }}
                </span>
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
                stroke-linecap="butt"
              />
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
              v-slot="{ days, hours, minutes, seconds, isFinished }"
            >
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
        class="mt-5 flex justify-end border-t border-slate-200 pt-4"
      >
        <button
          data-testid="LockDetail.unlock()"
          @click="emit('unlock')"
          class="bg-argon-600 hover:bg-argon-700 cursor-pointer rounded-md px-6 py-2 text-lg font-bold text-white"
        >
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
import { getConfig } from '../../stores/config.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { useFinancials } from '../../stores/financials.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline';
import BitcoinMempool from '../../lib/BitcoinMempool.ts';
import { ESPLORA_HOST } from '../../lib/Env.ts';
import BitcoinIcon from '../../assets/wallets/bitcoin.svg?component';
import VaultIcon from '../../assets/wallets/vault.svg?component';
import Tooltip from '../../components/Tooltip.vue';
import CountdownClock from '../../components/CountdownClock.vue';
import type { IExternalBitcoinLock } from '../../lib/MyVault.ts';
import { valueSatoshisAtRate } from '../../lib/financials/BitcoinLocks.ts';

dayjs.extend(utc);

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const miningFrames = getMiningFrames();
const financials = useFinancials();
const { microgonToMoneyNm, satToMoneyNm } = createNumeralHelpers(currency);

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

const settledPerformance = Vue.computed(() => {
  const uuid = localLock.value?.uuid;
  if (!uuid) return;
  return financials.bitcoinLockPerformanceByUuid[uuid];
});

const isReturnLoading = Vue.computed(() => {
  return !!localLock.value?.isHistoryRecoveryPending;
});

const localSummary = Vue.computed(() => {
  if (!localLock.value) return;
  return bitcoinLocks.createLockSummary(localLock.value);
});

const vaultLabel = Vue.computed(() => {
  const upstreamOperator = config.upstreamOperator;
  if (config.hasExtensionTreasury && upstreamOperator) {
    const name = upstreamOperator.name;
    if (name) return `${name}'s vault`;
    return 'The vault';
  }

  return 'Your vault';
});

const statusMessage = Vue.computed(() => {
  if (isReleased.value) {
    if (isOwnLock.value) {
      const releasedOn = localLock.value?.removalBlockTime
        ? ` on ${dayjs(localLock.value.removalBlockTime).format('MMM D, YYYY')}`
        : '';
      if (localSummary.value?.pendingLiquidity) {
        return `Your bitcoin was unlocked and returned to your wallet${releasedOn}. The remaining argons will continue minting to your wallet.`;
      }
      return `Your bitcoin was unlocked and returned to your wallet${releasedOn}.`;
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
  return 'This bitcoin is locked and generating revenue on Argon.';
});

const fundingUtxoRecord = Vue.computed(() => {
  if (!localLock.value) return undefined;
  return bitcoinLocks.getAcceptedFundingRecord(localLock.value);
});

const mempool = new BitcoinMempool(ESPLORA_HOST);
const releaseTxid = Vue.computed(() => fundingUtxoRecord.value?.releaseTxid);

const fundingSatoshis = Vue.computed(() => {
  if (fundingUtxoRecord.value) return fundingUtxoRecord.value.satoshis;
  return 'uuid' in props.lock ? props.lock.fundedSatoshis || props.lock.securitizedSatoshis : props.lock.satoshis;
});

const formattedBtc = Vue.computed(() => {
  return numeral(currency.convertSatToBtc(fundingSatoshis.value)).format('0,0.[00000000]');
});

const vaultFees = Vue.computed(() => {
  if (localSummary.value) return localSummary.value.securityFees;
  return 'uuid' in props.lock ? props.lock.securityFees : props.lock.lockDetails.securityFees;
});

const lockTiming = Vue.computed(() => {
  if ('uuid' in props.lock) return props.lock;
  return {
    scriptDetails: props.lock.lockDetails,
    fundingExpirationHeight: props.lock.lockDetails.fundingExpirationHeight,
  };
});

const transactionFees = Vue.computed(() => {
  const summary = localSummary.value;
  if (!summary) return 0n;
  return summary.transactionFees;
});

const bitcoinUnlockCost = Vue.computed(() => {
  const lock = localLock.value;
  if (!lock) return;

  return valueSatoshisAtRate(lock.fundingUtxo?.releaseBitcoinNetworkFee, lock.btcPriceAtRemovalMicrogons ?? undefined);
});

const argonTransactionCost = Vue.computed(() => {
  const lock = localLock.value;
  if (!lock || lock.releaseArgonTxFeeMicrogons === undefined) return;
  return transactionFees.value + lock.releaseArgonTxFeeMicrogons;
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
  if (isPendingFunding.value) return bitcoinLocks.getFundingWindowProgress(lockTiming.value);

  if (isPendingCosign.value) {
    if (localLock.value) {
      return bitcoinLocks.getRequestReleaseByVaultProgress(localLock.value, miningFrames);
    }

    return bitcoinLocks.getCosignDeadlineProgress(props.pendingCosign?.dueFrame, miningFrames);
  }

  return bitcoinLocks.getLockTermProgress(lockTiming.value);
});

const cosignDueTime = Vue.computed(() => {
  const dueFrame = props.pendingCosign?.dueFrame;
  if (!dueFrame) return dayjs.utc();
  return dayjs.utc(miningFrames.getFrameDate(dueFrame).getTime());
});

const lockExpirationTime = Vue.computed(() => {
  if (isPendingFunding.value) {
    try {
      return dayjs.utc(bitcoinLocks.verifyExpirationTime(lockTiming.value));
    } catch {
      return dayjs.utc();
    }
  }

  if (!localLock.value) return dayjs.utc();

  const expirationMillis = bitcoinLocks.unlockDeadlineTime(localLock.value);
  return dayjs.utc(expirationMillis);
});
</script>
