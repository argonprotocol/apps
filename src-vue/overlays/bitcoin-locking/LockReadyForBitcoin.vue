<template>
  <div class="flex flex-col px-10 py-5">
    <div class="flex flex-col pt-3">
      <h1 class="flex flex-row items-center text-3xl font-bold">
        <span class="grow">Finish Locking Your Bitcoin</span>
        <span
          class="text-md bg-argon-100/30 text-argon-900/80 flex flex-row items-center rounded-full py-1 pr-2 pl-0 font-normal"
        >
          <ClockIcon class="relative -left-0 h-4" />
          <CountdownClock :time="fundingExpirationTime" v-slot="{ days, hours, minutes, seconds }">
            <template v-if="days > 0">{{ days }} day{{ days === 1 ? '' : 's' }}</template>
            <template v-if="days || hours">{{ hours }}h,</template>
            <template v-else>{{ minutes }}m and {{ seconds }}s</template>
          </CountdownClock>
        </span>
      </h1>

      <p class="mt-5 text-gray-600 select-text">1. Open the wallet that holds your Bitcoin</p>

      <p class="mt-5 text-gray-600 select-text">
        2. Send exactly
        <strong data-testid="LockReadyForBitcoin.amount">
          {{ formatBtc(currency.convertSatToBtc(props.personalLock.satoshis)) }}
        </strong>
        BTC (&asymp; {{ currency.symbol }}{{ satToMoneyNm(props.personalLock.satoshis).format('0,0.00') }}) to this
        address:
      </p>

      <div class="mt-5 flex flex-row items-stretch gap-x-2">
        <div class="flex min-w-0 grow items-center rounded-lg border border-gray-300 px-4 py-1.5 font-mono">
          <CopyToClipboard
            ref="scriptPaytoAddressCopy"
            :content="scriptPaytoAddress"
            class="relative min-w-0 grow cursor-pointer"
          >
            <span data-testid="LockReadyForBitcoin.address" class="flex min-w-0 items-center opacity-80">
              <span class="truncate">{{ scriptPaytoAddressPrefix }}</span>
              <span class="shrink-0">{{ scriptPaytoAddressSuffix }}</span>
              <CopyIcon class="ml-2 h-4 w-4 shrink-0" />
            </span>
            <template #copying>
              <div class="pointer-events-none absolute top-0 left-0 flex h-full w-full min-w-0 items-center">
                <span class="truncate">{{ scriptPaytoAddressPrefix }}</span>
                <span class="shrink-0">{{ scriptPaytoAddressSuffix }}</span>
                <CopyIcon class="ml-2 h-4 w-4 shrink-0" />
              </div>
            </template>
          </CopyToClipboard>
        </div>
        <button
          data-testid="LockReadyForBitcoin.copyAddress()"
          class="border-argon-600 shrink-0 rounded-md border px-3 whitespace-nowrap"
          @click.stop="scriptPaytoAddressCopy?.copy()"
        >
          Copy
        </button>
        <TooltipProvider :delayDuration="0" :disableHoverableContent="false">
          <TooltipRoot>
            <TooltipTrigger asChild>
              <button class="border-argon-600 shrink-0 rounded-md border px-3 whitespace-nowrap">View QR Code</button>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                side="bottom"
                align="end"
                :sideOffset="8"
                :collisionPadding="12"
                :style="floatingZIndex"
                class="flex w-80 flex-col items-center rounded-lg border border-slate-300 bg-white p-4 text-gray-500 shadow-xl"
                @click.stop
              >
                <p class="w-full text-left text-sm">
                  Scan this QR code with your Bitcoin wallet to pre-fill the transfer details.
                </p>
                <BitcoinQrCode class="mt-4 h-44 w-44 text-center" :bip21="fundingBip21" v-if="fundingBip21" />
                <TooltipArrow :width="18" :height="9" class="fill-white stroke-slate-300" />
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
        </TooltipProvider>
      </div>

      <p class="mt-5 text-gray-600 select-text">3. Click “Check for My Bitcoin” to look for your transfer.</p>

      <p class="mt-8 leading-normal font-light text-gray-600 select-text">
        Once your transaction is confirmed, Argon Network will mint you
        {{ currency.symbol }}{{ microgonToArgonNm(props.personalLock.liquidityPromised).format('0,0.[00]') }}, which is
        the current market value of {{ formatBtc(currency.convertSatToBtc(props.personalLock.satoshis)) }} BTC. If you
        accidentally send a different amount, the network will pause and let you accept the adjusted amount or return
        the BTC.
      </p>
    </div>

    <div class="mt-3 border-t border-slate-200 pt-4 pb-3">
      <div
        v-if="fundingCheckMessage"
        data-testid="LockReadyForBitcoin.fundingCheckMessage"
        class="mb-3 flex items-start rounded-md border border-yellow-400/70 bg-yellow-100 px-4 py-3 text-sm text-yellow-900"
      >
        <AlertIcon class="mt-0.5 mr-3 size-5 shrink-0 text-yellow-700" />
        <span>{{ fundingCheckMessage }}</span>
      </div>

      <div class="flex flex-row items-center justify-end gap-x-3">
        <button
          class="cursor-pointer rounded-md border border-slate-300 px-10 py-2 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          @click="closeOverlay"
        >
          Close and Finish Later
        </button>
        <button
          data-testid="LockReadyForBitcoin.checkForBitcoin()"
          :disabled="isCheckingForBitcoin || retrySeconds !== undefined"
          @click="checkForBitcoin"
          class="bg-argon-button enabled:hover:bg-argon-button-hover min-w-68 cursor-pointer rounded-md px-10 py-2 font-semibold text-white disabled:cursor-default disabled:opacity-60"
        >
          <template v-if="isCheckingForBitcoin">Checking Bitcoin Network...</template>
          <template v-else-if="retrySeconds !== undefined">Checking again in {{ retrySeconds }}s</template>
          <template v-else>
            Check for My Bitcoin
            <ChevronDoubleRightIcon class="relative -top-px inline-block size-5" />
          </template>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { createNumeralHelpers, formatBtc } from '../../lib/numeral.ts';
import { abbreviateAddress } from '../../lib/Utils.ts';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import BitcoinQrCode from '../../components/BitcoinQrCode.vue';
import CountdownClock from '../../components/CountdownClock.vue';
import AlertIcon from '../../assets/alert.svg?component';
import CopyIcon from '../../assets/copy.svg?component';
import ClockIcon from '../../assets/clock.svg?component';
import { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { SATS_PER_BTC } from '@argonprotocol/mainchain';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import { useFloatingZIndex } from '../helpers/OverlayZIndex.ts';
import { ChevronDoubleRightIcon } from '@heroicons/vue/24/outline';

dayjs.extend(utc);

const props = defineProps<{
  personalLock: IBitcoinLockRecord;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const currency = getCurrency();
const bitcoinLocks = getBitcoinLocks();
const floatingZIndex = useFloatingZIndex();

const { microgonToArgonNm, satToMoneyNm } = createNumeralHelpers(currency);

const fundingBip21 = Vue.ref('');
const scriptPaytoAddress = Vue.ref('');
const scriptPaytoAddressPrefix = Vue.computed(() => scriptPaytoAddress.value.slice(0, -18));
const scriptPaytoAddressSuffix = Vue.computed(() => scriptPaytoAddress.value.slice(-18));
const scriptPaytoAddressCopy = Vue.ref<{ copy: () => void }>();
const fundingExpirationTime = Vue.ref(dayjs.utc());
const isCheckingForBitcoin = Vue.ref(false);
const retrySeconds = Vue.ref<number>();
const fundingCheckMessage = Vue.ref('');

let retryCountdownInterval: ReturnType<typeof setInterval> | undefined;

function closeOverlay() {
  emit('close');
}

async function checkForBitcoin() {
  if (isCheckingForBitcoin.value) return;

  stopFundingRetryCountdown();
  isCheckingForBitcoin.value = true;
  try {
    const observation = await bitcoinLocks.utxoTracking.observeMempoolFunding(props.personalLock);
    if (observation) return;

    fundingCheckMessage.value = 'We haven’t found your transfer yet, but we’ll keep checking automatically.';
  } catch (error) {
    console.error('Error checking for Bitcoin funding:', error);
    fundingCheckMessage.value = 'We couldn’t check the Bitcoin network just now, but we’ll try again automatically.';
  } finally {
    isCheckingForBitcoin.value = false;
  }

  startFundingRetryCountdown();
}

function startFundingRetryCountdown() {
  stopFundingRetryCountdown();
  retrySeconds.value = 30;
  retryCountdownInterval = setInterval(() => {
    if (retrySeconds.value === undefined) return;
    if (retrySeconds.value > 1) {
      retrySeconds.value -= 1;
      return;
    }

    stopFundingRetryCountdown();
    void checkForBitcoin();
  }, 1e3);
}

function stopFundingRetryCountdown() {
  if (retryCountdownInterval) clearInterval(retryCountdownInterval);
  retryCountdownInterval = undefined;
  retrySeconds.value = undefined;
}

Vue.onMounted(async () => {
  await bitcoinLocks.load();
  fundingExpirationTime.value = dayjs.utc(bitcoinLocks.verifyExpirationTime(props.personalLock));
  try {
    scriptPaytoAddress.value = bitcoinLocks.formatP2wshAddress(props.personalLock.lockDetails.p2wshScriptHashHex);
  } catch (error) {
    console.error('Error formatting P2WSH address:', error);
    throw new Error('Failed to format P2WSH address');
  }
  const btcAmount = formatBtc(Number(props.personalLock.satoshis) / Number(SATS_PER_BTC));
  const label = encodeURIComponent(`Argon Vault #${props.personalLock.vaultId} (utxo id=${props.personalLock.utxoId})`);
  const message = encodeURIComponent(
    `Personal BTC Funding for Vault #${props.personalLock.vaultId}, Utxo Id #${props.personalLock.utxoId}`,
  );
  fundingBip21.value = `bitcoin:${scriptPaytoAddress.value}?amount=${btcAmount}&label=${label}&message=${message}`;
});

Vue.onUnmounted(stopFundingRetryCountdown);
</script>
